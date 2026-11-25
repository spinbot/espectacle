import SwiftUI
import ARKit

/// Walk around the yard to capture it in 3D, and aim at the base of each plant to place it.
struct YardScanView: View {
    @EnvironmentObject var store: TreeStore
    @Environment(\.dismiss) private var dismiss
    @StateObject private var engine = YardScanEngine()
    @State private var selected: UUID?
    @State private var saving = false
    @State private var error: String?

    /// Plants that have a scanned shape and so can be placed.
    private var placeable: [Plant] { store.data.plants.filter { store.mapIsCurrent($0) } }

    var body: some View {
        ZStack {
            ARSceneContainer(view: engine.sceneView)
                .ignoresSafeArea()

            Image(systemName: "plus")
                .font(.system(size: 34, weight: .light))
                .foregroundStyle(.white)
                .shadow(radius: 2)

            VStack(spacing: 0) {
                topBar
                Spacer()
                panel
            }
        }
        .onAppear {
            let colours = store.data.plants.enumerated().map { ($0.element, PointCloudGeometry.plantColor($0.offset)) }
            engine.start(plants: colours.filter { store.mapIsCurrent($0.0) })
            selected = placeable.first?.id
        }
        .onDisappear { engine.stop() }
        .statusBarHidden()
    }

    private var topBar: some View {
        HStack {
            Button { dismiss() } label: {
                Image(systemName: "xmark").font(.headline).padding(10)
                    .background(.ultraThinMaterial, in: Circle())
            }
            Spacer()
            if !engine.trackingMessage.isEmpty {
                Label(engine.trackingMessage, systemImage: "exclamationmark.triangle.fill")
                    .font(.footnote.weight(.medium))
                    .padding(.horizontal, 12).padding(.vertical, 8)
                    .background(.ultraThinMaterial, in: Capsule())
            }
            Spacer()
        }
        .padding()
    }

    private var panel: some View {
        VStack(alignment: .leading, spacing: 12) {
            if engine.hasLiDAR {
                HStack {
                    Toggle(isOn: $engine.capturing) {
                        VStack(alignment: .leading, spacing: 1) {
                            Text("Capture yard").font(.subheadline.weight(.medium))
                            Text("\(engine.pointCount.formatted()) points" +
                                 (engine.pointCount >= YardScanEngine.maxPoints ? " (full)" : ""))
                                .font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    Button("Clear") { engine.clearPoints() }
                        .buttonStyle(.bordered)
                }
                Text("Walk slowly around, pointing at everything you want in the 3D view. LiDAR reaches about 5 m.")
                    .font(.caption).foregroundStyle(.secondary)
            } else {
                Text("This device has no LiDAR, so the yard itself can't be captured – but you can still place props.")
                    .font(.caption).foregroundStyle(.secondary)
            }

            Divider()

            if placeable.isEmpty {
                Text("Scan some props on the Props tab first, then come back to place them.")
                    .font(.footnote)
            } else {
                HStack {
                    Picker("Prop", selection: $selected) {
                        ForEach(placeable) { p in
                            Label(p.name, systemImage: engine.placements[p.id] != nil ? "checkmark.circle.fill" : "circle")
                                .tag(Optional(p.id))
                        }
                    }
                    .pickerStyle(.menu)
                    Spacer()
                    Button {
                        if let id = selected {
                            let current = store.data.plants.first { $0.id == id }?.rotation ?? 0
                            engine.placeAtCrosshair(id, defaultRotation: current)
                        }
                    } label: {
                        Label("Base is here", systemImage: "scope")
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(selected == nil || !engine.frameReady)
                }
                if let id = selected, let p = engine.placements[id] {
                    HStack {
                        Text("Turn").font(.footnote)
                        Slider(value: Binding(get: { Double(p.rotation) },
                                              set: { engine.setRotation(id, Float($0.rounded())) }),
                               in: -180...180)
                        Text("\(Int(p.rotation))°").font(.footnote.monospacedDigit()).frame(width: 44)
                    }
                    Text("Turn the prop until its coloured LED dots sit over the real lights.")
                        .font(.caption).foregroundStyle(.secondary)
                } else {
                    Text("Aim the crosshair at the ground right at the prop's trunk or centre, then tap “Base is here”.")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }

            if let msg = engine.message ?? error {
                Text(msg).font(.footnote).foregroundStyle(.orange)
            }

            Button {
                save()
            } label: {
                Group { if saving { ProgressView() } else { Text("Save") } }
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .disabled(saving || (engine.pointCount == 0 && engine.placements.isEmpty))
        }
        .padding()
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 20))
        .padding()
        .frame(maxWidth: 560)
    }

    private func save() {
        saving = true
        let r = engine.result()
        engine.stop()
        do {
            if let area = r.area {
                try AreaStore.save(area)
                store.data.area = AreaInfo(pointCount: area.count)
            } else {
                // A new scan has new axes, so an old point cloud would no longer line up.
                AreaStore.delete()
                store.data.area = nil
            }
        } catch {
            self.error = "Couldn't save the yard scan: \(error.localizedDescription)"
            saving = false
            return
        }
        for (id, p) in r.placements {
            guard let i = store.data.plants.firstIndex(where: { $0.id == id }) else { continue }
            store.data.plants[i].x = (p.position.x * 100).rounded() / 100
            store.data.plants[i].y = (p.position.y * 100).rounded() / 100
            store.data.plants[i].z = (p.position.z * 100).rounded() / 100
            store.data.plants[i].rotation = p.rotation
        }
        Task {
            try? await store.uploadLayout()
            dismiss()
        }
    }
}
