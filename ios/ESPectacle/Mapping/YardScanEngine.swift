import ARKit
import SceneKit
import SwiftUI

/// Scans the whole yard with LiDAR into a coloured point cloud, and lets the user place each
/// plant by aiming at its base. The yard's axes come from where the scan starts: the start
/// position is the front, looking at the yard: +X right, Y up, +Z back towards the viewer.
final class YardScanEngine: NSObject, ObservableObject, ARSessionDelegate {
    struct Placement: Equatable {
        var position: SIMD3<Float>     // yard space (metres)
        var rotation: Float            // degrees
    }

    struct Result {
        var area: AreaPoints?
        var placements: [UUID: Placement]
    }

    // MARK: UI state (main thread)
    @Published var trackingOK = false
    @Published var trackingMessage = "Starting camera…"
    @Published var frameReady = false
    @Published var pointCount = 0
    @Published var capturing = true { didSet { let c = capturing; queue.async { self.qCapturing = c } } }
    @Published var placements: [UUID: Placement] = [:]
    @Published var message: String?

    let hasLiDAR = ARWorldTrackingConfiguration.supportsFrameSemantics(.sceneDepth)
    static let maxPoints = 400_000
    let sceneView: ARSCNView

    private let yardRoot = SCNNode()
    private let pointsNode = SCNNode()
    private var plantNodes: [UUID: SCNNode] = [:]
    private var maps: [UUID: (map: PlantMap, color: UIColor)] = [:]
    private var worldToYardMain = matrix_identity_float4x4
    private var refreshTimer: Timer?
    private var shownCount = -1

    // MARK: Capture state (confined to `queue`)
    private let queue = DispatchQueue(label: "espectacle.yardscan", qos: .userInitiated)
    private var frameSet = false
    private var worldToYard = matrix_identity_float4x4
    private var voxels: [Int64: Int32] = [:]
    private var positions: [SIMD3<Float>] = []
    private var colors: [SIMD3<UInt8>] = []
    private var lastSample: TimeInterval = 0
    private var qCapturing = true
    private var lastTrackingText = ""
    private static let voxel: Float = 0.03          // keep one point per 3 cm cube

    @MainActor
    init(frame: CGRect = .zero) {
        sceneView = ARSCNView(frame: frame)
        super.init()
        sceneView.scene.rootNode.addChildNode(yardRoot)
        yardRoot.addChildNode(pointsNode)
        yardRoot.isHidden = true
    }

    // MARK: - Session

