// V3: Screen Capture + H264 Encode + WebRTC Direct Send
//
// Video path: ScreenCaptureKit → VideoToolbox H264 → libdatachannel RTP → UDP → Browser
// Signaling: stdin JSON ← Node, stdout JSON → Node
// Cursor: stdout CURSOR:x:y → Node → WebSocket → Browser
//
// Args: capture [fps] [scale] [bitrate_kbps] [bindAddress]

import Foundation
import ScreenCaptureKit
import CoreMedia
import VideoToolbox

let fps = CommandLine.arguments.count > 1 ? Double(CommandLine.arguments[1]) ?? 30 : 30
let scale = CommandLine.arguments.count > 2 ? Double(CommandLine.arguments[2]) ?? 1 : 1
let defaultBitrate = CommandLine.arguments.count > 3 ? Int(CommandLine.arguments[3]) ?? 8000 : 8000
let bindAddr = CommandLine.arguments.count > 4 ? CommandLine.arguments[4] : nil

let stdoutH = FileHandle.standardOutput
let stderrH = FileHandle.standardError
var pliReceived = false
var rembBitrate: UInt32 = 0
var pliCount: Int = 0
var pliWindowCount: Int = 0
var pliWindowStart: UInt64 = 0

// Mach timebase for mach_absolute_time → nanoseconds
private var _machInfo = mach_timebase_info_data_t()
private let _ : Void = { mach_timebase_info(&_machInfo) }()
func machToSeconds(_ t: UInt64) -> Double {
    return Double(t) * Double(_machInfo.numer) / Double(_machInfo.denom) / 1_000_000_000.0
}
func log(_ msg: String) { stderrH.write(Data((msg + "\n").utf8)) }
func output(_ msg: String) { stdoutH.write(Data((msg + "\n").utf8)) }

// ========== WebRTC Manager (libdatachannel C API) ==========
class WebRTCManager {
    var pcId: Int32 = -1
    var trackId: Int32 = -1
    var trackOpen = false

    init(bindAddress: String?) {
        var config = rtcConfiguration()
        memset(&config, 0, MemoryLayout<rtcConfiguration>.size)
        config.iceServersCount = 0
        if let addr = bindAddress {
            addr.withCString { config.bindAddress = $0; self.createPC(&config) }
        } else {
            createPC(&config)
        }
    }

    private func createPC(_ config: inout rtcConfiguration) {
        pcId = rtcCreatePeerConnection(&config)
        guard pcId >= 0 else { log("Failed to create PeerConnection"); return }

        rtcSetLocalDescriptionCallback(pcId) { pc, sdp, type, ptr in
            guard let sdp = sdp, let type = type else { return }
            let sdpStr = String(cString: sdp)
            let typeStr = String(cString: type)
            output("{\"type\":\"\(typeStr)\",\"sdp\":\(WebRTCManager.jsonEscape(sdpStr))}")
        }

        rtcSetLocalCandidateCallback(pcId) { pc, cand, mid, ptr in
            guard let cand = cand, let mid = mid else { return }
            var c = String(cString: cand)
            if c.hasPrefix("a=") { c = String(c.dropFirst(2)) }
            let m = String(cString: mid)
            output("{\"type\":\"ice\",\"candidate\":{\"candidate\":\(WebRTCManager.jsonEscape(c)),\"sdpMid\":\(WebRTCManager.jsonEscape(m))}}")
        }

        rtcSetStateChangeCallback(pcId) { pc, state, ptr in
            let states = ["new","connecting","connected","disconnected","failed","closed"]
            let s = state >= 0 && state < states.count ? states[Int(state)] : "unknown"
            log("[webrtc] connection: \(s)")
        }

        rtcSetIceStateChangeCallback(pcId) { pc, state, ptr in
            let states = ["new","checking","connected","completed","failed","disconnected","closed"]
            let s = state >= 0 && state < states.count ? states[Int(state)] : "unknown"
            log("[webrtc] ICE: \(s)")
        }

        // DataChannel callback (browser creates it for input)
        rtcSetDataChannelCallback(pcId) { pc, dc, ptr in
            log("[webrtc] DataChannel received")
            rtcSetMessageCallback(dc) { id, msg, size, ptr in
                // Forward to stdout for Node to handle
                guard let msg = msg else { return }
                let data = size < 0 ? String(cString: msg) : String(data: Data(bytes: msg, count: Int(size)), encoding: .utf8) ?? ""
                output("{\"type\":\"dc\",\"data\":\(data)}")
            }
        }
    }

