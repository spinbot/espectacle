import SwiftUI
import UniformTypeIdentifiers

/// Edits one clip on the show timeline.
struct ClipInspectorView: View {
    @Binding var clip: ShowClip
    var bpm: Double?
    var beatOffset: Double
    var onDuplicate: () -> Void
    var onDelete: () -> Void
    var onPlayFrom: () -> Void

    private var effect: LightEffect { LightEffect.named(clip.fx) }
    private let columns = [GridItem(.adaptive(minimum: 74), spacing: 8)]
    private static let beatChoices: [Double] = [0.5, 1, 2, 4, 8, 16, 32]

    var body: some View {
        Form {
            Section("Effect") {
                LazyVGrid(columns: columns, spacing: 8) {
                    ForEach(LightEffect.all) { fx in
                        EffectButton(effect: fx, selected: fx.id == clip.fx) {
                            // A direction of travel and a camera view mean different things: start afresh.
                            if fx.usesView != effect.usesView { clip.dirYaw = nil; clip.dirPitch = nil }
                            clip.fx = fx.id
                        }
                    }
                }
                .padding(.vertical, 4)
            }

            if effect.usesPalette {
                Section("Palette") {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 10) {
                            ForEach(ColorPalette.all) { pal in
                                PaletteSwatch(palette: pal, custom: [clip.c1, clip.c2], selected: pal.id == clip.pal) {
                                    clip.pal = pal.id
                                }
                            }
                        }
                        .padding(.vertical, 4)
                    }
                }
            }

            Section("Look") {
                if effect.usesColor1 || (effect.usesPalette && clip.pal == 0) {
                    ColorPicker("Colour 1", selection: colour(\.c1), supportsOpacity: false)
                }
                if effect.usesColor2 || (effect.usesPalette && clip.pal == 0) {
                    ColorPicker("Colour 2", selection: colour(\.c2), supportsOpacity: false)
                }
                slider("Brightness", value: $clip.bri)
                if let label = effect.scaleLabel {
                    slider(label, value: $clip.scl)
                }
            }

            if effect.online {
                OnlineEffectSection(effect: effect, text: $clip.text, media: $clip.media, target: $clip.target)
            }
            if effect.hasDirSetting {
                DirectionSection(yaw: $clip.dirYaw, pitch: $clip.dirPitch, effect: effect)
            }

            if clip.fx != 0 {
                Section {
                    if let bpm, bpm > 0 {
                        Picker("Cycle", selection: Binding(get: { clip.beats ?? 0 }, set: { clip.beats = $0 == 0 ? nil : $0 })) {
                            ForEach(Self.beatChoices.filter { $0 * 60 / bpm >= 0.26 }, id: \.self) { b in
                                Text(b == 1 ? "1 beat" : b < 1 ? "½ beat" : "\(Int(b)) beats").tag(b)
                            }
                            Text("Free").tag(0.0)
                        }
                    }
                    if clip.beats == nil || bpm == nil {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(String(format: "Cycle: %.2f s", clip.seconds)).font(.subheadline)
                            Slider(value: Binding(get: { log(clip.seconds) }, set: { clip.seconds = (exp($0) * 100).rounded() / 100 }),
                                   in: log(0.3)...log(30))
                        }
                    }
                } header: {
                    Text("Speed")
                } footer: {
                    Text(clip.fx == 14 ? "Flash fires at the start of every cycle – set it to 1 beat to flash on the beat."
                                       : "How long one cycle of the animation takes. Each clip starts its animation fresh.")
                }
            }

            Section("Timing") {
                timeRow("Start", $clip.start)
                timeRow("Length", $clip.duration, minimum: 0.1)
                if let bpm, bpm > 0 {
                    Text(String(format: "Starts on beat %.2f · %.2f beats long",
                                (clip.start - beatOffset) * bpm / 60 + 1, clip.duration * bpm / 60))
                        .font(.caption).foregroundStyle(.secondary)
                }
            }

            Section {
                Button("Play from this clip", action: onPlayFrom)
                Button("Duplicate", action: onDuplicate)
                Button("Delete clip", role: .destructive, action: onDelete)
                    .keyboardShortcut(.delete, modifiers: [])
            }
        }
    }

    private func slider(_ title: String, value: Binding<Int>) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title).font(.subheadline)
            Slider(value: Binding(get: { Double(value.wrappedValue) }, set: { value.wrappedValue = Int($0.rounded()) }),
                   in: 0...255)
        }
    }

    private func colour(_ key: WritableKeyPath<ShowClip, Int>) -> Binding<Color> {
        Binding(get: { Color(hex: clip[keyPath: key]) }, set: { clip[keyPath: key] = $0.hexRGB })
    }

    private func timeRow(_ label: String, _ value: Binding<Double>, minimum: Double = 0) -> some View {
        let step = bpm.map { 60 / $0 } ?? 0.25
        return HStack {
            Text(label)
            Spacer()
            TextField("0", value: value, format: .number.precision(.fractionLength(2)))
                .keyboardType(.decimalPad)
                .multilineTextAlignment(.trailing)
                .frame(width: 70)
            Text("s").foregroundStyle(.secondary)
            Stepper(label, onIncrement: { value.wrappedValue += step },
                    onDecrement: { value.wrappedValue = max(minimum, value.wrappedValue - step) })
                .labelsHidden()
        }
    }
}

