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
import Carbon.HIToolbox
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
    let waitingOn: String     // what Claude is blocked on (exact tool/question/message)
    let waitingKind: String   // permission | reply | question | mcp | ""
    let errorType: String     // StopFailure error_type when status == "error"
    let failStreak: Int       // consecutive failed tool calls this turn
    let turnStartedAt: Date?  // stamped by UserPromptSubmit; survives tool events
    let updatedAt: Date

    // Text to summarize: what the chat is doing now (latest prompt), else its name.
    var summarySource: String { lastPrompt.isEmpty ? title : lastPrompt }

    // Working cards age from the turn's start (tool events keep updated_at
    // fresh, so it would always read "now"); others from the last event —
    // which for needs_input is how long you've kept Claude waiting.
    var activityDate: Date {
        status == "working" ? (turnStartedAt ?? updatedAt) : updatedAt
    }
}

let statusDir = FileManager.default.homeDirectoryForCurrentUser
    .appendingPathComponent(".claude/chat-status")

// FNV-1a. Stable across launches (String.hashValue is per-process seeded), so
// the persisted summary cache survives an app relaunch.
func stableHash(_ s: String) -> UInt64 {
    var h: UInt64 = 0xcbf29ce484222325
    for b in s.utf8 { h = (h ^ UInt64(b)) &* 0x100000001b3 }
    return h
}

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
    // Never used to generate: each summary gets its own session so chats don't
    // share transcript context. Holding one prewarmed session keeps the model
    // assets resident, which is what makes fresh sessions fast (~0.5s vs ~4s).
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
            waitingOn: (obj["waiting_on"] as? String) ?? "",
            waitingKind: (obj["waiting_kind"] as? String) ?? "",
            errorType: (obj["error_type"] as? String) ?? "",
            failStreak: (obj["fail_streak"] as? Int) ?? 0,
            turnStartedAt: (obj["turn_started_at"] as? Double).map { Date(timeIntervalSince1970: $0) },
            updatedAt: updated
        ))
    }
    let order = ["needs_input": 0, "error": 1, "working": 2, "live": 3, "done": 4]
    chats.sort {
        let a = order[$0.status] ?? 5
        let b = order[$1.status] ?? 5
        if a != b { return a < b }
        return $0.updatedAt > $1.updatedAt
    }
    return chats
}

func dotColor(for status: String) -> NSColor {
    switch status {
    case "working": return .systemGreen
    case "needs_input": return .systemOrange
    case "error": return .systemRed
    default: return .systemGray
    }
}

func label(for chat: Chat) -> String {
    switch chat.status {
    case "working": return "working"
    case "needs_input":
        switch chat.waitingKind {
        case "permission": return "needs permission"
        case "question": return "needs an answer"
        case "reply": return "waiting on you"
        case "mcp": return "MCP form"
        default: return "needs you"
        }
    case "error": return "errored"
    case "done": return "finished"
    case "live": return "idle"
    default: return chat.status
    }
}

// Human text for a StopFailure error_type.
func errorText(_ type: String) -> String {
    switch type {
    case "rate_limit": return "Rate limited"
    case "overloaded": return "API overloaded"
    case "authentication_failed": return "Auth failed — run /login"
    case "oauth_org_not_allowed": return "Org not allowed"
    case "billing_error": return "Billing error"
    case "invalid_request": return "Invalid request"
    case "model_not_found": return "Model not found"
    case "server_error": return "API server error"
    case "max_output_tokens": return "Hit max output tokens"
    default: return type.isEmpty ? "API error" : type.replacingOccurrences(of: "_", with: " ")
    }
}

func age(_ date: Date) -> String {
    let s = Int(Date().timeIntervalSince(date))
    if s < 60 { return "now" }
    if s < 3600 { return "\(s / 60)m" }
    return "\(s / 3600)h"
}

final class FlippedView: NSView { override var isFlipped: Bool { true } }