    func addH264Track(ssrc: UInt32) {
        var init_ = rtcTrackInit()
        memset(&init_, 0, MemoryLayout<rtcTrackInit>.size)
        init_.direction = 1 // RTC_DIRECTION_SENDONLY
        init_.codec = 0     // RTC_CODEC_H264
        init_.payloadType = 96
        init_.ssrc = ssrc

        "video".withCString { mid in
            "screen".withCString { name in
                init_.mid = mid
                init_.name = name
                trackId = rtcAddTrackEx(pcId, &init_)
            }
        }
        guard trackId >= 0 else { log("Failed to add track"); return }

        // Set H264 packetizer
        var pktInit = rtcPacketizerInit()
        memset(&pktInit, 0, MemoryLayout<rtcPacketizerInit>.size)
        pktInit.ssrc = ssrc
        "screen".withCString { pktInit.cname = $0 }
        pktInit.payloadType = 96
        pktInit.clockRate = 90000
        pktInit.maxFragmentSize = 1200
        pktInit.nalSeparator = 2
        rtcSetH264Packetizer(trackId, &pktInit)

        // Media handler chain (order matters):
        // 1. RTCP SR Reporter — sends sender reports for sync
        rtcChainRtcpSrReporter(trackId)

        // 2. NACK Responder — auto-retransmit lost packets
        rtcChainRtcpNackResponder(trackId, 512)

        // 3. PLI Handler — browser detected decode failure
        rtcChainPliHandler(trackId) { tr, ptr in
            pliReceived = true
            pliCount += 1
            pliWindowCount += 1
        }

        // 5. REMB Handler — browser reports available bandwidth
        rtcChainRembHandler(trackId) { tr, bitrate, ptr in
            rembBitrate = bitrate
        }

        rtcSetOpenCallback(trackId) { id, ptr in
            log("[webrtc] Track open")
        }

        log("[webrtc] H264 track added, id=\(trackId)")
    }

    func createOffer() {
        rtcSetLocalDescription(pcId, nil) // nil = auto (offer since we have track)
    }

    func setRemoteDescription(_ sdp: String, type: String) {
        sdp.withCString { s in
            type.withCString { t in
                rtcSetRemoteDescription(pcId, s, t)
            }
        }
    }

    func addRemoteCandidate(_ candidate: String, mid: String) {
        candidate.withCString { c in
            mid.withCString { m in
                rtcAddRemoteCandidate(pcId, c, m)
            }
        }
    }

    func sendH264(_ data: Data, timestamp: UInt32) {
        guard trackId >= 0 else { return }
        // Set RTP timestamp for this frame (90kHz clock)
        rtcSetTrackRtpTimestamp(trackId, timestamp)
        data.withUnsafeBytes { ptr in
            guard let base = ptr.baseAddress else { return }
            rtcSendMessage(trackId, base.assumingMemoryBound(to: CChar.self), Int32(data.count))
        }
    }

    static func jsonEscape(_ s: String) -> String {
        let escaped = s.replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
            .replacingOccurrences(of: "\n", with: "\\n")
            .replacingOccurrences(of: "\r", with: "\\r")
        return "\"\(escaped)\""
    }
}
// ========== H264 Encoder ==========
class H264Encoder {
    var session: VTCompressionSession?
    var forceKeyframe = false
    var webrtc: WebRTCManager?
    var lastRembApplied: Int = 0

