// macOS Screen Capture — ScreenCaptureKit + VideoToolbox H264 Encoding
//
// Protocol (stdout):
//   READY:<screenW>:<screenH>\n
//   CURSOR:<x>:<y>\n
//   NALU:<len>:<ts>:<isKey>\n<h264Data>
//
// Protocol (stdin):
//   KEYFRAME\n          — force IDR frame
//   BITRATE:<bps>\n     — change target bitrate
//
// Args: capture [fps] [scale] [bitrate_kbps]

import Cocoa
import ScreenCaptureKit
import CoreMedia
import CoreGraphics
import VideoToolbox
import Foundation

let fps = CommandLine.arguments.count > 1 ? Double(CommandLine.arguments[1]) ?? 30 : 30
let scale = CommandLine.arguments.count > 2 ? Double(CommandLine.arguments[2]) ?? 1 : 1
let defaultBitrate = CommandLine.arguments.count > 3 ? Int(CommandLine.arguments[3]) ?? 2000 : 2000

let stdoutHandle = FileHandle.standardOutput
let stderrHandle = FileHandle.standardError

func log(_ msg: String) {
    stderrHandle.write(Data((msg + "\n").utf8))
}

class H264Encoder {
    var session: VTCompressionSession?
    var forceKeyframe = false
    var currentBitrate: Int = 0
    let width: Int
    let height: Int

    init(width: Int, height: Int, fps: Double, bitrate: Int) {
        self.width = width
        self.height = height

        var s: VTCompressionSession?
        let status = VTCompressionSessionCreate(
            allocator: nil,
            width: Int32(width), height: Int32(height),
            codecType: kCMVideoCodecType_H264,
            encoderSpecification: nil,
            imageBufferAttributes: [
                kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA
            ] as CFDictionary,
            compressedDataAllocator: nil,
            outputCallback: nil,
            refcon: nil,
            compressionSessionOut: &s
        )
        guard status == noErr, let session = s else {
            log("Failed to create VTCompressionSession: \(status)")
            exit(1)
        }
        self.session = session

        // Low-latency realtime encoding
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_RealTime, value: kCFBooleanTrue)
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_ProfileLevel, value: kVTProfileLevel_H264_Baseline_AutoLevel)
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_AllowFrameReordering, value: kCFBooleanFalse) // no B-frames
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_AverageBitRate, value: (bitrate * 1000) as CFNumber)
        currentBitrate = bitrate * 1000
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_MaxKeyFrameInterval, value: Int(fps) as CFNumber) // 1 IDR per second
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_ExpectedFrameRate, value: fps as CFNumber)

        VTCompressionSessionPrepareToEncodeFrames(session)
        log("H264 encoder: \(width)x\(height) @ \(Int(fps))fps, \(bitrate)kbps")
    }

    func setBitrate(_ bps: Int) {
        guard let session = session else { return }
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_AverageBitRate, value: bps as CFNumber)
        currentBitrate = bps
        log("Bitrate updated: \(bps / 1000)kbps")
    }

    func encode(_ pixelBuffer: CVPixelBuffer, timestamp: CMTime) {
        guard let session = session else { return }

        var flags: VTEncodeInfoFlags = []
        var properties: CFDictionary?

        if forceKeyframe {
            forceKeyframe = false
            properties = [
                kVTEncodeFrameOptionKey_ForceKeyFrame: true
            ] as CFDictionary
        }

        VTCompressionSessionEncodeFrame(
            session,
            imageBuffer: pixelBuffer,
            presentationTimeStamp: timestamp,
            duration: .invalid,
            frameProperties: properties,
            infoFlagsOut: &flags
        ) { [self] status, flags, sampleBuffer in
            guard status == noErr, let sb = sampleBuffer else { return }
            self.outputNALU(sb)
        }
    }

    func outputNALU(_ sampleBuffer: CMSampleBuffer) {
        guard let dataBuffer = CMSampleBufferGetDataBuffer(sampleBuffer) else { return }

        let isKey = sampleBuffer.isKeyFrame
        let ts = UInt64(Date().timeIntervalSince1970 * 1000)

        // Get SPS/PPS from keyframes
        if isKey, let formatDesc = CMSampleBufferGetFormatDescription(sampleBuffer) {
            var spsData = Data()

            // Extract SPS
            var spsSize: Int = 0, spsCount: Int = 0
            var spsPtr: UnsafePointer<UInt8>?
            if CMVideoFormatDescriptionGetH264ParameterSetAtIndex(formatDesc, parameterSetIndex: 0, parameterSetPointerOut: &spsPtr, parameterSetSizeOut: &spsSize, parameterSetCountOut: &spsCount, nalUnitHeaderLengthOut: nil) == noErr, let ptr = spsPtr {
                // Annex-B start code + SPS
                spsData.append(contentsOf: [0x00, 0x00, 0x00, 0x01])
                spsData.append(ptr, count: spsSize)
            }

            // Extract PPS
            var ppsSize: Int = 0
            var ppsPtr: UnsafePointer<UInt8>?
            if CMVideoFormatDescriptionGetH264ParameterSetAtIndex(formatDesc, parameterSetIndex: 1, parameterSetPointerOut: &ppsPtr, parameterSetSizeOut: &ppsSize, parameterSetCountOut: nil, nalUnitHeaderLengthOut: nil) == noErr, let ptr = ppsPtr {
                spsData.append(contentsOf: [0x00, 0x00, 0x00, 0x01])
                spsData.append(ptr, count: ppsSize)
            }

            if !spsData.isEmpty {
                writeNALU(spsData, ts: ts, isKey: true)
            }
        }

        // Extract NAL units from data buffer (AVCC format → Annex-B)
        var totalLength: Int = 0
        CMBlockBufferGetDataLength(dataBuffer)
        var lengthAtOffset: Int = 0
        var dataPointer: UnsafeMutablePointer<Int8>?
        CMBlockBufferGetDataPointer(dataBuffer, atOffset: 0, lengthAtOffsetOut: &lengthAtOffset, totalLengthOut: &totalLength, dataPointerOut: &dataPointer)

        guard let ptr = dataPointer else { return }

        var annexB = Data()
        var offset = 0
        while offset < totalLength {
            // Read 4-byte AVCC length prefix
            var naluLen: UInt32 = 0
            memcpy(&naluLen, ptr + offset, 4)
            naluLen = naluLen.bigEndian
            offset += 4

            // Annex-B start code + NALU data
            annexB.append(contentsOf: [0x00, 0x00, 0x00, 0x01])
            annexB.append(Data(bytes: ptr + offset, count: Int(naluLen)))
            offset += Int(naluLen)
        }

        if !annexB.isEmpty {
            writeNALU(annexB, ts: ts, isKey: isKey)
        }
    }

    func writeNALU(_ data: Data, ts: UInt64, isKey: Bool) {
        let header = Data("NALU:\(data.count):\(ts):\(isKey ? 1 : 0)\n".utf8)
        stdoutHandle.write(header)
        stdoutHandle.write(data)
    }

    deinit {
        if let session = session {
            VTCompressionSessionInvalidate(session)
        }
    }
}

