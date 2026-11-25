import AVFoundation
import SwiftUI

/// Plays a show: the music here, the lights on the controllers.
///
/// The compiled show is uploaded to every controller beforehand. To start, the app measures each
/// controller's clock against its own and tells it at which moment (on the controller's clock)
/// show time zero happens; the music is scheduled for the same moment here. After that the
/// controllers run by themselves, so WiFi delays during the song don't matter.
@MainActor
final class ShowPlayer: ObservableObject {
    @Published private(set) var playing = false
    @Published private(set) var position: Double = 0          // seconds, as seen on the lights
    @Published private(set) var busy = false
    @Published var error: String?

    private var player: AVAudioPlayer?
    private var audioName: String?
    private var zeroUptime: Double = 0                        // local uptime (s) at show time 0
    private var ticker: Task<Void, Never>?
    private var offsets: [String: Double] = [:]               // controller id -> clock offset (ms)
    private var resyncTask: Task<Void, Never>?
    private var currentShowID: UInt32 = 0
    private var currentLatency: Double = 0                    // seconds the lights run behind the scheduled audio

    private static let leadIn = 0.35                          // seconds between pressing play and it starting

    private static var now: Double { ProcessInfo.processInfo.systemUptime }

    // MARK: - Audio

    func loadAudio(for show: Show) {
        guard show.audioFile != audioName else { return }
        stopAudio()
        audioName = show.audioFile
        player = nil
        guard let name = show.audioFile else { return }
        do {
            let p = try AVAudioPlayer(contentsOf: AudioStore.url(for: name))
            p.prepareToPlay()
            player = p
        } catch {
            self.error = "Couldn't open the music: \(error.localizedDescription)"
        }
    }

    private func stopAudio() {
        player?.stop()
    }

    // MARK: - Transport

    func seek(_ t: Double, show: Show, store: TreeStore) {
        let t = max(0, min(t, show.duration))
        if playing {
            play(from: t, show: show, store: store)
        } else {
            position = t
        }
    }

    func toggle(show: Show, store: TreeStore) {
        if playing { pause(store: store) } else { play(from: position, show: show, store: store) }
    }

    func play(from start: Double, show: Show, store: TreeStore) {
        guard !busy else { return }
        busy = true
        error = nil
        Task {
            defer { busy = false }
            do {
                let controllers = try await prepare(show: show, store: store)
                try await begin(at: start, show: show, controllers: controllers, store: store)
            } catch {
                self.error = error.localizedDescription
                stopEverything(store: store)
            }
        }
    }

    func pause(store: TreeStore) {
        position = currentPosition()
        stopEverything(store: store)
    }

    func stop(store: TreeStore) {
        stopEverything(store: store)
        position = 0
    }

    /// Opening the editor: every controller goes dark while nothing is playing.
    func enterEditor(store: TreeStore) {
        store.holdDark = true
        stopEverything(store: store)
    }

    /// Leaving the editor: stop, and give every controller its normal look back.
    func leaveEditor(store: TreeStore) {
        ticker?.cancel()
        ticker = nil
        resyncTask?.cancel()
        playing = false
        stopAudio()
        store.holdDark = false
        store.onShowPlayback?(nil, nil)
        let list = store.data.controllers
        Task {
            for c in list { try? await DeviceClient(host: c.host).stopShow(dark: false) }
        }
    }

    /// Call after editing during playback: re-sends the show and carries on from where it is.
    func showEdited(_ show: Show, store: TreeStore) {
        guard playing else { return }
        resyncTask?.cancel()
        resyncTask = Task {
            try? await Task.sleep(nanoseconds: 600_000_000)
            guard !Task.isCancelled, playing else { return }
            do {
                let controllers = try await prepare(show: show, store: store, measureClocks: false)
                try await startLights(controllers: controllers, zeroUptime: zeroUptime)
                notifyServer(show: show, store: store)
            } catch {
                self.error = error.localizedDescription
            }
        }
    }

    /// The server draws the online clips (marquee, video): tell it when show time 0 is, on the wall clock.
    private func notifyServer(show: Show, store: TreeStore) {
        let zeroWall = Date().timeIntervalSince1970 + (zeroUptime + currentLatency - Self.now)
        store.onShowPlayback?(show.id, zeroWall)
    }

    private func stopEverything(store: TreeStore) {
        store.onShowPlayback?(nil, nil)
        ticker?.cancel()
        ticker = nil
        resyncTask?.cancel()
        playing = false
        stopAudio()
        let list = store.data.controllers
        Task {
            for c in list { try? await DeviceClient(host: c.host).stopShow(dark: true) }
        }
    }

    private func currentPosition() -> Double {
        guard playing else { return position }
        return max(0, Self.now - zeroUptime - currentLatency)
    }

    // MARK: - Getting the controllers ready

