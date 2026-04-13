// Windows Screen Capture + H264 Encode + WebRTC Direct Send
// Architecture mirrors macOS capture.swift exactly:
//   DXGI Desktop Duplication → Media Foundation H264 → libdatachannel → UDP
//   stdin: JSON signaling from Node
//   stdout: JSON signaling + CURSOR to Node
//
// Build: see build.bat (requires Visual Studio + libdatachannel)
// Args: capture.exe [fps] [scale] [bitrate_kbps] [bindAddress]

#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <d3d11.h>
#include <dxgi1_2.h>
#include <mfapi.h>
#include <mfidl.h>
#include <mfreadwrite.h>
#include <mftransform.h>
#include <codecapi.h>
#include <rtc/rtc.h>
#include <stdio.h>
#include <string>
#include <thread>
#include <mutex>
#include <atomic>
#include <chrono>

#pragma comment(lib, "d3d11.lib")
#pragma comment(lib, "dxgi.lib")
#pragma comment(lib, "mfplat.lib")
#pragma comment(lib, "mfuuid.lib")
#pragma comment(lib, "mf.lib")
#pragma comment(lib, "mfreadwrite.lib")
#pragma comment(lib, "datachannel.lib")

// ========== Globals ==========
static int g_fps = 60;
static double g_scale = 1.0;
static int g_bitrate = 15000; // kbps
static std::string g_bindAddress;

static std::atomic<bool> g_pliReceived{false};
static std::atomic<uint32_t> g_rembBitrate{0};
static std::atomic<int> g_pliWindowCount{0};

static void logErr(const char* msg) {
    fprintf(stderr, "%s\n", msg);
    fflush(stderr);
}

static void output(const std::string& msg) {
    printf("%s\n", msg.c_str());
    fflush(stdout);
}

static std::string jsonEscape(const std::string& s) {
    std::string r = "\"";
    for (char c : s) {
        if (c == '\\') r += "\\\\";
        else if (c == '"') r += "\\\"";
        else if (c == '\n') r += "\\n";
        else if (c == '\r') r += "\\r";
        else r += c;
    }
    return r + "\"";
}

// ========== WebRTC Manager ==========
class WebRTCManager {
public:
    int pcId = -1;
    int trackId = -1;
    uint32_t rtpTimestamp = 0;
    uint32_t rtpStep = 0;

    WebRTCManager(const std::string& bindAddr, int fps) {
        rtpStep = 90000 / fps;
        rtcConfiguration config = {};
        config.iceServersCount = 0;
        if (!bindAddr.empty()) config.bindAddress = bindAddr.c_str();

        pcId = rtcCreatePeerConnection(&config);
        if (pcId < 0) { logErr("Failed to create PeerConnection"); return; }

        rtcSetLocalDescriptionCallback(pcId, [](int pc, const char* sdp, const char* type, void*) {
            output("{\"type\":\"" + std::string(type) + "\",\"sdp\":" + jsonEscape(sdp) + "}");
        });

        rtcSetLocalCandidateCallback(pcId, [](int pc, const char* cand, const char* mid, void*) {
            std::string c = cand;
            if (c.substr(0, 2) == "a=") c = c.substr(2);
            output("{\"type\":\"ice\",\"candidate\":{\"candidate\":" + jsonEscape(c) + ",\"sdpMid\":" + jsonEscape(mid) + "}}");
        });

        rtcSetStateChangeCallback(pcId, [](int pc, int state, void*) {
            const char* states[] = {"new","connecting","connected","disconnected","failed","closed"};
            if (state == 2 || state >= 4) {
                char buf[64]; snprintf(buf, sizeof(buf), "[webrtc] %s", states[state]);
                logErr(buf);
            }
        });

        rtcSetIceStateChangeCallback(pcId, [](int, int, void*) {});

        rtcSetDataChannelCallback(pcId, [](int pc, int dc, void*) {
            rtcSetMessageCallback(dc, [](int id, const char* msg, int size, void*) {
                std::string data = size < 0 ? std::string(msg) : std::string(msg, size);
                output("{\"type\":\"dc\",\"data\":" + data + "}");
            });
        });
    }

