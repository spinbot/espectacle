import SwiftUI
import ARKit

/// One plant: which LED strings are on it, its scanned shape, and where it stands in the yard.
struct PlantDetailView: View {
    @EnvironmentObject var store: TreeStore
    @Environment(\.dismiss) private var dismiss
    let plantID: UUID

    @State private var scan: ScanRequest?

    private struct ScanRequest: Identifiable {
        let keepGood: Bool
        var id: Bool { keepGood }
    }
    @State private var plantAtOpen: Plant?

    private var index: Int? { store.data.plants.firstIndex { $0.id == plantID } }

    var body: some View {
        Form {
            if let i = index {
                content($store.data.plants[i])
            }
        }
        .navigationTitle(index.map { store.data.plants[$0].name } ?? "Prop")
        .navigationBarTitleDisplayMode(.inline)
        .fullScreenCover(item: $scan) { request in
            ScanView(plantID: plantID, keepGood: request.keepGood)
        }
        .onAppear {
            if let i = index { plantAtOpen = store.data.plants[i] }
        }
        .onDisappear {
            // Moving, re-wiring or reshaping a plant changes the controllers' geometry.
            guard let i = index, store.data.plants[i] != plantAtOpen else { return }
            Task { try? await store.uploadLayout(onlyIfChanged: true) }
        }
    }

