// macOS Screen Capture — ScreenCaptureKit + Tile-based Delta Encoding
//
// Protocol (stdout):
//   READY:<screenW>:<screenH>:<tileSize>\n
//   CURSOR:<x>:<y>\n                        — cursor position (every frame)
//   FRAME:<totalLen>:<timestamp>:<type>\n<payload>
//     type 1 (keyframe): full JPEG
//     type 2 (delta):    [2B regionCount] + regions
//     type 3 (skip):     empty
//
// Args: capture [fps] [scale] [quality]

import Cocoa
import ScreenCaptureKit
import CoreMedia
import CoreGraphics
import Foundation

let fps = CommandLine.arguments.count > 1 ? Double(CommandLine.arguments[1]) ?? 30 : 30
let scale = CommandLine.arguments.count > 2 ? Double(CommandLine.arguments[2]) ?? 0.75 : 0.75
let quality = CommandLine.arguments.count > 3 ? Double(CommandLine.arguments[3]) ?? 0.7 : 0.7

let stdoutHandle = FileHandle.standardOutput
let stderrHandle = FileHandle.standardError
let TILE_SIZE = 64

func log(_ msg: String) {
    stderrHandle.write(Data((msg + "\n").utf8))
}

class StreamOutput: NSObject, SCStreamOutput {
    let context = CIContext(options: [.useSoftwareRenderer: false])
    let colorSpace = CGColorSpace(name: CGColorSpace.sRGB)!
    var currentQuality: Double = quality
    var jpegOpts: [CIImageRepresentationOption: Any] {
        [CIImageRepresentationOption(rawValue: kCGImageDestinationLossyCompressionQuality as String): currentQuality]
    }
    var prevHashes: [UInt64] = []
    var gridCols = 0, gridRows = 0, frameCounter = 0
    var forceKeyframe = true
    let keyframeInterval = 30 // every 1s at 30fps — faster recovery from dropped deltas

    func tileHash(_ ptr: UnsafePointer<UInt8>, bpr: Int, tx: Int, ty: Int, tw: Int, th: Int) -> UInt64 {
        var h: UInt64 = 0xcbf29ce484222325; let p: UInt64 = 0x100000001b3
        for row in stride(from: 0, to: th, by: 4) {
            let base = ptr + (ty + row) * bpr + tx * 4
            for col in stride(from: 0, to: tw, by: 4) {
                let v = base.advanced(by: col * 4).withMemoryRebound(to: UInt32.self, capacity: 1) { $0.pointee }
                h ^= UInt64(v); h &*= p
            }
        }
        return h
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, let pb = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }

        // Send cursor position (lightweight, every frame)
        let mouseEvent = CGEvent(source: nil)
        let cursorLoc = mouseEvent?.location ?? .zero
        let cursorMsg = Data("CURSOR:\(Int(cursorLoc.x)):\(Int(cursorLoc.y))\n".utf8)
        stdoutHandle.write(cursorMsg)

        // Try to get raw pixel access for delta detection
        CVPixelBufferLockBaseAddress(pb, .readOnly)
        let base = CVPixelBufferGetBaseAddress(pb)

