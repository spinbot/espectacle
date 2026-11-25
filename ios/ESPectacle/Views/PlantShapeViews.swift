import SwiftUI

/// Settings for a drawn plant (grid, cone, polyline, circle, arch), as Form sections.
struct ShapeEditorSections: View {
    @Binding var shape: PlantShape
    let ledCount: Int

    var body: some View {
        Section {
            switch shape.kind {
            case .grid:
                metres("Width", $shape.width)
                metres("Height", $shape.height)
                whole("Columns", $shape.columns)
                whole("Rows", $shape.rows)
                Picker("First LED", selection: $shape.start) {
                    Text("Bottom left").tag("bottomLeft"); Text("Bottom right").tag("bottomRight")
                    Text("Top left").tag("topLeft"); Text("Top right").tag("topRight")
                }
                Picker("Wired along", selection: $shape.vertical) {
                    Text("Rows").tag(false); Text("Columns").tag(true)
                }
                Toggle("Zigzag (every other row runs back)", isOn: $shape.zigzag)
            case .cone:
                metres("Height", $shape.height)
                metres("Bottom diameter", $shape.width)
                metres("Top diameter", $shape.topWidth)
                Picker("Wired as", selection: $shape.spiral) {
                    Text("Strands, bottom to top").tag(false); Text("One spiral").tag(true)
                }
                if shape.spiral {
                    number("Turns", $shape.turns, step: 0.5)
                } else {
                    whole("Strands", $shape.columns)
                    Toggle("Zigzag (every other strand runs back)", isOn: $shape.zigzag)
                }
                Picker("First LED", selection: $shape.start) {
                    Text("Bottom").tag("bottom"); Text("Top").tag("top")
                }
                countRows
            case .circle:
                metres("Diameter", $shape.width)
                number("First LED at (°)", $shape.startAngle, step: 15)
                Toggle("Clockwise", isOn: $shape.clockwise)
                Toggle("Lying flat", isOn: $shape.flat)
                countRows
            case .arch:
                metres("Span", $shape.width)
                metres("Height", $shape.height)
                Picker("First LED", selection: $shape.start) {
                    Text("Left foot").tag("left"); Text("Right foot").tag("right")
                }
                countRows
            case .polyline:
                Toggle("First LED at the last point", isOn: $shape.reverse)
                countRows
            case .panel:
                Picker("Panel", selection: Binding(get: { "\(shape.columns)x\(shape.rows)" },
                                                   set: { v in
                                                       let p = v.split(separator: "x").compactMap { Int($0) }
                                                       if p.count == 2 { shape.columns = p[0]; shape.rows = p[1] }
                                                   })) {
                    ForEach(["8x8", "16x16", "32x8", "8x32"], id: \.self) { Text($0.replacingOccurrences(of: "x", with: " × ")).tag($0) }
                    if !["8x8", "16x16", "32x8", "8x32"].contains("\(shape.columns)x\(shape.rows)") {
                        Text("Custom").tag("\(shape.columns)x\(shape.rows)")
                    }
                }
                number("LED spacing (mm)", Binding(get: { shape.pitch * 1000 }, set: { shape.pitch = max($0, 1) / 1000 }), step: 0.5)
                whole("Columns (per panel)", $shape.columns)
                whole("Rows (per panel)", $shape.rows)
                whole("Panels across", $shape.tilesX)
                whole("Panels down", $shape.tilesY)
                Picker("First LED", selection: $shape.start) {
                    Text("Top left").tag("topLeft"); Text("Top right").tag("topRight")
                    Text("Bottom left").tag("bottomLeft"); Text("Bottom right").tag("bottomRight")
                }
                Picker("Wired along", selection: $shape.vertical) {
                    Text("Columns").tag(true); Text("Rows").tag(false)
                }
                Toggle("Zigzag (serpentine)", isOn: $shape.zigzag)
            }
        } header: {
            Text(shape.kind.name)
        } footer: {
            Text("\(ledCount) LEDs. " + hint)
        }

        if shape.kind == .polyline {
            Section {
                ForEach(shape.points.indices, id: \.self) { k in
                    HStack(spacing: 8) {
                        Text("\(k + 1)").foregroundStyle(.secondary).frame(width: 22, alignment: .leading)
                        axis("X", point(k, \.x))
                        axis("Y", point(k, \.y))
                        axis("Z", point(k, \.z))
                    }
                }
                .onDelete { shape.points.remove(atOffsets: $0) }
                Button {
                    let last = shape.points.last ?? ShapePoint(x: 0, y: 0, z: 0)
                    shape.points.append(ShapePoint(x: last.x + 0.5, y: last.y, z: last.z))
                } label: {
                    Label("Add point", systemImage: "plus")
                }
            } header: {
                Text("Points")
            } footer: {
                Text("Metres from the prop's position: X right, Y up, Z towards the street. Swipe to remove a point.")
            }
        }
    }

