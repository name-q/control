#!/bin/bash
set -e
echo "Compiling capture (V3: Swift + libdatachannel)..."
swiftc -O -o capture capture.swift \
  -import-objc-header rtc_bridge.h \
  -I/usr/local/include \
  -L/usr/local/lib \
  -ldatachannel \
  -Xlinker -rpath -Xlinker /usr/local/lib \
  -framework ScreenCaptureKit \
  -framework CoreMedia \
  -framework CoreGraphics \
  -framework VideoToolbox \
  -framework AppKit

# Package into .app bundle
APP="ScreenCapture.app"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp capture "$APP/Contents/MacOS/capture"

cat > "$APP/Contents/Info.plist" << 'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleIdentifier</key>
    <string>com.control.capture</string>
    <key>CFBundleName</key>
    <string>ScreenCapture</string>
    <key>CFBundleExecutable</key>
    <string>capture</string>
    <key>CFBundleVersion</key>
    <string>3.0</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>LSUIElement</key>
    <true/>
    <key>NSScreenCaptureUsageDescription</key>
    <string>Remote Control needs screen capture to stream your desktop.</string>
</dict>
</plist>
EOF

codesign -s - -f "$APP"
echo "Done: $APP (V3 with libdatachannel)"