        if let base = base {
            let ptr = base.assumingMemoryBound(to: UInt8.self)
            processFrame(pb, ptr: ptr)
            CVPixelBufferUnlockBaseAddress(pb, .readOnly)
        } else {
            CVPixelBufferUnlockBaseAddress(pb, .readOnly)
            // No raw access — emit full keyframe via CIImage (no lock needed)
            forceKeyframe = false
            frameCounter += 1
            let ci = CIImage(cvPixelBuffer: pb)
            guard let jpeg = context.jpegRepresentation(of: ci, colorSpace: colorSpace, options: jpegOpts) else { return }
            let ts = UInt64(Date().timeIntervalSince1970 * 1000)
            stdoutHandle.write(Data("FRAME:\(jpeg.count):\(ts):1\n".utf8))
            stdoutHandle.write(jpeg)
        }
    }

    func processFrame(_ pb: CVPixelBuffer, ptr: UnsafePointer<UInt8>) {
        let bpr = CVPixelBufferGetBytesPerRow(pb)
        let w = CVPixelBufferGetWidth(pb), h = CVPixelBufferGetHeight(pb)
        let cols = (w + TILE_SIZE - 1) / TILE_SIZE, rows = (h + TILE_SIZE - 1) / TILE_SIZE

        if gridCols != cols || gridRows != rows {
            gridCols = cols; gridRows = rows
            prevHashes = [UInt64](repeating: 0, count: cols * rows)
            forceKeyframe = true
        }
        frameCounter += 1
        let ts = UInt64(Date().timeIntervalSince1970 * 1000)

        var curHash = [UInt64](repeating: 0, count: cols * rows)
        var dirty: [(Int, Int)] = []
        for r in 0..<rows { for c in 0..<cols {
            let tw = min(TILE_SIZE, w - c * TILE_SIZE), th = min(TILE_SIZE, h - r * TILE_SIZE)
            let hash = tileHash(ptr, bpr: bpr, tx: c * TILE_SIZE, ty: r * TILE_SIZE, tw: tw, th: th)
            curHash[r * cols + c] = hash
            if hash != prevHashes[r * cols + c] { dirty.append((c, r)) }
        }}
        prevHashes = curHash

        if forceKeyframe || frameCounter % keyframeInterval == 0 || dirty.count > cols * rows * 4 / 10 {
            forceKeyframe = false; emitKeyframe(pb)
        } else if dirty.isEmpty {
            let hdr = Data("FRAME:0:\(ts):3\n".utf8); stdoutHandle.write(hdr)
        } else {
            forceKeyframe = false; emitDelta(pb, dirty: dirty, w: w, h: h, ts: ts)
        }
    }

    func emitKeyframe(_ pb: CVPixelBuffer) {
        let ci = CIImage(cvPixelBuffer: pb)
        guard let jpeg = context.jpegRepresentation(of: ci, colorSpace: colorSpace, options: jpegOpts) else { return }
        let ts = UInt64(Date().timeIntervalSince1970 * 1000)
        stdoutHandle.write(Data("FRAME:\(jpeg.count):\(ts):1\n".utf8))
        stdoutHandle.write(jpeg)
    }

    func emitDelta(_ pb: CVPixelBuffer, dirty: [(Int, Int)], w: Int, h: Int, ts: UInt64) {
        var byRow: [Int: [Int]] = [:]
        for (c, r) in dirty { byRow[r, default: []].append(c) }
        var regions: [(x: Int, y: Int, w: Int, h: Int)] = []
        for (row, colsArr) in byRow {
            let sorted = colsArr.sorted(); var i = 0
            while i < sorted.count {
                let sc = sorted[i]; var ec = sc
                while i + 1 < sorted.count && sorted[i+1] == ec + 1 { i += 1; ec = sorted[i] }
                let rx = sc * TILE_SIZE, ry = row * TILE_SIZE
                let rw = min((ec+1) * TILE_SIZE, w) - rx, rh = min((row+1) * TILE_SIZE, h) - ry
                regions.append((rx, ry, rw, rh)); i += 1
            }
        }
        let ci = CIImage(cvPixelBuffer: pb)
        let imgH = CVPixelBufferGetHeight(pb)
        var payload = Data()
        var cnt = UInt16(regions.count).bigEndian; payload.append(Data(bytes: &cnt, count: 2))
        for r in regions {
            let fy = imgH - r.y - r.h
            let cropped = ci.cropped(to: CGRect(x: r.x, y: fy, width: r.w, height: r.h))
            let moved = cropped.transformed(by: CGAffineTransform(translationX: -CGFloat(r.x), y: -CGFloat(fy)))
            guard let jpeg = context.jpegRepresentation(of: moved, colorSpace: colorSpace, options: jpegOpts) else { continue }
            var x16 = UInt16(r.x).bigEndian, y16 = UInt16(r.y).bigEndian
            var w16 = UInt16(r.w).bigEndian, h16 = UInt16(r.h).bigEndian
            var l32 = UInt32(jpeg.count).bigEndian
            payload.append(Data(bytes: &x16, count: 2)); payload.append(Data(bytes: &y16, count: 2))
            payload.append(Data(bytes: &w16, count: 2)); payload.append(Data(bytes: &h16, count: 2))
            payload.append(Data(bytes: &l32, count: 4)); payload.append(jpeg)
        }
        stdoutHandle.write(Data("FRAME:\(payload.count):\(ts):2\n".utf8))
        stdoutHandle.write(payload)
    }
}

