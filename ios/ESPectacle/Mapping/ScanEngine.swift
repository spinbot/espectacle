import ARKit
import SceneKit
import SwiftUI

/// One LED to be located: its index within the plant being scanned and how to light it.
struct ScanTarget {
    let global: Int
    let host: String
    let string: Int
    let index: Int
}

struct ScanSettings: Equatable {
    var ledValue = 96                    // brightness of the LED being located (1..255)
    var settle: TimeInterval = 0.08      // wait after the controller confirms, before trusting a frame
    var threshold = 45                   // minimum brightness jump (0..255) to count as "seen"
    var maxStepCm: Double = 10           // neighbouring LEDs further apart than this are treated as bad
    var flash = false                    // blink each LED three times and only accept sightings that repeat
}

struct ScanSummary: Equatable {
    var total = 0
    var triangulated = 0
    var lidar = 0
    var interpolated = 0
    var missing = 0
    var measured: Int { triangulated + lidar }
}

/// Locates LEDs in 3D.
///
/// ARKit tracks the phone's position while the controllers light one LED at a
/// time. Each LED shows up as a bright spot in the difference between two
/// consecutive camera frames; that spot becomes a ray in world space, and
/// (with LiDAR) a depth along it. Passes from several sides of the plant are
/// combined by `Solver`. One plant is scanned at a time; every other LED stays dark.
final class ScanEngine: NSObject, ObservableObject, ARSessionDelegate {
    // MARK: UI state (main thread)
    @Published var passRunning = false
    @Published var progress: Double = 0
    @Published var passCount = 0
    @Published var seenThisPass = 0
    @Published var summary = ScanSummary()
    @Published var trackingOK = false
    @Published var trackingMessage = "Starting camera…"
    @Published var errorMessage: String?
    @Published var settings = ScanSettings()
    @Published var resultsReady = false         // something has been located or placed this session
    @Published var manualIndex: Int?            // LED being placed by hand (nil: not in manual mode)
    @Published var manualQuality: MapQuality = .unknown

    let hasLiDAR = ARWorldTrackingConfiguration.supportsFrameSemantics(.sceneDepth)
    let sceneView: ARSCNView
    private let overlay = SCNNode()
    private var markerLEDs: [(node: SCNNode, led: Int, measured: Bool)] = []    // main thread only
    private var lastPoints: [SolvedLED?] = []       // latest world-space estimates (main thread only)
    private let cursorNode = SCNNode()              // the marker being dragged in manual mode
    private var manualHost: String?                 // controller whose LED is lit in manual mode
    private var mainTargets: [ScanTarget] = []      // main-thread copy of the targets
    private var sessionHosts: [String] = []

    // MARK: Scan state (confined to `queue`)
    private let queue = DispatchQueue(label: "espectacle.scan", qos: .userInitiated)
    private enum Step {
        case idle
        case waitingAck
        case settling(until: TimeInterval)
    }
    private var step = Step.idle
    private var targets: [ScanTarget] = []
    private var stringRanges: [Range<Int>] = []
    private var hosts: [String] = []         // controllers with LEDs on this plant
    private var otherHosts: [String] = []    // the rest: kept dark while scanning
    private var previous: [MappedLED] = []   // the plant's saved map when topping it up (else empty)
    private var keep = Set<Int>()            // saved LEDs whose positions are kept as they are
    private var skip = Set<Int>()            // kept LEDs that aren't lit at all (the rest are anchors)
    private var alignment: Solver.Alignment? // this session's world space -> the saved map's space
    private var order: [Int] = []
    private var cursor = 0
    private var current: ScanTarget?        // LED lit right now; nil while capturing the dark reference
    private var litHost: String?
    private var prev = [UInt8]()
    private var cur = [UInt8]()
    private var havePrev = false
    private var observations: [[Observation]] = []
    private var solved: [SolvedLED?] = []
    private var pass = 0
    private var seen = 0
    private var viewer: SIMD3<Float>?
    private var cancelled = false
    private var qSettings = ScanSettings()
    private var frameCount = 0
    private var lastTrackingText = ""
    private var manual: [Int: SIMD3<Float>] = [:]   // positions set by hand (world space)
    private var pendingLED = -1                     // flash mode: sightings of one LED awaiting agreement
    private var pending: [Observation] = []

