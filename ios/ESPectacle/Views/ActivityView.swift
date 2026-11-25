import SwiftUI
import UIKit

/// The system share sheet (AirDrop, Save to Files, …) for one or more files.
struct ActivityView: UIViewControllerRepresentable {
    let urls: [URL]
    init(url: URL) { urls = [url] }
    init(urls: [URL]) { self.urls = urls }
    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: urls, applicationActivities: nil)
    }
    func updateUIViewController(_ vc: UIActivityViewController, context: Context) {}
}
