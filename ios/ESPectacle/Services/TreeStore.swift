import Foundation
import SwiftUI
import simd

/// App state: the controllers, the plants they decorate, animation settings, plus
/// the orchestration that keeps every controller showing the same thing.
@MainActor
final class TreeStore: ObservableObject {
    @Published var data = AppData() {
        didSet {
            scheduleSave()
            if !applyingRemote { onLocalChange?() }
        }
    }
    /// Called after every change made on this device (not for copies pulled from the server).
    var onLocalChange: (() -> Void)?
    private var applyingRemote = false

    /// Replaces the project with a copy from the server without treating it as a local edit.
    func applyRemote(_ d: AppData) {
        applyingRemote = true
        data = d
        applyingRemote = false
        // Plants may have been moved, re-wired or drawn on the website: keep the controllers current.
        Task { try? await uploadLayout(onlyIfChanged: true) }
    }
    /// Latest info from controllers that answered the last status poll.
    @Published var online: [String: DeviceInfo] = [:]
    @Published var lastError: String?
    /// Set by ServerSync: tells the server the look just sent to the lights (online looks stream from it).
    var onLiveState: ((LightState) -> Void)?
    /// Set by ServerSync: a show started (id, wall-clock seconds of show time 0) or stopped (nil, nil).
    var onShowPlayback: ((UUID?, Double?) -> Void)?
    /// True while a show is open for editing: every controller is kept dark when not playing.
    var holdDark = false

    private var saveTask: Task<Void, Never>?
    private var pushTask: Task<Void, Never>?
    private var pollCount = 0

    private static var fileURL: URL {
        let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let url = dir.appendingPathComponent("espectacle.json")
        // Saved as treelights.json before the rename: carry it over once.
        let old = dir.appendingPathComponent("treelights.json")
        if !FileManager.default.fileExists(atPath: url.path), FileManager.default.fileExists(atPath: old.path) {
            try? FileManager.default.moveItem(at: old, to: url)
        }
        return url
    }

    init() {
        if let d = try? Data(contentsOf: Self.fileURL),
           let decoded = try? JSONDecoder().decode(AppData.self, from: d) {
            data = decoded
        }
    }

    private func scheduleSave() {
        saveTask?.cancel()
        let snapshot = data
        saveTask = Task {
            try? await Task.sleep(nanoseconds: 400_000_000)
            if Task.isCancelled { return }
            if let d = try? JSONEncoder().encode(snapshot) {
                try? d.write(to: Self.fileURL, options: .atomic)
            }
        }
    }

    // MARK: - Layout

    var totalLEDs: Int { data.controllers.reduce(0) { $0 + $1.totalLEDs } }

    /// Index of a controller's first LED in the tree-wide numbering.
    func baseIndex(of controllerID: String) -> Int {
        var base = 0
        for c in data.controllers {
            if c.id == controllerID { return base }
            base += c.totalLEDs
        }
        return base
    }

    func isOnline(_ c: Controller) -> Bool { online[c.id] != nil }

    // MARK: - Controllers

    /// Contacts a controller at `host` and adds it to the tree (or updates its address).
    func addController(host: String) async throws {
        let h = host.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !h.isEmpty else { throw APIError(message: "Enter an address") }
        let info = try await DeviceClient(host: h).info()
        online[info.id] = info
        if let i = data.controllers.firstIndex(where: { $0.id == info.id }) {
            data.controllers[i].host = h
            return
        }
        let strings = info.strings.map { LEDString(pin: $0.pin, count: $0.count, order: $0.order) }
        data.controllers.append(Controller(id: info.id, name: info.name, host: h,
                                           strings: strings, maxMilliamps: info.maxMilliamps ?? 2000))
        try? await DeviceClient(host: h).setState(data.state)
    }

    func removeController(_ c: Controller) {
        data.controllers.removeAll { $0.id == c.id }
        online[c.id] = nil
    }