    // Frame Scheduler: lock-free single-slot buffer
    // Encoder writes, scheduler reads. Atomic swap via os_unfair_lock (fastest on macOS)
    private var frameSlot: Data?
    private var slotLock = os_unfair_lock()
    private var rtpTimestamp: UInt32 = 0
    private let rtpStep: UInt32
    private var schedulerTimer: DispatchSourceTimer?
    private var consecutiveEmpty = 0 // track idle ticks

    init(width: Int, height: Int, fps: Double, bitrate: Int) {
        self.rtpStep = UInt32(90000 / fps)
        var s: VTCompressionSession?
        VTCompressionSessionCreate(allocator: nil, width: Int32(width), height: Int32(height),
            codecType: kCMVideoCodecType_H264, encoderSpecification: nil,
            imageBufferAttributes: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA] as CFDictionary,
            compressedDataAllocator: nil, outputCallback: nil, refcon: nil, compressionSessionOut: &s)
        guard let session = s else { log("VTCompressionSession failed"); exit(1) }
        self.session = session

        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_RealTime, value: kCFBooleanTrue)
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_ProfileLevel, value: kVTProfileLevel_H264_High_AutoLevel)
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_AllowFrameReordering, value: kCFBooleanFalse)
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_AverageBitRate, value: (bitrate * 1000) as CFNumber)
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_MaxKeyFrameInterval, value: Int(fps) as CFNumber)
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_MaxKeyFrameIntervalDuration, value: 1.0 as CFNumber)
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_ExpectedFrameRate, value: fps as CFNumber)
        VTCompressionSessionPrepareToEncodeFrames(session)
        log("H264 encoder: \(width)x\(height) @ \(Int(fps))fps, \(bitrate)kbps")

        // Frame Scheduler — strict clock-driven send
        let intervalNs = UInt64(1_000_000_000 / fps)
        let timer = DispatchSource.makeTimerSource(queue: DispatchQueue(label: "scheduler", qos: .userInteractive))
        timer.schedule(deadline: .now(), repeating: .nanoseconds(Int(intervalNs)), leeway: .nanoseconds(0))
        timer.setEventHandler { [weak self] in
            guard let self = self, let webrtc = self.webrtc else { return }

            // Atomic swap: grab frame, clear slot
            os_unfair_lock_lock(&self.slotLock)
            let frame = self.frameSlot
            self.frameSlot = nil
            os_unfair_lock_unlock(&self.slotLock)

            if let frame = frame {
                self.consecutiveEmpty = 0
                webrtc.sendH264(frame, timestamp: self.rtpTimestamp)
                self.rtpTimestamp &+= self.rtpStep
            } else {
                self.consecutiveEmpty += 1
                // Still increment timestamp to keep clock steady
                if self.consecutiveEmpty < 3 {
                    self.rtpTimestamp &+= self.rtpStep
                }
            }
        }
        timer.resume()
        schedulerTimer = timer
    }

    func setBitrate(_ bps: Int) {
        guard let s = session else { return }
        VTSessionSetProperty(s, key: kVTCompressionPropertyKey_AverageBitRate, value: bps as CFNumber)
    }

    func encode(_ pb: CVPixelBuffer, timestamp: CMTime) {
        guard let s = session else { return }

        // PLI response — immediate IDR
        if pliReceived {
            pliReceived = false
            forceKeyframe = true
        }

        // Dynamic GOP based on PLI frequency (5-second window)
        let now = mach_absolute_time()
        if pliWindowStart == 0 { pliWindowStart = now }
        let elapsed = machToSeconds(now - pliWindowStart)
        if elapsed > 5.0 {
            // Adjust GOP based on PLI rate in last 5 seconds
            if pliWindowCount >= 5 {
                // Heavy packet loss — very short GOP (IDR every 0.25s)
                VTSessionSetProperty(s, key: kVTCompressionPropertyKey_MaxKeyFrameInterval, value: max(Int(fps / 4), 2) as CFNumber)
            } else if pliWindowCount >= 2 {
                // Moderate loss — shorter GOP (IDR every 0.5s)
                VTSessionSetProperty(s, key: kVTCompressionPropertyKey_MaxKeyFrameInterval, value: Int(fps / 2) as CFNumber)
            } else {
                // Stable — normal GOP (IDR every 1s)
                VTSessionSetProperty(s, key: kVTCompressionPropertyKey_MaxKeyFrameInterval, value: Int(fps) as CFNumber)
            }
            pliWindowCount = 0
            pliWindowStart = now
        }

        // REMB-driven bitrate control: fast down, slow up
        if rembBitrate > 0 {
            let remb = Int(rembBitrate)
            let currentBitrate = lastRembApplied > 0 ? lastRembApplied : defaultBitrate * 1000
            var targetBps = currentBitrate

            if remb < currentBitrate {
                // Network congested — drop fast (85% of REMB)
                targetBps = max(Int(Double(remb) * 0.85), 1_000_000)
            } else if pliWindowCount == 0 {
                // Stable — recover slowly (10% increase)
                targetBps = min(Int(Double(currentBitrate) * 1.1), defaultBitrate * 1000)
            }

            if abs(targetBps - lastRembApplied) > 200_000 {
                lastRembApplied = targetBps
                VTSessionSetProperty(s, key: kVTCompressionPropertyKey_AverageBitRate, value: targetBps as CFNumber)
            }
        }

        var flags: VTEncodeInfoFlags = []
        let props: CFDictionary? = forceKeyframe ? [kVTEncodeFrameOptionKey_ForceKeyFrame: true] as CFDictionary : nil
        if forceKeyframe { forceKeyframe = false }

        let encodeStart = mach_absolute_time()
        VTCompressionSessionEncodeFrame(s, imageBuffer: pb, presentationTimeStamp: timestamp,
            duration: .invalid, frameProperties: props, infoFlagsOut: &flags) { [weak self] status, _, sb in
            guard status == noErr, let sb = sb, let self = self else { return }
            // Track encode time
            let encodeMs = machToSeconds(mach_absolute_time() - encodeStart) * 1000
            self.lastEncodeTimeMs = encodeMs

            let annexB = self.buildAnnexB(sb)
            if !annexB.isEmpty {
                os_unfair_lock_lock(&self.slotLock)
                self.frameSlot = annexB
                os_unfair_lock_unlock(&self.slotLock)
            }
        }
    }
    var lastEncodeTimeMs: Double = 0

    private func buildAnnexB(_ sb: CMSampleBuffer) -> Data {
        guard let dataBuffer = CMSampleBufferGetDataBuffer(sb) else { return Data() }
        let isKey = sb.isKeyFrame
        var annexB = Data()

        if isKey, let fmt = CMSampleBufferGetFormatDescription(sb) {
            var spsPtr: UnsafePointer<UInt8>?; var spsSize = 0
            if CMVideoFormatDescriptionGetH264ParameterSetAtIndex(fmt, parameterSetIndex: 0,
                parameterSetPointerOut: &spsPtr, parameterSetSizeOut: &spsSize, parameterSetCountOut: nil, nalUnitHeaderLengthOut: nil) == noErr, let p = spsPtr {
                annexB.append(contentsOf: [0,0,0,1]); annexB.append(p, count: spsSize)
            }
            var ppsPtr: UnsafePointer<UInt8>?; var ppsSize = 0
            if CMVideoFormatDescriptionGetH264ParameterSetAtIndex(fmt, parameterSetIndex: 1,
                parameterSetPointerOut: &ppsPtr, parameterSetSizeOut: &ppsSize, parameterSetCountOut: nil, nalUnitHeaderLengthOut: nil) == noErr, let p = ppsPtr {
                annexB.append(contentsOf: [0,0,0,1]); annexB.append(p, count: ppsSize)
            }
        }

        var totalLen = 0; var dataPtr: UnsafeMutablePointer<Int8>?
        CMBlockBufferGetDataPointer(dataBuffer, atOffset: 0, lengthAtOffsetOut: nil, totalLengthOut: &totalLen, dataPointerOut: &dataPtr)
        guard let ptr = dataPtr else { return annexB }
        // Pre-allocate to avoid repeated reallocation
        annexB.reserveCapacity(annexB.count + totalLen + 32)
        var offset = 0
        while offset < totalLen {
            var naluLen: UInt32 = 0; memcpy(&naluLen, ptr + offset, 4); naluLen = naluLen.bigEndian; offset += 4
            annexB.append(contentsOf: [0,0,0,1]); annexB.append(Data(bytes: ptr + offset, count: Int(naluLen))); offset += Int(naluLen)
        }

        return annexB
    }
}

