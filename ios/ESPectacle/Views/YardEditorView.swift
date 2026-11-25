import SwiftUI
import SceneKit

/// The yard in 3D: the LiDAR scan (if any) with every plant's LEDs on top.
/// In Move mode, drag a plant across the ground and twist with two fingers to turn it.
struct YardEditorView: View {
    @EnvironmentObject var store: TreeStore
    @State private var selected: UUID?
    @State private var moving = false
    @State private var area: AreaPoints?
    @State private var loaded = false
    @State private var startLayout: [[Float]] = []

    private var mapped: [Plant] { store.data.plants.filter { store.mapIsCurrent($0) } }

    var body: some View {
        VStack(spacing: 0) {
            YardSceneView(area: area, plants: store.data.plants.filter { store.mapIsCurrent($0) },
                          colours: plantColours, selected: selected, moving: moving,
                          onMove: { id, x, z in move(id, x: x, z: z) },
                          onTurn: { id, deg in turn(id, by: deg) },
                          onSelect: { selected = $0 })
                .ignoresSafeArea(edges: .horizontal)
            controls
        }
        .navigationTitle("Arrange props")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            guard !loaded else { return }
            loaded = true
            startLayout = layout
            if selected == nil { selected = mapped.first?.id }
            area = await Task.detached { AreaStore.load() }.value
        }
        .onDisappear {
            if layout != startLayout { Task { try? await store.uploadLayout() } }
        }
    }

    private var layout: [[Float]] { store.data.plants.map { [$0.x, $0.y, $0.z, $0.rotation] } }

    private var plantColours: [UUID: UIColor] {
        Dictionary(uniqueKeysWithValues: store.data.plants.enumerated().map { ($1.id, PointCloudGeometry.plantColor($0)) })
    }

    private var index: Int? { selected.flatMap { id in store.data.plants.firstIndex { $0.id == id } } }

    private var controls: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Picker("Prop", selection: $selected) {
                    ForEach(mapped) { p in
                        Text(p.name).tag(Optional(p.id))
                    }
                }
                .pickerStyle(.menu)
                Spacer()
                Picker("Mode", selection: $moving) {
                    Label("Look", systemImage: "rotate.3d").tag(false)
                    Label("Move", systemImage: "hand.draw").tag(true)
                }
                .pickerStyle(.segmented)
                .frame(maxWidth: 220)
            }
            if let i = index {
                HStack(spacing: 14) {
                    number("X", $store.data.plants[i].x)
                    number("Y", $store.data.plants[i].y)
                    number("Z", $store.data.plants[i].z)
                }
                HStack {
                    Text("Turn").font(.footnote)
                    Slider(value: Binding(get: { Double(store.data.plants[i].rotation) },
                                          set: { store.data.plants[i].rotation = Float($0.rounded()) }),
                           in: -180...180)
                    Text("\(Int(store.data.plants[i].rotation))°").font(.footnote.monospacedDigit()).frame(width: 44)
                }
            }
            Text(moving ? "Drag the selected prop across the ground; twist with two fingers to turn it. Tap a prop to select it."
                        : "Drag to look around, pinch to zoom. Switch to Move to reposition props.")
                .font(.caption).foregroundStyle(.secondary)
            if area == nil && loaded {
                Text("No yard scan yet – use “Scan the yard” on a LiDAR iPhone or iPad to see the yard here.")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
        .padding()
        .background(.bar)
    }

    private func number(_ label: String, _ v: Binding<Float>) -> some View {
        HStack(spacing: 4) {
            Text(label).font(.footnote.weight(.semibold))
            TextField("0", value: v, format: .number.precision(.fractionLength(2)))
                .keyboardType(.numbersAndPunctuation)
                .textFieldStyle(.roundedBorder)
                .frame(width: 70)
            Text("m").font(.footnote).foregroundStyle(.secondary)
        }
    }

    private func move(_ id: UUID, x: Float, z: Float) {
        guard let i = store.data.plants.firstIndex(where: { $0.id == id }) else { return }
        store.data.plants[i].x = (x * 100).rounded() / 100
        store.data.plants[i].z = (z * 100).rounded() / 100
    }

    private func turn(_ id: UUID, by deg: Float) {
        guard let i = store.data.plants.firstIndex(where: { $0.id == id }) else { return }
        var r = store.data.plants[i].rotation + deg
        while r > 180 { r -= 360 }
        while r < -180 { r += 360 }
        store.data.plants[i].rotation = r
    }
}