    @ViewBuilder
    private func content(_ plant: Binding<Plant>) -> some View {
        let p = plant.wrappedValue
        let strings = store.strings(of: p)
        let online = !strings.isEmpty && strings.allSatisfy { store.isOnline($0.controller) }

        Section("Name") {
            TextField("Name", text: plant.name)
        }

        if let shape = p.shape {
            ShapeEditorSections(shape: Binding(get: { plant.wrappedValue.shape ?? shape },
                                               set: { plant.wrappedValue.shape = $0
                                                      plant.wrappedValue.map = ShapeGenerator.map(for: $0) }),
                                ledCount: p.map?.leds.count ?? 0)
            if let map = p.map {
                Section {
                    TreePreviewView(map: PreviewCloud(points: map.leds, height: map.height, radius: map.radius)) { _ in }
                        .frame(height: 240)
                        .listRowInsets(EdgeInsets())
                }
            }
        }

        if usesRanges(p) {
            rangesSection(plant)
        } else {
            Section {
                ForEach(store.data.controllers) { c in
                    ForEach(Array(c.strings.enumerated()), id: \.offset) { si, s in
                        stringRow(controller: c, stringIndex: si, string: s)
                    }
                }
                if store.data.controllers.isEmpty {
                    Text("No controllers yet.")
                        .foregroundStyle(.secondary)
                }
                Button {
                    var parts = strings.map { PlantPart(controller: $0.controller.id, string: $0.stringIndex, start: 0, count: $0.count) }
                    if parts.isEmpty, let next = store.nextFreePart(for: p) { parts = [next] }
                    plant.wrappedValue.parts = parts
                } label: {
                    Label("Use LED ranges instead", systemImage: "line.3.horizontal.decrease")
                }
            } header: {
                Text("LED strings on this prop")
            } footer: {
                Text("Tap to add or remove a string. A string belongs to one prop. A scan follows its LEDs, so you can move them to another controller or string without scanning again, as long as the same LEDs stay in the same order. Use LED ranges when several props share one string.")
            }
        }

        if p.shape == nil {
            Section {
                if let map = p.map, store.mapIsCurrent(p) {
                    TreePreviewView(map: PreviewCloud(points: map.leds, height: map.height, radius: map.radius)) { i in
                        // Tap a green LED to un-flag it (orange); tap again to flag it as good again.
                        store.toggleRescan(plant: plantID, led: i)
                    }
                    .frame(height: 260)
                    .listRowInsets(EdgeInsets())
                    LabeledContent("Scanned", value: map.date.formatted(date: .abbreviated, time: .shortened))
                    LabeledContent("Size", value: String(format: "%.2f m tall, %.2f m wide", map.height, map.radius * 2))
                    LabeledContent("Good (green)", value: "\(map.leds.filter { $0.isGood }.count) of \(map.leds.count)")
                    if map.leds.contains(where: { $0.rescan == true }) {
                        LabeledContent("Un-flagged (orange)", value: "\(map.leds.filter { $0.rescan == true }.count)")
                    }
                } else if let map = p.map {
                    let n = store.ledCount(of: p), m = map.leds.count
                    Label(map.portable == true
                          ? "Give this prop \(m) LEDs (it has \(n)) to use its shape, or scan it."
                          : "It's wired to \(n) LEDs but the scan has \(m). Say which LEDs changed, or scan it again.",
                          systemImage: "exclamationmark.triangle")
                        .foregroundStyle(.orange)
                    if map.portable != true, n > 0 {
                        if n < m {
                            Button("Use the first \(n) (shortened at the far end)") { store.fitMap(of: plantID, keepStart: true) }
                            Button("Use the last \(n) (shortened where the data goes in)") { store.fitMap(of: plantID, keepStart: false) }
                        } else {
                            Button("Add \(n - m) at the far end") { store.fitMap(of: plantID, keepStart: true) }
                            Button("Add \(n - m) where the data goes in") { store.fitMap(of: plantID, keepStart: false) }
                        }
                    }
                }
                if let map = p.map, store.mapIsCurrent(p) {
                    let good = map.leds.filter { $0.isGood }.count
                    if good >= 4 && good < map.leds.count {
                        Button {
                            scan = ScanRequest(keepGood: true)
                        } label: {
                            Label("Scan the \(map.leds.count - good) LEDs that aren't green", systemImage: "camera.viewfinder")
                        }
                        .disabled(!online || !ARWorldTrackingConfiguration.isSupported)
                    }
                }
                Button {
                    scan = ScanRequest(keepGood: false)
                } label: {
                    Label(p.map == nil ? "Scan this prop" : "Scan everything again", systemImage: "arrow.triangle.2.circlepath.camera")
                }
                .disabled(!online || !ARWorldTrackingConfiguration.isSupported)
                if let map = p.map, map.portable != true, store.mapIsCurrent(p) {
                    Button("Reverse LED order") { store.reverseMap(of: plantID) }
                }
                if p.map != nil {
                    Button("Delete scan", role: .destructive) {
                        plant.wrappedValue.map = nil
                        Task { try? await store.uploadLayout() }
                    }
                }
            } header: {
                Text("Shape")
            } footer: {
                if strings.isEmpty {
                    Text("Assign at least one LED string first.")
                } else if !online {
                    Text("This prop's controllers must be online to scan it.")
                } else {
                    Text("Green LEDs have a good position and are skipped by the top-up scan. Tap a green LED in the preview to un-flag it (it turns orange) if it looks wrong; tap again to undo. Keep some light on while scanning so the phone can track its position – dusk works well outdoors.")
                }
            }

        }

        Section {
            axisRow("X (right)", plant.x)
            axisRow("Y (up)", plant.y)
            axisRow("Z (towards you)", plant.z)
            Stepper(value: plant.rotation, in: -180...180, step: 15) {
                HStack {
                    Text("Rotation")
                    Spacer()
                    Text("\(Int(p.rotation))°")
                        .foregroundStyle(.secondary)
                }
            }
        } header: {
            Text("Position in yard")
        } footer: {
            Text("Where the centre of the prop's base is, in metres from any fixed point you choose (a corner of the yard, or the first prop). Looking at the yard from the front, X runs to the right and Z comes towards you. The prop's own front is where you stood for the first scan pass; positive rotation turns that front to the right.")
        }

        Section {
            Button {
                store.clonePlant(plantID)
                dismiss()
            } label: {
                Label("Clone this prop", systemImage: "plus.square.on.square")
            }
            .disabled(p.map == nil)
        } footer: {
            Text("Makes a copy with the same shape, half a metre to the right. Give the copy its own LEDs with LED ranges (or strings) – no need to scan it.")
        }
    }