extension CMSampleBuffer {
    var isKeyFrame: Bool {
        guard let a = CMSampleBufferGetSampleAttachmentsArray(self, createIfNecessary: false) as? [[CFString: Any]],
              let f = a.first else { return true }
        return !(f[kCMSampleAttachmentKey_NotSync] as? Bool ?? false)
    }
}
// ========== Stream Output + Frame Arbitration ==========
class StreamOutput: NSObject, SCStreamOutput {
    var encoder: H264Encoder

    // Frame Arbitration: only keep the latest pixel buffer
    // Capture writes, encoder reads. Never queue, never backlog.
    private var latestPixelBuffer: CVPixelBuffer?
    private var latestPTS: CMTime = .zero
    private var pbLock = os_unfair_lock()
    private var encodeTimer: DispatchSourceTimer?
    private let encodeFps: Double

    init(encoder: H264Encoder, fps: Double) {
        self.encoder = encoder
        self.encodeFps = fps
        super.init()
        startEncodeLoop()
    }

    // Encode loop: fixed interval, always takes latest frame only
    func startEncodeLoop() {
        encodeTimer?.cancel()
        let interval = UInt64(1_000_000_000 / encodeFps)
        let timer = DispatchSource.makeTimerSource(queue: DispatchQueue(label: "encode", qos: .userInteractive))
        timer.schedule(deadline: .now(), repeating: .nanoseconds(Int(interval)), leeway: .nanoseconds(0))
        timer.setEventHandler { [weak self] in
            guard let self = self else { return }
            // Grab latest frame, clear slot
            os_unfair_lock_lock(&self.pbLock)
            let pb = self.latestPixelBuffer
            let pts = self.latestPTS
            self.latestPixelBuffer = nil
            os_unfair_lock_unlock(&self.pbLock)

            if let pb = pb {
                self.encoder.encode(pb, timestamp: pts)
            }
        }
        timer.resume()
        encodeTimer = timer
    }

