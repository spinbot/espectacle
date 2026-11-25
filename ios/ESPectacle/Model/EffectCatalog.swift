import SwiftUI

/// Effects built into the firmware. Ids must match `fxPixel()` in effects.cpp.
struct LightEffect: Identifiable {
    let id: Int
    let name: String
    let symbol: String
    var usesPalette = true
    var usesColor1 = false
    var usesColor2 = false
    var scaleLabel: String? = nil
    var spatial = true      // looks best once the plants have been scanned
    var usesDirection = false   // moves in a direction you can choose (firmware 1.6+)
    var dirDefault: String? = nil   // what it does without a chosen direction
    var usesView = false        // a 2D picture seen from a camera; the direction is where it looks (firmware 1.7+)

    var online = false          // drawn by the server and streamed to the lights (firmware 1.8+)
    var usesText = false
    var usesMedia = false
    var usesTarget = false      // countdown: a date and time to count down to

    /// Moving effects have a direction of travel; 2D effects have a camera. Both are stored as dirYaw/dirPitch.
    var hasDirSetting: Bool { usesDirection || usesView }

    static let all: [LightEffect] = [
        LightEffect(id: 0, name: "Solid", symbol: "circle.fill", usesPalette: false, usesColor1: true, spatial: false),
        LightEffect(id: 1, name: "Gradient", symbol: "arrow.up.to.line", scaleLabel: "Repeats", usesDirection: true, dirDefault: "Up each prop"),
        LightEffect(id: 2, name: "Spiral", symbol: "tornado", scaleLabel: "Twists"),
        LightEffect(id: 3, name: "Stripes", symbol: "line.diagonal", usesPalette: false, usesColor1: true, usesColor2: true, scaleLabel: "Twists"),
        LightEffect(id: 4, name: "Sweep", symbol: "rectangle.portrait.and.arrow.right", scaleLabel: "Thickness", usesDirection: true, dirDefault: "Random each pass"),
        LightEffect(id: 5, name: "Rings", symbol: "circle.circle", scaleLabel: "Rings", usesDirection: true, dirDefault: "Up each prop"),
        LightEffect(id: 6, name: "Beam", symbol: "light.beacon.max", scaleLabel: "Beam width"),
        LightEffect(id: 7, name: "Pulse", symbol: "dot.radiowaves.left.and.right", scaleLabel: "Rings"),
        LightEffect(id: 8, name: "Twinkle", symbol: "sparkles", scaleLabel: "Density", spatial: false),
        LightEffect(id: 9, name: "Glitter", symbol: "sparkle", scaleLabel: "Sparkle"),
        LightEffect(id: 10, name: "Plasma", symbol: "aqi.medium", scaleLabel: "Detail", usesDirection: true, dirDefault: "Swirl in place"),
        LightEffect(id: 11, name: "Fire", symbol: "flame", usesPalette: false, scaleLabel: "Height"),
        LightEffect(id: 12, name: "Snow", symbol: "snowflake", usesPalette: false, usesColor1: true, usesColor2: true, scaleLabel: "Flake size"),
        LightEffect(id: 13, name: "Chase", symbol: "arrow.right.to.line", scaleLabel: "Spacing", spatial: false),
        LightEffect(id: 14, name: "Flash", symbol: "bolt.fill", scaleLabel: "Decay", spatial: false),
        LightEffect(id: 15, name: "Meteor", symbol: "moon.stars", scaleLabel: "Lane width", usesDirection: true, dirDefault: "Falling"),
        LightEffect(id: 16, name: "Ripple", symbol: "drop.circle", scaleLabel: "Thickness"),
        LightEffect(id: 17, name: "Spin", symbol: "arrow.triangle.2.circlepath", scaleLabel: "Twists", usesDirection: true, dirDefault: "Around the vertical"),
        LightEffect(id: 18, name: "Clouds", symbol: "cloud", scaleLabel: "Cloud size", usesDirection: true, dirDefault: "Drift right"),
        // 2D pictures seen from a camera
        LightEffect(id: 19, name: "Bars", symbol: "chart.bar.fill", scaleLabel: "Bars", usesView: true),
        LightEffect(id: 20, name: "Wave", symbol: "water.waves", scaleLabel: "Thickness", usesView: true),
        LightEffect(id: 21, name: "Radar", symbol: "dot.radiowaves.up.forward", scaleLabel: "Trail", usesView: true),
        LightEffect(id: 22, name: "Tunnel", symbol: "circle.dotted.circle", scaleLabel: "Rings", usesView: true),
        LightEffect(id: 23, name: "Checker", symbol: "checkerboard.rectangle", usesPalette: false, usesColor1: true, usesColor2: true,
                    scaleLabel: "Square size", usesView: true),
        // Online: drawn by the ESPectacle server (needs server sync) and streamed to the lights
        LightEffect(id: 200, name: "Marquee", symbol: "textformat", scaleLabel: "Text size", usesView: true,
                    online: true, usesText: true),
        LightEffect(id: 201, name: "Video", symbol: "play.rectangle", usesPalette: false, scaleLabel: "Zoom", usesView: true,
                    online: true, usesMedia: true),
        LightEffect(id: 202, name: "Countdown", symbol: "calendar.badge.clock", scaleLabel: "Text size", usesView: true,
                    online: true, usesText: true, usesTarget: true),
    ]