    private var hint: String {
        switch shape.kind {
        case .grid: return "Standing up, facing the street; the bottom edge is at the prop's height (Y)."
        case .cone: return "Strands start at the front and go round to the right, seen from above."
        case .circle: return "0° is the right-hand side, 90° the top (away from the street when lying flat)."
        case .arch: return "Standing up, facing the street. Turn the prop to angle it."
        case .polyline: return "The LEDs are spread evenly along the line through the points."
        case .panel: return "Facing the street; panels chain from the first-LED corner along each row of panels. Great for Marquee and Video."
        }
    }

    @ViewBuilder private var countRows: some View {
        Picker("LEDs by", selection: Binding(get: { shape.perMetre != nil }, set: { shape.perMetre = $0 ? 30 : nil })) {
            Text("Number").tag(false); Text("Per metre").tag(true)
        }
        if shape.perMetre != nil {
            number("LEDs per metre", Binding(get: { shape.perMetre ?? 30 }, set: { shape.perMetre = max($0, 1) }), step: 1)
        } else {
            whole(shape.kind == .cone && !shape.spiral ? "LEDs (all strands)" : "LEDs", $shape.count)
        }
    }

    private func point(_ k: Int, _ key: WritableKeyPath<ShapePoint, Float>) -> Binding<Float> {
        Binding(get: { shape.points.indices.contains(k) ? shape.points[k][keyPath: key] : 0 },
                set: { if shape.points.indices.contains(k) { shape.points[k][keyPath: key] = $0 } })
    }

    private func axis(_ label: String, _ value: Binding<Float>) -> some View {
        HStack(spacing: 2) {
            Text(label).font(.caption).foregroundStyle(.secondary)
            TextField(label, value: value, format: .number.precision(.fractionLength(0...2)))
                .keyboardType(.numbersAndPunctuation)
                .textFieldStyle(.roundedBorder)
        }
    }

    private func metres(_ label: String, _ value: Binding<Float>) -> some View {
        HStack {
            Text(label)
            Spacer()
            TextField(label, value: Binding(get: { value.wrappedValue }, set: { value.wrappedValue = max($0, 0) }),
                      format: .number.precision(.fractionLength(0...2)))
                .keyboardType(.decimalPad)
                .multilineTextAlignment(.trailing)
                .frame(width: 80)
            Text("m").foregroundStyle(.secondary)
        }
    }

    private func number(_ label: String, _ value: Binding<Float>, step: Float) -> some View {
        HStack {
            Text(label)
            Spacer()
            TextField(label, value: value, format: .number.precision(.fractionLength(0...1)))
                .keyboardType(.numbersAndPunctuation)
                .multilineTextAlignment(.trailing)
                .frame(width: 70)
            Stepper(label, value: value, step: step).labelsHidden()
        }
    }

    private func whole(_ label: String, _ value: Binding<Int>) -> some View {
        HStack {
            Text(label)
            Spacer()
            TextField(label, value: Binding(get: { value.wrappedValue }, set: { value.wrappedValue = max($0, 1) }), format: .number)
                .keyboardType(.numberPad)
                .multilineTextAlignment(.trailing)
                .frame(width: 70)
            Stepper(label, value: Binding(get: { value.wrappedValue }, set: { value.wrappedValue = max($0, 1) }), in: 1...5000)
                .labelsHidden()
        }
    }
}

/// One LED range: a run of LEDs on a controller string.
struct PlantPartRow: View {
    @Binding var part: PlantPart
    let controllers: [Controller]

    private var strings: [LEDString] { controllers.first { $0.id == part.controller }?.strings ?? [] }
    private var stringLength: Int { strings.indices.contains(part.string) ? strings[part.string].count : 0 }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Picker("Controller", selection: $part.controller) {
                ForEach(controllers) { Text($0.name).tag($0.id) }
            }
            Picker("String", selection: $part.string) {
                ForEach(strings.indices, id: \.self) { i in Text("String \(i + 1) · \(strings[i].count) LEDs").tag(i) }
            }
            HStack {
                Text("From LED")
                TextField("1", value: Binding(get: { part.start + 1 }, set: { part.start = max(0, $0 - 1) }), format: .number)
                    .keyboardType(.numberPad)
                    .textFieldStyle(.roundedBorder)
                    .frame(width: 70)
                Spacer()
                Text("Count")
                TextField("1", value: Binding(get: { part.count }, set: { part.count = max(1, $0) }), format: .number)
                    .keyboardType(.numberPad)
                    .textFieldStyle(.roundedBorder)
                    .frame(width: 70)
            }
            if stringLength > 0, part.start + part.count > stringLength {
                Text("String \(part.string + 1) only has \(stringLength) LEDs.")
                    .font(.caption).foregroundStyle(.orange)
            }
        }
        .onChange(of: part.controller) {
            if !strings.indices.contains(part.string) { part.string = 0 }
        }
    }
}