    private static let lumaStride = 2       // analyse every 2nd pixel in each direction

    /// Create on the main thread (it owns a view).
    @MainActor
    init(frame: CGRect = .zero) {
        sceneView = ARSCNView(frame: frame)
        super.init()
        sceneView.addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(handleTap(_:))))
        sceneView.addGestureRecognizer(UIPanGestureRecognizer(target: self, action: #selector(handlePan(_:))))
    }

    // MARK: - Session

    @MainActor
    /// `allHosts` is every controller in the yard, so LEDs on other plants can be switched off.
    ///
    /// To top up a saved map, pass it as `previous` with the indices to `keep`. Kept LEDs are not
    /// scanned again, except for a few spread-out "anchors" that are located in this session too
    /// so the new measurements can be lined up with the saved ones.
    func startSession(targets: [ScanTarget], strings: [Range<Int>], allHosts: [String],
                      previous: [MappedLED] = [], keep: Set<Int> = []) {
        let topUp = previous.count == targets.count && keep.count >= 4
        let keepSet = topUp ? keep : []
        var anchors = Set<Int>()
        let sortedKeep = keepSet.sorted()
        let wanted = min(24, sortedKeep.count)
        for k in 0..<wanted { anchors.insert(sortedKeep[k * sortedKeep.count / wanted]) }
        let skipSet = keepSet.subtracting(anchors)

        mainTargets = targets
        let hostList = Array(Set(targets.map { $0.host }))
        let others = Array(Set(allHosts).subtracting(hostList))
        sessionHosts = hostList + others
        queue.sync {
            self.targets = targets
            self.stringRanges = strings
            self.hosts = hostList
            self.otherHosts = others
            self.previous = topUp ? previous : []
            self.keep = keepSet
            self.skip = skipSet
            self.alignment = nil
            self.manual = [:]
            self.pending = []
            self.pendingLED = -1
            self.observations = Array(repeating: [], count: targets.count)
            self.solved = []
            self.pass = 0
            self.viewer = nil
            self.step = .idle
            self.cancelled = false
        }
        passRunning = false
        passCount = 0
        resultsReady = false
        manualIndex = nil
        lastPoints = []
        if cursorNode.parent == nil {
            let g = SCNSphere(radius: 0.018)
            let m = SCNMaterial()
            m.lightingModel = .constant
            m.diffuse.contents = UIColor.white
            g.materials = [m]
            cursorNode.geometry = g
            cursorNode.renderingOrder = 10
            sceneView.scene.rootNode.addChildNode(cursorNode)
        }
        cursorNode.isHidden = true
        summary = ScanSummary(total: targets.count, triangulated: keepSet.count, missing: targets.count - keepSet.count)
        errorMessage = nil

        if overlay.parent == nil { sceneView.scene.rootNode.addChildNode(overlay) }
        overlay.childNodes.forEach { $0.removeFromParentNode() }
        sceneView.session.delegate = self
        sceneView.session.delegateQueue = queue

        let config = ARWorldTrackingConfiguration()
        if hasLiDAR { config.frameSemantics.insert(.sceneDepth) }
        sceneView.session.run(config, options: [.resetTracking, .removeExistingAnchors])
        UIApplication.shared.isIdleTimerDisabled = true

        let everyHost = sessionHosts
        Task {
            for h in everyHost { try? await DeviceClient(host: h).setScan(true) }
        }
    }

    @MainActor
    func stopSession() {
        manualIndex = nil
        cursorNode.isHidden = true
        queue.sync {
            self.cancelled = true
            self.step = .idle
        }
        sceneView.session.pause()
        UIApplication.shared.isIdleTimerDisabled = false
        let hostList = sessionHosts
        Task {
            for h in hostList { try? await DeviceClient(host: h).setScan(false) }
        }
    }

    // MARK: - Passes

    /// Lights every LED once and records where the camera sees it from the current viewpoint.
    @MainActor
    func startPass() {
        guard !passRunning, manualIndex == nil else { return }
        passRunning = true
        progress = 0
        seenThisPass = 0
        errorMessage = nil
        let s = settings
        queue.async {
            self.qSettings = s
            self.cancelled = false
            self.seen = 0
            self.havePrev = false
            // Only LEDs that still need locating: not kept from the saved map, and not
            // already seen from two sides in this session.
            let todo = (0..<self.targets.count).filter { i in
                if self.skip.contains(i) { return false }
                if i < self.solved.count, self.solved[i]?.quality == .triangulated { return false }
                return true
            }
            guard !todo.isEmpty else {
                Task { @MainActor in
                    self.passRunning = false
                    self.errorMessage = "Every LED is already located from two sides."
                }
                return
            }
            if s.flash {
                // dark, lit, dark, lit, dark, lit for each LED; -1 means "all dark"
                self.order = todo.flatMap { [-1, $0, -1, $0, -1, $0] }
            } else {
                self.order = todo       // step along the wire in order
            }
            self.pending = []
            self.pendingLED = -1
            self.cursor = -1
            self.current = nil
            self.allOff { ok in
                if ok { self.settle() } else { self.endPass(error: "Could not reach this prop's controller. Check it is powered and on WiFi.") }
            }
        }
    }

    func cancelPass() {
        queue.async { self.cancelled = true }
    }

    private func allOff(_ done: @escaping (Bool) -> Void) {
        step = .waitingAck
        litHost = nil
        let hostList = hosts, others = otherHosts
        Task {
            var ok = true
            for h in hostList {
                do { try await DeviceClient(host: h).solo(string: 0, index: -1, value: 1) } catch { ok = false }
            }
            // Other plants' controllers: best effort (this also keeps them in scan mode).
            for h in others { try? await DeviceClient(host: h).solo(string: 0, index: -1, value: 1) }
            self.queue.async { done(ok) }
        }
    }

    private func settle() {
        step = .settling(until: ProcessInfo.processInfo.systemUptime + qSettings.settle)
    }

    private func advance() {
        cursor += 1
        if cursor % 5 == 0 || cursor >= order.count {
            let p = Double(cursor) / Double(max(1, order.count)), s = seen
            Task { @MainActor in
                self.progress = min(1, p)
                self.seenThisPass = s
            }
        }
        guard cursor < order.count else {
            endPass(error: nil)
            return
        }
        let k = order[cursor]
        if k >= 0 && k != pendingLED { flushPending() }
        light(k >= 0 ? targets[k] : nil, attempt: 1)
    }

    /// Flash mode: an LED only counts as seen if at least two of its blinks were detected
    /// in the same direction. Camera shake and passing reflections don't repeat like that.
    private func flushPending() {
        defer { pending = [] }
        guard pendingLED >= 0, pending.count >= 2 else { return }
        let limit = cos(Float(0.6) * .pi / 180)
        var bestGroup: [Observation] = []
        for a in pending {
            let group = pending.filter { simd_dot($0.dir, a.dir) >= limit }
            if group.count > bestGroup.count { bestGroup = group }
        }
        guard bestGroup.count >= 2 else { return }
        let n = Float(bestGroup.count)
        var o = bestGroup[0]
        o.origin = bestGroup.reduce(SIMD3<Float>(repeating: 0)) { $0 + $1.origin } / n
        o.dir = simd_normalize(bestGroup.reduce(SIMD3<Float>(repeating: 0)) { $0 + $1.dir })
        o.lidar = bestGroup.compactMap { $0.lidar }.first
        observations[pendingLED].append(o)
        seen += 1
    }

    /// Lights one LED, or with nil makes everything dark (used as the reference frame in flash mode).
    private func light(_ t: ScanTarget?, attempt: Int) {
        step = .waitingAck
        let previousHost = litHost
        let value = qSettings.ledValue
        let everyHost = hosts
        Task {
            var ok = true
            do {
                if let t {
                    if let p = previousHost, p != t.host {
                        try await DeviceClient(host: p).solo(string: 0, index: -1, value: 1)
                    }
                    try await DeviceClient(host: t.host).solo(string: t.string, index: t.index, value: value)
                } else {
                    for h in (previousHost.map { [$0] } ?? everyHost) {
                        try await DeviceClient(host: h).solo(string: 0, index: -1, value: 1)
                    }
                }
            } catch {
                ok = false
            }
            self.queue.async {
                if self.cancelled {
                    self.endPass(error: nil)
                } else if ok {
                    self.current = t
                    if let t { self.litHost = t.host }
                    self.settle()
                } else if attempt < 3 {
                    self.light(t, attempt: attempt + 1)
                } else {
                    self.endPass(error: "Lost contact with a controller during the scan.")
                }
            }
        }
    }

    private func endPass(error: String?) {
        guard !isIdle else { return }
        step = .idle
        current = nil
        flushPending()
        pendingLED = -1
        if seen > 0 { pass += 1 }
        let hostList = hosts
        Task {
            for h in hostList { try? await DeviceClient(host: h).solo(string: 0, index: -1, value: 1) }
        }

        publishResults(error: error)
    }

    /// Re-solves everything seen so far and updates the summary and the markers.
    private func publishResults(error: String?) {
        var error = error
        let result = Solver.solveAll(observations, strings: stringRanges,
                                     maxStep: Float(qSettings.maxStepCm / 100), fixed: manual)
        solved = result.leds
        if result.limitIgnored && error == nil {
            error = "Most LEDs measured further apart than the \(Int(qSettings.maxStepCm)) cm neighbour limit, so it was ignored. Raise the limit in the scan settings if your LEDs are spaced wider."
        }
        if !keep.isEmpty {
            // Line this session up with the saved map using kept LEDs that were located again.
            var pairs: [(world: SIMD3<Float>, local: SIMD3<Float>)] = []
            for i in keep.sorted() {
                if let s = solved[i], s.quality != .interpolated {
                    let m = previous[i]
                    pairs.append((s.p, SIMD3<Float>(m.x, m.y, m.z)))
                }
            }
            alignment = Solver.align(pairs)
        }
        var sum = ScanSummary(total: targets.count)
        var points: [SolvedLED?] = solved       // world space, for the markers over the camera view
        for i in solved.indices {
            if keep.contains(i) {
                sum.triangulated += 1
                if let al = alignment {
                    let m = previous[i]
                    points[i] = SolvedLED(p: al.toWorld(SIMD3<Float>(m.x, m.y, m.z)), quality: .triangulated)
                }
                continue
            }
            switch solved[i]?.quality {
            case .triangulated: sum.triangulated += 1
            case .lidar: sum.lidar += 1
            case .interpolated: sum.interpolated += 1
            default: sum.missing += 1
            }
        }
        let overlayPoints = points, total = sum, passes = pass, s = seen, message = error
        Task { @MainActor in
            self.passRunning = false
            self.passCount = passes
            self.seenThisPass = s
            self.progress = 0
            self.summary = total
            self.errorMessage = message
            self.resultsReady = true
            self.lastPoints = overlayPoints
            self.updateOverlay(overlayPoints)
            if let i = self.manualIndex, overlayPoints.indices.contains(i) {
                self.manualQuality = overlayPoints[i]?.quality ?? .unknown
            }
        }
    }

    private var isIdle: Bool {
        if case .idle = step { return true }
        return false
    }

    // MARK: - Result

    enum MapResult {
        case map(PlantMap)
        case failure(String)
    }

    /// The finished map in the plant's own space.
    func buildMap(layout: [String]) -> MapResult {
        queue.sync { () -> MapResult in
            if keep.isEmpty {
                // Fresh scan: the plant's space is defined by this session.
                guard let ts = Solver.treeSpace(solved, viewer: viewer) else {
                    return .failure("No LEDs were located.")
                }
                let leds = ts.points.map { s in
                    MappedLED(x: s?.p.x ?? 0, y: s?.p.y ?? ts.height / 2, z: s?.p.z ?? 0,
                              quality: s?.quality ?? MapQuality.unknown)
                }
                return .map(PlantMap(height: ts.height, radius: ts.radius, layout: layout, leds: leds))
            }

            // Top-up: keep the saved positions and bring the new ones into the same space.
            guard let al = alignment else {
                return .failure("Couldn't line this scan up with the saved positions. At least 4 of the LEDs that were already good need to be found again – scan from a side where some are visible, or use “Scan everything again”.")
            }
            var merged: [SolvedLED?] = (0..<targets.count).map { i in
                let old = previous[i]
                if keep.contains(i) {
                    return SolvedLED(p: SIMD3<Float>(old.x, old.y, old.z), quality: .triangulated)
                }
                if i < solved.count, let s = solved[i], s.quality != .interpolated {
                    return SolvedLED(p: al.toLocal(s.p), quality: s.quality)
                }
                if old.quality == .lidar {      // not found this time: the old LiDAR fix beats a guess
                    return SolvedLED(p: SIMD3<Float>(old.x, old.y, old.z), quality: .lidar)
                }
                return nil
            }
            // A newly located LED must be within reach of the kept LEDs either side of it on the wire.
            let maxStep = Float(qSettings.maxStepCm / 100)
            for range in stringRanges {
                for i in range where !keep.contains(i) && manual[i] == nil {
                    guard let s = merged[i] else { continue }
                    for step in [-1, 1] {
                        var k = i + step
                        while range.contains(k), !keep.contains(k) { k += step }
                        guard range.contains(k), let anchor = merged[k] else { continue }
                        if simd_distance(s.p, anchor.p) > maxStep * Float(abs(k - i)) {
                            merged[i] = nil
                            break
                        }
                    }
                }
            }
            Solver.fillGaps(&merged, strings: stringRanges)

            var height: Float = 0.1, radius: Float = 0.05
            for case let s? in merged {
                height = max(height, s.p.y)
                radius = max(radius, (s.p.x * s.p.x + s.p.z * s.p.z).squareRoot())
            }
            let leds = merged.map { s in
                MappedLED(x: s?.p.x ?? 0, y: max(0, s?.p.y ?? height / 2), z: s?.p.z ?? 0,
                          quality: s?.quality ?? MapQuality.unknown)
            }
            return .map(PlantMap(height: height, radius: radius, layout: layout, leds: leds))
        }
    }

    /// Small markers drawn over the camera view where each LED was located.
    @MainActor
    private func updateOverlay(_ points: [SolvedLED?]) {
        overlay.childNodes.forEach { $0.removeFromParentNode() }
        markerLEDs = []
        func marker(_ color: UIColor) -> SCNGeometry {
            let g = SCNSphere(radius: 0.012)
            g.segmentCount = 8
            let m = SCNMaterial()
            m.lightingModel = .constant
            m.diffuse.contents = color
            g.materials = [m]
            return g
        }
        let green = marker(.systemGreen), yellow = marker(.systemYellow), gray = marker(.systemGray)
        for (i, led) in points.enumerated() {
            guard let led else { continue }
            let geo: SCNGeometry
            switch led.quality {
            case .triangulated: geo = green
            case .lidar: geo = yellow
            default: geo = gray
            }
            let node = SCNNode(geometry: geo)
            node.simdPosition = led.p
            overlay.addChildNode(node)
            markerLEDs.append((node, i, led.quality != .interpolated))
        }
    }

    /// Tapping a green or yellow marker discards that LED's position so it is located again.
    @MainActor
    @objc private func handleTap(_ gesture: UITapGestureRecognizer) {
        guard !passRunning else { return }
        let pt = gesture.location(in: sceneView)
        if manualIndex != nil {
            // Manual mode: jump the marker to the tapped spot, keeping its distance from the camera.
            let s = sceneView.projectPoint(cursorNode.worldPosition)
            cursorNode.worldPosition = sceneView.unprojectPoint(SCNVector3(Float(pt.x), Float(pt.y), s.z))
            commitManual()
            return
        }
        var best: Int?
        var bestDist = CGFloat(40)          // points: ignore taps far from any marker
        for (node, led, measured) in markerLEDs where measured {
            let s = sceneView.projectPoint(node.worldPosition)
            guard s.z > 0, s.z < 1 else { continue }
            let d = hypot(CGFloat(s.x) - pt.x, CGFloat(s.y) - pt.y)
            if d < bestDist {
                best = led
                bestDist = d
            }
        }
        if let best { discard(best) }
    }

    // MARK: - Placing LEDs by hand

    /// Starts stepping through the wire one LED at a time. The chosen LED is lit on the plant and
    /// a white marker shows where the app thinks it is; dragging the marker corrects it.
    @MainActor
    func enterManual() {
        guard !passRunning, !mainTargets.isEmpty else { return }
        let firstProblem = mainTargets.indices.first { i in
            !(i < lastPoints.count && lastPoints[i]?.quality == .triangulated)
        }
        selectManual(firstProblem ?? 0)
    }

    @MainActor
    func exitManual() {
        manualIndex = nil
        cursorNode.isHidden = true
        if let h = manualHost {
            Task { try? await DeviceClient(host: h).solo(string: 0, index: -1, value: 1) }
        }
        manualHost = nil
    }

    @MainActor
    func stepManual(_ delta: Int) {
        guard let i = manualIndex else { return }
        selectManual(min(max(i + delta, 0), mainTargets.count - 1))
    }

    /// Jumps to the next LED after the current one that isn't green.
    @MainActor
    func nextProblem() {
        guard let i = manualIndex else { return }
        let n = mainTargets.count
        for k in 1...max(1, n) {
            let j = (i + k) % n
            if !(j < lastPoints.count && lastPoints[j]?.quality == .triangulated) {
                selectManual(j)
                return
            }
        }
    }

    @MainActor
    private func selectManual(_ i: Int) {
        guard mainTargets.indices.contains(i) else { return }
        manualIndex = i
        let estimate = i < lastPoints.count ? lastPoints[i] : nil
        manualQuality = estimate?.quality ?? .unknown

        if let p = estimate?.p {
            cursorNode.simdWorldPosition = p
        } else if let cam = sceneView.session.currentFrame?.camera.transform {
            // No idea where it is: start 1.5 m in front of the camera.
            let origin = SIMD3<Float>(cam.columns.3.x, cam.columns.3.y, cam.columns.3.z)
            let forward = -SIMD3<Float>(cam.columns.2.x, cam.columns.2.y, cam.columns.2.z)
            cursorNode.simdWorldPosition = origin + forward * 1.5
        }
        cursorNode.isHidden = false

        // Light this LED on the plant so it can be seen through the camera.
        let t = mainTargets[i]
        let previous = manualHost, value = settings.ledValue
        manualHost = t.host
        Task {
            if let p = previous, p != t.host {
                try? await DeviceClient(host: p).solo(string: 0, index: -1, value: 1)
            }
            try? await DeviceClient(host: t.host).solo(string: t.string, index: t.index, value: value)
        }
    }

    /// Dragging moves the marker sideways/up/down as seen on screen, keeping its distance from the
    /// camera. Looking from a second side and dragging again fixes the remaining direction.
    @MainActor
    @objc private func handlePan(_ gesture: UIPanGestureRecognizer) {
        guard manualIndex != nil, !passRunning else { return }
        let d = gesture.translation(in: sceneView)
        gesture.setTranslation(.zero, in: sceneView)
        let s = sceneView.projectPoint(cursorNode.worldPosition)
        cursorNode.worldPosition = sceneView.unprojectPoint(SCNVector3(s.x + Float(d.x), s.y + Float(d.y), s.z))
        if gesture.state == .ended { commitManual() }
    }

    /// Saves the marker's position as this LED's position and marks it good.
    @MainActor
    func commitManual() {
        guard let i = manualIndex else { return }
        let p = cursorNode.simdWorldPosition
        manualQuality = .triangulated
        queue.async {
            guard self.observations.indices.contains(i) else { return }
            self.manual[i] = p
            self.keep.remove(i)
            self.skip.remove(i)
            if self.isIdle { self.publishResults(error: nil) }
        }
    }

    /// Forgets everything known about one LED (its sightings this session and any saved position).
    func discard(_ led: Int) {
        queue.async {
            guard self.isIdle, self.observations.indices.contains(led) else { return }
            self.observations[led] = []
            self.manual[led] = nil
            self.keep.remove(led)
            self.skip.remove(led)
            self.publishResults(error: nil)
        }
    }

    // MARK: - ARSessionDelegate (called on `queue`)

    func session(_ session: ARSession, didUpdate frame: ARFrame) {
        frameCount += 1
        var normal = false
        let text: String
        switch frame.camera.trackingState {
        case .normal:
            normal = true
            text = ""
        case .notAvailable:
            text = "Starting camera…"
        case .limited(let reason):
            switch reason {
            case .initializing: text = "Move the phone slowly to start tracking"
            case .excessiveMotion: text = "Hold the phone steadier"
            case .insufficientFeatures: text = "Too dark or featureless – turn on a room light"
            case .relocalizing: text = "Finding position again…"
            @unknown default: text = "Tracking limited"
            }
        }
        if text != lastTrackingText || frameCount == 1 {
            lastTrackingText = text
            Task { @MainActor in
                self.trackingOK = normal
                self.trackingMessage = text
            }
        }

        guard case let .settling(until) = step else { return }
        if cancelled {
            endPass(error: nil)
            return
        }
        // Frame timestamps and systemUptime share a clock; fall back to arrival time if they ever don't.
        let now = ProcessInfo.processInfo.systemUptime
        let stamp = abs(now - frame.timestamp) < 1 ? frame.timestamp : now - 0.05
        guard stamp >= until, normal else { return }

        capture(frame)
        advance()
    }

    func session(_ session: ARSession, didFailWithError error: Error) {
        let msg = error.localizedDescription
        Task { @MainActor in self.errorMessage = msg }
    }

    // MARK: - Image analysis

    /// Compares this frame's brightness with the previous captured frame and,
    /// if a new bright spot appeared, records it as a sighting of `current`.
    private func capture(_ frame: ARFrame) {
        let pb = frame.capturedImage
        CVPixelBufferLockBaseAddress(pb, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(pb, .readOnly) }
        guard let raw = CVPixelBufferGetBaseAddressOfPlane(pb, 0) else { return }   // plane 0 = luma
        let w = CVPixelBufferGetWidthOfPlane(pb, 0)
        let h = CVPixelBufferGetHeightOfPlane(pb, 0)
        let bpr = CVPixelBufferGetBytesPerRowOfPlane(pb, 0)
        let st = Self.lumaStride
        let sw = w / st, sh = h / st
        guard sw > 16, sh > 16 else { return }
        if cur.count != sw * sh {
            cur = [UInt8](repeating: 0, count: sw * sh)
            prev = cur
            havePrev = false
        }

        let src = raw.assumingMemoryBound(to: UInt8.self)
        let thr = qSettings.threshold
        var best = 0, bx = 0, by = 0, over = 0
        cur.withUnsafeMutableBufferPointer { c in
            prev.withUnsafeBufferPointer { p in
                for y in 0..<sh {
                    let row = src + y * st * bpr
                    var i = y * sw
                    for x in 0..<sw {
                        let v = row[x * st]
                        c[i] = v
                        let d = Int(v) - Int(p[i])
                        if d > thr {
                            over += 1
                            if d > best { best = d; bx = x; by = y }
                        }
                        i += 1
                    }
                }
            }
        }

        let hadPrev = havePrev
        defer {
            swap(&prev, &cur)
            havePrev = true
        }

        let T = frame.camera.transform
        let origin = SIMD3<Float>(T.columns.3.x, T.columns.3.y, T.columns.3.z)
        guard let target = current else {
            if viewer == nil { viewer = origin }    // where the user stood for the first pass
            return
        }
        // Nothing lit up, or far too much changed (camera moved, room light switched).
        guard hadPrev, best > 0, over < sw * sh / 50 else { return }

        // Brightness-weighted centre of the spot.
        var sx: Float = 0, sy: Float = 0, sum: Float = 0
        let half = best / 2, r = 8
        for y in max(0, by - r)...min(sh - 1, by + r) {
            for x in max(0, bx - r)...min(sw - 1, bx + r) {
                let i = y * sw + x
                let d = Int(cur[i]) - Int(prev[i])
                if d >= half {
                    sx += Float(x) * Float(d)
                    sy += Float(y) * Float(d)
                    sum += Float(d)
                }
            }
        }
        guard sum > 0 else { return }
        let u = (sx / sum + 0.5) * Float(st)        // full-resolution pixel coordinates
        let v = (sy / sum + 0.5) * Float(st)

        // Pixel -> ray. ARKit camera space: +X right, +Y up, -Z forward; image Y runs downwards.
        let K = frame.camera.intrinsics
        let local = SIMD3<Float>((u - K[2][0]) / K[0][0], -(v - K[2][1]) / K[1][1], -1)
        let d4 = T * SIMD4<Float>(local.x, local.y, local.z, 0)
        let dir = simd_normalize(SIMD3<Float>(d4.x, d4.y, d4.z))

        let hit = lidarPoint(frame, u: u, v: v, local: local)
        let sighting = Observation(origin: origin, dir: dir, lidar: hit, strength: Float(best), pass: pass)
        if qSettings.flash {
            pendingLED = target.global
            pending.append(sighting)
        } else {
            observations[target.global].append(sighting)
            seen += 1
        }
    }

    /// LiDAR depth at an image position, as a world-space point.
    private func lidarPoint(_ frame: ARFrame, u: Float, v: Float, local: SIMD3<Float>) -> SIMD3<Float>? {
        guard let depth = frame.sceneDepth else { return nil }
        let map = depth.depthMap
        CVPixelBufferLockBaseAddress(map, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(map, .readOnly) }
        guard let base = CVPixelBufferGetBaseAddress(map) else { return nil }
        let dw = CVPixelBufferGetWidth(map), dh = CVPixelBufferGetHeight(map)
        let bpr = CVPixelBufferGetBytesPerRow(map)

        let conf = depth.confidenceMap
        if let conf { CVPixelBufferLockBaseAddress(conf, .readOnly) }
        defer { if let conf { CVPixelBufferUnlockBaseAddress(conf, .readOnly) } }
        let cbase = conf.flatMap { CVPixelBufferGetBaseAddress($0) }
        let cbpr = conf.map { CVPixelBufferGetBytesPerRow($0) } ?? 0

        let res = frame.camera.imageResolution
        let dx = Int(u / Float(res.width) * Float(dw))
        let dy = Int(v / Float(res.height) * Float(dh))
        guard dx >= 0, dx < dw, dy >= 0, dy < dh else { return nil }

        var vals: [Float] = []
        for yy in max(0, dy - 2)...min(dh - 1, dy + 2) {
            for xx in max(0, dx - 2)...min(dw - 1, dx + 2) {
                let d = base.load(fromByteOffset: yy * bpr + xx * 4, as: Float32.self)
                guard d.isFinite, d > 0.2, d < 6 else { continue }
                if let cbase, cbase.load(fromByteOffset: yy * cbpr + xx, as: UInt8.self) < 1 { continue }   // low confidence
                vals.append(d)
            }
        }
        guard vals.count >= 3 else { return nil }
        // The LED sits on the plant; gaps between branches read as the wall behind,
        // so take a near value rather than the average.
        vals.sort()
        let d = vals[vals.count / 4]
        let pc = local * d      // depth is measured along the camera's forward axis
        let wp = frame.camera.transform * SIMD4<Float>(pc.x, pc.y, pc.z, 1)
        return SIMD3<Float>(wp.x, wp.y, wp.z)
    }
}

/// SwiftUI wrapper for the engine's AR camera view.
struct ARViewContainer: UIViewRepresentable {
    let engine: ScanEngine
    func makeUIView(context: Context) -> ARSCNView { engine.sceneView }
    func updateUIView(_ uiView: ARSCNView, context: Context) {}
}