func startCapture() async throws {
    // Request screen capture permission — triggers system dialog on first run
    if !CGRequestScreenCaptureAccess() {
        log("Screen recording permission denied. Please grant access in System Settings → Privacy & Security → Screen Recording")
        exit(1)
    }
    let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
    guard let display = content.displays.first else { log("No display"); exit(1) }
    let w = Int(Double(display.width) * scale), h = Int(Double(display.height) * scale)
    let filter = SCContentFilter(display: display, excludingWindows: [])
    let config = SCStreamConfiguration()
    config.width = w; config.height = h
    config.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(fps))
    config.queueDepth = 3; config.pixelFormat = kCVPixelFormatType_32BGRA; config.showsCursor = false
    let s = SCStream(filter: filter, configuration: config, delegate: nil)
    let o = StreamOutput()
    try s.addStreamOutput(o, type: .screen, sampleHandlerQueue: DispatchQueue(label: "cap"))
    try await s.startCapture()
    stdoutHandle.write(Data("READY:\(display.width):\(display.height):\(TILE_SIZE)\n".utf8))
    log("Streaming \(display.width)x\(display.height) -> \(w)x\(h) @ \(fps)fps")

    // Poll stdin for commands (non-blocking) + keep alive
    let stdinFd: Int32 = 0
    var stdinBuf = ""
    while true {
        try await Task.sleep(nanoseconds: 100_000_000) // 100ms
        // Non-blocking check for stdin data
        var pfd = pollfd(fd: stdinFd, events: Int16(POLLIN), revents: 0)
        while poll(&pfd, 1, 0) > 0 && (pfd.revents & Int16(POLLIN) != 0) {
            var byte: [UInt8] = [0]
            let n = read(stdinFd, &byte, 1)
            if n <= 0 { exit(0) } // EOF — parent died
            stdinBuf += String(UnicodeScalar(byte[0]))
            if byte[0] == 0x0a { // newline
                let cmd = stdinBuf.trimmingCharacters(in: .whitespacesAndNewlines)
                stdinBuf = ""
                if cmd == "KEYFRAME" {
                    o.forceKeyframe = true
                } else if cmd.hasPrefix("QUALITY:") {
                    let parts = cmd.split(separator: ":")
                    if parts.count >= 3,
                       let newScale = Double(parts[1]),
                       let newQuality = Double(parts[2]) {
                        let nw = Int(Double(display.width) * newScale)
                        let nh = Int(Double(display.height) * newScale)
                        let newConfig = SCStreamConfiguration()
                        newConfig.width = nw; newConfig.height = nh
                        newConfig.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(fps))
                        newConfig.queueDepth = 3; newConfig.pixelFormat = kCVPixelFormatType_32BGRA; newConfig.showsCursor = false
                        try? await s.updateConfiguration(newConfig)
                        o.currentQuality = newQuality
                        o.prevHashes = []
                        o.forceKeyframe = true
                        log("Quality updated: \(nw)x\(nh) q=\(newQuality)")
                    }
                }
            }
            pfd.revents = 0
        }
    }
}

Task {
    do { try await startCapture() }
    catch { log("ERROR: \(error)"); exit(1) }
}
RunLoop.main.run()
