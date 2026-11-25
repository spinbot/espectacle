import Foundation
import Network

/// Finds ESPectacle controllers on the local network via Bonjour: _espectacle._tcp, plus _treelights._tcp
/// for controllers still on firmware from before the rename (newer firmware advertises both; listed once).
final class Discovery: ObservableObject {
    struct Found: Identifiable, Hashable {
        var id: String      // device id (falls back to the service name)
        var name: String
        var host: String
    }

    @Published var found: [Found] = []
    private static let types = ["_espectacle._tcp", "_treelights._tcp"]
    private var browsers: [String: NWBrowser] = [:]
    private var results: [String: [Found]] = [:]

    func start() {
        guard browsers.isEmpty else { return }
        for type in Self.types {
            let b = NWBrowser(for: .bonjourWithTXTRecord(type: type, domain: nil), using: NWParameters())
            b.browseResultsChangedHandler = { [weak self] results, _ in
                var list: [Found] = []
                for r in results {
                    guard case let .service(name, _, _, _) = r.endpoint else { continue }
                    var ip: String?
                    var id: String?
                    if case let .bonjour(txt) = r.metadata {
                        ip = txt["ip"]
                        id = txt["id"]
                    }
                    let host = (ip?.isEmpty == false) ? ip! : "\(name).local"
                    list.append(Found(id: id ?? name, name: name, host: host))
                }
                DispatchQueue.main.async { self?.update(type, list) }
            }
            b.stateUpdateHandler = { [weak self] state in
                if case .failed = state {
                    DispatchQueue.main.async { self?.restart() }
                }
            }
            b.start(queue: .main)
            browsers[type] = b
        }
    }

    /// Merges what each service type found, one entry per controller (the new type wins).
    private func update(_ type: String, _ list: [Found]) {
        results[type] = list
        var byID: [String: Found] = [:]
        for t in Self.types.reversed() { for f in results[t] ?? [] { byID[f.id] = f } }
        found = byID.values.sorted { $0.name < $1.name }
    }

    func stop() {
        for b in browsers.values { b.cancel() }
        browsers = [:]
        results = [:]
    }

    func restart() {
        stop()
        start()
    }
}
