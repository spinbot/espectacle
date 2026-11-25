import Foundation
import simd

/// Generates the map of a drawn plant (grid, cone, polyline, circle, arch): LED positions in wiring
/// order, in plant space (metres; origin on the ground under the middle, Y up, +Z towards the street).
/// Keep in step with server/shared/shapes.ts.
enum ShapeGenerator {
    static func map(for s: PlantShape) -> PlantMap {
        let pts = points(for: s)
        let leds = pts.map { MappedLED(x: $0.x, y: $0.y, z: $0.z, quality: .triangulated) }
        let height = max(0.01, pts.map { $0.y }.max() ?? 0)
        let radius = max(0.01, pts.map { ($0.x * $0.x + $0.z * $0.z).squareRoot() }.max() ?? 0)
        return PlantMap(height: height, radius: radius, layout: [], leds: leds, portable: true)
    }

    static func points(for s: PlantShape) -> [SIMD3<Float>] {
        switch s.kind {
        case .panel:
            return panel(s)
        case .grid:
            return grid(s)
        case .cone where !s.spiral:
            return strands(s)
        default:
            let (path, closed) = wirePath(s)
            let length = pathLength(closed ? path + [path[0]] : path)
            return resample(path, count: count(s, length: length), closed: closed)
        }
    }

    private static func count(_ s: PlantShape, length: Float) -> Int {
        if let m = s.perMetre, m > 0 { return max(1, Int((length * m).rounded())) }
        return max(1, s.count)
    }

    private static func grid(_ s: PlantShape) -> [SIMD3<Float>] {
        let rows = max(1, s.rows), cols = max(1, s.columns)
        func x(_ c: Int) -> Float { cols > 1 ? s.width * (Float(c) / Float(cols - 1) - 0.5) : 0 }
        func y(_ r: Int) -> Float { rows > 1 ? s.height * Float(r) / Float(rows - 1) : 0 }
        let fromTop = s.start.hasPrefix("top"), fromRight = s.start.hasSuffix("Right")
        let outer = s.vertical ? cols : rows, inner = s.vertical ? rows : cols
        var out: [SIMD3<Float>] = []
        for o in 0..<outer {
            let back = s.zigzag && o % 2 == 1
            for i0 in 0..<inner {
                let i = back ? inner - 1 - i0 : i0
                let c: Int, r: Int
                if s.vertical { c = fromRight ? cols - 1 - o : o; r = fromTop ? rows - 1 - i : i }
                else { r = fromTop ? rows - 1 - o : o; c = fromRight ? cols - 1 - i : i }
                out.append(SIMD3(x(c), y(r), 0))
            }
        }
        return out
    }

    /// LED order inside one rows x cols matrix, as (column, row) from the bottom left.
    private static func matrixOrder(rows: Int, cols: Int, start: String, vertical: Bool, zigzag: Bool) -> [(Int, Int)] {
        let fromTop = start.hasPrefix("top"), fromRight = start.hasSuffix("Right")
        let outer = vertical ? cols : rows, inner = vertical ? rows : cols
        var out: [(Int, Int)] = []
        for o in 0..<outer {
            let back = zigzag && o % 2 == 1
            for i0 in 0..<inner {
                let i = back ? inner - 1 - i0 : i0
                if vertical { out.append((fromRight ? cols - 1 - o : o, fromTop ? rows - 1 - i : i)) }
                else { out.append((fromRight ? cols - 1 - i : i, fromTop ? rows - 1 - o : o)) }
            }
        }
        return out
    }

    /// Matrix panels tiled tilesX x tilesY, chained from the start corner along rows of panels.
    private static func panel(_ s: PlantShape) -> [SIMD3<Float>] {
        let rows = max(1, s.rows), cols = max(1, s.columns)
        let tx = max(1, s.tilesX), ty = max(1, s.tilesY)
        let pitch = max(0.001, s.pitch)
        let width = Float(tx * cols) * pitch
        let inPanel = matrixOrder(rows: rows, cols: cols, start: s.start, vertical: s.vertical, zigzag: s.zigzag)
        let tiles = matrixOrder(rows: ty, cols: tx, start: s.start, vertical: false, zigzag: false)
        var out: [SIMD3<Float>] = []
        for (px, py) in tiles {
            for (c, r) in inPanel {
                out.append(SIMD3((Float(px * cols + c) + 0.5) * pitch - width / 2, Float(py * rows + r) * pitch, 0))
            }
        }
        return out
    }

