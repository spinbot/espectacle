import SwiftUI
import UniformTypeIdentifiers

/// Timeline editor for one show: the music's waveform and beat grid, a track per plant (or for
/// all plants), and clips of effects that play on the controllers in time with the music.
struct ShowEditorView: View {
    @EnvironmentObject var store: TreeStore
    @Environment(\.horizontalSizeClass) private var sizeClass
    let showID: UUID

    @StateObject private var player = ShowPlayer()
    @State private var pps: CGFloat = 60                 // points per second (zoom)
    @State private var snap = true
    @State private var follow = true
    @State private var selection: ClipRef?
    @State private var analysis: AudioAnalysis?
    @State private var analysing = false
    @State private var showSettings = false
    @State private var dragOrigin: (id: UUID, start: Double, duration: Double)?
    @State private var template = ShowClip(start: 0, duration: 2)
    @State private var scrollPosition = ScrollPosition(edge: .leading)
    @State private var visible: CGRect = .zero           // part of the timeline on screen
    @State private var editingTrack: TrackRef?

    struct TrackRef: Identifiable {
        var show: Int
        var track: UUID
        var id: UUID { track }
    }

    struct ClipRef: Equatable {
        var track: UUID
        var clip: UUID
    }

    static let rulerH: CGFloat = 26, waveH: CGFloat = 56, laneH: CGFloat = 54, labelW: CGFloat = 116
    private static let tileW: CGFloat = 600

    private var si: Int? { store.data.shows.firstIndex { $0.id == showID } }
    private var show: Show { si.map { store.data.shows[$0] } ?? Show(name: "") }

