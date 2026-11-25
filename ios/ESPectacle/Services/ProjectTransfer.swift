import Foundation

/// Moves the whole project (controllers, plants and their scans, the yard scan, shows and
/// their music) between devices as a single file, e.g. by AirDrop from iPhone to iPad or Mac.
enum ProjectTransfer {
    static func export(_ data: AppData) throws -> URL {
        var file = ProjectFile(data: data)
        file.area = try? Data(contentsOf: AreaStore.fileURL)
        for show in data.shows {
            if let name = show.audioFile, let d = try? Data(contentsOf: AudioStore.url(for: name)) {
                file.audio[name] = d
            }
        }
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("ESPectacle Project.json")
        try JSONEncoder().encode(file).write(to: url, options: .atomic)
        return url
    }

    static func read(_ url: URL) throws -> ProjectFile {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        let d = try Data(contentsOf: url)
        do {
            return try JSONDecoder().decode(ProjectFile.self, from: d)
        } catch {
            throw APIError(message: "That file isn't a ESPectacle project.")
        }
    }

    /// Replaces everything on this device with the project.
    @MainActor
    static func apply(_ p: ProjectFile, to store: TreeStore) throws {
        if let area = p.area {
            try area.write(to: AreaStore.fileURL, options: .atomic)
        } else {
            AreaStore.delete()
        }
        for (name, d) in p.audio {
            try d.write(to: AudioStore.url(for: name), options: .atomic)
        }
        store.data = p.data
    }
}