    /// Cone as vertical strands (a mega tree), starting at the front and going round to the right.
    private static func strands(_ s: PlantShape) -> [SIMD3<Float>] {
        let n = max(1, s.columns)
        let r0 = s.width / 2, r1 = s.topWidth / 2
        let slant = (s.height * s.height + (r0 - r1) * (r0 - r1)).squareRoot()
        let per: Int
        if let m = s.perMetre, m > 0 { per = max(1, Int((slant * m).rounded())) } else { per = max(1, s.count / n) }
        var out: [SIMD3<Float>] = []
        for k in 0..<n {
            let a = 2 * Float.pi * Float(k) / Float(n)
            let up = (s.start != "top") != (s.zigzag && k % 2 == 1)
            for i in 0..<per {
                let u0: Float = per > 1 ? Float(i) / Float(per - 1) : 0
                let u = up ? u0 : 1 - u0
                let r = r0 * (1 - u) + r1 * u
                out.append(SIMD3(r * sin(a), s.height * u, r * cos(a)))
            }
        }
        return out
    }

    /// The path of a single-wire shape, densely sampled.
    private static func wirePath(_ s: PlantShape) -> ([SIMD3<Float>], Bool) {
        let n = 256
        switch s.kind {
        case .circle:
            let r = s.width / 2, a0 = s.startAngle * .pi / 180, dir: Float = s.clockwise ? -1 : 1
            let pts = (0..<n).map { i -> SIMD3<Float> in
                let a = a0 + dir * 2 * .pi * Float(i) / Float(n)
                return s.flat ? SIMD3(r * cos(a), 0, -r * sin(a)) : SIMD3(r * cos(a), r + r * sin(a), 0)
            }
            return (pts, true)
        case .arch:
            var pts = (0...n).map { i -> SIMD3<Float> in
                let a = Float.pi - Float.pi * Float(i) / Float(n)      // left foot to right foot
                return SIMD3(s.width / 2 * cos(a), s.height * sin(a), 0)
            }
            if s.start == "right" { pts.reverse() }
            return (pts, false)
        case .cone:
            let steps = max(16, Int((abs(s.turns) * 64).rounded(.up)))
            var pts = (0...steps).map { i -> SIMD3<Float> in
                let u = Float(i) / Float(steps)
                let r = s.width / 2 * (1 - u) + s.topWidth / 2 * u, a = 2 * Float.pi * s.turns * u
                return SIMD3(r * sin(a), s.height * u, r * cos(a))
            }
            if s.start == "top" { pts.reverse() }
            return (pts, false)
        default:
            var pts = s.points.map { SIMD3($0.x, $0.y, $0.z) }
            if s.reverse { pts.reverse() }
            return (pts.isEmpty ? [SIMD3(0, 0, 0)] : pts, false)
        }
    }

    private static func pathLength(_ p: [SIMD3<Float>]) -> Float {
        zip(p, p.dropFirst()).reduce(0) { $0 + simd_distance($1.0, $1.1) }
    }

    /// `count` points evenly spaced along a path; a closed path doesn't repeat its first point at the end.
    private static func resample(_ pts: [SIMD3<Float>], count: Int, closed: Bool) -> [SIMD3<Float>] {
        guard let first = pts.first, count > 0 else { return [] }
        let path = closed ? pts + [first] : pts
        let total = pathLength(path)
        if count == 1 || total <= 0 { return Array(repeating: first, count: count) }
        let step = total / Float(closed ? count : count - 1)
        var out: [SIMD3<Float>] = []
        var seg = 0
        var segStart: Float = 0
        for k in 0..<count {
            let want = min(Float(k) * step, total)
            while seg < path.count - 2 && segStart + simd_distance(path[seg], path[seg + 1]) < want {
                segStart += simd_distance(path[seg], path[seg + 1])
                seg += 1
            }
            let a = path[seg], b = seg + 1 < path.count ? path[seg + 1] : a
            let len = simd_distance(a, b)
            let t = len > 0 ? min(max((want - segStart) / len, 0), 1) : 0
            out.append(a + (b - a) * t)
        }
        return out
    }
}