    /// Writes name / string layout / current limit to the controller, then stores it locally.
    func saveController(_ c: Controller) async throws {
        let info = try await DeviceClient(host: c.host).setConfig(name: c.name, strings: c.strings,
                                                                  maxMilliamps: c.maxMilliamps)
        online[c.id] = info
        if let i = data.controllers.firstIndex(where: { $0.id == c.id }) {
            data.controllers[i] = c
        }
    }

    /// Controllers get new IP addresses from time to time; follow them using Bonjour results.
    func updateHosts(from found: [Discovery.Found]) {
        for f in found {
            if let i = data.controllers.firstIndex(where: { $0.id == f.id }),
               data.controllers[i].host != f.host {
                data.controllers[i].host = f.host
            }
        }
    }

    func refreshStatus() async {
        let list = data.controllers
        var result: [String: DeviceInfo] = [:]
        await withTaskGroup(of: (String, DeviceInfo?).self) { group in
            for c in list {
                group.addTask { (c.id, try? await DeviceClient(host: c.host).info()) }
            }
            for await (id, info) in group {
                if let info { result[id] = info }
            }
        }
        // A controller that has just come back (e.g. after a power cut) gets the current look again.
        let returned = list.filter { result[$0.id] != nil && online[$0.id] == nil }
        online = result
        for c in returned {
            if holdDark {
                try? await DeviceClient(host: c.host).stopShow(dark: true)
            } else {
                try? await DeviceClient(host: c.host).setState(data.state)
            }
        }
        // Without internet the controllers' clocks drift apart; nudge them now and then.
        pollCount += 1
        if pollCount % 12 == 0 {
            for c in list where result[c.id] != nil {
                try? await DeviceClient(host: c.host).syncClock()
            }
        }
    }

    // MARK: - Animation

    /// Call whenever `data.state` changes. Debounced so sliders don't flood the network.
    func stateChanged() {
        pushTask?.cancel()
        pushTask = Task {
            try? await Task.sleep(nanoseconds: 60_000_000)
            if Task.isCancelled { return }
            await pushState()
        }
    }

    func pushState() async {
        let state = data.state
        onLiveState?(state)
        let list = data.controllers
        var failures = 0
        await withTaskGroup(of: Bool.self) { group in
            for c in list {
                group.addTask {
                    do { try await DeviceClient(host: c.host).setState(state); return true }
                    catch { return false }
                }
            }
            for await ok in group where !ok { failures += 1 }
        }
        lastError = failures > 0 ? "\(failures) controller\(failures == 1 ? "" : "s") did not respond" : nil
    }

    // MARK: - Plants

    /// One of a plant's LED strings and where it lives.
    /// One run of a plant's LEDs: `count` LEDs from `start` on one string.
    struct PlantString {
        let controller: Controller
        let stringIndex: Int
        let string: LEDString
        let start: Int
        let count: Int
        var isWholeString: Bool { start == 0 && count == string.count }
    }

    /// A plant's LEDs in order: its LED ranges when it has them, otherwise the whole strings assigned to
    /// it (controller order, then string order). This is the scan / map order.
    /// Mirrors stringsOf() in server/shared/layout.ts.
    func strings(of plant: Plant) -> [PlantString] {
        var out: [PlantString] = []
        if let parts = plant.parts, !parts.isEmpty {
            for p in parts {
                guard let c = data.controllers.first(where: { $0.id == p.controller }),
                      c.strings.indices.contains(p.string) else { continue }
                let s = c.strings[p.string]
                let start = p.start.clamped(to: 0...s.count)
                let count = p.count.clamped(to: 0...(s.count - start))
                if count > 0 { out.append(PlantString(controller: c, stringIndex: p.string, string: s, start: start, count: count)) }
            }
            return out
        }
        for c in data.controllers {
            for (i, s) in c.strings.enumerated() where s.plantID == plant.id {
                out.append(PlantString(controller: c, stringIndex: i, string: s, start: 0, count: s.count))
            }
        }
        return out
    }

    func ledCount(of plant: Plant) -> Int { strings(of: plant).reduce(0) { $0 + $1.count } }

