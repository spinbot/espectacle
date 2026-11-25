import Foundation

/// One physical run of LEDs on one GPIO pin of a controller.
struct LEDString: Codable, Identifiable, Equatable {
    var id = UUID()
    var pin: Int = 16
    var count: Int = 50
    var order: String = "GRB"
    var plantID: UUID?          // which plant this string decorates (app-side only)

    /// The usual orders first, then every other RGBW order (firmware 1.11+ accepts any of them).
    static let orders: [String] = {
        let common = ["GRB", "RGB", "BRG", "RBG", "GBR", "BGR", "GRBW", "RGBW"]
        func perms(_ s: [Character]) -> [String] {
            s.count <= 1 ? [String(s)] : s.indices.flatMap { i -> [String] in
                var rest = s
                let c = rest.remove(at: i)
                return perms(rest).map { String(c) + $0 }
            }
        }
        return common + perms(Array("RGBW")).filter { !common.contains($0) }
    }()
    /// GPIOs that are safe to drive LEDs from on an ESP32-S2 (matches the firmware). Firmware 1.5+
    /// reports its own list (`DeviceInfo.pins`), which is used instead – e.g. for ESP32-S3 boards.
    static let validPins: [Int] = Array(1...18) + [21] + Array(33...45)

    private enum CodingKeys: String, CodingKey { case pin, count, order, plantID }
}

/// An ESP32 controller in the yard.
struct Controller: Codable, Identifiable, Equatable {
    var id: String              // device id reported by the firmware
    var name: String
    var host: String            // IP address or mDNS name
    var strings: [LEDString]
    var maxMilliamps: Int

    var totalLEDs: Int { strings.reduce(0) { $0 + $1.count } }
}

/// Animation settings. Field names match the firmware's JSON.
struct LightState: Codable, Equatable {
    var on = true
    var fx = 1
    var pal = 1
    var bri = 128
    var spd = 96
    var scl = 128
    var c1 = 0xFF0000
    var c2 = 0x00A000
    /// Direction of travel for moving effects (degrees, see `EffectDirection`); nil = the effect's default.
    var dirYaw: Double? = nil
    var dirPitch: Double? = nil
    var text: String? = nil     // online effects: marquee text
    var media: String? = nil    //   video file on the server
    var target: Double? = nil   //   countdown to (ms since 1970); nil = next Christmas

    /// The direction as the firmware's unit vector (4096 == 1), when this effect moves and one is set.
    var dirVector: [Int]? {
        guard LightEffect.named(fx).hasDirSetting, let y = dirYaw, let p = dirPitch else { return nil }
        return EffectDirection.vector(yaw: y, pitch: p)
    }
}

enum MapQuality: Int, Codable {
    case unknown = 0          // never seen, nothing to estimate from
    case interpolated = 1   // estimated from neighbours on the wire
    case lidar = 2          // one camera ray + LiDAR depth
    case triangulated = 3   // two or more camera rays from different viewpoints
}

/// One LED in its plant's own space (metres): origin on the ground under the middle
/// of the plant, Y up, +Z towards where the user stood for the first scan pass.
struct MappedLED: Codable, Equatable {
    var x: Float
    var y: Float
    var z: Float
    var quality: MapQuality
    var rescan: Bool?           // user un-flagged this LED: locate it again on the next scan

    /// A position good enough to keep when the plant is scanned again.
    var isGood: Bool { quality == .triangulated && rescan != true }
}

/// The scanned shape of one plant.
struct PlantMap: Codable, Equatable {
    var date = Date()
    var height: Float           // metres
    var radius: Float           // metres
    var layout: [String]        // the wiring when it was scanned (information only: any wiring with the same LED count works)
    var leds: [MappedLED]       // in wiring order: the prop's strings (or ranges) one after another
    /// A clone or a drawn shape rather than a scan of these LEDs.
    var portable: Bool? = nil

    func count(of q: MapQuality) -> Int { leds.filter { $0.quality == q }.count }
}

