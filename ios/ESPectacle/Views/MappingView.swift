import SwiftUI

/// The Plants tab: every plant in the yard, a 3D preview of the whole layout,
/// and the way in to scanning and placing each plant.
struct MappingView: View {
    @EnvironmentObject var store: TreeStore
    @State private var busy = false
    @State private var message: String?
    @State private var showXLights = false

    private var unassigned: Int { store.unassignedLEDs }

    private var frontBinding: Binding<Float> {
        Binding(get: { store.data.yard?.front ?? 0 },
                set: { v in
                    var y = store.data.yard ?? YardSettings()
                    y.front = v.rounded()
                    store.data.yard = y
                })
    }

    private var frontText: String {
        let v = Int(store.data.yard?.front ?? 0)
        return v == 0 ? "straight ahead" : "\(abs(v))° \(v > 0 ? "right" : "left")"
    }

    private func sendLayout() {
        Task { try? await store.uploadLayout(onlyIfChanged: true) }
    }

    var body: some View {
        NavigationStack {
            List {
                if let yard = store.yardPreview() {
                    Section {
                        TreePreviewView(map: yard.cloud) { i in
                            guard yard.refs.indices.contains(i) else { return }
                            store.toggleRescan(plant: yard.refs[i].plant, led: yard.refs[i].led)
                        }
                        .frame(height: 300)
                        .listRowInsets(EdgeInsets())
                    } footer: {
                        Text("The whole yard. Drag to rotate, pinch to zoom; the white dot marks the street side. Green: seen from two or more sides. Yellow: placed with LiDAR. Grey: estimated. Tap a green LED to un-flag it (orange) so the next top-up scan locates it again.")
                    }
                }

                Section {
                    VStack(alignment: .leading, spacing: 4) {
                        HStack {
                            Label("Street direction", systemImage: "location.north.line")
                            Spacer()
                            Text(frontText).foregroundStyle(.secondary).monospacedDigit()
                        }
                        Slider(value: frontBinding, in: -180...180, step: 1,
                               onEditingChanged: { editing in if !editing { sendLayout() } })
                    }
                    Stepper("Fine tune", value: frontBinding, in: -180...180, step: 1,
                            onEditingChanged: { editing in if !editing { sendLayout() } })
                } header: {
                    Text("Yard")
                } footer: {
                    Text("Turn until the street side of the yard faces the white dot in the preview above. Effect directions and camera views (Street, Left side, Right…) are measured from it. No LED moves and nothing needs scanning again.")
                }

                Section {
                    ForEach(store.data.plants) { plant in
                        NavigationLink {
                            PlantDetailView(plantID: plant.id)
                        } label: {
                            PlantRow(plant: plant, leds: store.ledCount(of: plant), current: store.mapIsCurrent(plant))
                        }
                    }
                    .onDelete { offsets in
                        for id in offsets.map({ store.data.plants[$0].id }) { store.removePlant(id) }
                    }
                    Menu {
                        Button {
                            store.addPlant()
                        } label: {
                            Label("Prop to scan", systemImage: "camera.viewfinder")
                        }
                        Section("Drawn shape") {
                            ForEach(ShapeKind.allCases) { kind in
                                Button {
                                    store.addShapePlant(kind)
                                } label: {
                                    Label(kind.name, systemImage: kind.symbol)
                                }
                            }
                        }
                    } label: {
                        Label("Add prop", systemImage: "plus")
                    }
                } header: {
                    Text("Props")
                } footer: {
                    if store.data.controllers.isEmpty {
                        Text("Add a controller first, then create a prop for each thing you've decorated.")
                    } else if unassigned > 0 {
                        Text("\(unassigned) LED\(unassigned == 1 ? " isn't" : "s aren't") on a prop yet.")
                    }
                }

                if !store.data.plants.isEmpty {
                    Section {
                        Button {
                            upload()
                        } label: {
                            HStack {
                                Label("Send layout to controllers", systemImage: "arrow.up.circle")
                                if busy { Spacer(); ProgressView() }
                            }
                        }
                        .disabled(busy)
                        Button {
                            showXLights = true
                        } label: {
                            Label("Export to xLights…", systemImage: "square.and.arrow.up.on.square")
                        }
                    } footer: {
                        if let message { Text(message) }
                    }
                }

                Section("How it works") {
                    Text("""
                    1. Add a plant and choose which LED strings are on it.
                    2. Scan it: the app lights that plant's LEDs one at a time and finds them with the camera. Every other plant stays dark.
                    3. Place it: enter where the plant stands in the yard (X = right, Y = up, Z = towards you, in metres, from any reference point you like).

                    Spiral, Beam, Gradient and similar effects wrap each plant individually. Sweep, Plasma and Pulse travel across the whole yard using the placements.
                    """)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                }
            }
            .navigationTitle("Props")
            .sheet(isPresented: $showXLights) { XLightsExportView() }
        }
    }

    private func upload() {
        busy = true
        message = nil
        Task {
            do {
                try await store.uploadLayout()
                message = "Layout sent."
            } catch {
                message = error.localizedDescription
            }
            busy = false
        }
    }
}

private struct PlantRow: View {
    let plant: Plant
    let leds: Int
    let current: Bool

    private var status: String {
        let want = plant.map?.leds.count ?? 0
        if let shape = plant.shape {
            if current { return "\(shape.kind.name) · \(leds) LEDs" }
            return leds == 0 ? "\(shape.kind.name) · not wired (\(want) LEDs)" : "\(shape.kind.name) · wired \(leds) of \(want) LEDs"
        }
        if leds == 0 { return plant.map?.portable == true ? "Copy · needs \(want) LEDs" : "No LED strings assigned" }
        if current { return "\(leds) LEDs · " + (plant.map?.portable == true ? "copied shape" : "scanned") }
        if plant.map?.portable == true { return "Copy · wired \(leds) of \(want) LEDs" }
        return plant.map == nil ? "\(leds) LEDs · not scanned" : "wired \(leds) of \(want) scanned LEDs"
    }

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: plant.shape.map { $0.kind.symbol } ?? (current ? "tree.fill" : "tree"))
                .foregroundStyle(current ? Color.green : Color.secondary)
            VStack(alignment: .leading, spacing: 2) {
                Text(plant.name)
                Text(status + String(format: " · at %.1f, %.1f, %.1f m", plant.x, plant.y, plant.z))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }
}