/// Name, music, tempo and timing trim for a show.
struct ShowSettingsView: View {
    @Binding var show: Show
    var analysis: AudioAnalysis?
    var playhead: Double
    @Environment(\.dismiss) private var dismiss
    @State private var picking = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                Section("Name") {
                    TextField("Name", text: $show.name)
                }

                Section {
                    LabeledContent("Music", value: show.audioName ?? "None")
                    Button(show.audioFile == nil ? "Choose music…" : "Replace music…") { picking = true }
                    if show.audioFile != nil {
                        Button("Remove music", role: .destructive) {
                            if let a = show.audioFile { AudioStore.delete(a) }
                            show.audioFile = nil
                            show.audioName = nil
                        }
                    } else {
                        Stepper(value: $show.duration, in: 5...3600, step: 5) {
                            LabeledContent("Length", value: ShowEditorView.clock(show.duration))
                        }
                    }
                    if let error { Text(error).foregroundStyle(.orange) }
                } header: {
                    Text("Music")
                } footer: {
                    Text("MP3, M4A, WAV or AIFF. The music plays from this device – connect it to a speaker.")
                }

                Section {
                    HStack {
                        Text("Tempo")
                        Spacer()
                        TextField("BPM", value: Binding(get: { show.bpm ?? 0 }, set: { show.bpm = $0 > 0 ? $0 : nil }),
                                  format: .number.precision(.fractionLength(1)))
                            .keyboardType(.decimalPad)
                            .multilineTextAlignment(.trailing)
                            .frame(width: 80)
                        Text("BPM").foregroundStyle(.secondary)
                    }
                    HStack {
                        Button("Half") { show.bpm = show.bpm.map { $0 / 2 } }
                        Spacer()
                        Button("Double") { show.bpm = show.bpm.map { $0 * 2 } }
                        Spacer()
                        Button("Detect") {
                            if let a = analysis, let b = a.bpm { show.bpm = b; show.beatOffset = a.beatOffset }
                        }
                        .disabled(analysis?.bpm == nil)
                    }
                    .buttonStyle(.borderless)
                    HStack {
                        Text("First beat at")
                        Spacer()
                        TextField("0", value: $show.beatOffset, format: .number.precision(.fractionLength(2)))
                            .keyboardType(.decimalPad)
                            .multilineTextAlignment(.trailing)
                            .frame(width: 70)
                        Text("s").foregroundStyle(.secondary)
                    }
                    Button("Put a beat at the playhead (\(ShowEditorView.clock(playhead)))") {
                        if let bpm = show.bpm, bpm > 0 {
                            let beat = 60 / bpm
                            show.beatOffset = playhead.truncatingRemainder(dividingBy: beat)
                        } else {
                            show.beatOffset = playhead
                        }
                    }
                    Button("No tempo (free timing)") { show.bpm = nil }
                } header: {
                    Text("Beat grid")
                } footer: {
                    Text("The tempo is detected when music is loaded. If the grid lines don't sit on the beats, try Half or Double, or play to a strong beat, pause, and put a beat at the playhead.")
                }

                Section {
                    VStack(alignment: .leading) {
                        Text("Lights delay: \(Int(show.latencyMs)) ms")
                        Slider(value: $show.latencyMs, in: -500...500, step: 10)
                    }
                } header: {
                    Text("Sync")
                } footer: {
                    Text("If the lights run ahead of the music (common with Bluetooth or AirPlay speakers), increase the delay; if they lag, decrease it.")
                }
            }
            .navigationTitle("Show settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
            .fileImporter(isPresented: $picking, allowedContentTypes: [.mp3, .audio]) { result in
                switch result {
                case .success(let url):
                    do {
                        let name = try AudioStore.importFile(url)
                        if let old = show.audioFile { AudioStore.delete(old) }
                        show.audioFile = name
                        show.audioName = url.deletingPathExtension().lastPathComponent
                        show.bpm = nil              // detected afresh for the new music
                        show.beatOffset = 0
                    } catch {
                        self.error = "Couldn't import: \(error.localizedDescription)"
                    }
                case .failure(let e):
                    error = e.localizedDescription
                }
            }
        }
    }
}