/// A plant (or tree, or any object) that is scanned on its own and then placed in the yard.
struct Plant: Codable, Identifiable, Equatable {
    var id = UUID()
    var name: String
    var x: Float = 0            // metres: position of the plant's base in the yard
    var y: Float = 0            //   x = right, y = up, z = towards the viewer
    var z: Float = 0
    var rotation: Float = 0     // degrees about the vertical axis
    var map: PlantMap?
    /// When set (and not empty), the plant's LEDs are these ranges, in order, instead of the whole
    /// strings assigned to it. Lets several plants share one string.
    var parts: [PlantPart]?
    /// A drawn shape (grid, cone, arch...) instead of a scanned one; its map is generated from this.
    var shape: PlantShape?
}

/// A range of LEDs on one controller string.
struct PlantPart: Codable, Equatable, Hashable {
    var controller: String      // controller id
    var string: Int             // string index on that controller
    var start: Int              // first LED on the string, from 0
    var count: Int
}

enum ShapeKind: String, Codable, CaseIterable, Identifiable {
    case panel, grid, cone, polyline, circle, arch
    var id: String { rawValue }
    var name: String {
        switch self {
        case .panel: return "Panel (matrix)"
        case .grid: return "Grid"
        case .cone: return "Cone (mega tree)"
        case .polyline: return "Polyline"
        case .circle: return "Circle"
        case .arch: return "Arch"
        }
    }
    var symbol: String {
        switch self {
        case .panel: return "square.grid.4x3.fill"
        case .grid: return "square.grid.3x3"
        case .cone: return "triangle"
        case .polyline: return "point.topleft.down.to.point.bottomright.curvepath"
        case .circle: return "circle"
        case .arch: return "rainbow"
        }
    }
}

struct ShapePoint: Codable, Equatable, Hashable {
    var x: Float
    var y: Float
    var z: Float
}

/// A drawn plant. Sizes in metres; LEDs are spread evenly along it. `start` is where the data comes in:
/// grid "bottomLeft" / "bottomRight" / "topLeft" / "topRight"; cone "bottom" / "top"; arch "left" / "right".
/// Same fields as PlantShape in server/shared/project.ts.
struct PlantShape: Codable, Equatable {
    var kind: ShapeKind
    var count = 50              // LEDs (grid: rows x columns; cone strands: a multiple of the strand count)
    var perMetre: Float?        // when set, the count follows from the length (not for grids)
    var width: Float = 1        // grid width, arch span, circle diameter, cone bottom diameter
    var height: Float = 1       // grid / arch / cone height
    var topWidth: Float = 0     // cone top diameter
    var rows = 10               // grid rows
    var columns = 10            // grid columns, cone strands
    var start = "left"
    var vertical = false        // grid: wired up and down the columns
    var zigzag = true           // grid rows / cone strands alternate direction
    var spiral = false          // cone: one wire wrapped round instead of strands
    var turns: Float = 6
    var flat = false            // circle lying flat (else standing up, facing the street)
    var startAngle: Float = 270 // circle: degrees; 0 = right, 90 = top (away from the street when flat)
    var clockwise = false
    var reverse = false         // polyline: start at the last point
    var points: [ShapePoint] = []
    // panel: matrix panels of rows x columns each, tiled tilesX x tilesY, chained from the start corner
    // along rows of panels; pitch = LED spacing in metres.
    var pitch: Float = 0.01
    var tilesX = 1
    var tilesY = 1

    init(kind: ShapeKind) {
        self.kind = kind
        switch kind {
        case .grid: width = 1; height = 0.6; rows = 12; columns = 20; count = 240; start = "bottomLeft"
        case .cone: width = 1.2; height = 2; columns = 16; count = 800; start = "bottom"
        case .polyline: count = 60; perMetre = 30; points = [ShapePoint(x: -1, y: 0, z: 0), ShapePoint(x: 1, y: 0, z: 0)]
        case .circle: width = 0.6; count = 60
        case .arch: width = 1.5; height = 0.8; count = 50; start = "left"
        case .panel: rows = 8; columns = 32; count = 256; start = "topLeft"; vertical = true; zigzag = true
        }
    }

