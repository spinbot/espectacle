import SwiftUI

struct ContentView: View {
    @EnvironmentObject var store: TreeStore
    @EnvironmentObject var discovery: Discovery
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        TabView {
            LightsView()
                .tabItem { Label("Lights", systemImage: "sparkles") }
            MappingView()
                .tabItem { Label("Props", systemImage: "tree") }
            ShowsView()
                .tabItem { Label("Shows", systemImage: "music.note.list") }
            ControllersView()
                .tabItem { Label("Controllers", systemImage: "cpu") }
        }
        .task(id: scenePhase) {
            // Poll controller status while the app is in the foreground.
            guard scenePhase == .active else { return }
            discovery.start()
            while !Task.isCancelled {
                await store.refreshStatus()
                try? await Task.sleep(nanoseconds: 5_000_000_000)
            }
        }
        .modifier(SyncConflictModifier())
        .onChange(of: discovery.found) {
            store.updateHosts(from: discovery.found)
        }
    }
}
