import Foundation
import simd

/// One sighting of one LED: a ray from the camera through the bright spot,
/// plus the LiDAR hit along that ray if the phone has LiDAR.
struct Observation {
    var origin: SIMD3<Float>
    var dir: SIMD3<Float>           // unit length, world space
    var lidar: SIMD3<Float>?        // world space
    var strength: Float             // brightness change that triggered the detection (0..255)
    var pass: Int
}

struct SolvedLED {
    var p: SIMD3<Float>
    var quality: MapQuality
}

/// Turns camera observations into 3D positions.
enum Solver {
    static let minAngle: Float = 5 * .pi / 180     // rays closer than this can't be triangulated
    static let rayTolerance: Float = 0.05          // metres: how far a ray may miss the solution

    /// Point with the smallest summed squared distance to all rays.
    static func closestPoint(to rays: [Observation]) -> SIMD3<Float>? {
        var a = simd_float3x3(0)
        var b = SIMD3<Float>(repeating: 0)
        for r in rays {
            let d = r.dir
            // I - d·dᵀ projects onto the plane perpendicular to the ray
            let m = matrix_identity_float3x3 - simd_float3x3(columns: (d * d.x, d * d.y, d * d.z))
            a += m
            b += m * r.origin
        }
        guard abs(a.determinant) > 1e-6 else { return nil }
        return a.inverse * b
    }

    static func distance(_ p: SIMD3<Float>, to r: Observation) -> Float {
        let v = p - r.origin
        return simd_length(v - r.dir * simd_dot(v, r.dir))
    }

    static func maxAngle(_ rays: [Observation]) -> Float {
        var minDot: Float = 1
        for i in 0..<rays.count {
            for j in (i + 1)..<rays.count {
                minDot = min(minDot, simd_dot(rays[i].dir, rays[j].dir))
            }
        }
        return acos(max(-1, min(1, minDot)))
    }

    /// Best estimate for a single LED from everything seen of it.
    static func solve(_ obs: [Observation]) -> SolvedLED? {
        // 1. Triangulate from two or more viewpoints, discarding rays that disagree
        //    (a reflection in a bauble or window, or the camera being bumped).
        var rays = obs
        while rays.count >= 2, maxAngle(rays) >= minAngle {
            guard let p = closestPoint(to: rays) else { break }
            let dists = rays.map { distance(p, to: $0) }
            let worst = dists.indices.max { dists[$0] < dists[$1] }!
            if dists[worst] <= rayTolerance {
                let inFront = rays.allSatisfy { simd_dot(p - $0.origin, $0.dir) > 0.1 }
                if inFront { return SolvedLED(p: p, quality: .triangulated) }
                break
            }
            if rays.count == 2 { break }
            rays.remove(at: worst)
        }

        // 2. Otherwise fall back to LiDAR depth along a single ray.
        let hits = obs.compactMap { $0.lidar }
        if !hits.isEmpty {
            return SolvedLED(p: SIMD3(median(hits.map { $0.x }), median(hits.map { $0.y }), median(hits.map { $0.z })),
                             quality: .lidar)
        }
        return nil
    }

    static func median(_ v: [Float]) -> Float {
        let s = v.sorted()
        let n = s.count
        return n % 2 == 1 ? s[n / 2] : (s[n / 2 - 1] + s[n / 2]) / 2
    }

    /// Solves every LED, removes implausible results and fills the gaps.
    /// `strings` are the index ranges of each physical wire. `maxStep` is the furthest two
    /// neighbouring LEDs on a wire can be apart (metres); `limitIgnored` reports that it
    /// was clearly too small for this wire and was not applied.
    /// `fixed` are positions the user set by hand: they override measurements and are never rejected.
    static func solveAll(_ observations: [[Observation]], strings: [Range<Int>], maxStep: Float,
                         fixed: [Int: SIMD3<Float>] = [:])
        -> (leds: [SolvedLED?], limitIgnored: Bool) {
        var out: [SolvedLED?] = observations.map { solve($0) }
        for (i, p) in fixed where out.indices.contains(i) { out[i] = SolvedLED(p: p, quality: .triangulated) }
        let ignored = rejectUnreachable(&out, strings: strings, maxStep: maxStep)
        for (i, p) in fixed where out.indices.contains(i) { out[i] = SolvedLED(p: p, quality: .triangulated) }
        fillGaps(&out, strings: strings)
        return (out, ignored)
    }

    /// Steps along each wire and discards LEDs that can't be where they were measured:
    /// two LEDs k apart on the wire can never be more than k × `maxStep` apart in space.
    /// Rather than trusting whichever LED comes first, this keeps the longest run of LEDs
    /// that are all within reach of the one before them, so a single bad LED doesn't
    /// condemn the good ones after it. Returns true if the limit had to be ignored.
    @discardableResult
    static func rejectUnreachable(_ out: inout [SolvedLED?], strings: [Range<Int>], maxStep: Float) -> Bool {
        guard maxStep > 0 else { return false }
        var ignored = false
        for range in strings {
            let idx = range.filter { out[$0] != nil && out[$0]!.quality != .interpolated }
            guard idx.count >= 3 else { continue }
            var best = [Int](repeating: 1, count: idx.count)    // longest valid run ending at each LED
            var from = [Int](repeating: -1, count: idx.count)
            for a in 1..<idx.count {
                let pa = out[idx[a]]!.p
                var b = a - 1
                let lowest = max(0, a - 80)
                while b >= lowest {
                    if best[b] + 1 > best[a],
                       simd_distance(pa, out[idx[b]]!.p) <= maxStep * Float(idx[a] - idx[b]) {
                        best[a] = best[b] + 1
                        from[a] = b
                    }
                    b -= 1
                }
            }
            var end = best.indices.max { best[$0] < best[$1] }!
            if best[end] * 2 < idx.count {
                // Fewer than half fit: the limit is wrong for this wire, not the LEDs.
                ignored = true
                continue
            }
            var keep = Set<Int>()
            while end >= 0 {
                keep.insert(idx[end])
                end = from[end]
            }
            for i in idx where !keep.contains(i) { out[i] = nil }
        }
        return ignored
    }

