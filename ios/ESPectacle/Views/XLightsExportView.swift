import SwiftUI

/// Exports the scanned plants as xLights custom models, and shows how to set the controllers
/// up in xLights so it can drive the LEDs directly (DDP).
struct XLightsExportView: View {
    @EnvironmentObject var store: TreeStore
    @Environment(\.dismiss) private var dismiss
    @State private var cellMM = 30
    @State private var includeYard = true
    @State private var results: [XLightsExport.Result] = []
    @State private var files: [URL]?
    @State private var error: String?

    private static let cellChoices = [10, 20, 30, 50, 100]

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Picker("Grid size", selection: $cellMM) {
                        ForEach(Self.cellChoices, id: \.self) { Text("\($0 / 10) cm").tag($0) }
                    }
                    Toggle("Also export the whole yard as one model", isOn: $includeYard)
                } footer: {
                    Text("xLights stores custom models as a 3D grid, so each LED is rounded to the nearest grid point. A finer grid is more accurate but makes bigger models; LEDs closer together than the grid are nudged to a free neighbouring point.")
                }

                Section("Models") {
                    if results.isEmpty {
                        Text("No scanned props yet.").foregroundStyle(.secondary)
                    }
                    ForEach(results, id: \.name) { r in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(r.name)
                            Text("\(r.nodes) LEDs · grid \(r.width)×\(r.height)×\(r.depth)" +
                                 (r.moved > 0 ? " · \(r.moved) nudged" : ""))
                                .font(.caption).foregroundStyle(.secondary)
                            if r.cells > 2_000_000 {
                                Text("Very large grid – xLights may be slow with it. Try a coarser grid.")
                                    .font(.caption).foregroundStyle(.orange)
                            }
                        }
                    }
                    Button("Export .xmodel files…") { export() }
                        .disabled(results.isEmpty)
                    if let error { Text(error).foregroundStyle(.orange) }
                }

                Section {
                    ForEach(store.data.controllers) { c in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(c.name).font(.subheadline.weight(.medium))
                            Text("DDP · \(store.online[c.id]?.ip ?? c.host) · \(c.totalLEDs * 3) channels")
                                .font(.caption.monospaced())
                                .textSelection(.enabled)
                        }
                    }
                } header: {
                    Text("Controllers in xLights")
                } footer: {
                    Text("""
                    In xLights → Controllers, add an Ethernet controller for each one above: protocol DDP, its IP address, and the channel count shown. Give it exactly the same name, so the exported models pick up the right start channels. Then Import Model (Layout tab) each .xmodel file.

                    While xLights is sending data the controller shows it instead of its own effects, and goes back to them a couple of seconds after xLights stops. Needs firmware 1.4.
                    """)
                }
            }
            .navigationTitle("Export to xLights")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .onAppear { rebuild() }
            .onChange(of: cellMM) { rebuild() }
            .onChange(of: includeYard) { rebuild() }
            .sheet(item: Binding(get: { files.map { Files(urls: $0) } }, set: { files = $0?.urls })) { f in
                ActivityView(urls: f.urls)
            }
        }
    }

    private struct Files: Identifiable {
        var urls: [URL]
        var id: String { urls.map { $0.path }.joined() }
    }

    private func rebuild() {
        let src = store.xlightsSources()
        let cell = Float(cellMM) / 1000
        var list = src.plants.map { XLightsExport.build($0, cell: cell) }
        if includeYard, src.plants.count > 1, let yard = src.yard {
            list.append(XLightsExport.build(yard, cell: cell))
        }
        results = list
    }

    private func export() {
        do {
            files = try XLightsExport.write(results)
            error = nil
        } catch {
            self.error = "Couldn't write the files: \(error.localizedDescription)"
        }
    }
}