    /// Drawn shapes, clones and plants that share strings are wired with LED ranges.
    private func usesRanges(_ p: Plant) -> Bool {
        !(p.parts ?? []).isEmpty || (p.parts != nil && store.strings(of: p).isEmpty) || p.shape != nil
    }

    private func rangesSection(_ plant: Binding<Plant>) -> some View {
        let p = plant.wrappedValue
        let parts = Binding<[PlantPart]>(get: { plant.wrappedValue.parts ?? [] }, set: { plant.wrappedValue.parts = $0 })
        let wired = store.ledCount(of: p), wanted = p.map?.leds.count ?? 0
        let clash = store.overlaps(of: p)
        return Section {
            ForEach(parts.wrappedValue.indices, id: \.self) { k in
                PlantPartRow(part: Binding(get: { k < parts.wrappedValue.count ? parts.wrappedValue[k]
                                                                               : PlantPart(controller: "", string: 0, start: 0, count: 1) },
                                           set: { if k < parts.wrappedValue.count { parts.wrappedValue[k] = $0 } }),
                             controllers: store.data.controllers)
            }
            .onDelete { parts.wrappedValue.remove(atOffsets: $0) }
            Button {
                if let next = store.nextFreePart(for: p) { parts.wrappedValue.append(next) }
            } label: {
                Label("Add LED range", systemImage: "plus")
            }
            .disabled(store.data.controllers.isEmpty)
            if p.map != nil, wired != wanted, !parts.wrappedValue.isEmpty {
                Button("Make the last range fit (\(wanted) LEDs)") {
                    var list = parts.wrappedValue
                    list[list.count - 1].count = max(1, list[list.count - 1].count + wanted - wired)
                    parts.wrappedValue = list
                }
            }
        } header: {
            Text("LED ranges")
        } footer: {
            VStack(alignment: .leading, spacing: 4) {
                if p.map != nil && wired != wanted {
                    Text("The ranges add up to \(wired) LEDs but the \(p.shape == nil ? "prop" : "shape") has \(wanted).")
                        .foregroundStyle(.orange)
                } else if wired > 0 {
                    Text("\(wired) LEDs.")
                }
                if !clash.isEmpty {
                    Text("Shares LEDs with \(clash.joined(separator: ", ")).").foregroundStyle(.orange)
                }
                Text("LEDs are numbered from 1 along each string; the ranges run one after another, in this order. Swipe to remove one.")
            }
        }
    }

    private func stringRow(controller c: Controller, stringIndex si: Int, string s: LEDString) -> some View {
        let mine = s.plantID == plantID
        let other = s.plantID.flatMap { id in id == plantID ? nil : store.data.plants.first { $0.id == id }?.name }
        return Button {
            store.setPlant(mine ? nil : plantID, controllerID: c.id, stringIndex: si)
        } label: {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text("\(c.name) · string \(si + 1)")
                        .foregroundStyle(.primary)
                    Text("GPIO \(s.pin) · \(s.count) LEDs" + (other.map { " · on \($0)" } ?? ""))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                if mine {
                    Image(systemName: "checkmark")
                        .foregroundStyle(.tint)
                }
            }
        }
    }

    private func axisRow(_ label: String, _ value: Binding<Float>) -> some View {
        HStack {
            Text(label)
            Spacer()
            TextField("0", value: value, format: .number.precision(.fractionLength(2)))
                .keyboardType(.numbersAndPunctuation)
                .multilineTextAlignment(.trailing)
                .frame(width: 80)
            Text("m")
                .foregroundStyle(.secondary)
            Stepper(label, value: value, in: -100...100, step: 0.1)
                .labelsHidden()
        }
    }
}