    void addH264Track(uint32_t ssrc) {
        rtcTrackInit init = {};
        init.direction = RTC_DIRECTION_SENDONLY;
        init.codec = RTC_CODEC_H264;
        init.payloadType = 96;
        init.ssrc = ssrc;
        init.mid = "video";
        init.name = "screen";

        trackId = rtcAddTrackEx(pcId, &init);
        if (trackId < 0) { logErr("Failed to add track"); return; }

        rtcPacketizerInit pkt = {};
        pkt.ssrc = ssrc;
        pkt.cname = "screen";
        pkt.payloadType = 96;
        pkt.clockRate = 90000;
        pkt.maxFragmentSize = 1200;
        pkt.nalSeparator = 2; // LongStartSequence
        rtcSetH264Packetizer(trackId, &pkt);

        rtcChainRtcpSrReporter(trackId);
        rtcChainRtcpNackResponder(trackId, 512);
        rtcChainPliHandler(trackId, [](int, void*) {
            g_pliReceived = true;
            g_pliWindowCount++;
        });
        rtcChainRembHandler(trackId, [](int, unsigned int bitrate, void*) {
            g_rembBitrate = bitrate;
        });

        rtcSetOpenCallback(trackId, [](int, void*) {});

        char buf[64]; snprintf(buf, sizeof(buf), "[webrtc] H264 track added, id=%d", trackId);
        logErr(buf);
    }

    void createOffer() {
        rtcSetLocalDescription(pcId, nullptr);
    }

    void setRemoteDescription(const std::string& sdp, const std::string& type) {
        rtcSetRemoteDescription(pcId, sdp.c_str(), type.c_str());
    }

    void addRemoteCandidate(const std::string& candidate, const std::string& mid) {
        rtcAddRemoteCandidate(pcId, candidate.c_str(), mid.c_str());
    }

    void sendH264(const uint8_t* data, int size) {
        if (trackId < 0) return;
        rtcSetTrackRtpTimestamp(trackId, rtpTimestamp);
        rtcSendMessage(trackId, (const char*)data, size);
        rtpTimestamp += rtpStep;
    }
};

// ========== DXGI Desktop Duplication ==========
class ScreenCapture {
    ID3D11Device* device = nullptr;
    ID3D11DeviceContext* ctx = nullptr;
    IDXGIOutputDuplication* dupl = nullptr;
    ID3D11Texture2D* stagingTex = nullptr;
    int screenW = 0, screenH = 0;

public:
    bool init() {
        D3D_FEATURE_LEVEL featureLevel;
        HRESULT hr = D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr,
            D3D11_CREATE_DEVICE_BGRA_SUPPORT, nullptr, 0, D3D11_SDK_VERSION,
            &device, &featureLevel, &ctx);
        if (FAILED(hr)) { logErr("D3D11CreateDevice failed"); return false; }

        IDXGIDevice* dxgiDevice;
        device->QueryInterface(__uuidof(IDXGIDevice), (void**)&dxgiDevice);
        IDXGIAdapter* adapter;
        dxgiDevice->GetAdapter(&adapter);
        IDXGIOutput* output;
        adapter->EnumOutputs(0, &output);
        IDXGIOutput1* output1;
        output->QueryInterface(__uuidof(IDXGIOutput1), (void**)&output1);

        DXGI_OUTPUT_DESC desc;
        output->GetDesc(&desc);
        screenW = desc.DesktopCoordinates.right - desc.DesktopCoordinates.left;
        screenH = desc.DesktopCoordinates.bottom - desc.DesktopCoordinates.top;

        hr = output1->DuplicateOutput(device, &dupl);
        output1->Release(); output->Release(); adapter->Release(); dxgiDevice->Release();
        if (FAILED(hr)) { logErr("DuplicateOutput failed"); return false; }

        // Create staging texture for CPU access
        D3D11_TEXTURE2D_DESC texDesc = {};
        texDesc.Width = screenW;
        texDesc.Height = screenH;
        texDesc.MipLevels = 1;
        texDesc.ArraySize = 1;
        texDesc.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
        texDesc.SampleDesc.Count = 1;
        texDesc.Usage = D3D11_USAGE_STAGING;
        texDesc.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
        device->CreateTexture2D(&texDesc, nullptr, &stagingTex);

