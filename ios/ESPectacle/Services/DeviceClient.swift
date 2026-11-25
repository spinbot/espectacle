import Foundation

struct APIError: LocalizedError {
    var message: String
    var errorDescription: String? { message }
}

/// HTTP client for one ESPectacle controller. See firmware/README.md for the API.
struct DeviceClient {
    let host: String

    private static let session: URLSession = {
        let cfg = URLSessionConfiguration.ephemeral
        cfg.timeoutIntervalForRequest = 4
        cfg.waitsForConnectivity = false
        cfg.httpMaximumConnectionsPerHost = 2
        cfg.requestCachePolicy = .reloadIgnoringLocalCacheData
        return URLSession(configuration: cfg)
    }()

    @discardableResult
    func request(_ method: String, _ path: String, query: [String: String] = [:],
                 json: Any? = nil, timeout: TimeInterval = 4) async throws -> Data {
        var comps = URLComponents()
        comps.scheme = "http"
        comps.host = host
        comps.path = path
        if !query.isEmpty {
            comps.queryItems = query.sorted { $0.key < $1.key }.map { URLQueryItem(name: $0.key, value: $0.value) }
        }
        guard let url = comps.url else { throw APIError(message: "Invalid address: \(host)") }

        var req = URLRequest(url: url, timeoutInterval: timeout)
        req.httpMethod = method
        if let json {
            req.httpBody = try JSONSerialization.data(withJSONObject: json)
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        } else if method == "POST" {
            req.httpBody = Data("{}".utf8)
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }

        let (data, resp) = try await Self.session.data(for: req)
        guard let http = resp as? HTTPURLResponse else { throw APIError(message: "No response") }
        guard (200..<300).contains(http.statusCode) else {
            if let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let msg = obj["error"] as? String {
                throw APIError(message: msg)
            }
            throw APIError(message: "Controller returned HTTP \(http.statusCode)")
        }
        return data
    }

    func info(timeout: TimeInterval = 3) async throws -> DeviceInfo {
        let data = try await request("GET", "/api/info", timeout: timeout)
        return try JSONDecoder().decode(DeviceInfo.self, from: data)
    }

    func setConfig(name: String, strings: [LEDString], maxMilliamps: Int) async throws -> DeviceInfo {
        let body: [String: Any] = [
            "name": name,
            "maxMilliamps": maxMilliamps,
            "strings": strings.map { ["pin": $0.pin, "count": $0.count, "order": $0.order] as [String: Any] },
        ]
        let data = try await request("POST", "/api/config", json: body, timeout: 8)
        return try JSONDecoder().decode(DeviceInfo.self, from: data)
    }

    func setState(_ s: LightState) async throws {
        let body: [String: Any] = [
            "on": s.on, "fx": s.fx, "pal": s.pal, "bri": s.bri, "spd": s.spd, "scl": s.scl,
            "c1": s.c1, "c2": s.c2, "t": Self.clockMs(),
            "dir": s.dirVector.map { $0 as Any } ?? NSNull(),
        ]
        try await request("POST", "/api/state", json: body)
    }

    func syncClock() async throws {
        try await request("POST", "/api/sync", json: ["t": Self.clockMs()])
    }

    func setScan(_ on: Bool) async throws {
        try await request("POST", "/api/scan", query: ["on": on ? "1" : "0"])
    }

    /// Lights exactly one LED (index < 0: all dark). Returns once the LED has physically changed.
    func solo(string: Int, index: Int, value: Int) async throws {
        try await request("POST", "/api/solo",
                          query: ["s": String(string), "i": String(index), "v": String(value)], timeout: 2)
    }

