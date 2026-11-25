import SwiftUI

/// Lists the controllers, finds new ones on the network and adds them.
struct ControllersView: View {
    @EnvironmentObject var store: TreeStore
    @EnvironmentObject var discovery: Discovery

    @State private var manualHost = ""
    @State private var busy = false
    @State private var alert: String?
    @State private var showSetup = false

    private var newDevices: [Discovery.Found] {
        discovery.found.filter { f in !store.data.controllers.contains { $0.id == f.id } }
    }

    @EnvironmentObject var sync: ServerSync

    var body: some View {
        NavigationStack {
            List {
                Section {
                    NavigationLink {
                        ServerSettingsView()
                    } label: {
                        LabeledContent {
                            Text(sync.enabled ? sync.status : "Off").foregroundStyle(.secondary)
                        } label: {
                            Label("Server sync", systemImage: "server.rack")
                        }
                    }
                }

                Section {
                    if store.data.controllers.isEmpty {
                        Text("No controllers yet.")
                            .foregroundStyle(.secondary)
                    }
                    ForEach(store.data.controllers) { c in
                        NavigationLink {
                            ControllerDetailView(controllerID: c.id)
                        } label: {
                            ControllerRow(controller: c, info: store.online[c.id])
                        }
                    }
                    .onMove { store.data.controllers.move(fromOffsets: $0, toOffset: $1) }
                } header: {
                    Text("In your yard")
                } footer: {
                    if store.totalLEDs > 0 {
                        Text("\(store.totalLEDs) LEDs in total")
                    }
                }

                Section("Found on your network") {
                    if newDevices.isEmpty {
                        HStack {
                            ProgressView()
                            Text("Searching…")
                                .foregroundStyle(.secondary)
                                .padding(.leading, 6)
                        }
                    }
                    ForEach(newDevices) { f in
                        HStack {
                            VStack(alignment: .leading) {
                                Text(f.name)
                                Text(f.host)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            Spacer()
                            Button("Add") { add(f.host) }
                                .buttonStyle(.borderedProminent)
                                .disabled(busy)
                        }
                    }
                }

                Section {
                    HStack {
                        TextField("IP address or name.local", text: $manualHost)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .keyboardType(.URL)
                        Button("Add") { add(manualHost) }
                            .disabled(busy || manualHost.trimmingCharacters(in: .whitespaces).isEmpty)
                    }
                    Button {
                        showSetup = true
                    } label: {
                        Label("Set up a new controller's WiFi", systemImage: "wifi.router")
                    }
                } header: {
                    Text("Add manually")
                }
            }
            .navigationTitle("Controllers")
            .toolbar { EditButton() }
            .refreshable {
                discovery.restart()
                await store.refreshStatus()
            }
            .sheet(isPresented: $showSetup) { SetupDeviceView() }
            .alert("Couldn't add controller", isPresented: Binding(get: { alert != nil }, set: { if !$0 { alert = nil } })) {
                Button("OK", role: .cancel) {}
            } message: {
                Text(alert ?? "")
            }
        }
    }

    private func add(_ host: String) {
        busy = true
        Task {
            do {
                try await store.addController(host: host)
                manualHost = ""
            } catch {
                alert = error.localizedDescription
            }
            busy = false
        }
    }
}

private struct ControllerRow: View {
    let controller: Controller
    let info: DeviceInfo?

