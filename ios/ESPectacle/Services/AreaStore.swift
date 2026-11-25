import Foundation
import simd

/// The yard scan: coloured points in yard space (metres, Y up, +Z towards the viewer).
/// Kept in its own binary file because it can hold hundreds of thousands of points.
struct AreaPoints {
    var positions: [SIMD3<Float>] = []
    var colors: [SIMD3<UInt8>] = []
    var count: Int { positions.count }
}

enum AreaStore {
    private static let magic: UInt32 = 0x3141_4C54      // "TLA1"

    static var fileURL: URL {
        let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("area.bin")
    }

    /// 16 bytes per point: x, y, z as Float32, then r, g, b and one spare byte.
    static func encode(_ a: AreaPoints) -> Data {
        var d = Data(capacity: 8 + a.count * 16)
        var m = magic, n = UInt32(a.count)
        withUnsafeBytes(of: &m) { d.append(contentsOf: $0) }
        withUnsafeBytes(of: &n) { d.append(contentsOf: $0) }
        for i in 0..<a.count {
            var p = (a.positions[i].x, a.positions[i].y, a.positions[i].z)
            withUnsafeBytes(of: &p) { d.append(contentsOf: $0) }
            let c = a.colors[i]
            d.append(contentsOf: [c.x, c.y, c.z, 0])
        }
        return d
    }

    static func decode(_ d: Data) -> AreaPoints? {
        guard d.count >= 8 else { return nil }
        return d.withUnsafeBytes { raw -> AreaPoints? in
            guard raw.loadUnaligned(fromByteOffset: 0, as: UInt32.self) == magic else { return nil }
            let n = Int(raw.loadUnaligned(fromByteOffset: 4, as: UInt32.self))
            guard d.count >= 8 + n * 16 else { return nil }
            var a = AreaPoints()
            a.positions.reserveCapacity(n)
            a.colors.reserveCapacity(n)
            for i in 0..<n {
                let o = 8 + i * 16
                a.positions.append(SIMD3(raw.loadUnaligned(fromByteOffset: o, as: Float.self),
                                         raw.loadUnaligned(fromByteOffset: o + 4, as: Float.self),
                                         raw.loadUnaligned(fromByteOffset: o + 8, as: Float.self)))
                a.colors.append(SIMD3(raw[o + 12], raw[o + 13], raw[o + 14]))
            }
            return a
        }
    }

    static func save(_ a: AreaPoints) throws {
        try encode(a).write(to: fileURL, options: .atomic)
    }

    static func load() -> AreaPoints? {
        guard let d = try? Data(contentsOf: fileURL) else { return nil }
        return decode(d)
    }

    static func delete() {
        try? FileManager.default.removeItem(at: fileURL)
    }
}

/// Where imported music files are kept.
enum AudioStore {
    static var folder: URL {
        let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Audio", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    static func url(for name: String) -> URL { folder.appendingPathComponent(name) }

    /// Copies a picked file into the app and returns its new file name.
    static func importFile(_ source: URL) throws -> String {
        let scoped = source.startAccessingSecurityScopedResource()
        defer { if scoped { source.stopAccessingSecurityScopedResource() } }
        let ext = source.pathExtension.isEmpty ? "mp3" : source.pathExtension
        let name = UUID().uuidString + "." + ext
        try FileManager.default.copyItem(at: source, to: url(for: name))
        return name
    }

    static func delete(_ name: String) {
        try? FileManager.default.removeItem(at: url(for: name))
    }
}