    func stopEncodeLoop() {
        encodeTimer?.cancel()
        encodeTimer = nil
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sb: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, let pb = CMSampleBufferGetImageBuffer(sb) else { return }

        // Cursor (always send, never blocked)
        let loc = CGEvent(source: nil)?.location ?? .zero
        output("CURSOR:\(Int(loc.x)):\(Int(loc.y))")

        // Frame Arbitration: just store latest, never call encode directly
        let pts = CMSampleBufferGetPresentationTimeStamp(sb)
        os_unfair_lock_lock(&pbLock)
        latestPixelBuffer = pb
        latestPTS = pts
        os_unfair_lock_unlock(&pbLock)
    }

    deinit {
        stopEncodeLoop()
    }
}
// ========== Start Capture ==========
func startCapture() async throws {
    if !CGRequestScreenCaptureAccess() { log("Screen recording denied"); exit(1) }
    let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
    guard let display = content.displays.first else { log("No display"); exit(1) }
    let w = Int(Double(display.width) * scale), h = Int(Double(display.height) * scale)

    // WebRTC
    let webrtc = WebRTCManager(bindAddress: bindAddr)
    let ssrc = UInt32.random(in: 1...UInt32.max)
    webrtc.addH264Track(ssrc: ssrc)

    // Encoder
    var encoder = H264Encoder(width: w, height: h, fps: fps, bitrate: defaultBitrate)
    encoder.webrtc = webrtc

    // Screen capture
    let cfg = SCStreamConfiguration()
    cfg.width = w; cfg.height = h
    cfg.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(fps))
    cfg.queueDepth = 3; cfg.pixelFormat = kCVPixelFormatType_32BGRA; cfg.showsCursor = false
    let s = SCStream(filter: SCContentFilter(display: display, excludingWindows: []), configuration: cfg, delegate: nil)
    let o = StreamOutput(encoder: encoder, fps: fps)
    try s.addStreamOutput(o, type: .screen, sampleHandlerQueue: DispatchQueue(label: "cap"))
    try await s.startCapture()

    // Signal ready
    output("READY:\(display.width):\(display.height)")
    log("Streaming \(display.width)x\(display.height) → \(w)x\(h) @ \(Int(fps))fps H264 \(defaultBitrate)kbps")

    // Create offer (server is offerer)
    webrtc.createOffer()

    // stdin command loop (non-blocking poll)
    let fd: Int32 = 0
    var stdinBuf = ""
    while true {
        try await Task.sleep(nanoseconds: 50_000_000) // 50ms
        var pfd = pollfd(fd: fd, events: Int16(POLLIN), revents: 0)
        while poll(&pfd, 1, 0) > 0 && (pfd.revents & Int16(POLLIN) != 0) {
            var byte: [UInt8] = [0]
            let n = read(fd, &byte, 1)
            if n <= 0 { exit(0) }
            stdinBuf += String(UnicodeScalar(byte[0]))
            if byte[0] == 0x0a {
                let line = stdinBuf.trimmingCharacters(in: .whitespacesAndNewlines)
                stdinBuf = ""
                handleStdinCommand(line, webrtc: webrtc, encoder: &encoder, streamOutput: o, stream: s, display: display)
            }
            pfd.revents = 0
        }
    }
}