    var body: some View {
        Group {
            if let si {
                editor(si)
            } else {
                Text("This show no longer exists.").foregroundStyle(.secondary)
            }
        }
        .navigationTitle(show.name)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button { showSettings = true } label: { Label("Show settings", systemImage: "slider.horizontal.3") }
            }
        }
        .sheet(isPresented: $showSettings) {
            if let si {
                ShowSettingsView(show: $store.data.shows[si], analysis: analysis, playhead: player.position)
            }
        }
        .sheet(item: $editingTrack) { ref in
            if let ti = store.data.shows[ref.show].tracks.firstIndex(where: { $0.id == ref.track }) {
                TrackPlantsView(track: $store.data.shows[ref.show].tracks[ti], plants: store.data.plants)
            }
        }
        .task(id: show.audioFile) { await analyse() }
        .onChange(of: show) { player.showEdited(show, store: store) }
        .onAppear { player.enterEditor(store: store) }
        .onDisappear { player.leaveEditor(store: store) }
    }

    // MARK: - Layout

    @ViewBuilder
    private func editor(_ si: Int) -> some View {
        VStack(spacing: 0) {
            transport
            Divider()
            if let err = player.error {
                Text(err).font(.footnote).foregroundStyle(.orange)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal).padding(.vertical, 6)
                Divider()
            }
            if sizeClass == .regular {
                HStack(spacing: 0) {
                    timeline(si)
                    Divider()
                    inspector(si).frame(width: 330)
                }
            } else {
                timeline(si)
                Divider()
                inspector(si).frame(maxHeight: 320)
            }
        }
    }

    private var transport: some View {
        HStack(spacing: 14) {
            Button {
                player.toggle(show: show, store: store)
            } label: {
                Image(systemName: player.playing ? "pause.fill" : "play.fill").font(.title2).frame(width: 30)
            }
            .keyboardShortcut(.space, modifiers: [])
            .disabled(player.busy)
            Button {
                player.stop(store: store)
            } label: {
                Image(systemName: "backward.end.fill").font(.title3)
            }
            if player.busy { ProgressView() }
            Text("\(Self.clock(player.position)) / \(Self.clock(show.duration))")
                .font(.callout.monospacedDigit())
            Spacer()
            Toggle(isOn: $snap) { Image(systemName: "rectangle.split.3x1") }
                .toggleStyle(.button)
                .help("Snap to beats")
            Toggle(isOn: $follow) { Image(systemName: "arrow.right.to.line") }
                .toggleStyle(.button)
                .help("Follow the playhead")
            Button { pps = max(10, pps / 1.5) } label: { Image(systemName: "minus.magnifyingglass") }
            Button { pps = min(400, pps * 1.5) } label: { Image(systemName: "plus.magnifyingglass") }
        }
        .padding(.horizontal)
        .padding(.vertical, 8)
    }

    private func timeline(_ si: Int) -> some View {
        let s = store.data.shows[si]
        let width = CGFloat(max(s.duration, 5)) * pps + 200
        let contentH: CGFloat = Self.rulerH + Self.waveH + CGFloat(s.tracks.count) * Self.laneH
        let playheadX: CGFloat = CGFloat(player.position) * pps - 1
        return ScrollView(.vertical) {
            VStack(alignment: .leading, spacing: 0) {
                HStack(alignment: .top, spacing: 0) {
                    labels(si)
                        .frame(width: Self.labelW)
                    Divider()
                    ScrollView(.horizontal) {
                            ZStack(alignment: .topLeading) {
                                gridLayer(s, height: contentH)
                                VStack(alignment: .leading, spacing: 0) {
                                    ruler(s)
                                    waveform
                                    ForEach(s.tracks) { t in lane(si, t) }
                                }
                                Rectangle()
                                    .fill(Color.red)
                                    .frame(width: 2, height: contentH)
                                    .offset(x: playheadX)
                                    .allowsHitTesting(false)
                            }
                            .frame(width: width, alignment: .leading)
                        }
                        .scrollPosition($scrollPosition)
                        .onScrollGeometryChange(for: CGRect.self, of: { $0.visibleRect }) { _, rect in
                            visible = rect
                        }
                        .onChange(of: player.position) { followPlayhead() }
                }
                Button {
                    store.data.shows[si].tracks.append(ShowTrack())
                } label: {
                    Label("Add track", systemImage: "plus")
                }
                .padding()
            }
        }
    }

    // MARK: - Track labels

    private func labels(_ si: Int) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("Time").font(.caption2).foregroundStyle(.secondary)
                .frame(height: Self.rulerH).padding(.horizontal, 8)
            Text(show.audioName ?? "No music").font(.caption).lineLimit(2)
                .frame(height: Self.waveH, alignment: .center).padding(.horizontal, 8)
            ForEach(Array(store.data.shows[si].tracks.enumerated()), id: \.element.id) { ti, t in
                trackLabel(si, ti, t)
                    .frame(height: Self.laneH)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color.secondary.opacity(0.06))
                    .overlay(alignment: .bottom) { Divider() }
            }
        }
    }

    private func trackLabel(_ si: Int, _ ti: Int, _ t: ShowTrack) -> some View {
        let plants = store.data.plants
        let chosen = t.targets.filter { id in plants.contains { $0.id == id } }
        let pi = chosen.count == 1 ? plants.firstIndex { $0.id == chosen[0] } : nil
        let name = t.targets.isEmpty ? "All props"
            : chosen.isEmpty ? "No props" : pi.map { plants[$0].name } ?? "\(chosen.count) props"
        let grouped = t.targets.isEmpty || chosen.count > 1
        return Menu {
            Button("Choose props…") { editingTrack = TrackRef(show: si, track: t.id) }
            if grouped {
                Picker("Animate", selection: $store.data.shows[si].tracks[ti].together) {
                    Label("Each prop on its own", systemImage: "square.grid.2x2").tag(false)
                    Label("All as one prop", systemImage: "square").tag(true)
                }
            }
            Toggle("Mute", isOn: $store.data.shows[si].tracks[ti].muted)
            if ti > 0 {
                Button("Move up") { store.data.shows[si].tracks.swapAt(ti, ti - 1) }
            }
            if ti < store.data.shows[si].tracks.count - 1 {
                Button("Move down") { store.data.shows[si].tracks.swapAt(ti, ti + 1) }
            }
            Button("Delete track", role: .destructive) {
                if selection?.track == t.id { selection = nil }
                store.data.shows[si].tracks.remove(at: ti)
            }
        } label: {
            HStack(spacing: 6) {
                Circle()
                    .fill(pi.map { Color(uiColor: PointCloudGeometry.plantColor($0)) } ?? Color.white)
                    .frame(width: 9, height: 9)
                VStack(alignment: .leading, spacing: 1) {
                    Text(name).font(.caption.weight(.medium)).lineLimit(1)
                    if grouped {
                        Text(t.together ? "as one" : "each own")
                            .font(.caption2).foregroundStyle(.secondary)
                    }
                }
                if t.muted { Image(systemName: "speaker.slash.fill").font(.caption2) }
            }
            .foregroundStyle(t.muted ? .secondary : .primary)
            .padding(.horizontal, 8)
        }
    }

    // MARK: - Ruler, waveform, grid

    private func tiles(_ width: CGFloat) -> Int { Int((width / Self.tileW).rounded(.up)) }

    private func ruler(_ s: Show) -> some View {
        let total = CGFloat(max(s.duration, 5)) * pps
        return LazyHStack(spacing: 0) {
            ForEach(0..<tiles(total), id: \.self) { i in
                Canvas { ctx, size in
                    let x0 = CGFloat(i) * Self.tileW
                    let step = Self.labelStep(pps)
                    var t = (Double(x0 / pps) / step).rounded(.down) * step
                    while CGFloat(t) * pps < x0 + size.width {
                        let x = CGFloat(t) * pps - x0
                        ctx.fill(Path(CGRect(x: x, y: size.height - 8, width: 1, height: 8)), with: .color(.secondary))
                        ctx.draw(Text(Self.clock(t, short: true)).font(.caption2).foregroundColor(.secondary),
                                 at: CGPoint(x: x + 3, y: 2), anchor: .topLeading)
                        t += step
                    }
                }
                .frame(width: Self.tileW, height: Self.rulerH)
            }
        }
        .frame(width: total, height: Self.rulerH, alignment: .leading)
        .contentShape(Rectangle())
        .gesture(DragGesture(minimumDistance: 0).onEnded { v in
            player.seek(Double(v.location.x / pps), show: show, store: store)
        })
    }

    private var waveform: some View {
        let s = show
        let total = CGFloat(max(s.duration, 5)) * pps
        let env = analysis?.envelope ?? []
        let rate = AudioAnalysis.rate
        let pps = self.pps
        return LazyHStack(spacing: 0) {
            ForEach(0..<tiles(total), id: \.self) { i in
                Canvas { ctx, size in
                    guard !env.isEmpty else { return }
                    let x0 = CGFloat(i) * Self.tileW
                    let mid = size.height / 2
                    var path = Path()
                    var x: CGFloat = 0
                    while x < size.width {
                        let a = Int(Double((x0 + x) / pps) * rate)
                        let b = max(a + 1, Int(Double((x0 + x + 2) / pps) * rate))
                        guard a < env.count else { break }
                        let v = CGFloat(env[a..<min(b, env.count)].max() ?? 0)
                        let h = max(1, v * (size.height - 6) / 2)
                        path.addRect(CGRect(x: x, y: mid - h, width: 1.5, height: h * 2))
                        x += 2
                    }
                    ctx.fill(path, with: .color(.accentColor.opacity(0.7)))
                }
                .frame(width: Self.tileW, height: Self.waveH)
            }
        }
        .frame(width: total, height: Self.waveH, alignment: .leading)
        .background(Color.secondary.opacity(0.08))
        .overlay {
            if analysing { ProgressView() } else if s.audioFile == nil {
                Button("Choose music…") { showSettings = true }.font(.caption)
            }
        }
        .contentShape(Rectangle())
        .gesture(DragGesture(minimumDistance: 0).onEnded { v in
            player.seek(Double(v.location.x / pps), show: show, store: store)
        })
    }

    /// Beat and bar lines behind everything.
    private func gridLayer(_ s: Show, height: CGFloat) -> some View {
        let total = CGFloat(max(s.duration, 5)) * pps
        let pps = self.pps
        return LazyHStack(spacing: 0) {
            ForEach(0..<tiles(total), id: \.self) { i in
                Canvas { ctx, size in
                    let x0 = CGFloat(i) * Self.tileW
                    if let bpm = s.bpm, bpm > 0 {
                        let beat = 60 / bpm
                        guard CGFloat(beat) * pps >= 4 else { return }
                        var k = ((Double(x0 / pps) - s.beatOffset) / beat).rounded(.down)
                        while CGFloat(s.beatOffset + k * beat) * pps < x0 + size.width {
                            let x = CGFloat(s.beatOffset + k * beat) * pps - x0
                            let bar = Int(k) % 4 == 0
                            ctx.fill(Path(CGRect(x: x, y: Self.rulerH, width: bar ? 1 : 0.5, height: size.height)),
                                     with: .color(.secondary.opacity(bar ? 0.45 : 0.2)))
                            k += 1
                        }
                    } else {
                        var t = (Double(x0 / pps)).rounded(.down)
                        while CGFloat(t) * pps < x0 + size.width {
                            let x = CGFloat(t) * pps - x0
                            ctx.fill(Path(CGRect(x: x, y: Self.rulerH, width: 0.5, height: size.height)),
                                     with: .color(.secondary.opacity(0.2)))
                            t += 1
                        }
                    }
                }
                .frame(width: Self.tileW, height: height)
            }
        }
        .frame(width: total, height: height, alignment: .leading)
        .allowsHitTesting(false)
    }

    /// Page-turn following: when the playhead gets near the right edge (or is off screen),
    /// scroll so it sits near the left edge again.
    private func followPlayhead() {
        guard follow, player.playing, visible.width > 0 else { return }
        let x = CGFloat(player.position) * pps
        let margin = visible.width * 0.1
        guard x > visible.maxX - margin || x < visible.minX else { return }
        withAnimation(.easeInOut(duration: 0.25)) {
            scrollPosition.scrollTo(x: max(0, x - margin))
        }
    }

    // MARK: - Lanes and clips

    private func lane(_ si: Int, _ t: ShowTrack) -> some View {
        ZStack(alignment: .topLeading) {
            Rectangle()
                .fill(Color.secondary.opacity(t.muted ? 0.02 : 0.05))
                .contentShape(Rectangle())
                .onTapGesture(coordinateSpace: .local) { loc in
                    addClip(si, track: t.id, at: Double(loc.x / pps))
                }
            ForEach(t.clips) { c in
                clipView(si, track: t, clip: c)
                resizeHandle(si, track: t, clip: c)
            }
        }
        .frame(height: Self.laneH)
        .overlay(alignment: .bottom) { Divider() }
        .opacity(t.muted ? 0.5 : 1)
    }

    private func clipView(_ si: Int, track t: ShowTrack, clip c: ShowClip) -> some View {
        let selected = selection == ClipRef(track: t.id, clip: c.id)
        let w = max(CGFloat(c.duration) * pps, 6)
        return RoundedRectangle(cornerRadius: 6)
            .fill(LinearGradient(colors: Self.colours(of: c), startPoint: .leading, endPoint: .trailing))
            .overlay(alignment: .topLeading) {
                Text(LightEffect.named(c.fx).name)
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.white)
                    .shadow(color: .black, radius: 1)
                    .padding(4)
                    .lineLimit(1)
            }
            .overlay {
                RoundedRectangle(cornerRadius: 6)
                    .stroke(selected ? Color.white : Color.black.opacity(0.4), lineWidth: selected ? 2.5 : 1)
            }
            .frame(width: w, height: Self.laneH - 10)
            .offset(x: CGFloat(c.start) * pps, y: 5)
            .onTapGesture { select(t.id, c) }
            .highPriorityGesture(
                DragGesture(minimumDistance: 4)
                    .onChanged { v in
                        if dragOrigin?.id != c.id { dragOrigin = (c.id, c.start, c.duration); select(t.id, c) }
                        guard let o = dragOrigin else { return }
                        let start = max(0, snapTime(o.start + Double(v.translation.width / pps)))
                        updateClip(si, t.id, c.id) { $0.start = start }
                    }
                    .onEnded { _ in dragOrigin = nil }
            )
            .contextMenu {
                Button("Duplicate") { duplicate(si, t.id, c) }
                Button("Split at playhead") { split(si, t.id, c) }
                Button("Delete", role: .destructive) { delete(si, t.id, c.id) }
            }
    }

    /// Drag the right edge of a clip to change its length. A sibling of the clip, so the clip's
    /// own drag doesn't take its touches.
    private func resizeHandle(_ si: Int, track t: ShowTrack, clip c: ShowClip) -> some View {
        let w = max(CGFloat(c.duration) * pps, 6)
        return Rectangle()
            .fill(Color.white.opacity(0.001))
            .frame(width: 16, height: Self.laneH - 10)
            .overlay(Capsule().fill(Color.white.opacity(0.8)).frame(width: 3, height: 18))
            .offset(x: CGFloat(c.start) * pps + w - 12, y: 5)
            .highPriorityGesture(
                DragGesture(minimumDistance: 1)
                    .onChanged { v in
                        if dragOrigin?.id != c.id { dragOrigin = (c.id, c.start, c.duration); select(t.id, c) }
                        guard let o = dragOrigin else { return }
                        let end = snapTime(o.start + o.duration + Double(v.translation.width / pps))
                        updateClip(si, t.id, c.id) { $0.duration = max(minLength, end - o.start) }
                    }
                    .onEnded { _ in dragOrigin = nil }
            )
    }

    // MARK: - Inspector

    @ViewBuilder
    private func inspector(_ si: Int) -> some View {
        if let sel = selection,
           let ti = store.data.shows[si].tracks.firstIndex(where: { $0.id == sel.track }),
           let ci = store.data.shows[si].tracks[ti].clips.firstIndex(where: { $0.id == sel.clip }) {
            ClipInspectorView(clip: $store.data.shows[si].tracks[ti].clips[ci], bpm: store.data.shows[si].bpm,
                              beatOffset: store.data.shows[si].beatOffset,
                              onDuplicate: { duplicate(si, sel.track, store.data.shows[si].tracks[ti].clips[ci]) },
                              onDelete: { delete(si, sel.track, sel.clip) },
                              onPlayFrom: { player.play(from: store.data.shows[si].tracks[ti].clips[ci].start, show: show, store: store) })
                .onChange(of: store.data.shows[si].tracks[ti].clips[ci]) { _, new in
                    template = new
                }
        } else {
            VStack(spacing: 10) {
                Image(systemName: "hand.tap").font(.largeTitle).foregroundStyle(.secondary)
                Text("Tap an empty spot on a track to add a clip there. Tap a clip to edit it; drag it to move it, or drag its right edge to change its length.")
                    .font(.footnote).foregroundStyle(.secondary).multilineTextAlignment(.center)
                Text("Tracks lower in the list win where they overlap, so an “All props” track at the top makes a good background.")
                    .font(.footnote).foregroundStyle(.secondary).multilineTextAlignment(.center)
            }
            .padding()
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    // MARK: - Editing

    private var beatLength: Double? { show.bpm.map { 60 / $0 } }
    private var minLength: Double { (beatLength ?? 0.4) / 2 }

    private func snapTime(_ t: Double) -> Double {
        guard snap else { return (t * 20).rounded() / 20 }
        if let beat = beatLength {
            return show.beatOffset + ((t - show.beatOffset) / beat).rounded() * beat
        }
        return (t * 4).rounded() / 4
    }

    private func select(_ track: UUID, _ c: ShowClip) {
        selection = ClipRef(track: track, clip: c.id)
    }

    private func updateClip(_ si: Int, _ track: UUID, _ clip: UUID, _ change: (inout ShowClip) -> Void) {
        guard let ti = store.data.shows[si].tracks.firstIndex(where: { $0.id == track }),
              let ci = store.data.shows[si].tracks[ti].clips.firstIndex(where: { $0.id == clip }) else { return }
        change(&store.data.shows[si].tracks[ti].clips[ci])
    }

    private func addClip(_ si: Int, track: UUID, at time: Double) {
        guard let ti = store.data.shows[si].tracks.firstIndex(where: { $0.id == track }) else { return }
        var c = template
        c.id = UUID()
        c.start = max(0, snap ? snapTime(time - (beatLength ?? 0.5) / 2) : time)
        c.duration = (beatLength ?? 0.5) * 4
        store.data.shows[si].tracks[ti].clips.append(c)
        store.data.shows[si].tracks[ti].clips.sort { $0.start < $1.start }
        select(track, c)
    }

    private func duplicate(_ si: Int, _ track: UUID, _ c: ShowClip) {
        guard let ti = store.data.shows[si].tracks.firstIndex(where: { $0.id == track }) else { return }
        var d = c
        d.id = UUID()
        d.start = c.end
        store.data.shows[si].tracks[ti].clips.append(d)
        store.data.shows[si].tracks[ti].clips.sort { $0.start < $1.start }
        select(track, d)
    }

    private func split(_ si: Int, _ track: UUID, _ c: ShowClip) {
        let t = player.position
        guard t > c.start + 0.05, t < c.end - 0.05,
              let ti = store.data.shows[si].tracks.firstIndex(where: { $0.id == track }),
              let ci = store.data.shows[si].tracks[ti].clips.firstIndex(where: { $0.id == c.id }) else { return }
        var second = c
        second.id = UUID()
        second.start = t
        second.duration = c.end - t
        store.data.shows[si].tracks[ti].clips[ci].duration = t - c.start
        store.data.shows[si].tracks[ti].clips.insert(second, at: ci + 1)
    }

    private func delete(_ si: Int, _ track: UUID, _ clip: UUID) {
        guard let ti = store.data.shows[si].tracks.firstIndex(where: { $0.id == track }) else { return }
        store.data.shows[si].tracks[ti].clips.removeAll { $0.id == clip }
        if selection?.clip == clip { selection = nil }
    }

    // MARK: - Music

    private func analyse() async {
        guard let name = show.audioFile else { analysis = nil; return }
        analysing = true
        defer { analysing = false }
        let url = AudioStore.url(for: name)
        let result = await Task.detached(priority: .userInitiated) { try? AudioAnalysis.analyze(url: url) }.value
        analysis = result
        guard let result, let si else { return }
        if abs(store.data.shows[si].duration - result.duration) > 0.01 {
            store.data.shows[si].duration = result.duration
        }
        if store.data.shows[si].bpm == nil, let bpm = result.bpm {
            store.data.shows[si].bpm = bpm
            store.data.shows[si].beatOffset = result.beatOffset
        }
    }

    // MARK: - Helpers

    static func clock(_ t: Double, short: Bool = false) -> String {
        let t = max(0, t)
        let m = Int(t) / 60
        let s = t - Double(m * 60)
        return short ? String(format: "%d:%02d", m, Int(s)) : String(format: "%d:%04.1f", m, s)
    }

    /// Spacing of ruler labels for a zoom level.
    static func labelStep(_ pps: CGFloat) -> Double {
        for step in [0.5, 1, 2, 5, 10, 15, 30, 60] where CGFloat(step) * pps >= 60 { return step }
        return 120
    }

    static func colours(of c: ShowClip) -> [Color] {
        let fx = LightEffect.named(c.fx)
        var hex: [Int]
        if c.fx == 11 {
            hex = ColorPalette.all[4].colors
        } else if fx.usesPalette && c.pal != 0 {
            hex = ColorPalette.all.first { $0.id == c.pal }?.colors ?? [c.c1]
        } else if fx.usesColor2 || (fx.usesPalette && c.pal == 0) {
            hex = [c.c1, c.c2]
        } else {
            hex = [c.c1]
        }
        if hex.count == 1 { hex.append(hex[0]) }
        let dim = Double(max(c.bri, 60)) / 255
        return hex.map { Color(hex: $0).opacity(dim) }
    }
}

/// Which plants a show track plays on, and whether they animate separately or as one.
struct TrackPlantsView: View {
    @Binding var track: ShowTrack
    let plants: [Plant]
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Button {
                        track.targets = []
                    } label: {
                        HStack {
                            Text("All props").foregroundStyle(.primary)
                            Spacer()
                            if track.targets.isEmpty { Image(systemName: "checkmark").foregroundStyle(.tint) }
                        }
                    }
                    ForEach(Array(plants.enumerated()), id: \.element.id) { i, p in
                        Button {
                            if let k = track.targets.firstIndex(of: p.id) {
                                track.targets.remove(at: k)
                            } else {
                                track.targets.append(p.id)
                            }
                        } label: {
                            HStack {
                                Circle().fill(Color(uiColor: PointCloudGeometry.plantColor(i))).frame(width: 10, height: 10)
                                Text(p.name).foregroundStyle(.primary)
                                Spacer()
                                if track.targets.contains(p.id) { Image(systemName: "checkmark").foregroundStyle(.tint) }
                            }
                        }
                    }
                } header: {
                    Text("Plays on")
                } footer: {
                    Text("Tick the props this track lights. With none ticked it plays on all of them.")
                }

                Section {
                    Picker("Animate", selection: $track.together) {
                        Text("Each prop on its own").tag(false)
                        Text("All as one prop").tag(true)
                    }
                    .pickerStyle(.inline)
                    .labelsHidden()
                } header: {
                    Text("Animate")
                } footer: {
                    Text(track.together
                         ? "The props are treated as one big prop: a spiral winds around the whole group, a sweep or pulse travels across it, a gradient runs from the lowest LED to the highest."
                         : "Every prop runs the effect by itself, as if it were the only prop: each gets its own spiral, sweep and pulse, fitted to its own size.")
                }
            }
            .navigationTitle("Track")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
        .presentationDetents([.medium, .large])
    }
}
