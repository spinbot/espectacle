import Foundation
import Security
import SwiftUI

/// Keeps this device's project in step with the ESPectacle server (server/ in the repo), so the
/// iPhone, iPad, Mac and the website all work on one copy. Pulls when the app comes forward and
/// every 20 s while open; pushes a couple of seconds after each local change.
@MainActor
final class ServerSync: ObservableObject {
    enum Conflict { case firstConnect, edited }

    @Published var serverURL: String = UserDefaults.standard.string(forKey: "serverURL") ?? "" {
        didSet { UserDefaults.standard.set(serverURL, forKey: "serverURL") }
    }
    @Published var password: String = Keychain.read("serverPassword") ?? "" {
        didSet { Keychain.write("serverPassword", password) }
    }
    @Published private(set) var status = "Not set up"
    @Published private(set) var busy = false
    @Published var conflict: Conflict?
    @Published var lastError: String?

    var enabled: Bool { !serverURL.trimmingCharacters(in: .whitespaces).isEmpty }

    private weak var store: TreeStore?
    private var pushTask: Task<Void, Never>?
    private var pollTask: Task<Void, Never>?
    private var syncedRevision: Int {
        get { UserDefaults.standard.integer(forKey: "serverRevision") }
        set { UserDefaults.standard.set(newValue, forKey: "serverRevision") }
    }
    /// Local edits not yet on the server (survives restarts).
    private var dirty: Bool {
        get { UserDefaults.standard.bool(forKey: "serverDirty") }
        set { UserDefaults.standard.set(newValue, forKey: "serverDirty") }
    }
    /// Date of the yard scan last sent to / fetched from the server.
    private var areaSyncedDate: Double {
        get { UserDefaults.standard.double(forKey: "serverAreaDate") }
        set { UserDefaults.standard.set(newValue, forKey: "serverAreaDate") }
    }

    func attach(_ store: TreeStore) {
        guard self.store == nil else { return }
        self.store = store
        store.onLocalChange = { [weak self] in self?.localChanged() }
        store.onLiveState = { [weak self] state in self?.sendLive(state) }
        store.onShowPlayback = { [weak self] id, zero in self?.sendShowPlayback(id: id, zeroWall: zero) }
        startPolling()
    }

    // MARK: - Online effects (drawn and streamed by the server)

    /// The look just sent to the lights, so the server streams it when it's an online effect.
    private func sendLive(_ state: LightState) {
        guard enabled, let body = try? JSONEncoder().encode(state) else { return }
        Task { _ = try? await requestData("POST", "/api/lights/live", body: body, contentType: "application/json", timeout: 5) }
    }

    /// A show started (show time 0 at `zeroWall`, seconds since 1970) or stopped: the server streams its
    /// online clips.
    private func sendShowPlayback(id: UUID?, zeroWall: Double?) {
        guard enabled else { return }
        Task {
            if let id, let zeroWall {
                _ = try? await request("POST", "/api/online/show", json: ["id": id.uuidString, "start": Int(zeroWall * 1000)], timeout: 5)
            } else {
                _ = try? await request("POST", "/api/online/stop", timeout: 5)
            }
        }
    }

    // MARK: - Firmware updates (the server stores the firmware and sends it to the controller)

    struct FirmwareStatus {
        var best: String?          // newest firmware file built for this controller's board
        var version: String?       // its version
        var available: Bool        // newer than what the controller runs
        var state: String?         // uploading, restarting, done, failed
        var progress: Double
        var message: String?
    }

    func firmwareStatus(controllerID: String) async -> FirmwareStatus? {
        guard enabled, let reply = try? await request("GET", "/api/devices", timeout: 10), reply.0 == 200,
              let root = reply.1 as? [String: Any], let list = root["devices"] as? [[String: Any]],
              let d = list.first(where: { ($0["id"] as? String) == controllerID }) else { return nil }
        let best = d["best"] as? [String: Any], u = d["update"] as? [String: Any]
        return FirmwareStatus(best: best?["name"] as? String, version: best?["version"] as? String,
                              available: d["updateAvailable"] as? Bool ?? false, state: u?["state"] as? String,
                              progress: u?["progress"] as? Double ?? 0, message: u?["message"] as? String)
    }

    /// Asks the server to send the newest suitable firmware to a controller.
    func startFirmwareUpdate(controllerID: String) async throws {
        let (code, json) = try await request("POST", "/api/devices/\(controllerID)/update", json: [String: Any](), timeout: 20)
        if code != 200 { throw APIError(message: (json as? [String: Any])?["error"] as? String ?? "The server said \(code)") }
    }

