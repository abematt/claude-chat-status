# Handoff: ChatStatus icon (4e) + menu-bar & panel redesign (4g)

## Overview

Two deliverables for the `claude-chat-status` repo (single-file AppKit app, `ChatStatusBar.swift` + `make-icon.swift`):

1. **App icon** — the "4e Cream" pixel window-panes mark: a 2×2 grid of 8-bit windows on a cream squircle, the tracked (top-right) pane lit in clay, with a pixel sunburst overlapping its corner.
2. **Menu-bar item + dropdown panel redesign** — keeps the existing compact count segments, replaces the glyph with the panes mark (template image), animates the working state with the pixel sunburst, and restyles the dropdown from floating grey cards to hairline-divided rows with urgency accent bars.

## About the design files

Everything in this bundle is a **design reference created in HTML** — screenshots and generated assets showing intended look, not production code. The task is to **recreate this in the existing AppKit codebase** (`ChatStatusBar.swift`, `make-icon.swift`) using its established patterns (NSStatusItem attributed titles, the `Spark` frame cache, `ChatCardView`, the 2s poll / ~7fps anim timer split). Do not embed a webview.

## Fidelity

**High-fidelity.** Colors, spacing, type sizes and the pixel-grid geometry below are final. Recreate pixel-perfectly, mapping fonts to native equivalents (see Typography).

---

## 1. The mark — exact pixel geometry

