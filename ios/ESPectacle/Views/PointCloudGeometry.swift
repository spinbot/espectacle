import SceneKit
import simd

/// Builds SceneKit geometry that draws each point as a small screen-space dot.
/// Much cheaper than one node per point, so it copes with large yard scans.
enum PointCloudGeometry {
    static func make(_ positions: [SIMD3<Float>], colors: [SIMD3<Float>], pointSize: CGFloat = 4,
                     minRadius: CGFloat = 1, maxRadius: CGFloat = 6) -> SCNGeometry {
        let n = min(positions.count, colors.count)
        var xyz = [Float](repeating: 0, count: n * 3)
        var rgb = [Float](repeating: 0, count: n * 3)
        for i in 0..<n {
            xyz[i * 3] = positions[i].x; xyz[i * 3 + 1] = positions[i].y; xyz[i * 3 + 2] = positions[i].z
            rgb[i * 3] = colors[i].x; rgb[i * 3 + 1] = colors[i].y; rgb[i * 3 + 2] = colors[i].z
        }
        let vData = xyz.withUnsafeBytes { Data($0) }
        let cData = rgb.withUnsafeBytes { Data($0) }
        let vertices = SCNGeometrySource(data: vData, semantic: .vertex, vectorCount: n,
                                         usesFloatComponents: true, componentsPerVector: 3,
                                         bytesPerComponent: 4, dataOffset: 0, dataStride: 12)
        let colorSource = SCNGeometrySource(data: cData, semantic: .color, vectorCount: n,
                                            usesFloatComponents: true, componentsPerVector: 3,
                                            bytesPerComponent: 4, dataOffset: 0, dataStride: 12)
        let indices = (0..<UInt32(n)).map { $0 }
        let element = SCNGeometryElement(indices: indices, primitiveType: .point)
        element.pointSize = pointSize
        element.minimumPointScreenSpaceRadius = minRadius
        element.maximumPointScreenSpaceRadius = maxRadius
        let g = SCNGeometry(sources: [vertices, colorSource], elements: [element])
        let m = SCNMaterial()
        m.lightingModel = .constant
        m.diffuse.contents = UIColor.white
        g.materials = [m]
        return g
    }

    static func make(area: AreaPoints, pointSize: CGFloat = 3) -> SCNGeometry {
        make(area.positions, colors: area.colors.map { SIMD3<Float>($0) / 255 },
             pointSize: pointSize, minRadius: 1, maxRadius: 4)
    }

    /// A plant's LEDs in its own space (before rotation), in one colour.
    static func make(plant map: PlantMap, color: UIColor, pointSize: CGFloat = 8) -> SCNGeometry {
        var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
        color.getRed(&r, green: &g, blue: &b, alpha: &a)
        let c = SIMD3<Float>(Float(r), Float(g), Float(b))
        let pts = map.leds.map { SIMD3<Float>($0.x, $0.y, $0.z) }
        return make(pts, colors: Array(repeating: c, count: pts.count), pointSize: pointSize, minRadius: 2, maxRadius: 10)
    }

    /// A distinct colour for each plant.
    static func plantColor(_ index: Int) -> UIColor {
        let hues: [CGFloat] = [0.33, 0.0, 0.58, 0.12, 0.83, 0.48, 0.07, 0.7]
        return UIColor(hue: hues[index % hues.count], saturation: 0.85, brightness: 1, alpha: 1)
    }
}

extension Plant {
    /// Plant space -> yard space, as a SceneKit transform (rotation about Y, then position).
    var yardTransform: simd_float4x4 {
        let th = rotation * .pi / 180
        var m = simd_float4x4(simd_quatf(angle: th, axis: SIMD3<Float>(0, 1, 0)))
        m.columns.3 = SIMD4<Float>(x, y, z, 1)
        return m
    }
}
