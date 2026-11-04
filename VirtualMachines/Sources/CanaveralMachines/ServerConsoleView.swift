#if os(macOS)
import SwiftUI

public struct ServerConsoleView: View {
    @Bindable private var console: SerialConsole
    @State private var input = ""
    @State private var hideInput = true
    @State private var error: String?
    private let running: Bool
    public init(console: SerialConsole, running: Bool) { self.console = console; self.running = running }
    public var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label("Server console", systemImage: "terminal").font(.headline)
            Text("The server keeps running with this window closed. Linux must provide a serial login on hvc0. This console accepts lines and Ctrl-C; full-screen terminal programs need SSH.")
                .font(.caption).foregroundStyle(.secondary)
            ScrollView {
                Text(console.output.isEmpty ? "Waiting for serial output…" : console.output)
                    .font(.system(.body, design: .monospaced)).textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }.accessibilityLabel("Guest serial output")
            HStack {
                Group {
                    if hideInput { SecureField("Console input", text: $input) }
                    else { TextField("Console input", text: $input) }
                }.onSubmit(send).disabled(!running || console.closed)
                Button("Send", action: send).disabled(!running || console.closed)
                Button("Ctrl-C") { do { try console.interrupt() } catch { self.error = error.localizedDescription } }
                    .disabled(!running || console.closed)
            }
            Toggle("Hide input", isOn: $hideInput).font(.caption)
            if let error { Text(error).font(.caption).foregroundStyle(.red) }
        }.padding()
        .task { while !Task.isCancelled { console.refresh(); try? await Task.sleep(for: .milliseconds(200)) } }
    }
    private func send() {
        do { try console.sendLine(input); input = ""; error = nil } catch { self.error = error.localizedDescription }
    }
}
#endif