// Borderless panels refuse key status by default; the dropdown needs it so the
// local event monitor sees Esc.
final class KeyPanel: NSPanel {
    override var canBecomeKey: Bool { true }
}

// One dropdown card. Top row: colored status dot, repo name (+ branch), an
// optional user tag chip, status word + age. Below: the chat title, wrapping
// up to 3 lines across the card. Hovering swaps the status text for a tag 🏷
// and a remove ✕. Tagging edits inline over the top row: Enter saves, Esc
// cancels, empty removes the tag. The auto title/AI summary is never touched.
final class ChatCardView: NSView, NSTextFieldDelegate {
    private let card = NSView()
    private let meta = NSTextField(labelWithString: "")
    private let deleteBtn = NSButton()
    private let tagBtn = NSButton()
    private var editor: NSTextField?
    private var currentTag = ""
    var onClick: (() -> Void)?
    var onDelete: (() -> Void)?
    var onTag: ((String) -> Void)?
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

    init(chat: Chat, width: CGFloat, titleText: String, tag: String) {
        let cardW = width - 12
        let titleW = cardW - 41
        let name = titleText.isEmpty ? Self.displayName(chat) : titleText
        let textH = Self.titleHeight(name, width: titleW)
        // Detail line: what Claude is blocked on (orange), the API error that
        // killed the turn (red), or a tool-failure streak while working (orange).
        var detail = ""
        var detailColor = NSColor.systemOrange
        if chat.status == "needs_input" {
            detail = chat.waitingOn
        } else if chat.status == "error" {
            detail = errorText(chat.errorType)
            detailColor = .systemRed
        } else if chat.status == "working" && chat.failStreak >= 3 {
            detail = "\(chat.failStreak) tool failures in a row"
        }
        let waitH: CGFloat = detail.isEmpty ? 0 : 17
        let cardH = textH + waitH + 34
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

        let repoText = NSMutableAttributedString(string: chat.repo, attributes: [
            .font: NSFont.systemFont(ofSize: 11, weight: .semibold),
            .foregroundColor: NSColor.secondaryLabelColor,
        ])
        if !chat.branch.isEmpty {
            repoText.append(NSAttributedString(string: "  \(chat.branch)", attributes: [
                .font: NSFont.systemFont(ofSize: 11),
                .foregroundColor: NSColor.tertiaryLabelColor,
            ]))
        }
        // Repo (+branch) label, then the user's tag chip; both share the row's
        // left region, with the repo truncating to make room for the chip.
        currentTag = tag
        let rowAvail = cardW - 145
        let chipFont = NSFont.systemFont(ofSize: 10, weight: .medium)
        let chipW: CGFloat = tag.isEmpty ? 0
            : min(ceil((tag as NSString).size(withAttributes: [.font: chipFont]).width) + 14, 120)
        let repoW = tag.isEmpty ? rowAvail
            : min(ceil(repoText.size().width) + 2, rowAvail - chipW - 6)

        let repo = NSTextField(labelWithString: "")
        repo.attributedStringValue = repoText
        repo.lineBreakMode = .byTruncatingTail
        repo.frame = NSRect(x: 29, y: cardH - 24, width: repoW, height: 16)
        card.addSubview(repo)

        if !tag.isEmpty {
            let chip = NSTextField(labelWithString: tag)
            chip.font = chipFont
            chip.textColor = .controlAccentColor
            chip.alignment = .center
            chip.lineBreakMode = .byTruncatingTail
            chip.wantsLayer = true
            chip.layer?.backgroundColor = NSColor.controlAccentColor.withAlphaComponent(0.16).cgColor
            chip.layer?.cornerRadius = 7.5
            chip.frame = NSRect(x: 29 + repoW + 6, y: cardH - 23.5, width: chipW, height: 15)
            card.addSubview(chip)
        }

        meta.stringValue = "\(label(for: chat)) · \(age(chat.activityDate))"
        meta.font = .systemFont(ofSize: 11)
        meta.textColor = chat.status == "needs_input" ? .systemOrange
            : chat.status == "error" ? .systemRed : .secondaryLabelColor
        meta.alignment = .right
        meta.frame = NSRect(x: cardW - 112, y: cardH - 24, width: 100, height: 16)
        card.addSubview(meta)

        // Shown in the meta text's place while hovering: rename ✎ and remove ✕
        // (the latter deletes this chat's status file whatever its status —
        // the way to kill one stale entry).
        deleteBtn.image = NSImage(systemSymbolName: "xmark.circle.fill",
                                  accessibilityDescription: "Remove")
        deleteBtn.isBordered = false
        deleteBtn.imagePosition = .imageOnly
        deleteBtn.contentTintColor = .tertiaryLabelColor
        deleteBtn.target = self
        deleteBtn.action = #selector(deleteClicked)
        deleteBtn.toolTip = "Remove from list"
        deleteBtn.frame = NSRect(x: cardW - 34, y: cardH - 27, width: 22, height: 22)
        deleteBtn.isHidden = true
        card.addSubview(deleteBtn)

        tagBtn.image = NSImage(systemSymbolName: "tag",
                               accessibilityDescription: "Tag")
        tagBtn.isBordered = false
        tagBtn.imagePosition = .imageOnly
        tagBtn.contentTintColor = .tertiaryLabelColor
        tagBtn.target = self
        tagBtn.action = #selector(tagClicked)
        tagBtn.toolTip = "Tag this chat (empty removes the tag)"
        tagBtn.frame = NSRect(x: cardW - 58, y: cardH - 27, width: 22, height: 22)
        tagBtn.isHidden = true
        card.addSubview(tagBtn)

        if !detail.isEmpty {
            let w = NSTextField(labelWithString: detail)
            w.font = .systemFont(ofSize: 11)
            w.textColor = detailColor
            w.lineBreakMode = .byTruncatingTail
            w.frame = NSRect(x: 29, y: 8 + textH + 3, width: titleW, height: 14)
            card.addSubview(w)
        }

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
        meta.isHidden = true
        deleteBtn.isHidden = false
        tagBtn.isHidden = false
    }

