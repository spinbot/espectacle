import Foundation
import simd

/// Writes plants as xLights custom models (.xmodel), so a mapped tree or yard can be sequenced in
/// xLights. xLights custom models are 3D grids of node numbers, so each LED's position is rounded
/// to the nearest grid cell; LEDs that land in an occupied cell are moved to the closest free one.
enum XLightsExport {
    /// One physical string within a model, and where xLights should send its data.
    struct StringPart {
        var count: Int
        var controller: String      // controller name (create a matching DDP controller in xLights)
        var startChannel: Int       // 1-based channel on that controller
    }

    struct ModelSource {
        var name: String
        var points: [SIMD3<Float>]  // metres, X right, Y up, Z towards the viewer; LED order
        var strings: [StringPart]
    }

    struct Result {
        var name: String
        var xml: String
        var width = 0, height = 0, depth = 0
        var nodes = 0
        var moved = 0               // LEDs shifted to a neighbouring cell because two shared one
        var cells: Int { width * height * depth }
    }

    static func build(_ m: ModelSource, cell: Float) -> Result {
        var r = Result(name: m.name, xml: "")
        guard let first = m.points.first else { return r }
        var lo = first, hi = first
        for p in m.points { lo = simd_min(lo, p); hi = simd_max(hi, p) }

        // Fractional grid position: columns left to right, rows top to bottom,
        // layers front (nearest the viewer) to back, as xLights lays them out.
        func grid(_ p: SIMD3<Float>) -> SIMD3<Float> {
            SIMD3((p.x - lo.x) / cell, (hi.y - p.y) / cell, (hi.z - p.z) / cell)
        }
        struct Cell: Hashable { var c, r, l: Int }
        var taken: [Cell: Int] = [:]
        var placed: [Cell] = []
        for (i, p) in m.points.enumerated() {
            let g = grid(p)
            var best = Cell(c: Int(g.x.rounded()), r: Int(g.y.rounded()), l: Int(g.z.rounded()))
            if taken[best] != nil {
                r.moved += 1
                var found: Cell?
                var radius = 1
                while found == nil {
                    var bestD = Float.infinity
                    for dl in -radius...radius { for dr in -radius...radius { for dc in -radius...radius {
                        let c = Cell(c: best.c + dc, r: best.r + dr, l: best.l + dl)
                        guard c.c >= 0, c.r >= 0, c.l >= 0, taken[c] == nil else { continue }
                        let d = simd_distance_squared(SIMD3(Float(c.c), Float(c.r), Float(c.l)), g)
                        if d < bestD { bestD = d; found = c }
                    }}}
                    radius += 1
                }
                best = found!
            }
            taken[best] = i + 1                     // xLights node numbers start at 1
            placed.append(best)
        }
        r.width = (placed.map { $0.c }.max() ?? 0) + 1
        r.height = (placed.map { $0.r }.max() ?? 0) + 1
        r.depth = (placed.map { $0.l }.max() ?? 0) + 1
        r.nodes = placed.count

        // Data: the plain grid for small models (read by every xLights version), the compressed
        // node list for big sparse ones.
        var dataAttr: String
        if r.cells <= 400_000 {
            var layers: [String] = []
            for l in 0..<r.depth {
                var rows: [String] = []
                for row in 0..<r.height {
                    var cols = [String](repeating: "", count: r.width)
                    for c in 0..<r.width { if let n = taken[Cell(c: c, r: row, l: l)] { cols[c] = String(n) } }
                    rows.append(cols.joined(separator: ","))
                }
                layers.append(rows.joined(separator: ";"))
            }
            dataAttr = "CustomModel=\"\(layers.joined(separator: "|"))\""
        } else {
            let list = placed.enumerated().map { i, c in
                r.depth > 1 ? "\(i + 1),\(c.r),\(c.c),\(c.l)" : "\(i + 1),\(c.r),\(c.c)"
            }
            dataAttr = "CustomModelCompressed=\"\(list.joined(separator: ";"))\""
        }

        var attrs: [(String, String)] = [
            ("name", m.name), ("DisplayAs", "Custom"),
            ("parm1", String(r.width)), ("parm2", String(r.height)),
            ("CustomWidth", String(r.width)), ("CustomHeight", String(r.height)), ("Depth", String(r.depth)),
            ("StringType", "RGB Nodes"), ("Transparency", "0"), ("PixelSize", "2"), ("Antialias", "1"),
            ("StartSide", "B"), ("Dir", "L"),
            ("widthmm", String(Int(Float(max(r.width - 1, 1)) * cell * 1000))),
            ("heightmm", String(Int(Float(max(r.height - 1, 1)) * cell * 1000))),
            ("SourceVersion", "2024.01"),
            ("Description", "Exported from ESPectacle: \(r.nodes) LEDs, \(Int((cell * 1000).rounded())) mm grid"),
        ]
        if r.depth > 1 { attrs.append(("depthmm", String(Int(Float(r.depth - 1) * cell * 1000)))) }
        if m.strings.count > 1 {
            // One entry per physical string: where it starts in the model and on which controller.
            attrs.append(("CustomStrings", String(m.strings.count)))
            attrs.append(("Advanced", "1"))
            var node = 1
            for (i, s) in m.strings.enumerated() {
                attrs.append(("NodeStart\(i + 1)", String(node)))
                attrs.append(("String\(i + 1)", "!\(s.controller):\(s.startChannel)"))
                node += s.count
            }
        } else if let s = m.strings.first {
            attrs.append(("StartChannel", "!\(s.controller):\(s.startChannel)"))
        }
        let attrText = attrs.map { "\($0.0)=\"\(escape($0.1))\"" }.joined(separator: " ")
        r.xml = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<custommodel \(attrText) \(dataAttr) >\n</custommodel>\n"
        return r
    }

    static func escape(_ s: String) -> String {
        s.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "\"", with: "&quot;")
            .replacingOccurrences(of: "<", with: "&lt;").replacingOccurrences(of: ">", with: "&gt;")
    }

    /// Writes the models to a fresh folder and returns the files.
    static func write(_ results: [Result]) throws -> [URL] {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("xLights export", isDirectory: true)
        try? FileManager.default.removeItem(at: dir)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return try results.map { r in
            let safe = r.name.components(separatedBy: CharacterSet(charactersIn: "/\\:?*\"<>|")).joined(separator: "-")
            let url = dir.appendingPathComponent(safe + ".xmodel")
            try r.xml.write(to: url, atomically: true, encoding: .utf8)
            return url
        }
    }
}
