// ChatStatus — menu bar app showing the status of every Claude Code chat.
//
// Reads ~/.claude/chat-status/*.json (written by update_status.py hooks) and shows
// colored dot + count per status in the bar: orange = needs your input,
// green = working, gray = finished/idle.
// Dropdown renders one card per chat (repo, status, age, wrapping chat title).
// Clicking a card focuses that repo's VS Code window and deep-links the session.
// Fires a macOS notification when a chat finishes or needs you.
// Build with build.sh; run `ChatStatus --dump` to print state without the GUI.

import AppKit
import UserNotifications
import FoundationModels

func run(_ path: String, _ args: [String]) {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: path)
    p.arguments = args
    try? p.run()
}

struct Chat {
    let sessionId: String
    let repo: String
    let branch: String
    let cwd: String
    let status: String
    let title: String
    let lastPrompt: String
    let updatedAt: Date

    // Text to summarize: what the chat is doing now (latest prompt), else its name.
    var summarySource: String { lastPrompt.isEmpty ? title : lastPrompt }
}

let statusDir = FileManager.default.homeDirectoryForCurrentUser
    .appendingPathComponent(".claude/chat-status")

// Wraps Apple's on-device model (macOS 26+). Isolated in an availability-gated
// class so FoundationModels types never leak into the rest of the app.
@available(macOS 26.0, *)
final class FMEngine {
    static let shared = FMEngine()
    private let instructions = """
        Turn the developer's chat message into a terse status label of at most 6 words \
        describing what they are working on. Output only the label: no quotes, no \
        trailing punctuation, no preamble.
        """
    private let options = GenerationOptions(maximumResponseTokens: 16)
    private var warm: LanguageModelSession?

    var available: Bool {
        if case .available = SystemLanguageModel.default.availability { return true }
        return false
    }

    // Load the model once at launch so later summaries are ~0.5s, not ~4s.
    func prewarm() {
        guard available else { return }
        let s = LanguageModelSession(instructions: instructions)
        s.prewarm()
        warm = s
    }