    override func mouseExited(with event: NSEvent) {
        card.layer?.backgroundColor = baseColor.cgColor
        meta.isHidden = false
        deleteBtn.isHidden = true
        tagBtn.isHidden = true
    }

    override func mouseUp(with event: NSEvent) {
        guard editor == nil else { return }  // don't jump away mid-edit
        onClick?()
    }

    @objc private func deleteClicked() {
        onDelete?()
    }

    // --- Inline tag editing ---------------------------------------------

    @objc private func tagClicked() {
        guard editor == nil else { return }
        // Editor sits over the top row (where the chip lives), leaving the
        // title below visible — you're labeling the chat, not renaming it.
        let e = NSTextField(frame: NSRect(x: 29, y: card.frame.height - 28,
                                          width: card.frame.width - 29 - 64, height: 21))
        e.stringValue = currentTag
        e.placeholderString = "tag"
        e.font = .systemFont(ofSize: 11)
        e.delegate = self
        e.focusRingType = .none
        card.addSubview(e)
        editor = e
        window?.makeKey()
        window?.makeFirstResponder(e)
    }

    func control(_ control: NSControl, textView: NSTextView, doCommandBy sel: Selector) -> Bool {
        if sel == #selector(NSResponder.insertNewline(_:)) { commitTag(); return true }
        if sel == #selector(NSResponder.cancelOperation(_:)) { endTagEdit(); return true }
        return false
    }

    // Clicking away also commits (covers ending the edit without Enter).
    func controlTextDidEndEditing(_ obj: Notification) {
        commitTag()
    }

    private func commitTag() {
        guard let e = editor else { return }
        let text = e.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        endTagEdit()
        if text != currentTag { onTag?(text) }
    }