    // Every field is optional when reading, so a shape written by an older or newer app or the website loads.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(kind: try c.decode(ShapeKind.self, forKey: .kind))
        count = try c.decodeIfPresent(Int.self, forKey: .count) ?? count
        perMetre = try c.decodeIfPresent(Float.self, forKey: .perMetre)
        width = try c.decodeIfPresent(Float.self, forKey: .width) ?? width
        height = try c.decodeIfPresent(Float.self, forKey: .height) ?? height
        topWidth = try c.decodeIfPresent(Float.self, forKey: .topWidth) ?? topWidth
        rows = try c.decodeIfPresent(Int.self, forKey: .rows) ?? rows
        columns = try c.decodeIfPresent(Int.self, forKey: .columns) ?? columns
        start = try c.decodeIfPresent(String.self, forKey: .start) ?? start
        vertical = try c.decodeIfPresent(Bool.self, forKey: .vertical) ?? vertical
        zigzag = try c.decodeIfPresent(Bool.self, forKey: .zigzag) ?? zigzag
        spiral = try c.decodeIfPresent(Bool.self, forKey: .spiral) ?? spiral
        turns = try c.decodeIfPresent(Float.self, forKey: .turns) ?? turns
        flat = try c.decodeIfPresent(Bool.self, forKey: .flat) ?? flat
        startAngle = try c.decodeIfPresent(Float.self, forKey: .startAngle) ?? startAngle
        clockwise = try c.decodeIfPresent(Bool.self, forKey: .clockwise) ?? clockwise
        reverse = try c.decodeIfPresent(Bool.self, forKey: .reverse) ?? reverse
        if c.contains(.points) { points = try c.decodeIfPresent([ShapePoint].self, forKey: .points) ?? [] }
        pitch = try c.decodeIfPresent(Float.self, forKey: .pitch) ?? pitch
        tilesX = try c.decodeIfPresent(Int.self, forKey: .tilesX) ?? tilesX
        tilesY = try c.decodeIfPresent(Int.self, forKey: .tilesY) ?? tilesY
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(kind, forKey: .kind); try c.encode(count, forKey: .count)
        try c.encode(perMetre, forKey: .perMetre)           // null when not set (the website expects the key)
        try c.encode(width, forKey: .width); try c.encode(height, forKey: .height); try c.encode(topWidth, forKey: .topWidth)
        try c.encode(rows, forKey: .rows); try c.encode(columns, forKey: .columns); try c.encode(start, forKey: .start)
        try c.encode(vertical, forKey: .vertical); try c.encode(zigzag, forKey: .zigzag); try c.encode(spiral, forKey: .spiral)
        try c.encode(turns, forKey: .turns); try c.encode(flat, forKey: .flat); try c.encode(startAngle, forKey: .startAngle)
        try c.encode(clockwise, forKey: .clockwise); try c.encode(reverse, forKey: .reverse); try c.encode(points, forKey: .points)
        if kind == .panel { try c.encode(pitch, forKey: .pitch); try c.encode(tilesX, forKey: .tilesX); try c.encode(tilesY, forKey: .tilesY) }
    }

    private enum CodingKeys: String, CodingKey {
        case kind, count, perMetre, width, height, topWidth, rows, columns, start, vertical, zigzag, spiral, turns
        case flat, startAngle, clockwise, reverse, points, pitch, tilesX, tilesY
    }
}

struct AppData: Codable {
    var controllers: [Controller] = []
    var state = LightState()
    var plants: [Plant] = []
    var area: AreaInfo?         // the LiDAR scan of the whole yard (points are stored in their own file)
    var shows: [Show] = []
    var yard: YardSettings?
    var schedule: ScheduleSettings?     // edited on the website, run by the server

    init() {}

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        controllers = try c.decodeIfPresent([Controller].self, forKey: .controllers) ?? []
        state = try c.decodeIfPresent(LightState.self, forKey: .state) ?? LightState()
        plants = try c.decodeIfPresent([Plant].self, forKey: .plants) ?? []
        area = try c.decodeIfPresent(AreaInfo.self, forKey: .area)
        shows = try c.decodeIfPresent([Show].self, forKey: .shows) ?? []
        yard = try c.decodeIfPresent(YardSettings.self, forKey: .yard)
        schedule = try c.decodeIfPresent(ScheduleSettings.self, forKey: .schedule)
    }
}

/// Schedules (server/shared/schedule.ts): the server plays the listed shows on the real lights on the
/// chosen days between two times. The app only keeps them so it never drops them when it saves.
struct ScheduleSettings: Codable, Equatable {
    var enabled = true
    var timeZone = TimeZone.current.identifier
    var items: [ScheduleItem] = []

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        enabled = try c.decodeIfPresent(Bool.self, forKey: .enabled) ?? true
        timeZone = try c.decodeIfPresent(String.self, forKey: .timeZone) ?? TimeZone.current.identifier
        items = try c.decodeIfPresent([ScheduleItem].self, forKey: .items) ?? []
    }
    private enum CodingKeys: String, CodingKey { case enabled, timeZone, items }
}