    func summarize(_ text: String) async -> String? {
        guard available else { return nil }
        let session = LanguageModelSession(instructions: instructions)
        guard let r = try? await session.respond(to: text, options: options) else { return nil }
        return r.content.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

func loadChats() -> [Chat] {
    let fm = FileManager.default
    guard let files = try? fm.contentsOfDirectory(at: statusDir, includingPropertiesForKeys: nil) else {
        return []
    }
    var chats: [Chat] = []
    for url in files where url.pathExtension == "json" {
        guard let data = try? Data(contentsOf: url),
              let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let sid = obj["session_id"] as? String,
              let status = obj["status"] as? String else { continue }
        let ts = (obj["updated_at"] as? Double) ?? 0
        let updated = Date(timeIntervalSince1970: ts)
        // Sessions killed without a clean SessionEnd leave files behind; prune after a day.
        if Date().timeIntervalSince(updated) > 24 * 3600 {
            try? fm.removeItem(at: url)
            continue
        }
        chats.append(Chat(
            sessionId: sid,
            repo: (obj["repo"] as? String) ?? "?",
            branch: (obj["branch"] as? String) ?? "",
            cwd: (obj["cwd"] as? String) ?? "",
            status: status,
            title: (obj["title"] as? String) ?? (obj["last_prompt"] as? String) ?? "",
            lastPrompt: (obj["last_prompt"] as? String) ?? "",
            updatedAt: updated
        ))
    }
    let order = ["needs_input": 0, "working": 1, "live": 2, "done": 3]
    chats.sort {
        let a = order[$0.status] ?? 4
        let b = order[$1.status] ?? 4
        if a != b { return a < b }
        return $0.updatedAt > $1.updatedAt
    }
    return chats
}

func dotColor(for status: String) -> NSColor {
    switch status {
    case "working": return .systemGreen
    case "needs_input": return .systemOrange
    default: return .systemGray
    }
}

func label(for status: String) -> String {
    switch status {
    case "working": return "working"
    case "needs_input": return "needs you"
    case "done": return "finished"
    case "live": return "idle"
    default: return status
    }
}

func age(_ date: Date) -> String {
    let s = Int(Date().timeIntervalSince(date))
    if s < 60 { return "now" }
    if s < 3600 { return "\(s / 60)m" }
    return "\(s / 3600)h"
}

final class FlippedView: NSView { override var isFlipped: Bool { true } }

// One dropdown card. Top row: colored status dot, repo name, status word + age.
// Below: the chat title, wrapping up to 3 lines across the full card width.
final class ChatCardView: NSView {
    private let card = NSView()
    var onClick: (() -> Void)?
    private let baseColor = NSColor.labelColor.withAlphaComponent(0.055)
    private let hoverColor = NSColor.labelColor.withAlphaComponent(0.12)

    static let titleFont = NSFont.systemFont(ofSize: 13, weight: .medium)
    static let lineHeight: CGFloat = 17
    static let maxLines: CGFloat = 3

    static func displayName(_ chat: Chat) -> String {
        if !chat.title.isEmpty { return chat.title }
        let folder = URL(fileURLWithPath: chat.cwd).lastPathComponent
        return folder.isEmpty ? chat.repo : folder
    }

    static func titleHeight(_ name: String, width: CGFloat) -> CGFloat {
        let rect = (name as NSString).boundingRect(
            with: NSSize(width: width, height: .greatestFiniteMagnitude),
            options: [.usesLineFragmentOrigin, .usesFontLeading],
            attributes: [.font: titleFont])
        return min(ceil(rect.height), lineHeight * maxLines)
    }

    init(chat: Chat, width: CGFloat, titleText: String) {
        let cardW = width - 12
        let titleW = cardW - 41
        let name = titleText.isEmpty ? Self.displayName(chat) : titleText
        let textH = Self.titleHeight(name, width: titleW)
        let cardH = textH + 34
        super.init(frame: NSRect(x: 0, y: 0, width: width, height: cardH + 4))
        card.frame = NSRect(x: 6, y: 2, width: cardW, height: cardH)
        card.wantsLayer = true
        card.layer?.cornerRadius = 9
        card.layer?.backgroundColor = baseColor.cgColor
        addSubview(card)

        let dot = NSView(frame: NSRect(x: 12, y: cardH - 20.5, width: 9, height: 9))
        dot.wantsLayer = true
        dot.layer?.cornerRadius = 4.5
        dot.layer?.backgroundColor = dotColor(for: chat.status).cgColor
        card.addSubview(dot)

        let repo = NSTextField(labelWithString: chat.repo)
        repo.font = .systemFont(ofSize: 11, weight: .semibold)
        repo.textColor = .secondaryLabelColor
        repo.lineBreakMode = .byTruncatingTail
        repo.frame = NSRect(x: 29, y: cardH - 24, width: cardW - 145, height: 16)
        card.addSubview(repo)

        let meta = NSTextField(labelWithString: "\(label(for: chat.status)) · \(age(chat.updatedAt))")
        meta.font = .systemFont(ofSize: 11)
        meta.textColor = chat.status == "needs_input" ? .systemOrange : .secondaryLabelColor
        meta.alignment = .right
        meta.frame = NSRect(x: cardW - 112, y: cardH - 24, width: 100, height: 16)
        card.addSubview(meta)

        let primary = NSTextField(wrappingLabelWithString: name)
        primary.font = Self.titleFont
        primary.isSelectable = false
        primary.maximumNumberOfLines = Int(Self.maxLines)
        primary.cell?.truncatesLastVisibleLine = true
        primary.frame = NSRect(x: 29, y: 8, width: titleW, height: textH)
        card.addSubview(primary)
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        trackingAreas.forEach(removeTrackingArea)
        addTrackingArea(NSTrackingArea(
            rect: bounds,
            options: [.mouseEnteredAndExited, .activeAlways],
            owner: self
        ))
    }

    override func mouseEntered(with event: NSEvent) {
        card.layer?.backgroundColor = hoverColor.cgColor
    }

    override func mouseExited(with event: NSEvent) {
        card.layer?.backgroundColor = baseColor.cgColor
    }

    override func mouseUp(with event: NSEvent) {
        onClick?()
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
    var statusItem: NSStatusItem!
    var chats: [Chat] = []
    var lastStatuses: [String: String] = [:]
    var firstPoll = true
    var nativeNotifications = false

    let panelWidth: CGFloat = 420
    var panel: NSPanel!
    var panelHeight: CGFloat = 0
    var panelFingerprint = ""
    var clickMonitor: Any?

    // On-device AI one-line summaries, keyed by session. Cache stores the
    // source-text hash so a summary is recomputed only when the prompt changes.
    var summaryCache: [String: (hash: Int, text: String)] = [:]
    var summaryInFlight: Set<String> = []

    var notificationsEnabled: Bool {
        get { !UserDefaults.standard.bool(forKey: "notificationsPaused") }
        set { UserDefaults.standard.set(!newValue, forKey: "notificationsPaused") }
    }

    // Default on (bool(forKey:) is false when unset); only meaningful when the
    // on-device model is available.
    var summariesEnabled: Bool {
        get { !UserDefaults.standard.bool(forKey: "summariesOff") }
        set { UserDefaults.standard.set(!newValue, forKey: "summariesOff") }
    }

    var summariesAvailable: Bool {
        if #available(macOS 26.0, *) { return FMEngine.shared.available }
        return false
    }

    // Kick off a summary for a chat if enabled, available, and its prompt changed.
    func ensureSummary(for chat: Chat) {
        guard summariesEnabled, summariesAvailable else { return }
        let text = chat.summarySource
        guard !text.isEmpty else { return }
        let key = chat.sessionId
        let h = text.hashValue
        if let c = summaryCache[key], c.hash == h { return }
        if summaryInFlight.contains(key) { return }
        summaryInFlight.insert(key)
        guard #available(macOS 26.0, *) else { return }
        Task {
            let result = await FMEngine.shared.summarize(text)
            await MainActor.run {
                self.summaryInFlight.remove(key)
                if let r = result, !r.isEmpty {
                    self.summaryCache[key] = (h, r)
                    if self.panel.isVisible { self.refreshPanel(); self.positionPanel() }
                }
            }
        }
    }

    // The best label to show for a chat: its AI summary if ready, else nil (raw).
    func summaryText(for chat: Chat) -> String? {
        guard summariesEnabled else { return nil }
        return summaryCache[chat.sessionId]?.text
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        // A ⌘-dragged-off status item is remembered as hidden across launches;
        // this app is useless without its item, so force it visible every start.
        statusItem.isVisible = true
        statusItem.behavior = []
        statusItem.button?.target = self
        statusItem.button?.action = #selector(togglePanel)
        statusItem.button?.sendAction(on: [.leftMouseUp, .rightMouseUp])

        panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: panelWidth, height: 100),
                        styleMask: [.borderless, .nonactivatingPanel],
                        backing: .buffered, defer: true)
        panel.level = .statusBar
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.isMovable = false
        panel.becomesKeyOnlyIfNeeded = true
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        // Rich notifications (app icon, subtitle, click-to-jump) need the
        // notification center; if macOS won't authorize this ad-hoc-signed
        // build, notify() falls back to the osascript ping.
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        center.requestAuthorization(options: [.alert, .sound]) { granted, _ in
            DispatchQueue.main.async { self.nativeNotifications = granted }
        }

        if #available(macOS 26.0, *) {
            FMEngine.shared.prewarm()
        }

        poll()
        Timer.scheduledTimer(withTimeInterval: 2.0, repeats: true) { [weak self] _ in
            self?.poll()
        }
    }