    private func endTagEdit() {
        editor?.delegate = nil
        editor?.removeFromSuperview()
        editor = nil
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
    var statusItem: NSStatusItem!
    var chats: [Chat] = []
    var lastStatuses: [String: String] = [:]
    var firstPoll = true
    var nativeNotifications = false
    var hotKeyRef: EventHotKeyRef?

    // One follow-up ping per stretch of needs_input, so a missed banner
    // doesn't leave Claude hanging indefinitely. Reset when the chat moves on.
    var nagged: Set<String> = []
    let nagAfter: TimeInterval = 5 * 60

    let panelWidth: CGFloat = 420
    var panel: NSPanel!
    var panelHeight: CGFloat = 0
    var panelFingerprint = ""
    var clickMonitor: Any?
    var keyMonitor: Any?

    // On-device AI one-line summaries, keyed by session. Cache stores the
    // source-text hash so a summary is recomputed only when the prompt changes.
    // Persisted to UserDefaults so a relaunch doesn't re-summarize every chat.
    var summaryCache: [String: (hash: UInt64, text: String)] = [:]
    var summaryInFlight: Set<String> = []

    func loadSummaryCache() {
        guard let d = UserDefaults.standard.dictionary(forKey: "summaries")
                as? [String: [String: String]] else { return }
        for (sid, v) in d {
            if let hs = v["h"], let h = UInt64(hs), let t = v["t"] {
                summaryCache[sid] = (h, t)
            }
        }
    }

    func saveSummaryCache() {
        var d: [String: [String: String]] = [:]
        // Hash as a string: plists can't hold the upper half of UInt64.
        for (sid, v) in summaryCache { d[sid] = ["h": String(v.hash), "t": v.text] }
        UserDefaults.standard.set(d, forKey: "summaries")
    }

    // User tags, keyed by session — a chip next to the repo name. Kept
    // app-side (not in the status files) so hook writes can never clobber them.
    var tags: [String: String] = [:]

    func loadTags() {
        tags = (UserDefaults.standard.dictionary(forKey: "tags") as? [String: String]) ?? [:]
    }

    func saveTags() {
        UserDefaults.standard.set(tags, forKey: "tags")
    }

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
        // Must precede the in-flight insert: bailing after it would strand the
        // key in summaryInFlight and block that session's summaries forever.
        guard #available(macOS 26.0, *) else { return }
        let text = chat.summarySource
        guard !text.isEmpty else { return }
        let key = chat.sessionId
        let h = stableHash(text)
        if let c = summaryCache[key], c.hash == h { return }
        if summaryInFlight.contains(key) { return }
        summaryInFlight.insert(key)
        Task {
            let result = await FMEngine.shared.summarize(text)
            await MainActor.run {
                self.summaryInFlight.remove(key)
                if let r = result, !r.isEmpty {
                    self.summaryCache[key] = (h, r)
                    self.saveSummaryCache()
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

        panel = KeyPanel(contentRect: NSRect(x: 0, y: 0, width: panelWidth, height: 100),
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

        registerHotkey()
        loadSummaryCache()
        loadTags()
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
        let before = summaryCache.count
        summaryCache = summaryCache.filter { live.contains($0.key) }
        if summaryCache.count != before { saveSummaryCache() }
        let tagsBefore = tags.count
        tags = tags.filter { live.contains($0.key) }
        if tags.count != tagsBefore { saveTags() }
        if notificationsEnabled && !firstPoll {
            for chat in chats {
                let prev = lastStatuses[chat.sessionId]
                guard prev != chat.status else { continue }
                if chat.status == "needs_input" {
                    let headline: String
                    switch chat.waitingKind {
                    case "permission": headline = "Claude needs permission"
                    case "question": headline = "Claude has a question"
                    case "reply": headline = "Claude is waiting on you"
                    default: headline = "Claude needs your input"
                    }
                    notify(chat: chat, headline: headline)
                } else if chat.status == "error" {
                    notify(chat: chat, headline: "Claude hit an error")
                } else if chat.status == "done" && prev == "working" {
                    var headline = "Claude finished"
                    if let t = chat.turnStartedAt {
                        let m = Int(chat.updatedAt.timeIntervalSince(t)) / 60
                        if m >= 1 { headline += " · \(m < 60 ? "\(m)m" : "\(m / 60)h \(m % 60)m")" }
                    }
                    notify(chat: chat, headline: headline)
                }
            }
            // Nag: still needs_input after nagAfter with no reaction -> one more ping.
            for chat in chats where chat.status == "needs_input" {
                if Date().timeIntervalSince(chat.updatedAt) > nagAfter,
                   !nagged.contains(chat.sessionId) {
                    nagged.insert(chat.sessionId)
                    notify(chat: chat, headline: "Still waiting on you · \(age(chat.updatedAt))")
                }
            }
        }
        for chat in chats where chat.status != "needs_input" { nagged.remove(chat.sessionId) }
        nagged.formIntersection(live)
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
        chats.map {
            "\($0.sessionId)|\($0.status)|\(age($0.activityDate))|\($0.title)|" +
            "\($0.waitingOn)|\($0.waitingKind)|\($0.errorType)|\($0.failStreak)"
        }.joined(separator: "\n")
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
        segment(counts["error"] ?? 0, .systemRed)
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
        if NSApp.currentEvent?.type == .rightMouseUp {
            hidePanel()
            showContextMenu()
            return
        }
        if panel.isVisible { hidePanel() } else { showPanel() }
    }

    // Global hotkey (default ⌃⌥C) toggles the panel from anywhere. Carbon
    // hotkeys work without the Accessibility permission a global key monitor
    // would need. Rebind via:
    //   defaults write com.measure.chatstatus hotkeyKeyCode -int <keycode>
    //   defaults write com.measure.chatstatus hotkeyModifiers -int <carbon mask>
    func registerHotkey() {
        var eventType = EventTypeSpec(eventClass: OSType(kEventClassKeyboard),
                                      eventKind: UInt32(kEventHotKeyPressed))
        InstallEventHandler(GetApplicationEventTarget(), { _, _, _ in
            DispatchQueue.main.async {
                guard let d = NSApp.delegate as? AppDelegate else { return }
                if d.panel.isVisible { d.hidePanel() } else { d.showPanel() }
            }
            return noErr
        }, 1, &eventType, nil, nil)
        let defaults = UserDefaults.standard
        let key = (defaults.object(forKey: "hotkeyKeyCode") as? NSNumber)?.uint32Value
            ?? UInt32(kVK_ANSI_C)
        let mods = (defaults.object(forKey: "hotkeyModifiers") as? NSNumber)?.uint32Value
            ?? UInt32(controlKey | optionKey)
        let hkid = EventHotKeyID(signature: OSType(0x43485354), id: 1)  // 'CHST'
        RegisterEventHotKey(key, mods, hkid, GetApplicationEventTarget(), 0, &hotKeyRef)
    }

    // Right-click on the status item: a small native menu, so quit / clear /
    // notification toggles are reachable without opening the panel.
    func showContextMenu() {
        let menu = NSMenu()
        func item(_ title: String, _ action: Selector) {
            let i = NSMenuItem(title: title, action: action, keyEquivalent: "")
            i.target = self
            menu.addItem(i)
        }
        item("Clear Finished", #selector(clearFinished(_:)))
        item(notificationsEnabled ? "Pause Notifications" : "Resume Notifications",
             #selector(toggleNotifications(_:)))
        if summariesAvailable {
            item(summariesEnabled ? "Disable AI Summaries" : "Enable AI Summaries",
                 #selector(toggleSummaries(_:)))
        }
        menu.addItem(.separator())
        item("Quit ChatStatus", #selector(quitApp(_:)))
        // Attach-click-detach: the standard trick for a status item that shows
        // a panel on left-click but a real menu on right-click.
        statusItem.menu = menu
        statusItem.button?.performClick(nil)
        statusItem.menu = nil
    }

    func showPanel() {
        chats = loadChats()
        refreshPanel()
        positionPanel()
        // Key (not just front) so Esc reaches the monitor below; the
        // .nonactivatingPanel style keeps our app from stealing activation.
        panel.makeKeyAndOrderFront(nil)
        // Any click outside the app dismisses, like a menu would.
        clickMonitor = NSEvent.addGlobalMonitorForEvents(
            matching: [.leftMouseDown, .rightMouseDown]) { [weak self] _ in
            self?.hidePanel()
        }
        keyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] e in
            if e.keyCode == 53 {  // Esc
                // Mid-rename, Esc belongs to the field editor (cancels the edit).
                if self?.panel.firstResponder is NSTextView { return e }
                self?.hidePanel()
                return nil
            }
            return e
        }
    }

    func hidePanel() {
        panel.orderOut(nil)
        if let m = clickMonitor { NSEvent.removeMonitor(m); clickMonitor = nil }
        if let m = keyMonitor { NSEvent.removeMonitor(m); keyMonitor = nil }
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
                                    titleText: summaryText(for: chat) ?? "",
                                    tag: tags[chat.sessionId] ?? "")
            card.setFrameOrigin(NSPoint(x: 10, y: y))
            card.toolTip = chat.cwd
            card.onClick = { [weak self] in
                self?.hidePanel()
                self?.routeTo(cwd: chat.cwd, sessionId: chat.sessionId)
            }
            card.onDelete = { [weak self] in
                try? FileManager.default.removeItem(
                    at: statusDir.appendingPathComponent("\(chat.sessionId).json"))
                // poll() reloads and, since the fingerprint changed, rebuilds
                // and repositions the open panel.
                self?.poll()
            }
            card.onTag = { [weak self] tag in
                guard let self else { return }
                if tag.isEmpty {
                    self.tags.removeValue(forKey: chat.sessionId)
                } else {
                    self.tags[chat.sessionId] = tag
                }
                self.saveTags()
                self.refreshPanel()
                self.positionPanel()
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

    // Rich notification: headline, repo as subtitle, what Claude is blocked on
    // (else AI summary / title) as body. Clicking it jumps to the chat.
    // osascript fallback if not authorized.
    func notify(chat: Chat, headline: String) {
        var body = summaryText(for: chat) ?? (chat.title.isEmpty ? chat.cwd : chat.title)
        if chat.status == "needs_input", !chat.waitingOn.isEmpty { body = chat.waitingOn }
        if chat.status == "error" { body = errorText(chat.errorType) }
        let subtitle = tags[chat.sessionId].map { "\(chat.repo) · \($0)" } ?? chat.repo
        if nativeNotifications {
            let content = UNMutableNotificationContent()
            content.title = headline
            content.subtitle = subtitle
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
                .replacingOccurrences(of: "\n", with: " ")
        }
        let script = "display notification \"\(esc(body))\" with title \"\(esc(headline))\" subtitle \"\(esc(subtitle))\" sound name \"Ping\""
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
    let tags = (UserDefaults.standard.dictionary(forKey: "tags") as? [String: String]) ?? [:]
    for c in loadChats() {
        var line = "\(label(for: c))\t\(c.repo)\t\(c.branch)\t\(age(c.activityDate))\t\(c.title)"
        if let t = tags[c.sessionId] { line += "\t#\(t)" }
        if !c.waitingOn.isEmpty { line += "\t[waiting: \(c.waitingOn)]" }
        if c.status == "error" { line += "\t[\(errorText(c.errorType))]" }
        if c.failStreak >= 3 { line += "\t[\(c.failStreak) tool failures]" }
        print(line)
    }
    exit(0)
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
