import SwiftUI

/// Full-screen camera view that scans one plant and saves its map.
struct ScanView: View {
    let plantID: UUID
    var keepGood = false        // top up the saved map instead of starting again
    @EnvironmentObject var store: TreeStore
    @Environment(\.dismiss) private var dismiss
    @StateObject private var engine = ScanEngine()

    @State private var saving = false
    @State private var saveError: String?
    @State private var showSettings = false

    var body: some View {
        ZStack {
            ARViewContainer(engine: engine)
                .ignoresSafeArea()

            VStack(spacing: 0) {
                topBar
                Spacer()
                bottomPanel
            }
        }
        .onAppear { start() }
        .onDisappear { engine.stopSession() }
        .statusBarHidden()
    }

    // MARK: - Pieces

    private var topBar: some View {
        HStack(alignment: .top) {
            Button {
                dismiss()
            } label: {
                Image(systemName: "xmark")
                    .font(.headline)
                    .padding(10)
                    .background(.ultraThinMaterial, in: Circle())
            }
            Spacer()
            if !engine.trackingMessage.isEmpty {
                Label(engine.trackingMessage, systemImage: "exclamationmark.triangle.fill")
                    .font(.footnote.weight(.medium))
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(.ultraThinMaterial, in: Capsule())
            }
            Spacer()
            Button {
                showSettings.toggle()
            } label: {
                Image(systemName: "slider.horizontal.3")
                    .font(.headline)
                    .padding(10)
                    .background(.ultraThinMaterial, in: Circle())
            }
            .disabled(engine.passRunning)
        }
        .padding()
    }