All sprites live on integer pixel grids. Draw them procedurally (fits `make-icon.swift`'s approach); each grid cell is drawn at `cellSize × 1.03` to avoid hairline seams.

### Panes mark — 13×13 grid

- Four **6×6 windows** at origins `(0,0)`, `(7,0)`, `(0,7)`, `(7,7)` (1-cell gutter between).
- Each window: 1-cell **perimeter frame**, plus a full-width row at `y = originY + 1` (title bar — the top edge reads 2 cells thick).
- **Active window = top-right `(7,0)`**: fill interior cells `x ∈ [8,11]`, `y ∈ [2,4]` with the accent color.

### Sunburst — center `(0,0)`, drawn per-cell

- **Small** (badge / menu-bar spark): cardinal rays length 3, diagonal rays length 2 → 7×7 bounding box.
- **Large** (standalone mark): cardinal length 6, diagonal length 4, plus 8 intermediate spokes in directions `(±1,±2)`, `(±2,±1)` with cells at 1× and 2× the direction vector → 13×13 bounding box.

## 2. App icon spec (4e Cream)

1024×1024 master (`assets/icon-4e-1024.png`, `assets/icon-4e.svg`):

- **Squircle**: corner radius 229 px (22.4%). The bundled assets use a rounded rect; if you want Apple's true squircle, draw into the official icon-grid template in `make-icon.swift`.
- **Background**: linear gradient ~160°, `#F5F0E5 → #E4DAC6`.
- **Top highlight**: radial gradient centered at (50%, −12%), radius ~90%, `white @ 55% → transparent` by ~58%.
- **Panes mark**: width 56% (573 px), centered both axes. Frames `#2B2620`, active fill `#D97757`.
- **Sunburst badge** (small variant): 7×7 cells in a 191 px box, placed 150 px from the right edge, 123 px from the top — its lower-left rays overlap the active pane's top-right corner. Color `#D97757`.

Regenerate the `.icns` through the existing `build.sh` / `make-icon.swift` pipeline.

## 3. Menu-bar item

- **Glyph**: panes mark, single color, **no** active fill — `assets/menubar-glyph-template.svg` / `-36.png`. Ship as an `NSImage` with `isTemplate = true` so it adapts to light/dark menu bars. Point size ≈ 15×15 @ 1×.
- **Count segments** (keep the existing `updateStatusItem` structure, ~line 873): `●N` needs_input `#E8912F` · `●N` error `#FF6257` · working = **animated sunburst** tinted `#D97757` + count · `✓N` done `#3BD17A` · live in tertiary. Digits in `monospacedSystemFont(11)`.
- **Working animation**: the small sunburst pulsing — scale 0.92 → 1.12, opacity 0.85 → 1, 1.6 s ease-in-out loop. Implement by rendering ~10 pre-scaled frames into the existing `Spark` fixed-size image cache (driven by the ~7fps anim timer); replaces the CLI thinking-glyph frames.
- When the panel is open the item shows the standard highlighted state (system behavior).

## 4. Dropdown panel

Container: width **384 pt**, corner radius **16**, bg `rgba(13,16,25,0.94)` over a dark `NSVisualEffectView` material, border 1 px `rgba(185,189,214,0.16)`, large soft shadow.

### Header
- `SESSIONS` — 10.5 pt mono, uppercase, +0.2 em tracking, `#6B7197`.
- Right: the same count segments (11 pt mono) + trash glyph `#6B7197` (existing clear-all).
- Full-width hairline below: `rgba(185,189,214,0.12)`.

### Session rows (replaces the floating grey cards)
- Row padding 13 / 16; separated by **inset hairlines** `rgba(185,189,214,0.08)` (16 pt inset), not card backgrounds.
- **Accent bar**: 3 pt wide, left edge, 10 pt top/bottom inset, right-rounded — working `#D97757`, needs_input `#E8912F`, error `#FF6257`; none for done/idle. This is the urgency scan cue.
- **Glyph column** (18 pt): working = 16 pt animated sunburst (same frames as the bar); needs_input / error = 9 pt dot in status color; done = ✓ 15 pt semibold `#3BD17A`; idle = 9 pt dot `#4B5168` and the whole row at 62% opacity.
- **Line 1**: `repo · branch` — 11 pt mono `#8B90A6`, middle-ellipsized. Right-aligned meta, 11 pt mono, status-colored: working shows the **turn clock** `#E0A76B` with tabular digits; others show `needs you` / `errored · 2m` / `finished · now` / `idle`.
- **Line 2 (title)**: 14 pt semibold `#F3F5FA`, −0.01 em tracking — the AI summary / user label, as today.
- **Line 3 (detail, single line, ellipsized, 12 pt)**: needs_input → the blocker in mono `#C79B6A` (e.g. `Bash: git push origin main`); error → cause `#CC7777`; done → closing message `#6B7197`; working → current action `#6B7197` (optional); idle → none.
- **Hover** keeps the existing affordances (✎ rename, ✕ remove) plus a faint row wash `rgba(91,123,255,0.05)`.

### Options + footer
- `OPTIONS` eyebrow, same style as header eyebrow.
- Toggle rows: label 13.5 pt `#EEF0F6`; switch 34×20 pill, on-state `#5B7BFF`, 16 pt white knob (or keep native NSSwitch tinted `#5B7BFF`).
- Footer: `v0.6.0` 11 pt mono `#565C74` left; `Quit ⌘Q` right — 13 pt `#CDD2DC`, shortcut 11 pt mono `#6B7197`. Hairlines above each.

## Interactions & behavior (unchanged semantics)

- Statuses map 1:1 to the existing vocabulary: `working`, `needs_input`, `error`, `done`, `live` (idle).
- Click-through, notifications, hover-rename, ⌃⌥C hotkey, 2 s poll and turn-clock rules are all unchanged — this is a reskin, not a behavior change.
- Animation runs only while a foreground turn is working (keep `ensureAnimTimer` gating). `animTick` should mutate the spark image + clock labels in place, as today.

## Design tokens

| Token | Value |
|---|---|
| Cream bg | `#F5F0E5 → #E4DAC6` |
| Frame ink | `#2B2620` |
| Clay accent (working / active pane / sunburst) | `#D97757` |
| Working clock text | `#E0A76B` |
| Needs-input orange | `#E8912F` (blocker text `#C79B6A`) |
| Error red | `#FF6257` (cause text `#CC7777`) |
| Done green | `#3BD17A` |
| Idle dot | `#4B5168` |
| Panel bg | `rgba(13,16,25,0.94)` + dark material |
| Hairline strong / row | `rgba(185,189,214,0.12)` / `0.08` |
| Border | `rgba(185,189,214,0.16)` |
| Primary text | `#F3F5FA` · secondary `#8B90A6` · muted `#6B7197` |
| Toggle on | `#5B7BFF` |

**Typography**: the mocks use Geist / Geist Mono. Native mapping: `NSFont.systemFont` (titles `.semibold`), `NSFont.monospacedSystemFont` for everything marked mono (repo·branch, meta, clocks, eyebrows — always tabular digits). Bundling Geist is optional and not required for fidelity.

## Assets

| File | What |
|---|---|
| `assets/icon-4e-1024.png` | App icon master (raster) |
| `assets/icon-4e.svg` | App icon master (vector, same geometry) |
| `assets/menubar-glyph-template.svg` / `-36.png` | Menu-bar glyph, black, for `isTemplate` NSImage |
| `assets/sunburst-clay.svg` | Large sunburst, clay |
| `assets/sunburst-small-clay.svg` | Small sunburst (badge / spark frames), clay |
| `assets/sunburst-template.svg` | Large sunburst, black (template uses) |

## Screenshots

| File | What |
|---|---|
| `screenshots/01-ref.jpg` | Colorway sheet — 4e is the cream tile |
| `screenshots/04-statusitem.jpg` | Menu bar with the new status item + full panel (top) |
| `screenshots/05-panel-footer.jpg` | Panel lower half — options, toggles, footer |

## Files

The live design exploration is `Claude Status — App Icons.dc.html` in the design project (options 4e and 4g). This packet is self-sufficient; the HTML is a browser prototype, not code to port.