    /// Fills unseen LEDs by interpolating between measured neighbours on the same wire.
    static func fillGaps(_ out: inout [SolvedLED?], strings: [Range<Int>]) {
        for range in strings {
            for i in range where out[i] == nil {
                let prev = nearestKnown(out, from: i, step: -1, in: range, maxGap: .max, measuredOnly: true)
                let next = nearestKnown(out, from: i, step: 1, in: range, maxGap: .max, measuredOnly: true)
                if let a = prev, let b = next {
                    let t = Float(i - a) / Float(b - a)
                    out[i] = SolvedLED(p: simd_mix(out[a]!.p, out[b]!.p, SIMD3(repeating: t)), quality: .interpolated)
                } else if let k = prev ?? next {
                    out[i] = SolvedLED(p: out[k]!.p, quality: .interpolated)
                }
            }
        }
    }

    /// Rotation about the vertical axis plus a translation, taking this scan's ARKit
    /// world coordinates into the plant's saved coordinates.
    struct Alignment {
        var cs: Float
        var sn: Float
        var t: SIMD3<Float>

        func toLocal(_ p: SIMD3<Float>) -> SIMD3<Float> {
            SIMD3(p.x * cs - p.z * sn, p.y, p.x * sn + p.z * cs) + t
        }
        func toWorld(_ q: SIMD3<Float>) -> SIMD3<Float> {
            let d = q - t
            return SIMD3(d.x * cs + d.z * sn, d.y, -d.x * sn + d.z * cs)
        }
    }

    /// Lines a new scan up with a saved one using LEDs located in both.
    /// Both spaces have Y up (gravity), so only a turn about Y and a shift are unknown.
    static func align(_ pairs: [(world: SIMD3<Float>, local: SIMD3<Float>)]) -> Alignment? {
        func fit(_ ps: [(world: SIMD3<Float>, local: SIMD3<Float>)]) -> Alignment {
            let n = Float(ps.count)
            let wc = ps.reduce(SIMD3<Float>(repeating: 0)) { $0 + $1.world } / n
            let lc = ps.reduce(SIMD3<Float>(repeating: 0)) { $0 + $1.local } / n
            var dotSum: Float = 0, crossSum: Float = 0
            for p in ps {
                let a = p.world - wc, b = p.local - lc
                dotSum += b.x * a.x + b.z * a.z
                crossSum += b.z * a.x - b.x * a.z
            }
            let th = atan2(crossSum, dotSum)
            var al = Alignment(cs: cos(th), sn: sin(th), t: SIMD3(repeating: 0))
            al.t = lc - al.toLocal(wc)
            return al
        }
        guard pairs.count >= 4 else { return nil }
        var al = fit(pairs)
        // Drop anchors that don't agree (a mis-detected LED), then fit again.
        let res = pairs.map { simd_distance(al.toLocal($0.world), $0.local) }
        let limit = max(0.08, 2.5 * median(res))
        let good = zip(pairs, res).filter { $0.1 <= limit }.map { $0.0 }
        guard good.count >= 4 else { return nil }
        al = fit(good)
        let rms = (good.reduce(Float(0)) { $0 + simd_distance_squared(al.toLocal($1.world), $1.local) } / Float(good.count)).squareRoot()
        return rms <= 0.08 ? al : nil
    }

    private static func nearestKnown(_ out: [SolvedLED?], from i: Int, step: Int, in range: Range<Int>,
                                     maxGap: Int, measuredOnly: Bool = false) -> Int? {
        var k = i + step
        var gap = 1
        while range.contains(k), gap <= maxGap {
            if let s = out[k], !measuredOnly || s.quality != .interpolated { return k }
            k += step
            gap += 1
        }
        return nil
    }

    /// Converts ARKit world coordinates to the plant's own space: origin on the ground
    /// under the middle of the plant, Y up, +Z pointing at where the user stood
    /// for the first pass (so "left to right" effects match what they see).
    static func treeSpace(_ world: [SolvedLED?], viewer: SIMD3<Float>?)
        -> (points: [SolvedLED?], height: Float, radius: Float)? {
        let measured = world.compactMap { $0 }.filter { $0.quality != .interpolated }
        guard !measured.isEmpty else { return nil }

        let n = Float(measured.count)
        let cx = measured.reduce(Float(0)) { $0 + $1.p.x } / n
        let cz = measured.reduce(Float(0)) { $0 + $1.p.z } / n
        let minY = measured.map { $0.p.y }.min()!

        var theta: Float = 0
        if let v = viewer {
            let dx = v.x - cx, dz = v.z - cz
            if dx * dx + dz * dz > 0.01 { theta = atan2(dx, dz) }
        }
        let c = cos(theta), s = sin(theta)

        var height: Float = 0.1, radius: Float = 0.05
        let pts: [SolvedLED?] = world.map { led in
            guard let led else { return nil }
            let x = led.p.x - cx, y = led.p.y - minY, z = led.p.z - cz
            let q = SIMD3<Float>(x * c - z * s, max(0, y), x * s + z * c)
            height = max(height, q.y)
            radius = max(radius, (q.x * q.x + q.z * q.z).squareRoot())
            return SolvedLED(p: q, quality: led.quality)
        }
        return (pts, height, radius)
    }
}
