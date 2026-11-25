import SwiftUI
import SceneKit

/// Rotatable 3D point cloud of mapped LEDs (one plant, or the whole yard).
/// Green: seen from two or more sides. Yellow: LiDAR. Grey: estimated.
/// Orange: was green, but un-flagged by the user so it gets scanned again.
struct TreePreviewView: UIViewRepresentable {
    let map: PreviewCloud
    /// Called with the index of the LED nearest to a tap (when set).
    var onTap: ((Int) -> Void)? = nil

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> SCNView {
        let view = SCNView()
        view.backgroundColor = .black
        view.allowsCameraControl = true
        view.antialiasingMode = .multisampling4X
        context.coordinator.view = view
        context.coordinator.onTap = onTap
        context.coordinator.rebuild(map)
        if onTap != nil {
            let tap = UITapGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.tapped(_:)))
            tap.cancelsTouchesInView = false
            tap.delegate = context.coordinator      // don't let the camera-control gestures swallow taps
            view.addGestureRecognizer(tap)
        }
        return view
    }

    func updateUIView(_ view: SCNView, context: Context) {
        let c = context.coordinator
        c.onTap = onTap
        guard c.shown != map else { return }
        if c.sameShape(as: map) {
            c.recolour(map)         // only flags changed: keep the user's camera angle
        } else {
            c.rebuild(map)
        }
    }

    final class Coordinator: NSObject, UIGestureRecognizerDelegate {
        func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer,
                               shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool { true }

        weak var view: SCNView?
        var onTap: ((Int) -> Void)?
        var shown: PreviewCloud?
        private var nodes: [SCNNode] = []
        private var markers: [SCNGeometry] = []     // green, yellow, grey, orange

        func sameShape(as map: PreviewCloud) -> Bool {
            guard let old = shown, old.points.count == map.points.count,
                  old.height == map.height, old.radius == map.radius else { return false }
            for (a, b) in zip(old.points, map.points) where a.x != b.x || a.y != b.y || a.z != b.z {
                return false
            }
            return true
        }

        private func marker(for led: MappedLED) -> SCNGeometry {
            switch led.quality {
            case .triangulated: return led.rescan == true ? markers[3] : markers[0]
            case .lidar: return markers[1]
            default: return markers[2]
            }
        }

        func recolour(_ map: PreviewCloud) {
            for (node, led) in zip(nodes, map.points) { node.geometry = marker(for: led) }
            shown = map
        }

        func rebuild(_ map: PreviewCloud) {
            let scene = SCNScene()
            let size = CGFloat(max(0.006, max(map.height, map.radius * 2) / 150))

            func make(_ color: UIColor) -> SCNGeometry {
                let g = SCNSphere(radius: size)
                g.segmentCount = 8
                let m = SCNMaterial()
                m.lightingModel = .constant
                m.diffuse.contents = color
                g.materials = [m]
                return g
            }
            markers = [make(.systemGreen), make(.systemYellow), make(.systemGray), make(.systemOrange)]

            nodes = map.points.map { led in
                let node = SCNNode(geometry: marker(for: led))
                node.simdPosition = SIMD3<Float>(led.x, led.y, led.z)
                scene.rootNode.addChildNode(node)
                return node
            }

            // Floor ring to show the base and which way is "front" (+Z).
            let ring = SCNTorus(ringRadius: CGFloat(map.radius), pipeRadius: size / 3)
            ring.firstMaterial?.lightingModel = .constant
            ring.firstMaterial?.diffuse.contents = UIColor.darkGray
            scene.rootNode.addChildNode(SCNNode(geometry: ring))
            let front = SCNNode(geometry: make(.white))
            front.simdPosition = SIMD3<Float>(0, 0, map.radius)
            scene.rootNode.addChildNode(front)

            let camera = SCNCamera()
            camera.fieldOfView = 40
            camera.zNear = 0.05
            camera.zFar = 100
            let camNode = SCNNode()
            camNode.camera = camera
            let dist = max(map.height, map.radius * 2) * 1.9
            camNode.simdPosition = SIMD3<Float>(0, map.height * 0.5, dist)
            camNode.simdLook(at: SIMD3<Float>(0, map.height * 0.5, 0))
            scene.rootNode.addChildNode(camNode)

            view?.scene = scene
            shown = map
        }

        /// LED dots are too small to hit exactly, so pick whichever is nearest to the finger.
        @objc func tapped(_ gesture: UITapGestureRecognizer) {
            guard let view, let onTap else { return }
            let pt = gesture.location(in: view)
            var best: Int?
            var bestDist = CGFloat(44)          // points: ignore taps far from any dot
            for (i, node) in nodes.enumerated() {
                let s = view.projectPoint(node.worldPosition)
                guard s.z > 0, s.z < 1 else { continue }       // in front of the camera
                let d = hypot(CGFloat(s.x) - pt.x, CGFloat(s.y) - pt.y)
                if d < bestDist {
                    best = i
                    bestDist = d
                }
            }
            if let best { onTap(best) }
        }
    }
}
