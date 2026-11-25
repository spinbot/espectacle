import SwiftUI

/// Puts a factory-fresh controller onto the home WiFi.
/// A controller with no WiFi settings creates its own hotspot ("ESPectacle-xxxxxx")
/// and answers on 192.168.4.1 while the phone is joined to it.
struct SetupDeviceView: View {
    @Environment(\.dismiss) private var dismiss

    private let client = DeviceClient(host: "192.168.4.1")
    @State private var info: DeviceInfo?
    @State private var networks: [WiFiNetwork] = []
    @State private var ssid = ""
    @State private var password = ""
    @State private var busy = false
    @State private var message: String?
    @State private var done = false

    var body: some View {
        NavigationStack {
            Form {
                Section("1. Join the controller's hotspot") {
                    Text("Power the controller. In Settings → Wi-Fi on this phone, join the network named **ESPectacle-xxxxxx**, then come back here.")
                    Button {
                        connect()
                    } label: {
                        HStack {
                            Text(info == nil ? "Find controller" : "Found \(info!.name)")
                            if busy && info == nil { Spacer(); ProgressView() }
                        }
                    }
                    .disabled(busy || info != nil)
                }

                if info != nil && !done {
                    Section("2. Choose your home WiFi") {
                        if !networks.isEmpty {
                            Picker("Network", selection: $ssid) {
                                Text("Other…").tag("")
                                ForEach(networks) { Text($0.ssid).tag($0.ssid) }
                            }
                        }
                        if networks.isEmpty || !networks.contains(where: { $0.ssid == ssid }) {
                            TextField("Network name", text: $ssid)
                                .textInputAutocapitalization(.never)
                                .autocorrectionDisabled()
                        }
                        SecureField("Password", text: $password)
                        Button("Save and restart controller") { save() }
                            .disabled(busy || ssid.isEmpty)
                    }
                }

                if done {
                    Section("3. Finish") {
                        Text("The controller is restarting and joining **\(ssid)**. Put this phone back on the same WiFi; the controller will appear under “Found on your network” on the Controllers tab.\n\nIf it doesn't show up within a minute the password was probably wrong – the ESPectacle hotspot will reappear and you can try again.")
                    }
                }

                if let message {
                    Section {
                        Text(message)
                            .foregroundStyle(.orange)
                    }
                }

                Section {
                    Text("ESP32-S2 boards only support 2.4 GHz WiFi. To make a controller forget its network, hold its BOOT (0) button for 5 seconds.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
            .navigationTitle("New controller")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }

    private func connect() {
        busy = true
        message = nil
        Task {
            do {
                info = try await client.info()
                networks = (try? await client.networks()) ?? []
                if let first = networks.first, ssid.isEmpty { ssid = first.ssid }
            } catch {
                message = "No controller answered. Make sure this phone is joined to the ESPectacle-xxxxxx network."
            }
            busy = false
        }
    }

    private func save() {
        busy = true
        message = nil
        Task {
            do {
                try await client.setWiFi(ssid: ssid, password: password)
                done = true
            } catch {
                message = "Couldn't save: \(error.localizedDescription)"
            }
            busy = false
        }
    }
}