    /// Videos on the server, for the Video effect.
    func mediaList() async -> [String] {
        guard enabled, let reply = try? await request("GET", "/api/media", timeout: 10), reply.0 == 200,
              let list = reply.1 as? [[String: Any]] else { return [] }
        return list.compactMap { $0["name"] as? String }
    }

    // MARK: - Triggers

    private func localChanged() {
        guard enabled else { return }
        dirty = true
        status = "Changes waiting to sync…"
        pushTask?.cancel()
        pushTask = Task {
            try? await Task.sleep(nanoseconds: 2_000_000_000)
            if !Task.isCancelled { await push() }
        }
    }

    func startPolling() {
        pollTask?.cancel()
        pollTask = Task {
            while !Task.isCancelled {
                if enabled, conflict == nil, !busy { await pullIfNewer() }
                try? await Task.sleep(nanoseconds: 20_000_000_000)
            }
        }
    }

    /// First connection, or after changing the address: decides which copy wins.
    func connect() async {
        guard enabled, let store else { return }
        lastError = nil
        busy = true
        defer { busy = false }
        do {
            let rev = try await revision()
            syncedRevision = 0
            if rev == 0 {
                dirty = true
                await pushNow(force: true)            // empty server: give it this device's project
            } else if store.data.plants.isEmpty && store.data.controllers.isEmpty {
                try await pull()                      // empty device: take the server's
            } else {
                conflict = .firstConnect              // both have a project: ask
            }
        } catch {
            fail(error)
        }
    }

    /// Resolves a conflict: true keeps this device's project, false takes the server's.
    func resolve(keepLocal: Bool) async {
        conflict = nil
        busy = true
        defer { busy = false }
        if keepLocal {
            dirty = true
            await pushNow(force: true)
        } else {
            do { try await pull() } catch { fail(error) }
        }
    }

    func syncNow() async {
        if dirty { await push() } else { await pullIfNewer() }
    }

    // MARK: - Push / pull

    private func push() async {
        guard enabled, !busy, conflict == nil else { return }
        busy = true
        defer { busy = false }
        await pushNow(force: false)
    }

    private func pushNow(force: Bool) async {
        guard let store else { return }
        do {
            try await uploadAreaIfNeeded(store.data)
            try await uploadMissingAudio(store.data)
            let body = try JSONSerialization.jsonObject(with: JSONEncoder().encode(store.data))
            let payload: [String: Any] = ["baseRevision": syncedRevision, "data": body, "force": force]
            let (code, reply) = try await request("PUT", "/api/project", json: payload)
            if code == 409 {
                conflict = .edited
                status = "The server has newer changes"
                return
            }
            guard code == 200, let rev = (reply as? [String: Any])?["revision"] as? Int else {
                throw APIError(message: "Server returned HTTP \(code)")
            }
            syncedRevision = rev
            dirty = false
            status = "Synced (revision \(rev))"
            lastError = nil
        } catch {
            fail(error)
        }
    }

    private func pullIfNewer() async {
        do {
            let rev = try await revision()
            if rev > syncedRevision {
                if dirty { conflict = .edited; return }
                busy = true
                defer { busy = false }
                try await pull()
            } else if !dirty {
                status = "Synced (revision \(syncedRevision))"
            }
            lastError = nil
        } catch {
            fail(error)
        }
    }

    private func pull() async throws {
        guard let store else { return }
        let (code, reply) = try await request("GET", "/api/project")
        guard code == 200, let obj = reply as? [String: Any], let rev = obj["revision"] as? Int,
              let dataObj = obj["data"] else { throw APIError(message: "Server returned HTTP \(code)") }
        let incoming = try JSONDecoder().decode(AppData.self, from: JSONSerialization.data(withJSONObject: dataObj))
        try await downloadAreaIfNeeded(incoming)
        try await downloadMissingAudio(incoming)
        let layoutChanged = incoming.plants != store.data.plants || incoming.controllers != store.data.controllers
        store.applyRemote(incoming)
        syncedRevision = rev
        dirty = false
        status = "Synced (revision \(rev))"
        // Placements edited on the website reach the controllers through this device.
        if layoutChanged { try? await store.uploadLayout(onlyIfChanged: true) }
    }

    private func revision() async throws -> Int {
        let (code, reply) = try await request("GET", "/api/revision")
        if code == 401 { throw APIError(message: "Wrong server password") }
        guard code == 200, let rev = (reply as? [String: Any])?["revision"] as? Int else {
            throw APIError(message: "Server returned HTTP \(code)")
        }
        return rev
    }