    static func named(_ id: Int) -> LightEffect { all.first { $0.id == id } ?? all[0] }
}

/// Direction of travel for moving effects, as seen from the street:
/// yaw 0 = right (+X), 90 = away (-Z), 180 = left, 270 = towards you (+Z); pitch +90 = up.
enum EffectDirection {
    static func vector(yaw: Double, pitch: Double) -> [Int] {
        let y = yaw * .pi / 180, p = pitch * .pi / 180
        return [cos(p) * cos(y), sin(p), -cos(p) * sin(y)].map { Int(($0 * 4096).rounded()) }
    }

    struct Preset: Identifiable { let name: String; let yaw: Double; let pitch: Double; var id: String { name } }

    static let presets: [Preset] = [
        Preset(name: "Up", yaw: 0, pitch: 90), Preset(name: "Down", yaw: 0, pitch: -90),
        Preset(name: "Right", yaw: 0, pitch: 0), Preset(name: "Left", yaw: 180, pitch: 0),
        Preset(name: "Away", yaw: 90, pitch: 0), Preset(name: "Towards", yaw: 270, pitch: 0),
    ]

    /// Camera positions for 2D effects (the direction is where the camera looks).
    static let viewPresets: [Preset] = [
        Preset(name: "Street", yaw: 90, pitch: 0), Preset(name: "Behind", yaw: 270, pitch: 0),
        Preset(name: "Left side", yaw: 0, pitch: 0), Preset(name: "Right side", yaw: 180, pitch: 0),
        Preset(name: "Above", yaw: 90, pitch: -90), Preset(name: "Below", yaw: 90, pitch: 90),
    ]
}

/// Palettes built into the firmware. Ids and colours must match `PALS` in effects.cpp.
struct ColorPalette: Identifiable {
    let id: Int
    let name: String
    let colors: [Int]

    static let all: [ColorPalette] = [
        ColorPalette(id: 0, name: "Custom", colors: []),
        ColorPalette(id: 1, name: "Rainbow", colors: [0xFF0000, 0xFFD000, 0x00FF00, 0x00E0FF, 0x0000FF, 0xFF00C0]),
        ColorPalette(id: 2, name: "Christmas", colors: [0xE00000, 0x008A00, 0xFFFFFF, 0x008A00]),
        ColorPalette(id: 3, name: "Ice", colors: [0x001850, 0x0060FF, 0x80E0FF, 0xFFFFFF]),
        ColorPalette(id: 4, name: "Fire", colors: [0x400000, 0xFF2000, 0xFFA000, 0xFFF080]),
        ColorPalette(id: 5, name: "Candy cane", colors: [0xFF0000, 0xFF0000, 0xFFFFFF, 0xFFFFFF]),
        ColorPalette(id: 6, name: "Warm gold", colors: [0xFF8A18, 0xFFC850, 0xFF5A00]),
        ColorPalette(id: 7, name: "Aurora", colors: [0x00FF60, 0x00A0FF, 0x7000FF, 0x00FFC0, 0x0040A0]),
    ]
}

extension Color {
    init(hex: Int) {
        self.init(.sRGB,
                  red: Double((hex >> 16) & 0xFF) / 255,
                  green: Double((hex >> 8) & 0xFF) / 255,
                  blue: Double(hex & 0xFF) / 255,
                  opacity: 1)
    }

    var hexRGB: Int {
        var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
        UIColor(self).getRed(&r, green: &g, blue: &b, alpha: &a)
        func c(_ v: CGFloat) -> Int { Int((min(max(v, 0), 1) * 255).rounded()) }
        return (c(r) << 16) | (c(g) << 8) | c(b)
    }
}