extension CMSampleBuffer {
    var isKeyFrame: Bool {
        guard let attachments = CMSampleBufferGetSampleAttachmentsArray(self, createIfNecessary: false) as? [[CFString: Any]],
              let first = attachments.first else { return true }
        return !(first[kCMSampleAttachmentKey_NotSync] as? Bool ?? false)
    }
}
class StreamOutput: NSObject, SCStreamOutput {
    var encoder: H264Encoder
    var frameCount = 0

    init(encoder: H264Encoder) {
        self.encoder = encoder
        super.init()
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, let pb = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }

        // Cursor position
        let cursorLoc = CGEvent(source: nil)?.location ?? .zero
        stdoutHandle.write(Data("CURSOR:\(Int(cursorLoc.x)):\(Int(cursorLoc.y))\n".utf8))

        // Encode frame
        let pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
        encoder.encode(pb, timestamp: pts)
        frameCount += 1
    }
}

func startCapture() async throws {
    if !CGRequestScreenCaptureAccess() {
        log("Screen recording permission denied")
        exit(1)
    }
    let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
    guard let display = content.displays.first else { log("No display"); exit(1) }
    let w = Int(Double(display.width) * scale), h = Int(Double(display.height) * scale)

    var encoder = H264Encoder(width: w, height: h, fps: fps, bitrate: defaultBitrate)

    let filter = SCContentFilter(display: display, excludingWindows: [])
    let config = SCStreamConfiguration()
    config.width = w; config.height = h
    config.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(fps))
    config.queueDepth = 3; config.pixelFormat = kCVPixelFormatType_32BGRA; config.showsCursor = false
    let s = SCStream(filter: filter, configuration: config, delegate: nil)
    let o = StreamOutput(encoder: encoder)
    try s.addStreamOutput(o, type: .screen, sampleHandlerQueue: DispatchQueue(label: "cap"))
    try await s.startCapture()

    stdoutHandle.write(Data("READY:\(display.width):\(display.height)\n".utf8))
    log("Streaming \(display.width)x\(display.height) -> \(w)x\(h) @ \(Int(fps))fps H264 \(defaultBitrate)kbps")

    // stdin command loop (non-blocking poll)
    let stdinFd: Int32 = 0
    var stdinBuf = ""
    while true {
        try await Task.sleep(nanoseconds: 100_000_000)
        var pfd = pollfd(fd: stdinFd, events: Int16(POLLIN), revents: 0)
        while poll(&pfd, 1, 0) > 0 && (pfd.revents & Int16(POLLIN) != 0) {
            var byte: [UInt8] = [0]
            let n = read(stdinFd, &byte, 1)
            if n <= 0 { exit(0) }
            stdinBuf += String(UnicodeScalar(byte[0]))
            if byte[0] == 0x0a {
                let cmd = stdinBuf.trimmingCharacters(in: .whitespacesAndNewlines)
                stdinBuf = ""
                if cmd == "KEYFRAME" {
                    encoder.forceKeyframe = true
                } else if cmd.hasPrefix("BITRATE:") {
                    if let bps = Int(cmd.split(separator: ":")[1]) {
                        encoder.setBitrate(bps * 1000)
                    }
                } else if cmd.hasPrefix("SCALE:") {
                    if let newScale = Double(cmd.split(separator: ":")[1]) {
                        let nw = Int(Double(display.width) * newScale)
                        let nh = Int(Double(display.height) * newScale)
                        let newConfig = SCStreamConfiguration()
                        newConfig.width = nw; newConfig.height = nh
                        newConfig.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(fps))
                        newConfig.queueDepth = 3; newConfig.pixelFormat = kCVPixelFormatType_32BGRA; newConfig.showsCursor = false
                        Task {
                            try? await s.updateConfiguration(newConfig)
                            // Recreate encoder with new dimensions
                            let currentBitrate = encoder.currentBitrate
                            encoder = H264Encoder(width: nw, height: nh, fps: fps, bitrate: currentBitrate / 1000)
                            o.encoder = encoder
                            log("Scale updated: \(nw)x\(nh)")
                        }
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
