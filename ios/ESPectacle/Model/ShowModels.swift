import Foundation

/// Information about the yard scan. The points themselves live in `AreaStore`'s file.
struct AreaInfo: Codable, Equatable {
    var date = Date()
    var pointCount: Int
}

/// One block on a show timeline: an effect running between two times.
struct ShowClip: Codable, Identifiable, Equatable {
    var id = UUID()
    var start: Double               // seconds from the start of the music
    var duration: Double            // seconds
    var fx = 1
    var pal = 2
    var bri = 255
    var scl = 128
    var c1 = 0xFF0000
    var c2 = 0x00A000
    var beats: Double? = 4          // animation cycle length in beats (when the show has a tempo)
    var seconds: Double = 2         // animation cycle length in seconds (no tempo, or beats == nil)
    var dirYaw: Double? = nil       // direction of travel for moving effects (degrees); nil = effect default
    var dirPitch: Double? = nil
    var text: String? = nil         // online effects: marquee text
    var media: String? = nil        //   video file on the server
    var target: Double? = nil       //   countdown to (ms since 1970); nil = next Christmas

    /// The direction as the firmware's unit vector, when this clip's effect moves and one is set.
    var dirVector: [Int]? {
        guard LightEffect.named(fx).hasDirSetting, let y = dirYaw, let p = dirPitch else { return nil }
        return EffectDirection.vector(yaw: y, pitch: p)
    }

    var end: Double { start + duration }

    /// Animation cycle length in seconds for a show with the given tempo.
    func cycle(bpm: Double?) -> Double {
        if let b = beats, let bpm, bpm > 0 { return b * 60 / bpm }
        return seconds
    }
}

/// A row on the timeline. It plays on `targets` (empty means every plant).
/// Where tracks overlap, the one lower in the list wins.
struct ShowTrack: Codable, Identifiable, Equatable {
    var id = UUID()
    var targets: [UUID] = []
    /// false: every plant animates on its own, as if it were alone.
    /// true: the plants are treated as one big plant (spirals wrap the whole group, sweeps cross it).
    var together = false
    var muted = false
    var clips: [ShowClip] = []

    init() {}

    private enum CodingKeys: String, CodingKey { case id, targets, target, together, muted, clips }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decodeIfPresent(UUID.self, forKey: .id) ?? UUID()
        if let t = try c.decodeIfPresent([UUID].self, forKey: .targets) {
            targets = t
        } else if let old = try c.decodeIfPresent(UUID.self, forKey: .target) {
            targets = [old]                 // shows saved before tracks could have several plants
        }
        together = try c.decodeIfPresent(Bool.self, forKey: .together) ?? false
        muted = try c.decodeIfPresent(Bool.self, forKey: .muted) ?? false
        clips = try c.decodeIfPresent([ShowClip].self, forKey: .clips) ?? []
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(targets, forKey: .targets)
        try c.encode(together, forKey: .together)
        try c.encode(muted, forKey: .muted)
        try c.encode(clips, forKey: .clips)
    }

    func plays(on plant: UUID?) -> Bool {
        targets.isEmpty || (plant.map { targets.contains($0) } ?? false)
    }
}

struct Show: Codable, Identifiable, Equatable {
    var id = UUID()
    var name: String
    var audioFile: String?          // file name inside the app's Audio folder
    var audioName: String?          // original file name, for display
    var duration: Double = 60       // seconds (the music's length once loaded)
    var bpm: Double?
    var beatOffset: Double = 0      // seconds to the first beat
    var latencyMs: Double = 0       // extra delay applied to the lights (positive = lights later)
    var tracks: [ShowTrack] = [ShowTrack()]
}

/// Everything needed to carry the project to another device.
struct ProjectFile: Codable {
    var version = 1
    var data: AppData
    var area: Data?                 // contents of the yard scan file
    var audio: [String: Data] = [:] // audio file name -> contents
}
