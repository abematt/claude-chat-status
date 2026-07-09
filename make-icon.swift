// Renders AppIcon.icns for ChatStatus: the "4e Cream" mark — a 2×2 grid of
// 8-bit window panes on a cream squircle, the tracked (top-right) pane lit in
// clay, with a pixel sunburst overlapping its corner.
// Run by build.sh: swift make-icon.swift <output.icns>
import AppKit

// The mark is drawn procedurally on integer pixel grids (kept in step with
// PixelMark in ChatStatusBar.swift — the two files compile separately).
enum Mark {
    static let paneOrigins = [(0, 0), (7, 0), (0, 7), (7, 7)]

    static let frameCells: [(Int, Int)] = {
        var c: [(Int, Int)] = []
        for (ox, oy) in paneOrigins {
            for lx in 0..<6 {
                for ly in 0..<6 where lx == 0 || lx == 5 || ly == 0 || ly == 5 || ly == 1 {
                    c.append((ox + lx, oy + ly))
                }
            }
        }
        return c
    }()

    static let activeCells: [(Int, Int)] = {
        var c: [(Int, Int)] = []
        for x in 8...11 { for y in 2...4 { c.append((x, y)) } }
        return c
    }()

    static let sunburstCells: [(Int, Int)] = {
        var c: [(Int, Int)] = [(3, 3)]
        for d in 1...3 { c += [(3 + d, 3), (3 - d, 3), (3, 3 + d), (3, 3 - d)] }
        for d in 1...2 { c += [(3 + d, 3 + d), (3 - d, 3 + d), (3 + d, 3 - d), (3 - d, 3 - d)] }
        return c
    }()

    // Fill grid cells into rect, y measured from the top so title bars stay up.
    // Cells are drawn 1.03× oversized to avoid hairline seams.
    static func fill(_ cells: [(Int, Int)], grid: CGFloat, in rect: NSRect, color: NSColor) {
        let cell = rect.width / grid
        color.setFill()
        for (gx, gy) in cells {
            NSRect(x: rect.minX + CGFloat(gx) * cell,
                   y: rect.minY + rect.height - CGFloat(gy + 1) * cell,
                   width: cell * 1.03, height: cell * 1.03).fill()
        }
    }
}

// Paints the icon into the current graphics context at the given canvas size.
// All coordinates are authored on a 1024pt canvas and scaled down.
func draw(size: CGFloat) {
    let s = size / 1024.0

    // Full-bleed squircle (22.4% corner radius, the modern macOS convention).
    let squircle = NSBezierPath(roundedRect: NSRect(x: 0, y: 0, width: size, height: size),
                                xRadius: 229 * s, yRadius: 229 * s)
    NSGraphicsContext.current?.saveGraphicsState()
    squircle.addClip()

    // Cream background gradient (top-left light → bottom-right darker) with a
    // soft top highlight.
    NSGradient(starting: NSColor(srgbRed: 0.961, green: 0.941, blue: 0.898, alpha: 1),  // #F5F0E5
               ending: NSColor(srgbRed: 0.894, green: 0.855, blue: 0.776, alpha: 1))!   // #E4DAC6
        .draw(in: squircle, angle: -55)
    let hl = NSGradient(colors: [NSColor(white: 1, alpha: 0.55), NSColor(white: 1, alpha: 0)])!
    hl.draw(fromCenter: NSPoint(x: size * 0.5, y: size * 1.12), radius: 0,
            toCenter: NSPoint(x: size * 0.5, y: size * 1.12), radius: size * 0.52, options: [])

    let ink = NSColor(srgbRed: 0.169, green: 0.149, blue: 0.125, alpha: 1)   // #2B2620
    let clay = NSColor(srgbRed: 0.851, green: 0.467, blue: 0.341, alpha: 1)  // #D97757

    // Panes mark: 56% width (573 px on a 13-grid), centered both axes.
    let paneRect = NSRect(x: 225.3 * s, y: 225.3 * s, width: 573.4 * s, height: 573.4 * s)
    Mark.fill(Mark.frameCells, grid: 13, in: paneRect, color: ink)
    Mark.fill(Mark.activeCells, grid: 13, in: paneRect, color: clay)

    // Sunburst badge (7-grid, 191 px box) overlapping the lit pane's corner.
    let sunRect = NSRect(x: 683.03 * s, y: 709.97 * s, width: 191 * s, height: 191 * s)
    Mark.fill(Mark.sunburstCells, grid: 7, in: sunRect, color: clay)

    NSGraphicsContext.current?.restoreGraphicsState()
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
