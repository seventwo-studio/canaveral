import SwiftUI
import CanaveralVMCore
import ImageIO

public struct DesktopsView: View {
    @Bindable var model: DesktopModel
    public init(model: DesktopModel) { self.model = model }
    public var body: some View {
        NavigationStack {
            List {
                if (model.state.desktopTargets ?? []).isEmpty {
                    ContentUnavailableView("Your guest desktops", systemImage: "desktopcomputer", description: Text("Register a guest helper in Canaveral Machines settings. Its desktop will appear here on this Mac."))
                }
                ForEach(model.state.desktopTargets ?? []) { target in
                    NavigationLink { RemoteDesktopView(target: target, model: model) } label: {
                        HStack {
                            Label(target.name, systemImage: "desktopcomputer")
                            Spacer()
                            if target.userControl == true { Text("Your control").font(.caption).foregroundStyle(.secondary) }
                        }
                    }
                }
            }.navigationTitle("Desktops")
        }
    }
}

public struct RemoteDesktopView: View {
    var target: DesktopTarget
    @Bindable var model: DesktopModel
    @State private var session: DesktopSession?
    @State private var image: CGImage?
    @State private var confirmedOwner: Bool?
    @State private var busy = false
    @State private var loading = false
    @State private var issue: String?
    @State private var text = ""
    @State private var shortcut = ""
    @State private var live = true
    @Environment(\.scenePhase) private var phase
    public init(target: DesktopTarget, model: DesktopModel) { self.target = target; self.model = model }
    private var ownsControl: Bool { (confirmedOwner ?? target.userControl) == true }
    private var canInput: Bool { ownsControl && !busy && model.connected && session != nil && image != nil && issue == nil }
    public var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                HStack {
                    Label(ownsControl ? "You control this desktop" : "Assistant control", systemImage: ownsControl ? "hand.raised.fill" : "sparkle")
                    Spacer()
                    if loading { ProgressView().controlSize(.small) }
                }.font(.subheadline)
                if let image, let frame = session?.frame {
                    Image(decorative: image, scale: 1).resizable().aspectRatio(CGFloat(frame.width) / CGFloat(frame.height), contentMode: .fit)
                        .overlay {
                            GeometryReader { geometry in
                                Color.clear.contentShape(Rectangle())
                                    .onTapGesture { point in
                                        guard canInput, geometry.size.width > 0, geometry.size.height > 0 else { return }
                                        input(.init(frameID: frame.id, kind: .click, x: point.x / geometry.size.width, y: point.y / geometry.size.height))
                                    }
                            }
                        }
                        .accessibilityLabel("Desktop image for \(target.name). Use coordinate controls below to click.")
                        .background(.black).clipShape(.rect(cornerRadius: 12))
                    Text("Captured \(frame.capturedAt.formatted(date: .omitted, time: .standard)). Images refresh about once a second while visible.").font(.caption).foregroundStyle(.secondary)
                } else {
                    ContentUnavailableView("Desktop unavailable", systemImage: "display", description: Text(issue ?? "Connecting to the guest helper…"))
                }
                if let issue { Text(issue).font(.callout).foregroundStyle(.red).accessibilityAddTraits(.updatesFrequently) }
                HStack {
                    Button(ownsControl ? "Return control to AI" : "Take over", systemImage: ownsControl ? "sparkle" : "hand.raised") { changeControl() }
                        .buttonStyle(.glassProminent).disabled(busy || !model.connected)
                    Button("Refresh", systemImage: "arrow.clockwise") { Task { await refresh() } }.disabled(busy || loading || !model.connected)
                }
                Text("Takeover blocks assistant desktop input until you return control, including after disconnection. Returning control leaves interrupted tasks stopped for review.").font(.caption).foregroundStyle(.secondary)
                if ownsControl {
                    VStack(alignment: .leading, spacing: 12) {
                        Text("Click the image or use the controls below.").font(.callout)
                        HStack {
                            TextField("Text to type in the guest", text: $text)
                            Button("Type") { guard let frame = session?.frame else { return }; input(.init(frameID: frame.id, kind: .typeText, text: text)) }.disabled(text.isEmpty || !canInput)
                        }
                        HStack {
                            TextField("Shortcut, e.g. cmd+l or ctrl+l", text: $shortcut)
                            Button("Send key") { key(shortcut) }.disabled(shortcut.isEmpty || !canInput)
                        }
                        HStack {
                            Button("Return") { key("return") }; Button("Tab") { key("tab") }; Button("Escape") { key("escape") }
                        }.disabled(!canInput)
                        HStack {
                            Button("Scroll up", systemImage: "arrow.up") { scroll(5) }
                            Button("Scroll down", systemImage: "arrow.down") { scroll(-5) }
                        }.disabled(!canInput)
                        CoordinateClick { x, y in guard let frame = session?.frame else { return }; input(.init(frameID: frame.id, kind: .click, x: x, y: y)) }.disabled(!canInput)
                    }
                }
            }.padding().frame(maxWidth: 1400)
        }.navigationTitle(target.name)
        .toolbar { Toggle("Live refresh", isOn: $live) }
        .task(id: target.id) {
            while !Task.isCancelled {
                if live, phase == .active, !busy, model.connected { await refresh() }
                do { try await Task.sleep(for: .seconds(1)) } catch { break }
            }
        }
        .onChange(of: model.connected) { if !model.connected { issue = "Disconnected. Desktop control stays with its current owner." } }
    }
    private func refresh() async {
        guard !loading else { return }; loading = true; defer { loading = false }
        do {
            let next = try await model.desktop(target.id); try next.frame.validate()
            guard let data = Data(base64Encoded: next.frame.pngBase64), let source = CGImageSourceCreateWithData(data as CFData, nil), let picture = CGImageSourceCreateImageAtIndex(source, 0, nil) else { throw CanaveralError.invalid("Could not display this guest image.") }
            session = next; confirmedOwner = next.userControl; image = picture; issue = nil
        } catch { if !Task.isCancelled { issue = error.localizedDescription } }
    }
    private func changeControl() {
        guard !busy else { return }; let human = !ownsControl; busy = true
        Task {
            do {
                let result = try await model.desktopControl(target.id, human: human)
                confirmedOwner = result.userControl; session = nil; await refresh()
            } catch { issue = "Handoff was not confirmed: \(error.localizedDescription). Refresh to inspect its current owner." }
            busy = false
        }
    }
    private func input(_ action: DesktopAction) {
        guard canInput else { return }; busy = true
        Task {
            do { _ = try await model.desktopInput(target.id, action: action); session = nil; await refresh() }
            catch { session = nil; issue = "Input outcome is uncertain. Refresh and inspect the desktop before sending another action. \(error.localizedDescription)" }
            busy = false
        }
    }
    private func key(_ key: String) { guard let frame = session?.frame else { return }; input(.init(frameID: frame.id, kind: .key, key: key)) }
    private func scroll(_ delta: Int) { guard let frame = session?.frame else { return }; input(.init(frameID: frame.id, kind: .scroll, delta: delta)) }
}
private struct CoordinateClick: View {
    var click: (Double, Double) -> Void
    @State private var x = 50
    @State private var y = 50
    var body: some View {
        VStack(alignment: .leading) {
            Stepper("Horizontal position: \(x)%", value: $x, in: 0...100).accessibilityLabel("Click horizontal position")
            Stepper("Vertical position: \(y)%", value: $y, in: 0...100).accessibilityLabel("Click vertical position")
            Button("Click at position") { click(Double(x) / 100, Double(y) / 100) }
        }.font(.callout)
    }
}