    /// `plants` are the mapped plants that can be placed, with the colour to draw each in.
    @MainActor
    func start(plants: [(Plant, UIColor)]) {
        maps = [:]
        for (p, c) in plants { if let m = p.map { maps[p.id] = (m, c) } }
        sceneView.session.delegate = self
        sceneView.session.delegateQueue = queue
        let config = ARWorldTrackingConfiguration()
        if hasLiDAR { config.frameSemantics.insert(.sceneDepth) }
        if ARWorldTrackingConfiguration.supportsSceneReconstruction(.mesh) {
            config.sceneReconstruction = .mesh      // improves raycasts against the ground and plants
        }
        config.planeDetection = [.horizontal]
        sceneView.session.run(config, options: [.resetTracking, .removeExistingAnchors])
        UIApplication.shared.isIdleTimerDisabled = true
        capturing = hasLiDAR
        refreshTimer = Timer.scheduledTimer(withTimeInterval: 1.5, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.refreshPoints() }
        }
    }

    @MainActor
    func stop() {
        refreshTimer?.invalidate()
        refreshTimer = nil
        sceneView.session.pause()
        UIApplication.shared.isIdleTimerDisabled = false
    }

    @MainActor
    func clearPoints() {
        queue.async {
            self.voxels = [:]
            self.positions = []
            self.colors = []
            Task { @MainActor in self.pointCount = 0 }
        }
    }

    // MARK: - Placing plants

    /// Puts the plant's base where the crosshair (screen centre) meets the ground or the plant.
    @MainActor
    func placeAtCrosshair(_ id: UUID, defaultRotation: Float) {
        guard frameReady else { return }
        let centre = CGPoint(x: sceneView.bounds.midX, y: sceneView.bounds.midY)
        var world: SIMD3<Float>?
        for target in [ARRaycastQuery.Target.estimatedPlane, .existingPlaneGeometry] {
            if let q = sceneView.raycastQuery(from: centre, allowing: target, alignment: .any),
               let hit = sceneView.session.raycast(q).first {
                let c = hit.worldTransform.columns.3
                world = SIMD3(c.x, c.y, c.z)
                break
            }
        }
        guard let world else {
            message = "Couldn't find a surface at the crosshair. Aim at the ground right at the base of the prop."
            return
        }
        message = nil
        let y = worldToYardMain * SIMD4<Float>(world.x, world.y, world.z, 1)
        let rotation = placements[id]?.rotation ?? defaultRotation
        placements[id] = Placement(position: SIMD3(y.x, y.y, y.z), rotation: rotation)
        updatePlantNode(id)
    }

    @MainActor
    func setRotation(_ id: UUID, _ degrees: Float) {
        guard placements[id] != nil else { return }
        placements[id]?.rotation = degrees
        updatePlantNode(id)
    }

    @MainActor
    private func updatePlantNode(_ id: UUID) {
        guard let p = placements[id], let entry = maps[id] else { return }
        let node: SCNNode
        if let n = plantNodes[id] {
            node = n
        } else {
            node = SCNNode(geometry: PointCloudGeometry.make(plant: entry.map, color: entry.color))
            let ring = SCNTorus(ringRadius: CGFloat(max(entry.map.radius, 0.05)), pipeRadius: 0.008)
            ring.firstMaterial?.lightingModel = .constant
            ring.firstMaterial?.diffuse.contents = entry.color
            node.addChildNode(SCNNode(geometry: ring))
            yardRoot.addChildNode(node)
            plantNodes[id] = node
        }
        var plant = Plant(name: "")
        plant.x = p.position.x; plant.y = p.position.y; plant.z = p.position.z
        plant.rotation = p.rotation
        node.simdTransform = plant.yardTransform
    }

    @MainActor
    private func refreshPoints() {
        guard frameReady, pointCount != shownCount else { return }
        let (pos, col) = queue.sync { (self.positions, self.colors) }
        shownCount = pos.count
        pointsNode.geometry = pos.isEmpty ? nil
            : PointCloudGeometry.make(area: AreaPoints(positions: pos, colors: col), pointSize: 2)
    }

    // MARK: - Result

    /// The scan in yard space, with Y = 0 at the ground (the lowest plant base, or the floor
    /// near where the scan started).
    @MainActor
    func result() -> Result {
        let (pos, col) = queue.sync { (self.positions, self.colors) }
        var ground: Float = 0
        if let low = placements.values.map({ $0.position.y }).min() {
            ground = low
        } else {
            let near = pos.filter { $0.x * $0.x + $0.z * $0.z < 16 }.map { $0.y }.sorted()
            if near.count > 100 { ground = near[near.count / 20] }
        }
        var area: AreaPoints?
        if !pos.isEmpty {
            area = AreaPoints(positions: pos.map { $0 - SIMD3(0, ground, 0) }, colors: col)
        }
        var placed = placements
        for k in placed.keys { placed[k]?.position.y -= ground }
        return Result(area: area, placements: placed)
    }

    // MARK: - ARSessionDelegate (on `queue`)

    func session(_ session: ARSession, didUpdate frame: ARFrame) {
        var normal = false
        let text: String
        switch frame.camera.trackingState {
        case .normal: normal = true; text = ""
        case .notAvailable: text = "Starting camera…"
        case .limited(let reason):
            switch reason {
            case .initializing: text = "Move the phone slowly to start tracking"
            case .excessiveMotion: text = "Move more slowly"
            case .insufficientFeatures: text = "Too dark or featureless – some light helps"
            case .relocalizing: text = "Finding position again…"
            @unknown default: text = "Tracking limited"
            }
        }
        if text != lastTrackingText {
            lastTrackingText = text
            Task { @MainActor in
                self.trackingOK = normal
                self.trackingMessage = text
            }
        }
        guard normal else { return }

        if !frameSet { establishFrame(frame.camera.transform) }

        guard qCapturing, frame.timestamp - lastSample > 0.25, positions.count < Self.maxPoints,
              let depth = frame.sceneDepth else { return }
        lastSample = frame.timestamp
        capture(frame, depth: depth)
    }

    func session(_ session: ARSession, didFailWithError error: Error) {
        let msg = error.localizedDescription
        Task { @MainActor in self.message = msg }
    }

    /// Yard axes from the camera at the start of the scan.
    private func establishFrame(_ cam: simd_float4x4) {
        var back = SIMD3<Float>(cam.columns.2.x, 0, cam.columns.2.z)
        if simd_length(back) < 0.1 { back = SIMD3(0, 0, 1) }     // looking straight down
        let zAxis = simd_normalize(back)
        let yAxis = SIMD3<Float>(0, 1, 0)
        let xAxis = simd_cross(yAxis, zAxis)
        let origin = SIMD3<Float>(cam.columns.3.x, cam.columns.3.y - 1.4, cam.columns.3.z)   // roughly the ground
        let yardToWorld = simd_float4x4(SIMD4(xAxis, 0), SIMD4(yAxis, 0), SIMD4(zAxis, 0), SIMD4(origin, 1))
        worldToYard = yardToWorld.inverse
        frameSet = true
        let inverse = worldToYard
        Task { @MainActor in
            self.worldToYardMain = inverse
            self.yardRoot.simdTransform = yardToWorld
            self.yardRoot.isHidden = false
            self.frameReady = true
        }
    }

    /// Adds the LiDAR points of one frame, coloured from the camera image.
    private func capture(_ frame: ARFrame, depth: ARDepthData) {
        let map = depth.depthMap
        let img = frame.capturedImage
        CVPixelBufferLockBaseAddress(map, .readOnly)
        CVPixelBufferLockBaseAddress(img, .readOnly)
        let conf = depth.confidenceMap
        if let conf { CVPixelBufferLockBaseAddress(conf, .readOnly) }
        defer {
            CVPixelBufferUnlockBaseAddress(map, .readOnly)
            CVPixelBufferUnlockBaseAddress(img, .readOnly)
            if let conf { CVPixelBufferUnlockBaseAddress(conf, .readOnly) }
        }
        guard let dBase = CVPixelBufferGetBaseAddress(map),
              CVPixelBufferGetPlaneCount(img) >= 2,
              let yBase = CVPixelBufferGetBaseAddressOfPlane(img, 0),
              let cBase = CVPixelBufferGetBaseAddressOfPlane(img, 1) else { return }
        let dw = CVPixelBufferGetWidth(map), dh = CVPixelBufferGetHeight(map)
        let dBpr = CVPixelBufferGetBytesPerRow(map)
        let cfBase = conf.flatMap { CVPixelBufferGetBaseAddress($0) }
        let cfBpr = conf.map { CVPixelBufferGetBytesPerRow($0) } ?? 0
        let iw = CVPixelBufferGetWidthOfPlane(img, 0), ih = CVPixelBufferGetHeightOfPlane(img, 0)
        let yBpr = CVPixelBufferGetBytesPerRowOfPlane(img, 0)
        let cBpr = CVPixelBufferGetBytesPerRowOfPlane(img, 1)
        let yPix = yBase.assumingMemoryBound(to: UInt8.self)
        let cPix = cBase.assumingMemoryBound(to: UInt8.self)

        let K = frame.camera.intrinsics
        let res = frame.camera.imageResolution
        let sx = Float(res.width) / Float(dw), sy = Float(res.height) / Float(dh)
        let M = worldToYard * frame.camera.transform     // camera space -> yard space
        let inv = 1 / Self.voxel

        for v in stride(from: 0, to: dh, by: 2) {
            for u in stride(from: 0, to: dw, by: 2) {
                let d = dBase.load(fromByteOffset: v * dBpr + u * 4, as: Float32.self)
                guard d.isFinite, d > 0.3, d < 5 else { continue }
                if let cfBase, cfBase.load(fromByteOffset: v * cfBpr + u, as: UInt8.self) < 2 { continue }
                let ix = (Float(u) + 0.5) * sx, iy = (Float(v) + 0.5) * sy
                let local = SIMD4<Float>((ix - K[2][0]) / K[0][0] * d, -(iy - K[2][1]) / K[1][1] * d, -d, 1)
                let p4 = M * local
                let p = SIMD3<Float>(p4.x, p4.y, p4.z)
                let key = (Int64(floor(p.x * inv)) + (1 << 20)) << 42
                        | (Int64(floor(p.y * inv)) + (1 << 20)) << 21
                        | (Int64(floor(p.z * inv)) + (1 << 20))
                guard voxels[key] == nil else { continue }

                // Camera image is YCbCr 4:2:0 full range.
                let px = min(Int(ix), iw - 1), py = min(Int(iy), ih - 1)
                let Y = Float(yPix[py * yBpr + px])
                let cb = Float(cPix[(py / 2) * cBpr + (px / 2) * 2]) - 128
                let cr = Float(cPix[(py / 2) * cBpr + (px / 2) * 2 + 1]) - 128
                func c8(_ f: Float) -> UInt8 { UInt8(max(0, min(255, f))) }
                voxels[key] = Int32(positions.count)
                positions.append(p)
                colors.append(SIMD3(c8(Y + 1.402 * cr), c8(Y - 0.344136 * cb - 0.714136 * cr), c8(Y + 1.772 * cb)))
                if positions.count >= Self.maxPoints { break }
            }
            if positions.count >= Self.maxPoints { break }
        }
        let n = positions.count
        Task { @MainActor in self.pointCount = n }
    }
}

/// SwiftUI wrapper for an AR camera view owned by an engine.
struct ARSceneContainer: UIViewRepresentable {
    let view: ARSCNView
    func makeUIView(context: Context) -> ARSCNView { view }
    func updateUIView(_ uiView: ARSCNView, context: Context) {}
}
