import SwiftUI

/// Direction of travel for moving effects (Sweep, Meteor, Clouds...): the effect's default, a preset,
/// or turn/tilt sliders. As seen from the street. Shown as a Form section.
struct DirectionSection: View {
    @Binding var yaw: Double?
    @Binding var pitch: Double?
    let effect: LightEffect

    private var isDefault: Bool { yaw == nil || pitch == nil }
    private var camera: Bool { effect.usesView }
    private var presets: [EffectDirection.Preset] { camera ? EffectDirection.viewPresets : EffectDirection.presets }
    private let columns = [GridItem(.adaptive(minimum: 84), spacing: 8)]

    var body: some View {
        Section {
            LazyVGrid(columns: columns, spacing: 8) {
                chip("Default", selected: isDefault) { yaw = nil; pitch = nil }
                ForEach(presets) { p in
                    chip(p.name, selected: !isDefault && yaw == p.yaw && pitch == p.pitch) { yaw = p.yaw; pitch = p.pitch }
                }
            }
            .padding(.vertical, 4)
            if !isDefault {
                angle("Turn", "arrow.left.and.right", value: $yaw, range: 0...359)
                angle("Tilt", "arrow.up.and.down", value: $pitch, range: -90...90)
            }
        } header: {
            Text(camera ? "Camera" : "Direction")
        } footer: {
            if camera {
                Text(isDefault ? "Default: looking from the street. The picture is drawn as the camera sees it."
                               : "Turn moves the camera round the yard (90° is the street, 0° the left side); tilt −90° looks down from above. Needs firmware 1.7.")
            } else {
                Text(isDefault ? "Default: \(effect.dirDefault ?? "the effect's own movement")."
                               : "As seen from the street: turn 0° is right, 90° away from you, 270° towards you; tilt 90° is straight up. Needs firmware 1.6.")
            }
        }
    }

    private func chip(_ title: String, selected: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
                .font(.subheadline)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 8)
                .background(selected ? Color.accentColor.opacity(0.22) : Color.secondary.opacity(0.1),
                            in: RoundedRectangle(cornerRadius: 10))
                .overlay(RoundedRectangle(cornerRadius: 10).stroke(selected ? Color.accentColor : .clear, lineWidth: 2))
        }
        .buttonStyle(.borderless)
        .foregroundStyle(.primary)
    }

    private func angle(_ title: String, _ symbol: String, value: Binding<Double?>, range: ClosedRange<Double>) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack {
                Label(title, systemImage: symbol).font(.subheadline)
                Spacer()
                Text("\(Int(value.wrappedValue ?? 0))°").font(.subheadline).monospacedDigit().foregroundStyle(.secondary)
            }
            Slider(value: Binding(get: { value.wrappedValue ?? 0 }, set: { value.wrappedValue = $0.rounded() }),
                   in: range, step: 1)
        }
    }
}

/// Settings for an online effect (Marquee, Video): drawn by the ESPectacle server and streamed to the
/// lights, so server sync must be on. Videos are uploaded on the website.
struct OnlineEffectSection: View {
    @EnvironmentObject var sync: ServerSync
    let effect: LightEffect
    @Binding var text: String?
    @Binding var media: String?
    var target: Binding<Double?>? = nil
    @State private var videos: [String] = []

    var body: some View {
        Section {
            if effect.usesTarget, let target {
                Toggle("Christmas Day", isOn: Binding(get: { target.wrappedValue == nil },
                                                      set: { target.wrappedValue = $0 ? nil : (Date().addingTimeInterval(86400).timeIntervalSince1970 * 1000).rounded() }))
                if let ms = target.wrappedValue {
                    DatePicker("Count down to", selection: Binding(get: { Date(timeIntervalSince1970: ms / 1000) },
                                                                   set: { target.wrappedValue = ($0.timeIntervalSince1970 * 1000).rounded() }))
                }
            }
            if effect.usesText {
                TextField(effect.usesTarget ? "When it gets there: MERRY CHRISTMAS" : "Merry Christmas",
                          text: Binding(get: { text ?? "" }, set: { text = $0.isEmpty ? nil : $0 }))
            }
            if effect.usesMedia {
                Picker("Video", selection: Binding(get: { media ?? "" }, set: { media = $0.isEmpty ? nil : $0 })) {
                    Text("Choose…").tag("")
                    ForEach(videos, id: \.self) { Text($0).tag($0) }
                    if let m = media, !m.isEmpty, !videos.contains(m) { Text(m).tag(m) }
                }
            }
        } header: {
            Text(effect.usesTarget ? "Countdown" : effect.usesText ? "Text" : "Video")
        } footer: {
            if !sync.enabled {
                Text("Online effects are drawn by your ESPectacle server. Turn on server sync (Controllers → Server) to use them.")
                    .foregroundStyle(.orange)
            } else {
                Text(effect.usesMedia
                     ? "Upload videos on the ESPectacle website (Look tab → Video). Needs firmware 1.8."
                     : "Drawn by your ESPectacle server and streamed to the lights. Needs firmware 1.8.")
            }
        }
        .task(id: effect.id) {
            if effect.usesMedia { videos = await sync.mediaList() }
        }
    }
}