struct ScheduleItem: Codable, Equatable, Identifiable {
    var id: String
    var name = "Schedule"
    var enabled = true
    var days: [Int] = []        // 0 = Sunday ... 6 = Saturday
    var start = "18:30"         // "HH:MM"
    var end = "22:00"           // at or before start: runs past midnight
    var shows: [String] = []    // show ids, played in order, looping
    var after = "off"           // "off" or "look"

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decodeIfPresent(String.self, forKey: .id) ?? UUID().uuidString
        name = try c.decodeIfPresent(String.self, forKey: .name) ?? name
        enabled = try c.decodeIfPresent(Bool.self, forKey: .enabled) ?? enabled
        days = try c.decodeIfPresent([Int].self, forKey: .days) ?? days
        start = try c.decodeIfPresent(String.self, forKey: .start) ?? start
        end = try c.decodeIfPresent(String.self, forKey: .end) ?? end
        shows = try c.decodeIfPresent([String].self, forKey: .shows) ?? shows
        after = try c.decodeIfPresent(String.self, forKey: .after) ?? after
    }
    private enum CodingKeys: String, CodingKey { case id, name, enabled, days, start, end, shows, after }
}

/// Yard-wide settings (same as YardSettings in server/shared/project.ts).
struct YardSettings: Codable, Equatable {
    /// Degrees the street side is turned from the yard scan's +Z (positive turns it to the right, like a
    /// plant's rotation). Effect directions and camera views are measured from it.
    var front: Float = 0
}

/// Points for the 3D preview: origin on the ground at the centre, Y up.
struct PreviewCloud: Equatable {
    var points: [MappedLED]
    var height: Float
    var radius: Float
}

// MARK: - Firmware JSON

struct DeviceInfo: Codable {
    struct StringInfo: Codable {
        var pin: Int
        var count: Int
        var order: String
    }
    var id: String
    var name: String
    var fw: String?
    var ip: String?
    var ap: Bool?
    var ssid: String?
    var rssi: Int?
    var total: Int
    var mapped: Bool?
    var maxMilliamps: Int?
    var ntp: Bool?
    var strings: [StringInfo]
    var state: LightState?
    var up: Double?             // uptime clock (ms), firmware 1.2+
    var geoId: UInt32?          // id of the geometry the app last uploaded
    var showId: UInt32?
    var playing: Bool?
    var channels: Int?          // DDP channels (3 per LED), firmware 1.4+
    var ddp: Bool?              // xLights (DDP) is driving the LEDs right now
    var chip: String?           // e.g. "ESP32-S3", firmware 1.5+
    var psram: Int?             // bytes
    var pins: [Int]?            // GPIOs this controller allows for LED data, firmware 1.5+

    /// True when the firmware understands per-plant zones (1.2.0 or later).
    var supportsShows: Bool { firmwareAtLeast(1, 2) }
    /// Firmware 1.3 adds plant frames, so show tracks can animate plants separately or as one.
    var supportsGroups: Bool { firmwareAtLeast(1, 3) }
    /// Firmware 1.6 adds a chosen direction for moving effects, and Meteor, Ripple, Spin and Clouds.
    var supportsDirections: Bool { firmwareAtLeast(1, 6) }
    /// Firmware 1.7 adds the 2D camera effects (Bars, Wave, Radar, Tunnel, Checker).
    var supportsCamera: Bool { firmwareAtLeast(1, 7) }
    /// Firmware 1.8 shows online effects (Marquee, Video) streamed by the server.
    var supportsOnline: Bool { firmwareAtLeast(1, 8) }

    func firmwareAtLeast(_ major: Int, _ minor: Int) -> Bool {
        let v = (fw ?? "0").split(separator: ".").compactMap { Int($0) } + [0, 0, 0]
        return v[0] > major || (v[0] == major && v[1] >= minor)
    }
}

struct WiFiNetwork: Codable, Identifiable, Hashable {
    var ssid: String
    var rssi: Int
    var secure: Bool
    var id: String { ssid }
}
