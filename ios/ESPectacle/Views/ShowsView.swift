import SwiftUI
import ARKit
import UniformTypeIdentifiers

/// The Shows tab: the yard in 3D, the music shows, and moving the project between devices.
struct ShowsView: View {
    @EnvironmentObject var store: TreeStore
    @State private var showYardScan = false
    @State private var exportURL: URL?
    @State private var importing = false
    @State private var pendingImport: ProjectFile?
    @State private var message: String?
    @State private var path: [UUID] = []

    var body: some View {
        NavigationStack(path: $path) {
            List {
                Section {
                    NavigationLink {
                        YardEditorView()
                    } label: {
                        Label("Arrange props in 3D", systemImage: "cube.transparent")
                    }
                    Button {
                        showYardScan = true
                    } label: {
                        Label("Scan the yard", systemImage: "viewfinder")
                    }
                    .disabled(!ARWorldTrackingConfiguration.isSupported)
                } header: {
                    Text("Yard")
                } footer: {
                    if let a = store.data.area {
                        Text("Yard scanned \(a.date.formatted(date: .abbreviated, time: .shortened)) · \(a.pointCount.formatted()) points.")
                    } else if !ARWorldTrackingConfiguration.isSupported {
                        Text("Scanning needs an iPhone or iPad camera. Arrange props here, or scan on another device and import the project.")
                    } else {
                        Text("Scan the yard to see it in 3D and place each prop by aiming at it. Needs LiDAR to capture the yard itself.")
                    }
                }

                Section("Shows") {
                    ForEach(store.data.shows) { show in
                        NavigationLink(value: show.id) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(show.name)
                                Text(subtitle(show))
                                    .font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }
                    .onDelete { offsets in
                        for i in offsets {
                            if let a = store.data.shows[i].audioFile { AudioStore.delete(a) }
                        }
                        store.data.shows.remove(atOffsets: offsets)
                    }
                    Button {
                        let show = Show(name: "Show \(store.data.shows.count + 1)")
                        store.data.shows.append(show)
                        path.append(show.id)
                    } label: {
                        Label("New show", systemImage: "plus")
                    }
                }

                Section {
                    Button {
                        do { exportURL = try ProjectTransfer.export(store.data) }
                        catch { message = error.localizedDescription }
                    } label: {
                        Label("Share project…", systemImage: "square.and.arrow.up")
                    }
                    Button {
                        importing = true
                    } label: {
                        Label("Import project…", systemImage: "square.and.arrow.down")
                    }
                } header: {
                    Text("Other devices")
                } footer: {
                    Text(message ?? "Scan on the iPhone, then share the project (AirDrop or Files) and import it on an iPad or Mac to design shows there. Importing replaces everything on that device.")
                }
            }
            .navigationTitle("Shows")
            .navigationDestination(for: UUID.self) { ShowEditorView(showID: $0) }
            .fullScreenCover(isPresented: $showYardScan) { YardScanView() }
            .sheet(item: Binding(get: { exportURL.map { ExportItem(url: $0) } }, set: { exportURL = $0?.url })) { item in
                ActivityView(url: item.url)
            }
            .fileImporter(isPresented: $importing, allowedContentTypes: [.json]) { result in
                switch result {
                case .success(let url):
                    do { pendingImport = try ProjectTransfer.read(url) }
                    catch { message = error.localizedDescription }
                case .failure(let e):
                    message = e.localizedDescription
                }
            }
            .alert("Replace everything on this device?", isPresented: Binding(get: { pendingImport != nil },
                                                                          set: { if !$0 { pendingImport = nil } })) {
                Button("Replace", role: .destructive) {
                    if let p = pendingImport {
                        do { try ProjectTransfer.apply(p, to: store); message = "Project imported." }
                        catch { message = error.localizedDescription }
                    }
                    pendingImport = nil
                }
                Button("Cancel", role: .cancel) { pendingImport = nil }
            } message: {
                if let p = pendingImport {
                    Text("The imported project has \(p.data.controllers.count) controllers, \(p.data.plants.count) props and \(p.data.shows.count) shows.")
                }
            }
        }
    }

    private func subtitle(_ s: Show) -> String {
        let clips = s.tracks.reduce(0) { $0 + $1.clips.count }
        var parts = [s.audioName ?? "No music", "\(clips) clip\(clips == 1 ? "" : "s")"]
        if let bpm = s.bpm { parts.append("\(Int(bpm.rounded())) BPM") }
        return parts.joined(separator: " · ")
    }

    private struct ExportItem: Identifiable {
        let url: URL
        var id: URL { url }
    }
}
