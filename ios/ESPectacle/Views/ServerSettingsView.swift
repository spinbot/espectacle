import SwiftUI

/// Connects the app to a ESPectacle server so every device (and the website) shares one project.
struct ServerSettingsView: View {
    @EnvironmentObject var sync: ServerSync

    var body: some View {
        Form {
            Section {
                TextField("http://192.168.1.20:8080", text: $sync.serverURL)
                    .keyboardType(.URL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                SecureField("Password", text: $sync.password)
                Button {
                    Task { await sync.connect() }
                } label: {
                    HStack {
                        Text("Connect")
                        if sync.busy { Spacer(); ProgressView() }
                    }
                }
                .disabled(!sync.enabled || sync.busy)
            } header: {
                Text("Server")
            } footer: {
                Text("The address of the ESPectacle server on your network (see server/README in the project). Leave it empty to keep the project on this device only.")
            }

            if sync.enabled {
                Section("Status") {
                    LabeledContent("Sync", value: sync.status)
                    if let err = sync.lastError {
                        Text(err).foregroundStyle(.orange)
                    }
                    Button("Sync now") { Task { await sync.syncNow() } }
                        .disabled(sync.busy)
                    if let url = URL(string: sync.serverURL.contains("://") ? sync.serverURL : "http://" + sync.serverURL) {
                        Link("Open the web editor", destination: url)
                    }
                }
            }

            Section {
                Text("Props, their scans, the yard scan, shows and music are kept on the server. Other iPhones, iPads and Macs connected to the same server get the same project, and the website shows the yard in 3D and previews effects. Scanning still happens in the app.")
                    .font(.footnote).foregroundStyle(.secondary)
            }
        }
        .navigationTitle("Server")
        .navigationBarTitleDisplayMode(.inline)
    }
}

/// Asks which copy wins when this device and the server both changed.
struct SyncConflictModifier: ViewModifier {
    @EnvironmentObject var sync: ServerSync

    func body(content: Content) -> some View {
        content.alert(sync.conflict == .firstConnect ? "Both have a project" : "Changed in two places",
                      isPresented: Binding(get: { sync.conflict != nil }, set: { _ in })) {
            Button("Use the server's copy") { Task { await sync.resolve(keepLocal: false) } }
            Button("Keep this device's copy", role: .destructive) { Task { await sync.resolve(keepLocal: true) } }
        } message: {
            Text(sync.conflict == .firstConnect
                 ? "This device and the server each have a project. Which one should everyone use? The other is replaced."
                 : "The project was changed on the server (another device or the website) while this device also had unsynced changes. Which copy should win? The other's changes are lost.")
        }
    }
}