    private func prepare(show: Show, store: TreeStore, measureClocks: Bool = true) async throws -> [Controller] {
        let controllers = store.data.controllers.filter { store.isOnline($0) }
        guard !controllers.isEmpty else { throw APIError(message: "No controllers are online.") }
        if let old = controllers.first(where: { store.online[$0.id]?.supportsGroups == false }) {
            throw APIError(message: "\(old.name) needs firmware 1.3 or later to play shows.")
        }

        // Every LED needs to know which plant (zone) it is on.
        try await store.uploadLayout(onlyIfChanged: true)

        let segments = ShowCompiler.compile(show, plants: store.data.plants,
                                            zoneOf: TreeStore.zone(ofPlantAt:),
                                            otherZone: TreeStore.otherZone,
                                            groupFrame: { store.groupFrame($0) })
        guard !segments.isEmpty else { throw APIError(message: "The show is empty – add some clips first.") }
        let id = ShowCompiler.id(of: segments)
        let withDir = segments.contains { $0.dir != nil }
        let newFx = segments.contains { $0.fx >= 15 }
        if segments.contains(where: { $0.fx >= 200 }), let old = controllers.first(where: { store.online[$0.id]?.supportsOnline == false }) {
            throw APIError(message: "\(old.name) needs firmware 1.8 or later for online effects (Marquee, Video).")
        }
        if withDir || newFx, let old = controllers.first(where: { store.online[$0.id]?.supportsDirections == false }) {
            throw APIError(message: "\(old.name) needs firmware 1.6 or later for effect directions and the new 3D effects.")
        }
        if segments.contains(where: { $0.fx >= 19 }), let old = controllers.first(where: { store.online[$0.id]?.supportsCamera == false }) {
            throw APIError(message: "\(old.name) needs firmware 1.7 or later for the 2D camera effects.")
        }
        let ints = segments.map { $0.ints(withDirection: withDir) }

        var failures: [String] = []
        await withTaskGroup(of: String?.self) { group in
            for c in controllers {
                let loaded = store.online[c.id]?.showId == id
                group.addTask {
                    if loaded { return nil }
                    do { try await DeviceClient(host: c.host).uploadShow(ints, id: id); return nil }
                    catch { return "\(c.name): \(error.localizedDescription)" }
                }
            }
            for await f in group { if let f { failures.append(f) } }
        }
        if !failures.isEmpty { throw APIError(message: failures.joined(separator: "\n")) }
        for c in controllers { store.online[c.id]?.showId = id }
        currentShowID = id

        // Measure each controller's clock against ours (a controller may have restarted).
        if measureClocks || controllers.contains(where: { offsets[$0.id] == nil }) {
            try await withThrowingTaskGroup(of: (String, Double).self) { group in
                for c in controllers {
                    group.addTask { (c.id, try await DeviceClient(host: c.host).clockOffset()) }
                }
                for try await (id, off) in group { offsets[id] = off }
            }
        }
        return controllers
    }

    private func startLights(controllers: [Controller], zeroUptime: Double) async throws {
        let id = currentShowID
        let latency = currentLatency
        var failures: [String] = []
        await withTaskGroup(of: String?.self) { group in
            for c in controllers {
                guard let off = offsets[c.id] else { continue }
                let start = Int64(((zeroUptime + latency) * 1000 + off).rounded())
                group.addTask {
                    do { try await DeviceClient(host: c.host).playShow(id: id, startUptimeMs: start); return nil }
                    catch { return "\(c.name): \(error.localizedDescription)" }
                }
            }
            for await f in group { if let f { failures.append(f) } }
        }
        if !failures.isEmpty { throw APIError(message: failures.joined(separator: "\n")) }
    }

    private func begin(at start: Double, show: Show, controllers: [Controller], store: TreeStore) async throws {
        loadAudio(for: show)
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .default)
        try? AVAudioSession.sharedInstance().setActive(true)

        // Lights follow the sound as it leaves the speaker (Bluetooth adds a lot), plus the user's trim.
        let output = AVAudioSession.sharedInstance().outputLatency
        currentLatency = output + show.latencyMs / 1000

        let t0 = Self.now
        zeroUptime = t0 + Self.leadIn - start
        try await startLights(controllers: controllers, zeroUptime: zeroUptime)
        notifyServer(show: show, store: store)

        if let p = player {
            p.stop()
            p.currentTime = start
            // Both clocks were sampled together, so "lead-in from t0" means the same moment.
            let remaining = max(0.05, Self.leadIn - (Self.now - t0))
            p.play(atTime: p.deviceCurrentTime + remaining)
        }
        playing = true
        ticker?.cancel()
        ticker = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                let t = Self.now - self.zeroUptime - self.currentLatency
                self.position = max(0, t)
                if t >= show.duration {
                    self.playing = false
                    self.position = show.duration
                    return
                }
                try? await Task.sleep(nanoseconds: 33_000_000)
            }
        }
    }
}