    func poll() {
        // Re-check notification auth every tick so toggling it on in System
        // Settings takes effect live, without needing an app relaunch.
        UNUserNotificationCenter.current().getNotificationSettings { s in
            let ok = s.authorizationStatus == .authorized || s.authorizationStatus == .provisional
            DispatchQueue.main.async { self.nativeNotifications = ok }
        }
        chats = loadChats()
        // Keep summaries warm and current in the background so cards and
        // notifications can read them from cache the moment they're needed.
        for chat in chats { ensureSummary(for: chat) }
        // Drop cache entries for sessions that have ended.
        let live = Set(chats.map { $0.sessionId })
        summaryCache = summaryCache.filter { live.contains($0.key) }
        if notificationsEnabled && !firstPoll {
            for chat in chats {
                let prev = lastStatuses[chat.sessionId]
                guard prev != chat.status else { continue }
                if chat.status == "needs_input" {
                    notify(chat: chat, headline: "Claude needs your input")
                } else if chat.status == "done" && prev == "working" {
                    notify(chat: chat, headline: "Claude finished")
                }
            }
        }
        lastStatuses = Dictionary(uniqueKeysWithValues: chats.map { ($0.sessionId, $0.status) })
        firstPoll = false
        updateTitle()
        // Live-refresh the panel while it's open, but only when content changed
        // (a rebuild resets hover state, so don't do it for nothing).
        if panel.isVisible {
            let fp = fingerprint()
            if fp != panelFingerprint {
                refreshPanel()
                positionPanel()
            }
        }
    }