        return true;
    }

    int width() const { return screenW; }
    int height() const { return screenH; }

    // Returns BGRA pixel data, or nullptr if no new frame
    const uint8_t* acquireFrame(int& pitch) {
        DXGI_OUTDUPL_FRAME_INFO info;
        IDXGIResource* resource = nullptr;
        HRESULT hr = dupl->AcquireNextFrame(16, &info, &resource); // 16ms timeout
        if (FAILED(hr)) return nullptr;

        ID3D11Texture2D* tex;
        resource->QueryInterface(__uuidof(ID3D11Texture2D), (void**)&tex);
        ctx->CopyResource(stagingTex, tex);
        tex->Release();
        resource->Release();

        D3D11_MAPPED_SUBRESOURCE mapped;
        ctx->Map(stagingTex, 0, D3D11_MAP_READ, 0, &mapped);
        pitch = mapped.RowPitch;
        return (const uint8_t*)mapped.pData;
    }

    void releaseFrame() {
        ctx->Unmap(stagingTex, 0);
        dupl->ReleaseFrame();
    }
};

// ========== Media Foundation H264 Encoder ==========
// (Simplified — full MF encoder setup is verbose, this is the core structure)
// In production, use IMFTransform with MFT_CATEGORY_VIDEO_ENCODER
// For now, we output raw BGRA frames and let the caller handle encoding
// TODO: Implement full MF H264 encoder

// ========== Placeholder: For initial version, use software x264 or ffmpeg pipe ==========
// The correct implementation uses Media Foundation's H264 MFT directly
// This is left as a TODO — the architecture (DXGI + libdatachannel) is correct

// ========== Main ==========
int main(int argc, char* argv[]) {
    if (argc > 1) g_fps = atoi(argv[1]);
    if (argc > 2) g_scale = atof(argv[2]);
    if (argc > 3) g_bitrate = atoi(argv[3]);
    if (argc > 4) g_bindAddress = argv[4];

    // Initialize COM + Media Foundation
    CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    MFStartup(MF_VERSION);

    ScreenCapture capture;
    if (!capture.init()) return 1;

    int w = (int)(capture.width() * g_scale);
    int h = (int)(capture.height() * g_scale);

    // Cap at 4MP
    int maxPixels = 2560 * 1440;
    if (w * h > maxPixels) {
        double ratio = sqrt((double)maxPixels / (w * h));
        w = (int)(w * ratio);
        h = (int)(h * ratio);
    }

    // WebRTC
    WebRTCManager webrtc(g_bindAddress, g_fps);
    uint32_t ssrc = (uint32_t)rand();
    webrtc.addH264Track(ssrc);

    // Signal ready
    char readyBuf[64];
    snprintf(readyBuf, sizeof(readyBuf), "READY:%d:%d", capture.width(), capture.height());
    output(readyBuf);

    char logBuf[256];
    snprintf(logBuf, sizeof(logBuf), "Streaming %dx%d -> %dx%d @ %dfps H264 %dkbps",
        capture.width(), capture.height(), w, h, g_fps, g_bitrate);
    logErr(logBuf);

    // Create offer
    webrtc.createOffer();

    // Stdin reader thread
    std::thread stdinThread([&]() {
        char line[8192];
        while (fgets(line, sizeof(line), stdin)) {
            // Parse JSON commands (answer, ice, quality, keyframe)
            // Same protocol as macOS capture.swift
            std::string s(line);
            // TODO: JSON parsing + command handling
            // For now, just forward to WebRTC for answer/ice
        }
        exit(0);
    });
    stdinThread.detach();

    // TODO: Encode loop with Media Foundation H264
    // For now, just keep the process alive
    logErr("NOTE: Windows H264 encoder not yet implemented — DXGI + libdatachannel ready");

    while (true) {
        std::this_thread::sleep_for(std::chrono::seconds(1));
    }

    MFShutdown();
    CoUninitialize();
    return 0;
}
