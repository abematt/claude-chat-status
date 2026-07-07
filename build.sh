#!/bin/bash
# Builds ChatStatus.app (menu bar app for Claude Code chat statuses) into build/.
set -euo pipefail
cd "$(dirname "$0")"

APP=build/ChatStatus.app
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

swiftc -O -o "$APP/Contents/MacOS/ChatStatus" ChatStatusBar.swift

# App icon (notifications, Login Items, Finder). Regenerate only when the
# generator script changes; the icns is cached in build/.
if [ ! -f build/AppIcon.icns ] || [ make-icon.swift -nt build/AppIcon.icns ]; then
    swift make-icon.swift build/AppIcon.icns
fi
cp build/AppIcon.icns "$APP/Contents/Resources/AppIcon.icns"

cat > "$APP/Contents/Info.plist" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleExecutable</key>
    <string>ChatStatus</string>
    <!-- Not "chat-status": that id has poisoned status-item state in the window
         server (item parks off-screen after an accidental ⌘-drag removal). -->
    <key>CFBundleIdentifier</key>
    <string>com.measure.chatstatus</string>
    <key>CFBundleName</key>
    <string>ChatStatus</string>
    <key>CFBundleIconFile</key>
    <string>AppIcon</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleShortVersionString</key>
    <string>0.7.0</string>  <!-- keep in step with CHANGELOG.md; shown in the panel footer -->
    <key>LSUIElement</key>
    <true/>
</dict>
</plist>
EOF

codesign --force -s - "$APP"
echo "Built $APP — launch with: open $APP"