    /// Uploads ready-to-use geometry for this controller's LEDs: eight integers per LED
    /// (x, y, z, h, ang, rad, d3, zone – see `Geo` in the firmware's effects.h).
    /// Firmware older than 1.2 only understands seven (no zone), so `legacy` drops the zone.
    /// `zoneFrames` (seven integers per zone, see `Frame` in effects.h) go with the last chunk.
    func uploadGeometry(_ geo: [[Int]], baseIndex: Int, id: UInt32, zoneFrames: [Int] = [],
                        legacy: Bool = false) async throws {
        let chunk = 60
        var offset = 0
        while offset < geo.count {
            let end = min(offset + chunk, geo.count)
            var q = ["offset": String(offset), "total": String(geo.count)]
            if end == geo.count {
                q["final"] = "1"
                q["base"] = String(baseIndex)
                q["id"] = String(id)
            }
            let flat = legacy ? geo[offset..<end].flatMap { $0.prefix(7) } : geo[offset..<end].flatMap { $0 }
            var body: [String: Any] = [legacy ? "g" : "g8": flat]
            if end == geo.count, !legacy, !zoneFrames.isEmpty { body["zf"] = zoneFrames }
            try await request("POST", "/api/positions", query: q, json: body, timeout: 8)
            offset = end
        }
    }

    // MARK: - Shows (firmware 1.2+)

    /// Controller uptime minus this device's uptime, in milliseconds, from the quickest of several
    /// round trips (the quickest is the most symmetric, so its midpoint is the most accurate).
    func clockOffset(samples: Int = 6) async throws -> Double {
        struct Reply: Codable { var up: Double }
        var best: (rtt: Double, offset: Double)?
        for _ in 0..<samples {
            let t0 = ProcessInfo.processInfo.systemUptime * 1000
            let data = try await request("GET", "/api/time", timeout: 2)
            let t1 = ProcessInfo.processInfo.systemUptime * 1000
            let up = try JSONDecoder().decode(Reply.self, from: data).up
            let rtt = t1 - t0
            if best == nil || rtt < best!.rtt { best = (rtt, up - (t0 + t1) / 2) }
        }
        guard let best else { throw APIError(message: "No reply") }
        return best.offset
    }

    /// Uploads a compiled show: nineteen integers per segment, or twenty-three with directions
    /// (firmware 1.6+; see ShowCompiler.Segment).
    func uploadShow(_ segments: [[Int]], id: UInt32) async throws {
        let per = segments.first?.count ?? 19
        let chunk = 50
        var offset = 0
        repeat {
            let end = min(offset + chunk, segments.count)
            var q = ["offset": String(offset), "total": String(segments.count), "id": String(id)]
            if per == 23 { q["per"] = "23" }
            if end == segments.count { q["final"] = "1" }
            let flat = segments[offset..<end].flatMap { $0 }
            try await request("POST", "/api/show", query: q, json: ["s": flat], timeout: 8)
            offset = end
        } while offset < segments.count
    }

    /// Starts the loaded show so that show time 0 happens at `startUptimeMs` on the controller's clock.
    func playShow(id: UInt32, startUptimeMs: Int64) async throws {
        try await request("POST", "/api/show/play", json: ["id": id, "start": startUptimeMs], timeout: 2)
    }

    /// Stops a playing show. With `dark`, every LED stays off until the next play or look change;
    /// without it the controller goes back to its normal look.
    func stopShow(dark: Bool = false) async throws {
        try await request("POST", "/api/show/stop", query: ["dark": dark ? "1" : "0"], timeout: 2)
    }

    func clearPositions() async throws { try await request("DELETE", "/api/positions") }
    func identify() async throws { try await request("POST", "/api/identify") }
    func reboot() async throws { try await request("POST", "/api/reboot") }

    func networks() async throws -> [WiFiNetwork] {
        struct Reply: Codable { var networks: [WiFiNetwork] }
        let data = try await request("GET", "/api/networks", timeout: 15)
        var seen = Set<String>()
        return try JSONDecoder().decode(Reply.self, from: data).networks
            .filter { !$0.ssid.isEmpty && seen.insert($0.ssid).inserted }
            .sorted { $0.rssi > $1.rssi }
    }

    func setWiFi(ssid: String, password: String) async throws {
        try await request("POST", "/api/wifi", json: ["ssid": ssid, "pass": password])
    }

    static func clockMs() -> Int { Int(Date().timeIntervalSince1970 * 1000) }
}