    /// Identifies the LEDs a scan was made with (whole strings keep the original "id/string/count" form).
    func layoutKey(of plant: Plant) -> [String] {
        strings(of: plant).map {
            $0.isWholeString ? "\($0.controller.id)/\($0.stringIndex)/\($0.count)"
                             : "\($0.controller.id)/\($0.stringIndex)/\($0.start)+\($0.count)"
        }
    }

    /// True when the prop has a map for the number of LEDs wired to it. A map belongs to the prop's LEDs in
    /// wiring order, not to particular controllers or strings, so rewiring the same LEDs keeps it.
    /// Mirrors mapIsCurrent() in server/shared/layout.ts.
    func mapIsCurrent(_ plant: Plant) -> Bool {
        guard let map = plant.map else { return false }
        let n = ledCount(of: plant)
        return n > 0 && n == map.leds.count
    }

    /// Fits a scan to the LEDs now wired to the prop: keeps the first (or last) positions, or adds unlocated
    /// LEDs at the end (or start), placed at the nearest scanned LED until a partial scan finds them.
    /// Mirrors fitMap() in server/shared/layout.ts.
    func fitMap(of plantID: UUID, keepStart: Bool) {
        guard let pi = data.plants.firstIndex(where: { $0.id == plantID }), var map = data.plants[pi].map else { return }
        let n = ledCount(of: data.plants[pi])
        guard n > 0, n != map.leds.count else { return }
        if map.leds.count > n {
            map.leds = keepStart ? Array(map.leds.prefix(n)) : Array(map.leds.suffix(n))
        } else {
            let edge = keepStart ? map.leds.last : map.leds.first
            let pad = Array(repeating: MappedLED(x: edge?.x ?? 0, y: edge?.y ?? 0, z: edge?.z ?? 0, quality: .unknown),
                            count: n - map.leds.count)
            map.leds = keepStart ? map.leds + pad : pad + map.leds
        }
        map.layout = layoutKey(of: data.plants[pi])
        data.plants[pi].map = map
    }

    /// The same LEDs, now wired from the other end.
    func reverseMap(of plantID: UUID) {
        guard let pi = data.plants.firstIndex(where: { $0.id == plantID }) else { return }
        data.plants[pi].map?.leds.reverse()
    }

    /// Which plant each LED of a controller belongs to (nil: none). Later plants win any overlap.
    /// Mirrors ledOwners() in server/shared/layout.ts.
    func ledOwners() -> [String: [UUID?]] {
        var owners: [String: [UUID?]] = [:]
        var firstLED: [String: [Int]] = [:]
        for c in data.controllers {
            var n = 0
            firstLED[c.id] = c.strings.map { s in defer { n += s.count }; return n }
            owners[c.id] = Array(repeating: nil, count: n)
        }
        for plant in data.plants {
            for ps in strings(of: plant) {
                let first = firstLED[ps.controller.id]?[ps.stringIndex] ?? 0
                for i in 0..<ps.count { owners[ps.controller.id]?[first + ps.start + i] = plant.id }
            }
        }
        return owners
    }

    /// LEDs that aren't on any plant.
    var unassignedLEDs: Int { ledOwners().values.reduce(0) { $0 + $1.filter { $0 == nil }.count } }

    /// Names of other plants that claim some of this plant's LEDs.
    func overlaps(of plant: Plant) -> [String] {
        func keys(_ p: Plant) -> Set<String> {
            var k = Set<String>()
            for ps in strings(of: p) { for i in 0..<ps.count { k.insert("\(ps.controller.id)/\(ps.stringIndex)/\(ps.start + i)") } }
            return k
        }
        let mine = keys(plant)
        guard !mine.isEmpty else { return [] }
        return data.plants.filter { $0.id != plant.id && !keys($0).isDisjoint(with: mine) }.map { $0.name }
    }

    /// True when every LED belongs to a plant with an up-to-date map.
    var layoutComplete: Bool {
        guard !data.controllers.isEmpty else { return false }
        return unassignedLEDs == 0 && data.plants.allSatisfy { ledCount(of: $0) == 0 || mapIsCurrent($0) }
    }

