import SwiftUI

@main
struct ESPectacleApp: App {
    @StateObject private var store = TreeStore()
    @StateObject private var discovery = Discovery()
    @StateObject private var sync = ServerSync()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(store)
                .environmentObject(discovery)
                .environmentObject(sync)
                .task { sync.attach(store) }
        }
    }
}