    func fingerprint() -> String {
        chats.map { "\($0.sessionId)|\($0.status)|\(age($0.updatedAt))|\($0.title)" }
            .joined(separator: "\n")
    }

    // Compact native-looking title: small colored dot + count per status,
    // e.g. "●2 ●1" — much narrower than the old emoji counts.
    func updateTitle() {
        var counts: [String: Int] = [:]
        for c in chats { counts[c.status, default: 0] += 1 }
        let idle = (counts["done"] ?? 0) + (counts["live"] ?? 0)
        let s = NSMutableAttributedString()
        func segment(_ n: Int, _ color: NSColor) {
            guard n > 0 else { return }
            if s.length > 0 { s.append(NSAttributedString(string: " ")) }
            s.append(NSAttributedString(string: "●", attributes: [
                .font: NSFont.systemFont(ofSize: 10),
                .foregroundColor: color,
                .baselineOffset: 1,
            ]))
            s.append(NSAttributedString(string: "\u{2009}\(n)", attributes: [
                .font: NSFont.monospacedDigitSystemFont(ofSize: 12, weight: .medium),
                .foregroundColor: NSColor.labelColor,
            ]))
        }
        segment(counts["needs_input"] ?? 0, .systemOrange)
        segment(counts["working"] ?? 0, .systemGreen)
        segment(idle, .tertiaryLabelColor)
        if s.length > 0 {
            statusItem.button?.image = nil
            statusItem.button?.attributedTitle = s
        } else if let glyph = NSImage(systemSymbolName: "bubble.left.and.bubble.right",
                                      accessibilityDescription: "Chat Status") {
            glyph.isTemplate = true
            statusItem.button?.attributedTitle = NSAttributedString()
            statusItem.button?.image = glyph
        } else {
            statusItem.button?.attributedTitle = NSAttributedString(string: "✳︎")
        }
    }

    // --- Custom dropdown panel (frosted, rounded, non-native) ---

    @objc func togglePanel() {
        if panel.isVisible { hidePanel() } else { showPanel() }
    }

    func showPanel() {
        chats = loadChats()
        refreshPanel()
        positionPanel()
        panel.orderFrontRegardless()
        // Any click outside the app dismisses, like a menu would.
        clickMonitor = NSEvent.addGlobalMonitorForEvents(
            matching: [.leftMouseDown, .rightMouseDown]) { [weak self] _ in
            self?.hidePanel()
        }
    }

    func hidePanel() {
        panel.orderOut(nil)
        if let m = clickMonitor { NSEvent.removeMonitor(m); clickMonitor = nil }
    }