    /// A drawn plant (grid, cone, arch...), ready to be wired with LED ranges.
    @discardableResult
    func addShapePlant(_ kind: ShapeKind) -> Plant {
        let shape = PlantShape(kind: kind)
        let base = kind.name.components(separatedBy: " ").first ?? "Shape"
        var plant = Plant(name: "\(base) \(data.plants.count + 1)")
        plant.shape = shape
        plant.map = ShapeGenerator.map(for: shape)
        plant.parts = []
        data.plants.append(plant)
        return plant
    }

    /// A copy of a plant with the same shape, half a metre to the right. It needs its own LEDs (a string
    /// belongs to one plant), so it starts unwired; its shape stays valid on whatever LEDs it gets.
    @discardableResult
    func clonePlant(_ id: UUID) -> Plant? {
        guard let i = data.plants.firstIndex(where: { $0.id == id }) else { return nil }
        var copy = data.plants[i]
        copy.id = UUID()
        copy.name = "\(copy.name) copy"
        copy.x += 0.5
        copy.parts = []
        copy.map?.portable = true
        data.plants.insert(copy, at: i + 1)
        return copy
    }

    /// The next free LEDs (after every other plant's) on the first string with room.
    func nextFreePart(for plant: Plant) -> PlantPart? {
        let owners = ledOwners()
        let want = max(1, (plant.map?.leds.count ?? 0) - ledCount(of: plant))
        for c in data.controllers {
            guard let own = owners[c.id] else { continue }
            var first = 0
            for (si, s) in c.strings.enumerated() {
                var lastUsed = -1
                for i in 0..<s.count where own[first + i] != nil && own[first + i] != plant.id { lastUsed = i }
                if lastUsed < s.count - 1 {
                    return PlantPart(controller: c.id, string: si, start: lastUsed + 1, count: min(want, s.count - lastUsed - 1))
                }
                first += s.count
            }
        }
        return data.controllers.first.map { PlantPart(controller: $0.id, string: 0, start: 0, count: want) }
    }

    @discardableResult
    func addPlant() -> Plant {
        let plant = Plant(name: "Prop \(data.plants.count + 1)")
        data.plants.append(plant)
        return plant
    }

    func removePlant(_ id: UUID) {
        data.plants.removeAll { $0.id == id }
        for ci in data.controllers.indices {
            for si in data.controllers[ci].strings.indices where data.controllers[ci].strings[si].plantID == id {
                data.controllers[ci].strings[si].plantID = nil
            }
        }
    }

    func setPlant(_ plantID: UUID?, controllerID: String, stringIndex: Int) {
        guard let ci = data.controllers.firstIndex(where: { $0.id == controllerID }),
              data.controllers[ci].strings.indices.contains(stringIndex) else { return }
        data.controllers[ci].strings[stringIndex].plantID = plantID
    }

    /// Stores a finished scan for one plant and refreshes every controller's geometry.
    func setMap(_ map: PlantMap, for plantID: UUID) async throws {
        guard let i = data.plants.firstIndex(where: { $0.id == plantID }) else { return }
        data.plants[i].map = map
        try await uploadLayout()
    }

    // MARK: - Yard layout

    /// A mapped LED placed in the yard.
    fileprivate struct Placed {
        var controllerID: String
        var index: Int                  // LED index within its controller
        var yard: SIMD3<Float>          // metres, yard space
        var local: SIMD3<Float>         // metres, plant space after the plant's rotation
        var plantHeight: Float
        var plantRadius: Float
        var quality: MapQuality
        var rescan: Bool?
        var plantID: UUID
        var ledIndex: Int               // index within the plant's map
    }