func handleStdinCommand(_ json: String, webrtc: WebRTCManager, encoder: inout H264Encoder, streamOutput: StreamOutput, stream: SCStream, display: SCDisplay) {
    guard let data = json.data(using: .utf8),
          let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let type = obj["type"] as? String else { return }

    switch type {
    case "answer":
        if let sdp = obj["sdp"] as? String {
            webrtc.setRemoteDescription(sdp, type: "answer")
            log("[stdin] Answer applied")
        }
    case "ice":
        if let cand = obj["candidate"] as? [String: Any],
           let candidate = cand["candidate"] as? String,
           let mid = cand["sdpMid"] as? String {
            webrtc.addRemoteCandidate(candidate, mid: mid)
        }
    case "keyframe":
        encoder.forceKeyframe = true
    case "quality":
        let kbps = obj["kbps"] as? Int ?? defaultBitrate
        let newScale = obj["scale"] as? Double ?? scale
        var nw = Int(Double(display.width) * newScale)
        var nh = Int(Double(display.height) * newScale)
        // Cap at ~2MP (1920x1080 equivalent) — higher kills encoder performance
        let maxPixels = 1920 * 1080
        if nw * nh > maxPixels {
            let ratio = sqrt(Double(maxPixels) / Double(nw * nh))
            nw = Int(Double(nw) * ratio)
            nh = Int(Double(nh) * ratio)
        }
        // Update SCStream resolution
        let newCfg = SCStreamConfiguration()
        newCfg.width = nw; newCfg.height = nh
        newCfg.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(fps))
        newCfg.queueDepth = 3; newCfg.pixelFormat = kCVPixelFormatType_32BGRA; newCfg.showsCursor = false
        Task { try? await stream.updateConfiguration(newCfg) }
        // Rebuild encoder with new dimensions + bitrate
        streamOutput.stopEncodeLoop() // stop old encode timer
        let newEncoder = H264Encoder(width: nw, height: nh, fps: fps, bitrate: kbps)
        newEncoder.webrtc = encoder.webrtc
        encoder = newEncoder
        streamOutput.encoder = newEncoder
        streamOutput.startEncodeLoop() // restart with new encoder
        log("[stdin] Quality: \(nw)x\(nh) \(kbps)kbps")
    default: break
    }
}
Task {
    do { try await startCapture() }
    catch { log("ERROR: \(error)"); exit(1) }
}
RunLoop.main.run()
