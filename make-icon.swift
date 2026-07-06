// Renders AppIcon.icns for ChatStatus: dark rounded square, white chat bubble,
// three status dots (orange / green / gray — the app's status colors).
// Run by build.sh: swift make-icon.swift <output.icns>
import AppKit

// Paints the icon into the current graphics context at the given canvas size.
// All coordinates are authored on a 1024pt canvas and scaled down.
func draw(size: CGFloat) {
    let s = size / 1024.0

    // Background squircle with a subtle vertical gradient (macOS style margins).
    let inset = 80 * s
    let rect = NSRect(x: inset, y: inset, width: size - 2 * inset, height: size - 2 * inset)
    let bg = NSBezierPath(roundedRect: rect, xRadius: 190 * s, yRadius: 190 * s)
    NSGradient(
        starting: NSColor(calibratedRed: 0.20, green: 0.23, blue: 0.30, alpha: 1),
        ending: NSColor(calibratedRed: 0.09, green: 0.10, blue: 0.14, alpha: 1)
    )!.draw(in: bg, angle: -90)

    // Chat bubble with a tail, filled white.
    let bubble = NSBezierPath(
        roundedRect: NSRect(x: 212 * s, y: 340 * s, width: 600 * s, height: 400 * s),
        xRadius: 130 * s, yRadius: 130 * s)
    let tail = NSBezierPath()
    tail.move(to: NSPoint(x: 320 * s, y: 360 * s))
    tail.line(to: NSPoint(x: 282 * s, y: 236 * s))
    tail.line(to: NSPoint(x: 448 * s, y: 348 * s))
    tail.close()
    NSColor.white.setFill()
    bubble.fill()
    tail.fill()

    // The three status dots.
    let colors: [NSColor] = [
        NSColor(calibratedRed: 0.96, green: 0.60, blue: 0.15, alpha: 1), // needs you
        NSColor(calibratedRed: 0.28, green: 0.76, blue: 0.36, alpha: 1), // working
        NSColor(calibratedWhite: 0.72, alpha: 1),                        // idle/done
    ]
    let r = 56 * s
    for (i, cx) in [372.0, 512.0, 652.0].enumerated() {
        colors[i].setFill()
        NSBezierPath(ovalIn: NSRect(
            x: CGFloat(cx) * s - r, y: 540 * s - r, width: r * 2, height: r * 2)).fill()
    }
}

func png(_ pixels: Int) -> Data {
    let rep = NSBitmapImageRep(
        bitmapDataPlanes: nil, pixelsWide: pixels, pixelsHigh: pixels,
        bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
        colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    draw(size: CGFloat(pixels))
    NSGraphicsContext.restoreGraphicsState()
    return rep.representation(using: .png, properties: [:])!
}

let out = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "AppIcon.icns"
let fm = FileManager.default
let iconset = URL(fileURLWithPath: NSTemporaryDirectory())
    .appendingPathComponent("ChatStatus-\(ProcessInfo.processInfo.processIdentifier).iconset")
try? fm.removeItem(at: iconset)
try! fm.createDirectory(at: iconset, withIntermediateDirectories: true)

for base in [16, 32, 128, 256, 512] {
    try! png(base).write(to: iconset.appendingPathComponent("icon_\(base)x\(base).png"))
    try! png(base * 2).write(to: iconset.appendingPathComponent("icon_\(base)x\(base)@2x.png"))
}

let p = Process()
p.executableURL = URL(fileURLWithPath: "/usr/bin/iconutil")
p.arguments = ["-c", "icns", iconset.path, "-o", out]
try! p.run()
p.waitUntilExit()
try? fm.removeItem(at: iconset)
guard p.terminationStatus == 0 else { fatalError("iconutil failed") }
print("Wrote \(out)")