    fileprivate func placedLEDs() -> [Placed] {
        var firstLED: [String: [Int]] = [:]     // controller id -> first LED index of each string
        for c in data.controllers {
            var n = 0
            firstLED[c.id] = c.strings.map { s in defer { n += s.count }; return n }
        }
        var out: [Placed] = []
        for plant in data.plants where mapIsCurrent(plant) {
            guard let map = plant.map else { continue }
            let th = plant.rotation * .pi / 180
            let cs = cos(th), sn = sin(th)
            var k = 0
            for ps in strings(of: plant) {
                let first = firstLED[ps.controller.id]?[ps.stringIndex] ?? 0
                for i in 0..<ps.count {
                    guard k < map.leds.count else { break }
                    let m = map.leds[k]
                    k += 1
                    let local = SIMD3<Float>(m.x * cs + m.z * sn, m.y, -m.x * sn + m.z * cs)
                    out.append(Placed(controllerID: ps.controller.id, index: first + ps.start + i,
                                      yard: local + SIMD3<Float>(plant.x, plant.y, plant.z), local: local,
                                      plantHeight: max(map.height, 0.01), plantRadius: max(map.radius, 0.01),
                                      quality: m.quality, rescan: m.rescan, plantID: plant.id, ledIndex: k - 1))
                }
            }
        }
        return out
    }

    /// Flags or un-flags a green LED as needing to be located again.
    func toggleRescan(plant plantID: UUID, led: Int) {
        guard let pi = data.plants.firstIndex(where: { $0.id == plantID }),
              let leds = data.plants[pi].map?.leds, leds.indices.contains(led),
              leds[led].quality == .triangulated else { return }
        data.plants[pi].map?.leds[led].rescan = leds[led].rescan == true ? nil : true
    }

    /// The yard turned so that its front (the street) is +Z, as the controllers see it.
    /// Mirrors controllerSpace() in server/shared/layout.ts.
    fileprivate func controllerSpace(_ placed: [Placed]) -> [Placed] {
        let front = data.yard?.front ?? 0
        guard front != 0, front.isFinite else { return placed }
        let th = front * .pi / 180
        let cs = cos(th), sn = sin(th)
        return placed.map { p in
            var q = p
            q.yard = SIMD3<Float>(p.yard.x * cs - p.yard.z * sn, p.yard.y, p.yard.x * sn + p.yard.z * cs)
            return q
        }
    }

    /// Every mapped LED in yard space, recentred for the 3D preview, and which plant LED each point is.
    /// Turned so the street is at the front (the white dot).
    func yardPreview() -> (cloud: PreviewCloud, refs: [(plant: UUID, led: Int)])? {
        let placed = controllerSpace(placedLEDs())
        guard let first = placed.first else { return nil }
        var lo = first.yard, hi = first.yard
        for p in placed { lo = simd_min(lo, p.yard); hi = simd_max(hi, p.yard) }
        let cx = (lo.x + hi.x) / 2, cz = (lo.z + hi.z) / 2
        let pts = placed.map {
            MappedLED(x: $0.yard.x - cx, y: $0.yard.y - lo.y, z: $0.yard.z - cz, quality: $0.quality, rescan: $0.rescan)
        }
        let cloud = PreviewCloud(points: pts, height: max(hi.y - lo.y, 0.1),
                                 radius: max(max(hi.x - lo.x, hi.z - lo.z) / 2, 0.1))
        return (cloud, placed.map { (plant: $0.plantID, led: $0.ledIndex) })
    }

    /// Show zone for each plant: its position in the plant list. LEDs on no plant use `Self.otherZone`.
    nonisolated static let maxZones = 32
    nonisolated static let otherZone = 31

    nonisolated static func zone(ofPlantAt index: Int) -> Int { min(index, otherZone - 1) }