/// SceneKit view behind the yard editor.
struct YardSceneView: UIViewRepresentable {
    var area: AreaPoints?
    var plants: [Plant]
    var colours: [UUID: UIColor]
    var selected: UUID?
    var moving: Bool
    var onMove: (UUID, Float, Float) -> Void
    var onTurn: (UUID, Float) -> Void
    var onSelect: (UUID) -> Void

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> SCNView {
        let view = SCNView()
        view.backgroundColor = .black
        view.antialiasingMode = .multisampling4X
        view.scene = context.coordinator.scene
        view.pointOfView = context.coordinator.cameraNode
        let c = context.coordinator
        c.view = view
        let pan = UIPanGestureRecognizer(target: c, action: #selector(Coordinator.pan(_:)))
        pan.maximumNumberOfTouches = 1
        pan.delegate = c
        view.addGestureRecognizer(pan)
        let rot = UIRotationGestureRecognizer(target: c, action: #selector(Coordinator.rotate(_:)))
        rot.delegate = c
        view.addGestureRecognizer(rot)
        let tap = UITapGestureRecognizer(target: c, action: #selector(Coordinator.tap(_:)))
        view.addGestureRecognizer(tap)
        return view
    }

    func updateUIView(_ view: SCNView, context: Context) {
        let c = context.coordinator
        c.parent = self
        view.allowsCameraControl = !moving
        c.update(area: area, plants: plants, colours: colours, selected: selected)
    }

    final class Coordinator: NSObject, UIGestureRecognizerDelegate {
        var parent: YardSceneView?
        weak var view: SCNView?
        let scene = SCNScene()
        let cameraNode = SCNNode()
        private let areaNode = SCNNode()
        private var areaCount = -1
        private var plantNodes: [UUID: SCNNode] = [:]
        private var plantMaps: [UUID: PlantMap] = [:]
        private var framed = false
        private var grab: SIMD3<Float>?         // offset from plant base to finger at drag start

        override init() {
            super.init()
            let cam = SCNCamera()
            cam.fieldOfView = 50
            cam.zNear = 0.05
            cam.zFar = 300
            cameraNode.camera = cam
            scene.rootNode.addChildNode(cameraNode)
            scene.rootNode.addChildNode(areaNode)
            // A small marker at the yard origin, pointing to the front (+Z).
            let origin = SCNNode(geometry: SCNCylinder(radius: 0.03, height: 0.01))
            origin.geometry?.firstMaterial?.diffuse.contents = UIColor.white
            origin.geometry?.firstMaterial?.lightingModel = .constant
            scene.rootNode.addChildNode(origin)
        }

        func update(area: AreaPoints?, plants: [Plant], colours: [UUID: UIColor], selected: UUID?) {
            if let area, area.count != areaCount {
                areaCount = area.count
                areaNode.geometry = PointCloudGeometry.make(area: area)
            }
            let ids = Set(plants.map { $0.id })
            for (id, node) in plantNodes where !ids.contains(id) {
                node.removeFromParentNode()
                plantNodes[id] = nil
            }
            for p in plants {
                guard let map = p.map else { continue }
                let colour = colours[p.id] ?? .systemGreen
                let shown = selected == nil || selected == p.id ? colour : colour.withAlphaComponent(0.35)
                let node: SCNNode
                if let n = plantNodes[p.id], plantMaps[p.id] == map {
                    node = n
                } else {
                    plantNodes[p.id]?.removeFromParentNode()
                    node = SCNNode(geometry: PointCloudGeometry.make(plant: map, color: colour))
                    let ring = SCNTorus(ringRadius: CGFloat(max(map.radius, 0.05)), pipeRadius: 0.012)
                    ring.firstMaterial?.lightingModel = .constant
                    node.addChildNode(SCNNode(geometry: ring))
                    scene.rootNode.addChildNode(node)
                    plantNodes[p.id] = node
                    plantMaps[p.id] = map
                }
                node.simdTransform = p.yardTransform
                node.opacity = selected == nil || selected == p.id ? 1 : 0.45
                node.childNodes.first?.geometry?.firstMaterial?.diffuse.contents = shown
            }
            if !framed, !plants.isEmpty || area != nil {
                framed = true
                frame(plants: plants, area: area)
            }
        }

        /// Starts the camera in front of everything, looking at the middle.
        private func frame(plants: [Plant], area: AreaPoints?) {
            var pts = plants.map { SIMD3<Float>($0.x, $0.y, $0.z) }
            if pts.isEmpty, let area { pts = Array(area.positions.prefix(5000)) }
            guard let first = pts.first else { return }
            var lo = first, hi = first
            for p in pts { lo = simd_min(lo, p); hi = simd_max(hi, p) }
            let centre = (lo + hi) / 2 + SIMD3(0, 0.5, 0)
            let size = max(simd_reduce_max(hi - lo), 2)
            cameraNode.simdPosition = centre + SIMD3(0, size * 0.6, size * 1.3)
            cameraNode.simdLook(at: centre)
        }

        // MARK: Gestures (Move mode)

        func gestureRecognizerShouldBegin(_ g: UIGestureRecognizer) -> Bool {
            parent?.moving == true
        }

        func gestureRecognizer(_ g: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith o: UIGestureRecognizer) -> Bool {
            true
        }

        /// Where a screen point lands on the horizontal plane at height `y`.
        private func ground(_ pt: CGPoint, y: Float) -> SIMD3<Float>? {
            guard let view else { return nil }
            let a = SIMD3<Float>(view.unprojectPoint(SCNVector3(Float(pt.x), Float(pt.y), 0)))
            let b = SIMD3<Float>(view.unprojectPoint(SCNVector3(Float(pt.x), Float(pt.y), 1)))
            guard abs(b.y - a.y) > 1e-5 else { return nil }
            let t = (y - a.y) / (b.y - a.y)
            guard t > 0 else { return nil }
            return a + (b - a) * t
        }

        @objc func pan(_ g: UIPanGestureRecognizer) {
            guard let parent, let id = parent.selected, let plant = parent.plants.first(where: { $0.id == id }),
                  let view else { return }
            let pt = g.location(in: view)
            guard let hit = ground(pt, y: plant.y) else { return }
            switch g.state {
            case .began:
                grab = SIMD3(plant.x, plant.y, plant.z) - hit
            case .changed:
                let p = hit + (grab ?? .zero)
                parent.onMove(id, p.x, p.z)
            default:
                grab = nil
            }
        }

        @objc func rotate(_ g: UIRotationGestureRecognizer) {
            guard let parent, let id = parent.selected else { return }
            // Screen clockwise turns the plant's front to the right when seen from above and in front.
            parent.onTurn(id, -Float(g.rotation * 180 / .pi))
            g.rotation = 0
        }

        @objc func tap(_ g: UITapGestureRecognizer) {
            guard let view, let parent else { return }
            let pt = g.location(in: view)
            var best: (UUID, CGFloat)?
            for (id, node) in plantNodes {
                let s = view.projectPoint(node.worldPosition)
                guard s.z > 0, s.z < 1 else { continue }
                let d = hypot(CGFloat(s.x) - pt.x, CGFloat(s.y) - pt.y)
                if d < 80, d < (best?.1 ?? .infinity) { best = (id, d) }
            }
            if let best { parent.onSelect(best.0) }
        }
    }
}