    var body: some View {
        HStack(spacing: 12) {
            Circle()
                .fill(info != nil ? Color.green : Color.gray)
                .frame(width: 10, height: 10)
            VStack(alignment: .leading, spacing: 2) {
                Text(controller.name)
                Text("\(controller.totalLEDs) LEDs · \(controller.strings.count) string\(controller.strings.count == 1 ? "" : "s") · \(info != nil ? controller.host : "offline")")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }
}

/// Edits one controller: its name, the LED strings wired to it and its current limit.
struct ControllerDetailView: View {
    @EnvironmentObject var store: TreeStore
    @EnvironmentObject var sync: ServerSync
    @State private var fwStatus: ServerSync.FirmwareStatus?
    @State private var fwError: String?
    @Environment(\.dismiss) private var dismiss
    let controllerID: String

    @State private var draft: Controller?
    @State private var saving = false
    @State private var message: String?
    @State private var confirmRemove = false

    private var stored: Controller? { store.data.controllers.first { $0.id == controllerID } }
    private var info: DeviceInfo? { store.online[controllerID] }

    var body: some View {
        Form {
            if let binding = Binding($draft) {
                editor(binding)
            }
        }
        .navigationTitle(stored?.name ?? "Controller")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear { if draft == nil { draft = stored } }
        .confirmationDialog("Remove this controller?", isPresented: $confirmRemove, titleVisibility: .visible) {
            Button("Remove", role: .destructive) {
                if let c = stored { store.removeController(c) }
                dismiss()
            }
        }
    }

    /// GPIOs to offer: what the controller reports, plus any pin already in use so the picker can show it.
    private func pins(for c: Controller) -> [Int] {
        let allowed = info?.pins ?? LEDString.validPins
        return Array(Set(allowed + c.strings.map { $0.pin })).sorted()
    }

    @ViewBuilder
    private func editor(_ c: Binding<Controller>) -> some View {
        Section("Name") {
            TextField("Name", text: c.name)
        }

        Section {
            ForEach(c.strings) { $s in
                VStack(alignment: .leading, spacing: 8) {
                    Stepper(value: $s.count, in: 1...1500) {
                        HStack {
                            Text("LEDs")
                            Spacer()
                            TextField("Count", value: $s.count, format: .number)
                                .keyboardType(.numberPad)
                                .multilineTextAlignment(.trailing)
                                .frame(width: 70)
                        }
                    }
                    Picker("GPIO pin", selection: $s.pin) {
                        ForEach(pins(for: c.wrappedValue), id: \.self) { Text("GPIO \($0)").tag($0) }
                    }
                    Picker("Colour order", selection: $s.order) {
                        ForEach(LEDString.orders, id: \.self) { Text($0).tag($0) }
                    }
                }
            }
            .onDelete { c.wrappedValue.strings.remove(atOffsets: $0) }

            if c.wrappedValue.strings.count < 4 {
                Button {
                    let used = Set(c.wrappedValue.strings.map { $0.pin })
                    let pin = (info?.pins ?? LEDString.validPins).first { !used.contains($0) && $0 >= 16 } ?? 17
                    c.wrappedValue.strings.append(LEDString(pin: pin))
                } label: {
                    Label("Add string", systemImage: "plus")
                }
            }
        } header: {
            Text("LED strings")
        } footer: {
            Text("WS2812B strips are usually GRB; WS2811 bullet pixels are usually RGB. Use GRBW/RGBW for SK6812 with a white LED; other RGBW strips (e.g. WS2814) can use any order, such as WBRG (firmware 1.11+). If colours look wrong, try another order. Assign each string to a prop on the Props tab. Moving a string to another pin or controller keeps its prop's scan; if you change its LED count, the prop asks which LEDs were added or removed.")
        }

        Section {
            Stepper(value: c.maxMilliamps, in: 0...30000, step: 250) {
                HStack {
                    Text("Current limit")
                    Spacer()
                    Text(c.wrappedValue.maxMilliamps == 0 ? "Off" : String(format: "%.2f A", Double(c.wrappedValue.maxMilliamps) / 1000))
                        .foregroundStyle(.secondary)
                }
            }
        } footer: {
            Text("The controller dims everything to stay under this estimate. Set it a little below what your power supply can deliver.")
        }

        Section {
            Button {
                save(c.wrappedValue)
            } label: {
                HStack {
                    Text("Save to controller")
                    if saving { Spacer(); ProgressView() }
                }
            }
            .disabled(saving || c.wrappedValue == stored || !valid(c.wrappedValue))
            if !saving, let why = whyCantSave(c.wrappedValue) {
                Label(why, systemImage: "info.circle")
                    .font(.footnote)
                    .foregroundStyle(c.wrappedValue == stored ? Color.secondary : Color.orange)
            }

            Button("Identify (blink this controller)") {
                Task { try? await DeviceClient(host: c.wrappedValue.host).identify() }
            }
            if let message {
                Text(message)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }

        Section("Status") {
            LabeledContent("Address", value: c.wrappedValue.host)
            if let info {
                LabeledContent("Firmware", value: info.fw ?? "–")
                if let chip = info.chip {
                    LabeledContent("Chip", value: chip + ((info.psram ?? 0) > 0 ? " · \((info.psram ?? 0) / 1_048_576) MB PSRAM" : ""))
                }
                if info.ap == true {
                    LabeledContent("WiFi", value: "Setup hotspot")
                } else {
                    LabeledContent("WiFi", value: "\(info.ssid ?? "–")  (\(info.rssi ?? 0) dBm)")
                }
                LabeledContent("3D map loaded", value: info.mapped == true ? "Yes" : "No")
            } else {
                Text("Not reachable")
                    .foregroundStyle(.secondary)
            }
        }

        if sync.enabled {
            firmwareSection
        }

        Section {
            Button("Remove controller", role: .destructive) { confirmRemove = true }
        }
    }

    /// Over-the-air updates: the server keeps the firmware files and sends them to the controller.
    @ViewBuilder
    private var firmwareSection: some View {
        Section {
            if let s = fwStatus {
                if s.state == "uploading" || s.state == "restarting" {
                    ProgressView(value: s.state == "uploading" ? s.progress : 1) {
                        Text(s.state == "uploading" ? "Sending \(s.version ?? "firmware")…" : (s.message ?? "Restarting…"))
                    }
                } else {
                    if s.state == "failed" {
                        Label(s.message ?? "Update failed", systemImage: "exclamationmark.triangle").foregroundStyle(.orange)
                    } else if s.state == "done" {
                        Label(s.message ?? "Updated", systemImage: "checkmark.circle").foregroundStyle(.green)
                    }
                    if let v = s.version {
                        LabeledContent("Newest on the server", value: v)
                        Button(s.available ? "Update to \(v)" : "Reinstall \(v)") {
                            Task {
                                do { fwError = nil; try await sync.startFirmwareUpdate(controllerID: controllerID) }
                                catch { fwError = error.localizedDescription }
                            }
                        }
                        .disabled(info == nil)
                    } else {
                        Text("No firmware for this board on the server yet.").foregroundStyle(.secondary)
                    }
                }
            } else {
                Text("Checking the server…").foregroundStyle(.secondary)
            }
            if let fwError { Text(fwError).font(.footnote).foregroundStyle(.orange) }
        } header: {
            Text("Firmware update")
        } footer: {
            Text("Firmware built with PlatformIO (or uploaded on the website's Devices tab) is sent over WiFi. The lights go dark for about a minute. Needs firmware 1.10 or later on the controller (flash once over USB).")
        }
        .task(id: controllerID) {
            while !Task.isCancelled {
                fwStatus = await sync.firmwareStatus(controllerID: controllerID)
                let busy = fwStatus?.state == "uploading" || fwStatus?.state == "restarting"
                try? await Task.sleep(nanoseconds: busy ? 1_000_000_000 : 5_000_000_000)
            }
        }
    }

    private func valid(_ c: Controller) -> Bool { problem(c) == nil }

    /// What's wrong with the settings, if anything.
    private func problem(_ c: Controller) -> String? {
        let pins = c.strings.map { $0.pin }
        if c.name.trimmingCharacters(in: .whitespaces).isEmpty { return "Give the controller a name." }
        if c.strings.isEmpty { return "Add at least one LED string." }
        if Set(pins).count != pins.count { return "Two strings use the same GPIO pin; each needs its own." }
        if c.strings.contains(where: { $0.count < 1 }) { return "Each string needs at least 1 LED." }
        if c.totalLEDs > 1500 { return "\(c.totalLEDs) LEDs in total; a controller can drive at most 1500." }
        return nil
    }

    /// Why "Save to controller" is greyed out (nil when it can be pressed).
    private func whyCantSave(_ c: Controller) -> String? {
        if let p = problem(c) { return p }
        if c == stored { return "No changes to save." }
        return nil
    }

    private func save(_ c: Controller) {
        saving = true
        message = nil
        Task {
            do {
                try await store.saveController(c)
                message = "Saved."
            } catch {
                message = "Couldn't save: \(error.localizedDescription)"
            }
            saving = false
        }
    }
}