    // MARK: - Yard scan and music

    private func uploadAreaIfNeeded(_ d: AppData) async throws {
        guard let area = d.area else { return }
        let date = area.date.timeIntervalSinceReferenceDate
        guard date != areaSyncedDate, let bytes = try? Data(contentsOf: AreaStore.fileURL) else { return }
        status = "Uploading yard scan…"
        let (code, _) = try await request("PUT", "/api/area", body: bytes, timeout: 120)
        guard code == 200 else { throw APIError(message: "Yard scan upload failed (HTTP \(code))") }
        areaSyncedDate = date
    }

    private func downloadAreaIfNeeded(_ d: AppData) async throws {
        guard let area = d.area else { return }
        let date = area.date.timeIntervalSinceReferenceDate
        guard date != areaSyncedDate || !FileManager.default.fileExists(atPath: AreaStore.fileURL.path) else { return }
        status = "Downloading yard scan…"
        let (code, bytes) = try await requestData("GET", "/api/area", timeout: 120)
        guard code == 200 else { return }
        try bytes.write(to: AreaStore.fileURL, options: .atomic)
        areaSyncedDate = date
    }

    private func uploadMissingAudio(_ d: AppData) async throws {
        let names = Set(d.shows.compactMap { $0.audioFile })
        guard !names.isEmpty else { return }
        let (_, list) = try await request("GET", "/api/audio")
        let onServer = Set(((list as? [[String: Any]]) ?? []).compactMap { $0["name"] as? String })
        for name in names.subtracting(onServer) {
            guard let bytes = try? Data(contentsOf: AudioStore.url(for: name)) else { continue }
            status = "Uploading music…"
            _ = try await request("PUT", "/api/audio/\(name)", body: bytes, timeout: 300)
        }
    }

    private func downloadMissingAudio(_ d: AppData) async throws {
        for name in Set(d.shows.compactMap { $0.audioFile })
        where !FileManager.default.fileExists(atPath: AudioStore.url(for: name).path) {
            status = "Downloading music…"
            let (code, bytes) = try await requestData("GET", "/api/audio/\(name)", timeout: 300)
            if code == 200 { try bytes.write(to: AudioStore.url(for: name), options: .atomic) }
        }
    }

    // MARK: - HTTP

    private func url(_ path: String) throws -> URL {
        var base = serverURL.trimmingCharacters(in: .whitespaces)
        if !base.contains("://") { base = "http://" + base }
        while base.hasSuffix("/") { base.removeLast() }
        guard let u = URL(string: base + path) else { throw APIError(message: "Invalid server address") }
        return u
    }

    private func requestData(_ method: String, _ path: String, body: Data? = nil, contentType: String? = nil,
                             timeout: TimeInterval = 15) async throws -> (Int, Data) {
        var req = URLRequest(url: try url(path), timeoutInterval: timeout)
        req.httpMethod = method
        if !password.isEmpty { req.setValue("Bearer \(password)", forHTTPHeaderField: "Authorization") }
        if let body {
            req.httpBody = body
            req.setValue(contentType ?? "application/octet-stream", forHTTPHeaderField: "Content-Type")
        }
        let (data, resp) = try await URLSession.shared.data(for: req)
        return ((resp as? HTTPURLResponse)?.statusCode ?? 0, data)
    }

    private func request(_ method: String, _ path: String, json: Any? = nil, body: Data? = nil,
                         timeout: TimeInterval = 15) async throws -> (Int, Any?) {
        let (code, data) = try await requestData(method, path,
                                                 body: try json.map { try JSONSerialization.data(withJSONObject: $0) } ?? body,
                                                 contentType: json != nil ? "application/json" : nil, timeout: timeout)
        return (code, try? JSONSerialization.jsonObject(with: data))
    }

    private func fail(_ error: Error) {
        lastError = error.localizedDescription
        status = dirty ? "Not synced – changes waiting" : "Can't reach the server"
    }
}

/// Minimal Keychain storage for the server password.
enum Keychain {
    static func read(_ key: String) -> String? {
        let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrAccount as String: key,
                                kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
        var out: AnyObject?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let d = out as? Data else { return nil }
        return String(data: d, encoding: .utf8)
    }

    static func write(_ key: String, _ value: String) {
        let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrAccount as String: key]
        SecItemDelete(q as CFDictionary)
        guard !value.isEmpty else { return }
        var add = q
        add[kSecValueData as String] = Data(value.utf8)
        SecItemAdd(add as CFDictionary, nil)
    }
}