    /// Works out each LED's geometry from the plant maps and placements and sends it to the controllers.
    /// Position effects (sweep, plasma, pulse) use the yard position; spiral, beam, gradient and the
    /// like use the LED's place on its own plant. Each LED also carries its plant's zone for shows.
    /// With `onlyIfChanged`, controllers that already hold this exact geometry are skipped.
    func uploadLayout(onlyIfChanged: Bool = false) async throws {
        let placed = controllerSpace(placedLEDs())
        var errors: [String] = []

        // Zone of every LED: its plant's position in the list (LEDs on no plant use the "other" zone).
        let plantIndex = Dictionary(data.plants.enumerated().map { ($1.id, $0) }, uniquingKeysWith: { a, _ in a })
        let owners = ledOwners()

        guard let yard = yardScale(placed) else {
            for c in data.controllers { try? await DeviceClient(host: c.host).clearPositions() }
            return
        }
        let centre = yard.centre
        let maxDist = max(placed.map { simd_distance($0.yard, centre) }.max() ?? 0, 0.05)

        func u16(_ v: Float) -> Int { Int((v * 65535).rounded().clamped(to: 0...65535)) }
        func q12(_ v: Float) -> Int { yard.q12(v) }

        // Each plant's box, so a show track can animate every plant on its own.
        var zoneFrames: [Int] = []
        for z in 0..<Self.maxZones {
            let ids = Set(data.plants.indices.filter { Self.zone(ofPlantAt: $0) == z && z != Self.otherZone }
                .map { data.plants[$0].id })
            zoneFrames += frame(of: placed.filter { ids.contains($0.plantID) }, yard: yard)
        }

        // Start with a neutral guess for LEDs that aren't on a mapped plant, then fill in the real ones.
        var geo: [String: [[Int]]] = [:]
        for c in data.controllers {
            var list: [[Int]] = []
            let own = owners[c.id] ?? []
            for s in c.strings {
                for i in 0..<s.count {
                    let owner = list.count < own.count ? own[list.count] : nil
                    let zone = owner.flatMap { plantIndex[$0] }.map { Self.zone(ofPlantAt: $0) } ?? Self.otherZone
                    list.append([0, 0, 0, s.count > 1 ? i * 65535 / (s.count - 1) : 0, (i * 2185) & 0xFFFF, 32768, 0, zone])
                }
            }
            geo[c.id] = list
        }
        for p in placed {
            guard geo[p.controllerID]?.indices.contains(p.index) == true else { continue }
            let d = p.yard - centre
            var ang = atan2(p.local.z, p.local.x) / (2 * .pi)
            if ang < 0 { ang += 1 }
            let zone = geo[p.controllerID]?[p.index][7] ?? Self.otherZone
            geo[p.controllerID]?[p.index] = [
                q12(d.x), q12(d.y), q12(d.z),
                u16(p.local.y / p.plantHeight),
                Int(ang * 65536) & 0xFFFF,
                u16((p.local.x * p.local.x + p.local.z * p.local.z).squareRoot() / p.plantRadius),
                u16(simd_length(d) / maxDist),
                zone,
            ]
        }

        for c in data.controllers {
            guard let list = geo[c.id], !list.isEmpty else { continue }
            let base = baseIndex(of: c.id)
            var hash = FNV1a()
            hash.add(base)
            for g in list { for v in g { hash.add(v) } }
            for v in zoneFrames { hash.add(v) }
            let id = max(hash.value, 1)
            if onlyIfChanged, online[c.id]?.geoId == id { continue }
            do {
                let legacy = online[c.id].map { !$0.supportsShows } ?? false
                try await DeviceClient(host: c.host).uploadGeometry(list, baseIndex: base, id: id,
                                                                     zoneFrames: zoneFrames, legacy: legacy)
                online[c.id]?.geoId = id
            } catch {
                errors.append("\(c.name): \(error.localizedDescription)")
            }
        }
        if !errors.isEmpty { throw APIError(message: errors.joined(separator: "\n")) }
    }
}

extension TreeStore {
    /// How yard positions are scaled for the controllers: centred on the layout, with the
    /// largest half-extent mapped to 2048 (see `Geo` in effects.h).
    struct YardScale {
        var centre: SIMD3<Float>
        var half: Float
        func q12(_ v: Float) -> Int { Int((v / half * 2048).rounded().clamped(to: -32767...32767)) }
        func q12(_ p: SIMD3<Float>) -> SIMD3<Float> {
            let d = (p - centre) / half * 2048
            return simd_clamp(d, SIMD3(repeating: -32767), SIMD3(repeating: 32767))
        }
    }