    func headerButton(_ symbol: String, _ tip: String, _ action: Selector) -> NSButton {
        let b = NSButton()
        b.image = NSImage(systemSymbolName: symbol, accessibilityDescription: tip)
        b.isBordered = false
        b.bezelStyle = .regularSquare
        b.imagePosition = .imageOnly
        b.contentTintColor = .secondaryLabelColor
        b.target = self
        b.action = action
        b.toolTip = tip
        b.frame = NSRect(x: 0, y: 0, width: 24, height: 22)
        return b
    }

    func refreshPanel() {
        panelFingerprint = fingerprint()
        let W = panelWidth
        let headerH: CGFloat = 44

        // Cards stack, laid out top-down in a flipped container.
        let content = FlippedView()
        var y: CGFloat = 2
        if chats.isEmpty {
            let empty = NSTextField(labelWithString: "No active chats")
            empty.font = .systemFont(ofSize: 12)
            empty.textColor = .secondaryLabelColor
            empty.alignment = .center
            empty.frame = NSRect(x: 0, y: 16, width: W, height: 18)
            content.addSubview(empty)
            y = 50
        }
        for chat in chats {
            let card = ChatCardView(chat: chat, width: W - 20,
                                    titleText: summaryText(for: chat) ?? "")
            card.setFrameOrigin(NSPoint(x: 10, y: y))
            card.toolTip = chat.cwd
            card.onClick = { [weak self] in
                self?.hidePanel()
                self?.routeTo(cwd: chat.cwd, sessionId: chat.sessionId)
            }
            content.addSubview(card)
            y += card.frame.height + 4
        }
        let contentH = y + 8
        panelHeight = min(headerH + contentH, 640)
        content.frame = NSRect(x: 0, y: 0, width: W, height: contentH)

        let root = NSVisualEffectView(frame: NSRect(x: 0, y: 0, width: W, height: panelHeight))
        root.material = .popover
        root.blendingMode = .behindWindow
        root.state = .active
        root.wantsLayer = true
        root.layer?.cornerRadius = 14
        root.layer?.masksToBounds = true

        let title = NSTextField(labelWithString: "Claude Chats")
        title.font = .systemFont(ofSize: 13, weight: .semibold)
        title.frame = NSRect(x: 18, y: panelHeight - 30, width: 200, height: 18)
        root.addSubview(title)

        // Header buttons, laid out right-to-left from the edge.
        var bx = W - 34
        func place(_ b: NSButton) {
            b.setFrameOrigin(NSPoint(x: bx, y: panelHeight - 32))
            root.addSubview(b)
            bx -= 30
        }
        place(headerButton("power", "Quit Chat Status", #selector(quitApp(_:))))
        place(headerButton("trash", "Clear finished", #selector(clearFinished(_:))))
        let bell = headerButton(notificationsEnabled ? "bell" : "bell.slash",
                                notificationsEnabled ? "Notifications on" : "Notifications off",
                                #selector(toggleNotifications(_:)))
        place(bell)
        // AI summaries toggle — only shown when the on-device model is available.
        if summariesAvailable {
            let sparkles = headerButton("sparkles",
                                        summariesEnabled ? "AI summaries on" : "AI summaries off",
                                        #selector(toggleSummaries(_:)))
            sparkles.contentTintColor = summariesEnabled ? .controlAccentColor : .secondaryLabelColor
            place(sparkles)
        }

        let line = NSView(frame: NSRect(x: 14, y: panelHeight - headerH + 2, width: W - 28, height: 1))
        line.wantsLayer = true
        line.layer?.backgroundColor = NSColor.separatorColor.withAlphaComponent(0.5).cgColor
        root.addSubview(line)

        let scroll = NSScrollView(frame: NSRect(x: 0, y: 0, width: W, height: panelHeight - headerH))
        scroll.drawsBackground = false
        scroll.borderType = .noBorder
        scroll.hasVerticalScroller = true
        scroll.documentView = content
        root.addSubview(scroll)

        panel.contentView = root
        panel.invalidateShadow()
    }

    func positionPanel() {
        guard let btnWindow = statusItem.button?.window else { return }
        let f = btnWindow.frame
        let screen = btnWindow.screen ?? NSScreen.main
        var x = f.maxX - panelWidth
        if let vis = screen?.visibleFrame {
            x = max(vis.minX + 8, min(x, vis.maxX - panelWidth - 8))
        }
        panel.setFrame(NSRect(x: x, y: f.minY - 6 - panelHeight, width: panelWidth, height: panelHeight),
                       display: true)
    }

    // Routes to the exact conversation, in two steps:
    // 1. Focus the VS Code window that has this repo's folder open (opens it if not).
    // 2. Deep-link the session via the extension's URI handler — focuses the chat tab
    //    if open, otherwise resumes the session in the now-focused window.
    // Both opens target VS Code by bundle id so they work regardless of where
    // the app lives (it's in ~/Downloads here, not /Applications).
    func routeTo(cwd: String, sessionId: String) {
        if !cwd.isEmpty {
            run("/usr/bin/open", ["-b", "com.microsoft.VSCode", cwd])
        }
        guard !sessionId.isEmpty else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + (cwd.isEmpty ? 0 : 0.8)) {
            run("/usr/bin/open", ["-b", "com.microsoft.VSCode",
                                  "vscode://anthropic.claude-code/open?session=\(sessionId)"])
        }
    }

    @objc func toggleNotifications(_ sender: Any?) {
        notificationsEnabled.toggle()
        if panel.isVisible { refreshPanel(); positionPanel() }
    }

    @objc func toggleSummaries(_ sender: Any?) {
        summariesEnabled.toggle()
        if summariesEnabled { chats.forEach { ensureSummary(for: $0) } }
        if panel.isVisible { refreshPanel(); positionPanel() }
    }

    @objc func clearFinished(_ sender: Any?) {
        for chat in chats where chat.status == "done" || chat.status == "live" {
            try? FileManager.default.removeItem(
                at: statusDir.appendingPathComponent("\(chat.sessionId).json"))
        }
        poll()
        if panel.isVisible { refreshPanel(); positionPanel() }
    }

    @objc func quitApp(_ sender: Any?) {
        NSApp.terminate(nil)
    }

    // Rich notification: headline, repo as subtitle, AI summary (or title) as body.
    // Clicking it jumps to the chat. osascript fallback if not authorized.
    func notify(chat: Chat, headline: String) {
        let body = summaryText(for: chat) ?? (chat.title.isEmpty ? chat.cwd : chat.title)
        if nativeNotifications {
            let content = UNMutableNotificationContent()
            content.title = headline
            content.subtitle = chat.repo
            content.body = body
            content.sound = .default
            content.userInfo = ["cwd": chat.cwd, "sessionId": chat.sessionId]
            UNUserNotificationCenter.current().add(UNNotificationRequest(
                identifier: UUID().uuidString, content: content, trigger: nil))
            return
        }
        func esc(_ s: String) -> String {
            s.replacingOccurrences(of: "\\", with: "\\\\")
                .replacingOccurrences(of: "\"", with: "\\\"")
        }
        let script = "display notification \"\(esc(body))\" with title \"\(esc(headline))\" subtitle \"\(esc(chat.repo))\" sound name \"Ping\""
        run("/usr/bin/osascript", ["-e", script])
    }

    // Clicking a notification routes to the chat it came from.
    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        let info = response.notification.request.content.userInfo
        routeTo(cwd: info["cwd"] as? String ?? "", sessionId: info["sessionId"] as? String ?? "")
        completionHandler()
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .sound])
    }
}

if CommandLine.arguments.contains("--dump") {
    for c in loadChats() {
        print("\(c.status)\t\(c.repo)\t\(c.branch)\t\(age(c.updatedAt))\t\(c.title)")
    }
    exit(0)
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
