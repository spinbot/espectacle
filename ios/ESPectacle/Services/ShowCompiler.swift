import Foundation

/// Turns a show's tracks into the flat segment list the controllers play:
/// for every zone (plant), which clip is showing when. Tracks lower in the list win where
/// they overlap; "All plants" tracks apply to every zone, plant tracks to their own zone.
enum ShowCompiler {
    struct Segment: Equatable {
        var zone: Int
        var t0: Int         // ms
        var t1: Int
        var p0: Int         // ms: when the clip's animation started (its start time)
        var fx, pal, bri, scl, rate: Int
        var c1, c2: Int
        var mode: Int           // 1: each plant on its own, 2: the group as one plant (FRAME_* in effects.h)
        var group: [Int]        // the group's box, seven integers (used with mode 2)
        var dir: [Int]? = nil   // direction of travel (4096 == 1), nil = the effect's default

        /// Nineteen integers, or twenty-three with the direction (hasDir, dx, dy, dz; firmware 1.6+).
        func ints(withDirection: Bool) -> [Int] {
            let base = [zone, t0, t1, p0, fx, pal, bri, scl, rate, c1, c2, mode] + group
            guard withDirection else { return base }
            return base + (dir.map { [1] + $0 } ?? [0, 0, 0, 0])
        }
    }

    /// One cycle takes 16777216 / rate ms on the controller (see FxParams.rate).
    static func rate(forCycle seconds: Double) -> Int {
        let ms = max(seconds, 0.001) * 1000
        return Int((16_777_216 / ms).rounded()).clamped(to: 1...65535)
    }

    /// `groupFrame` gives the box around a set of plants (empty: all plants).
    static func compile(_ show: Show, plants: [Plant], zoneOf: (Int) -> Int,
                        otherZone: Int, groupFrame: ([UUID]) -> [Int]) -> [Segment] {
        let unitFrame = [0, 0, 0, 2048, -2048, 4096, 2048]
        var frames: [UUID: [Int]] = [:]       // track id -> group box
        for t in show.tracks where t.together { frames[t.id] = groupFrame(t.targets) }

        // Zones in use: one per plant, plus the zone for LEDs that aren't on any plant.
        var zones: [(zone: Int, plant: UUID?)] = plants.enumerated().map { (zoneOf($0.offset), $0.element.id) }
        zones.append((otherZone, nil))
        var seenZone = Set<Int>()
        zones = zones.filter { seenZone.insert($0.zone).inserted }

        var out: [Segment] = []
        for (zone, plantID) in zones.sorted(by: { $0.zone < $1.zone }) {
            // Clips that can show on this zone, with their track priority.
            var clips: [(prio: Int, clip: ShowClip, track: ShowTrack)] = []
            for (prio, track) in show.tracks.enumerated() where !track.muted {
                // LEDs on no plant only follow "all plants" tracks.
                guard track.plays(on: plantID) && (plantID != nil || track.targets.isEmpty) else { continue }
                for c in track.clips where c.duration > 0.001 { clips.append((prio, c, track)) }
            }
            guard !clips.isEmpty else { continue }

            func ms(_ s: Double) -> Int { max(0, Int((s * 1000).rounded())) }
            var cuts = Set<Int>()
            for c in clips { cuts.insert(ms(c.clip.start)); cuts.insert(ms(c.clip.end)) }
            let times = cuts.sorted()

            for (a, b) in zip(times, times.dropFirst()) where b > a {
                // Highest priority wins; within a track, the clip that started later.
                let active = clips.filter { ms($0.clip.start) <= a && ms($0.clip.end) >= b }
                guard let win = active.max(by: { ($0.prio, $0.clip.start) < ($1.prio, $1.clip.start) }) else { continue }
                let c = win.clip
                let seg = Segment(zone: zone, t0: a, t1: b, p0: ms(c.start), fx: c.fx, pal: c.pal, bri: c.bri,
                                  scl: c.scl, rate: rate(forCycle: c.cycle(bpm: show.bpm)), c1: c.c1, c2: c.c2,
                                  mode: win.track.together ? 2 : 1,
                                  group: win.track.together ? (frames[win.track.id] ?? unitFrame) : unitFrame,
                                  dir: c.dirVector)
                if var last = out.last, last.zone == zone, last.t1 == a,
                   last.p0 == seg.p0, last.fx == seg.fx, last.pal == seg.pal, last.bri == seg.bri,
                   last.scl == seg.scl, last.rate == seg.rate, last.c1 == seg.c1, last.c2 == seg.c2,
                   last.mode == seg.mode, last.group == seg.group, last.dir == seg.dir {
                    last.t1 = b             // same clip continuing: extend
                    out[out.count - 1] = last
                } else {
                    out.append(seg)
                }
            }
        }
        return out
    }

    static func id(of segments: [Segment]) -> UInt32 {
        var h = FNV1a()
        let withDir = segments.contains { $0.dir != nil }
        for s in segments { for v in s.ints(withDirection: withDir) { h.add(v) } }
        return max(h.value, 1)
    }
}