    fileprivate func yardScale(_ placed: [Placed]) -> YardScale? {
        guard let first = placed.first else { return nil }
        var lo = first.yard, hi = first.yard
        for p in placed { lo = simd_min(lo, p.yard); hi = simd_max(hi, p.yard) }
        return YardScale(centre: (lo + hi) / 2, half: max(simd_reduce_max(hi - lo) / 2, 0.05))
    }

    /// A box around some LEDs in controller units (see `Frame` in effects.h):
    /// centre x, y, z, half the largest extent, bottom, height, radius.
    fileprivate func frame(of leds: [Placed], yard: YardScale) -> [Int] {
        guard let first = leds.first else { return [0, 0, 0, 2048, -2048, 4096, 2048] }
        var lo = yard.q12(first.yard), hi = lo
        for p in leds { let q = yard.q12(p.yard); lo = simd_min(lo, q); hi = simd_max(hi, q) }
        let c = (lo + hi) / 2
        var radius: Float = 16
        for p in leds {
            let q = yard.q12(p.yard)
            radius = max(radius, ((q.x - c.x) * (q.x - c.x) + (q.z - c.z) * (q.z - c.z)).squareRoot())
        }
        func i(_ v: Float) -> Int { Int(v.rounded()).clamped(to: -32767...32767) }
        return [i(c.x), i(c.y), i(c.z), i(max(simd_reduce_max(hi - lo) / 2, 64)), i(lo.y), i(max(hi.y - lo.y, 16)), i(radius)]
    }

    /// The box around a group of plants (empty: every plant), for tracks that treat them as one.
    func groupFrame(_ plants: [UUID]) -> [Int] {
        let placed = controllerSpace(placedLEDs())
        guard let yard = yardScale(placed) else { return [0, 0, 0, 2048, -2048, 4096, 2048] }
        let ids = Set(plants)
        return frame(of: plants.isEmpty ? placed : placed.filter { ids.contains($0.plantID) }, yard: yard)
    }
}

extension TreeStore {
    /// Every scanned plant as an xLights model source (positions after the plant's rotation, around
    /// its own base), plus one model of the whole yard with every plant in place.
    func xlightsSources() -> (plants: [XLightsExport.ModelSource], yard: XLightsExport.ModelSource?) {
        let placed = placedLEDs()
        var plants: [XLightsExport.ModelSource] = []
        var yardPoints: [SIMD3<Float>] = []
        var yardStrings: [XLightsExport.StringPart] = []
        for plant in data.plants where mapIsCurrent(plant) {
            let mine = placed.filter { $0.plantID == plant.id }.sorted { $0.ledIndex < $1.ledIndex }
            guard !mine.isEmpty else { continue }
            var parts: [XLightsExport.StringPart] = []
            for ps in strings(of: plant) {
                let first = ps.controller.strings.prefix(ps.stringIndex).reduce(0) { $0 + $1.count } + ps.start
                parts.append(.init(count: ps.count, controller: ps.controller.name, startChannel: first * 3 + 1))
            }
            plants.append(.init(name: plant.name, points: mine.map { $0.local }, strings: parts))
            yardPoints += mine.map { $0.yard }
            yardStrings += parts
        }
        let yard = yardPoints.isEmpty ? nil
            : XLightsExport.ModelSource(name: "ESPectacle Yard", points: yardPoints, strings: yardStrings)
        return (plants, yard)
    }
}

/// Small, stable 32-bit hash used to tell whether a controller already holds some data.
struct FNV1a {
    private(set) var value: UInt32 = 2_166_136_261
    mutating func add(_ v: Int) {
        var x = UInt64(bitPattern: Int64(v))
        for _ in 0..<8 {
            value = (value ^ UInt32(x & 0xFF)) &* 16_777_619
            x >>= 8
        }
    }
}

extension Comparable {
    func clamped(to r: ClosedRange<Self>) -> Self { min(max(self, r.lowerBound), r.upperBound) }
}