    private var bottomPanel: some View {
        VStack(alignment: .leading, spacing: 12) {
            if showSettings && !engine.passRunning {
                settingsPanel
            }

            if let i = engine.manualIndex {
                manualPanel(i)
            } else if engine.passRunning {
                Text("Pass \(engine.passCount + 1) – hold steady, keep the whole prop in view")
                    .font(.subheadline.weight(.medium))
                ProgressView(value: engine.progress)
                HStack {
                    Text("\(engine.seenThisPass) LEDs seen")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    Spacer()
                    Button("Stop pass") { engine.cancelPass() }
                }
            } else {
                Text(instructions)
                    .font(.subheadline)

                if engine.passCount > 0 {
                    summaryRow
                    Text("Tap a green or yellow marker that's in the wrong place to discard it; it will be scanned again.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                if let err = engine.errorMessage ?? saveError {
                    Text(err)
                        .font(.footnote)
                        .foregroundStyle(.orange)
                }

                HStack(spacing: 12) {
                    Button {
                        engine.startPass()
                    } label: {
                        Label(engine.passCount == 0 ? "Scan from here" : "Scan another side", systemImage: "camera.viewfinder")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(!engine.trackingOK || saving)

                    if engine.resultsReady && engine.summary.measured > 0 {
                        Button {
                            save()
                        } label: {
                            Group {
                                if saving { ProgressView() } else { Text("Save map") }
                            }
                            .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.bordered)
                        .disabled(saving)
                    }
                }
                .controlSize(.large)

                Toggle(isOn: $engine.settings.flash) {
                    VStack(alignment: .leading, spacing: 1) {
                        Text("Flash each LED")
                            .font(.subheadline)
                        Text("Blinks each LED three times and only accepts it if it's seen in the same place. About five times slower, far fewer false readings.")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }
                Button {
                    showSettings = false
                    engine.enterManual()
                } label: {
                    Label("Place LEDs by hand", systemImage: "hand.draw")
                }
                .disabled(!engine.trackingOK || saving)
            }
        }
        .padding()
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 20))
        .padding()
    }

    private var instructions: String {
        if engine.passCount == 0 && keepGood {
            return "Only LEDs without a good position are scanned, plus a few good ones so the app can line this scan up with the saved one. Stand where some of those are visible."
        }
        if engine.passCount == 0 {
            return engine.hasLiDAR
                ? "Stand where the prop is normally viewed from, far enough back to fit all of it in view, then start the first pass."
                : "This phone has no LiDAR, so each LED must be seen from at least two sides. Start in front of the prop with all of it in view."
        }
        let s = engine.summary
        if s.triangulated == s.total { return "Every LED is located from two sides. Save the map." }
        if s.measured == s.total { return "Every LED located. Scan another side to turn the yellow ones green (green ones are skipped), or save." }
        return "Walk to another side of the prop (keep the camera pointing at it as you move) and scan again. Only LEDs that aren't green yet are lit."
    }

    private var summaryRow: some View {
        let s = engine.summary
        return HStack(spacing: 14) {
            stat("\(s.triangulated)", "good", .green)
            stat("\(s.lidar)", "LiDAR", .yellow)
            stat("\(s.interpolated + s.missing)", "not seen", .gray)
            Spacer()
            Text("\(s.measured)/\(s.total)")
                .font(.title3.monospacedDigit().weight(.semibold))
        }
    }

    /// Manual mode: one LED is lit on the plant and its marker can be dragged into place.
    private func manualPanel(_ i: Int) -> some View {
        let status: String
        switch engine.manualQuality {
        case .triangulated: status = "good"
        case .lidar: status = "LiDAR only"
        case .interpolated: status = "estimated"
        default: status = "not located"
        }
        return VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("LED \(i + 1) of \(engine.summary.total)")
                    .font(.headline.monospacedDigit())
                Text("· \(status)")
                    .font(.subheadline)
                    .foregroundStyle(engine.manualQuality == .triangulated ? Color.green : Color.orange)
                Spacer()
                Button("Done") { engine.exitManual() }
            }
            Text("This LED is lit on the prop. Drag the white marker onto it (or tap where it is). Then look from another side and drag again to set how far away it is.")
                .font(.footnote)
                .foregroundStyle(.secondary)
            HStack(spacing: 10) {
                Button {
                    engine.stepManual(-1)
                } label: {
                    Image(systemName: "chevron.left").frame(maxWidth: .infinity)
                }
                Button {
                    engine.commitManual()
                } label: {
                    Text("Looks right").frame(maxWidth: .infinity)
                }
                Button {
                    engine.nextProblem()
                } label: {
                    Text("Next problem").frame(maxWidth: .infinity)
                }
                Button {
                    engine.stepManual(1)
                } label: {
                    Image(systemName: "chevron.right").frame(maxWidth: .infinity)
                }
            }
            .buttonStyle(.bordered)
            .controlSize(.large)
        }
    }

    private func stat(_ value: String, _ label: String, _ color: Color) -> some View {
        HStack(spacing: 5) {
            Circle().fill(color).frame(width: 9, height: 9)
            VStack(alignment: .leading, spacing: 0) {
                Text(value).font(.subheadline.monospacedDigit().weight(.semibold))
                Text(label).font(.caption2).foregroundStyle(.secondary)
            }
        }
    }

    private var settingsPanel: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("LED brightness while scanning: \(engine.settings.ledValue)")
                .font(.footnote)
            Slider(value: intBinding(\.ledValue), in: 16...255)
            Text("Detection threshold: \(engine.settings.threshold)  (lower finds dimmer LEDs, higher ignores reflections)")
                .font(.footnote)
            Slider(value: intBinding(\.threshold), in: 15...120)
            Text("Settle time: \(Int(engine.settings.settle * 1000)) ms  (raise if LEDs are being missed or mixed up)")
                .font(.footnote)
            Slider(value: $engine.settings.settle, in: 0.04...0.4)
            Text("Furthest apart two neighbouring LEDs can be: \(Int(engine.settings.maxStepCm)) cm  (anything further is treated as a bad reading)")
                .font(.footnote)
            Slider(value: $engine.settings.maxStepCm, in: 3...50, step: 1)
            Divider()
        }
    }

    private func intBinding(_ key: WritableKeyPath<ScanSettings, Int>) -> Binding<Double> {
        Binding(get: { Double(engine.settings[keyPath: key]) },
                set: { engine.settings[keyPath: key] = Int($0.rounded()) })
    }

    // MARK: - Actions

    private var plant: Plant? { store.data.plants.first { $0.id == plantID } }

    private func start() {
        guard let plant else { return }
        // LED numbering within the plant: its strings one after another, then LEDs along each wire.
        var targets: [ScanTarget] = []
        var ranges: [Range<Int>] = []
        for ps in store.strings(of: plant) {
            let first = targets.count
            for i in 0..<ps.count {
                targets.append(ScanTarget(global: targets.count, host: ps.controller.host,
                                          string: ps.stringIndex, index: ps.start + i))
            }
            ranges.append(first..<targets.count)
        }
        var previous: [MappedLED] = []
        var keep = Set<Int>()
        if keepGood, let map = plant.map, store.mapIsCurrent(plant), map.leds.count == targets.count {
            previous = map.leds
            keep = Set(map.leds.indices.filter { map.leds[$0].isGood })
        }
        engine.startSession(targets: targets, strings: ranges, allHosts: store.data.controllers.map { $0.host },
                            previous: previous, keep: keep)
    }

    private func save() {
        guard let plant else { return }
        let map: PlantMap
        switch engine.buildMap(layout: store.layoutKey(of: plant)) {
        case .map(let m):
            map = m
        case .failure(let why):
            saveError = why
            return
        }
        saving = true
        saveError = nil
        engine.stopSession()        // hand the LEDs back before uploading
        Task {
            do {
                try await store.setMap(map, for: plantID)
                await store.pushState()
                dismiss()
            } catch {
                // The map is stored in the app even if a controller missed the upload.
                saveError = "Map saved, but not every controller received it: \(error.localizedDescription). Use “Send layout to controllers” on the Props tab."
                saving = false
            }
        }
    }
}
