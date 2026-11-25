import SwiftUI

/// Main control screen: pick an effect and tune it. Every change is sent to all controllers.
struct LightsView: View {
    @EnvironmentObject var store: TreeStore

    private var effect: LightEffect { LightEffect.named(store.data.state.fx) }
    private let columns = [GridItem(.adaptive(minimum: 96), spacing: 10)]

    var body: some View {
        NavigationStack {
            Form {
                if store.data.controllers.isEmpty {
                    Section {
                        Label("Add a controller on the Controllers tab to get started.", systemImage: "cpu")
                    }
                }

                Section {
                    Toggle("Power", isOn: $store.data.state.on)
                    slider("Brightness", "sun.max", value: $store.data.state.bri)
                }

                Section("Effect") {
                    LazyVGrid(columns: columns, spacing: 10) {
                        ForEach(LightEffect.all) { fx in
                            EffectButton(effect: fx, selected: fx.id == store.data.state.fx) {
                                if fx.usesView != effect.usesView {
                                    store.data.state.dirYaw = nil; store.data.state.dirPitch = nil
                                }
                                store.data.state.fx = fx.id
                            }
                        }
                    }
                    .padding(.vertical, 4)
                }

                if effect.usesPalette {
                    Section("Palette") {
                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack(spacing: 12) {
                                ForEach(ColorPalette.all) { pal in
                                    PaletteSwatch(palette: pal,
                                                  custom: [store.data.state.c1, store.data.state.c2],
                                                  selected: pal.id == store.data.state.pal) {
                                        store.data.state.pal = pal.id
                                    }
                                }
                            }
                            .padding(.vertical, 4)
                        }
                    }
                }

                Section("Adjust") {
                    if effect.usesColor1 || (effect.usesPalette && store.data.state.pal == 0) {
                        ColorPicker("Colour 1", selection: colorBinding(\.c1), supportsOpacity: false)
                    }
                    if effect.usesColor2 || (effect.usesPalette && store.data.state.pal == 0) {
                        ColorPicker("Colour 2", selection: colorBinding(\.c2), supportsOpacity: false)
                    }
                    if effect.id != 0 {
                        slider("Speed", "speedometer", value: $store.data.state.spd)
                    }
                    if let label = effect.scaleLabel {
                        slider(label, "slider.horizontal.3", value: $store.data.state.scl)
                    }
                }

                if effect.online {
                    OnlineEffectSection(effect: effect, text: $store.data.state.text, media: $store.data.state.media,
                                        target: $store.data.state.target)
                }
                if effect.hasDirSetting {
                    DirectionSection(yaw: $store.data.state.dirYaw, pitch: $store.data.state.dirPitch, effect: effect)
                }

                Section {
                    if effect.spatial && !store.layoutComplete && !store.data.controllers.isEmpty {
                        Label("This effect uses each LED's position. LEDs that aren't on a scanned prop run on a guessed layout.",
                              systemImage: "cube.transparent")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                    if let err = store.lastError {
                        Label(err, systemImage: "wifi.exclamationmark")
                            .font(.footnote)
                            .foregroundStyle(.orange)
                    }
                }
            }
            .navigationTitle("Lights")
            .onChange(of: store.data.state) {
                store.stateChanged()
            }
        }
    }

    private func slider(_ title: String, _ symbol: String, value: Binding<Int>) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Label(title, systemImage: symbol)
                .font(.subheadline)
            Slider(value: Binding(get: { Double(value.wrappedValue) },
                                  set: { value.wrappedValue = Int($0.rounded()) }),
                   in: 0...255)
        }
    }

    private func colorBinding(_ key: WritableKeyPath<LightState, Int>) -> Binding<Color> {
        Binding(get: { Color(hex: store.data.state[keyPath: key]) },
                set: { store.data.state[keyPath: key] = $0.hexRGB })
    }
}

struct EffectButton: View {
    let effect: LightEffect
    let selected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(spacing: 6) {
                Image(systemName: effect.symbol)
                    .font(.title2)
                    .frame(height: 28)
                Text(effect.name)
                    .font(.caption)
                    .lineLimit(1)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 10)
            .background(selected ? Color.accentColor.opacity(0.22) : Color.secondary.opacity(0.1),
                        in: RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12)
                .stroke(selected ? Color.accentColor : .clear, lineWidth: 2))
        }
        .buttonStyle(.plain)
    }
}

struct PaletteSwatch: View {
    let palette: ColorPalette
    let custom: [Int]
    let selected: Bool
    let action: () -> Void

    private var colors: [Color] {
        let hex = palette.id == 0 ? custom : palette.colors
        return (hex + [hex.first ?? 0]).map { Color(hex: $0) }
    }

    var body: some View {
        Button(action: action) {
            VStack(spacing: 4) {
                RoundedRectangle(cornerRadius: 8)
                    .fill(LinearGradient(colors: colors, startPoint: .leading, endPoint: .trailing))
                    .frame(width: 84, height: 36)
                    .overlay(RoundedRectangle(cornerRadius: 8)
                        .stroke(selected ? Color.accentColor : Color.secondary.opacity(0.3), lineWidth: selected ? 3 : 1))
                Text(palette.name)
                    .font(.caption2)
                    .foregroundStyle(selected ? .primary : .secondary)
            }
        }
        .buttonStyle(.plain)
    }
}
