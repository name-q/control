// Bridging header for libdatachannel C API
// Only the functions we need

#ifndef RTC_BRIDGE_H
#define RTC_BRIDGE_H

#include <stdint.h>
#include <stdbool.h>

// Enums
typedef enum { RTC_CODEC_H264 = 0 } rtcCodec;
typedef enum { RTC_DIRECTION_SENDONLY = 1 } rtcDirection;
typedef enum { RTC_NAL_SEPARATOR_LONG_START_SEQUENCE = 2, RTC_NAL_SEPARATOR_START_SEQUENCE = 3 } rtcNalUnitSeparator;
typedef enum { RTC_NEW = 0, RTC_CONNECTING = 1, RTC_CONNECTED = 2, RTC_DISCONNECTED = 3, RTC_FAILED = 4, RTC_CLOSED = 5 } rtcState;
typedef enum { RTC_ICE_NEW = 0, RTC_ICE_CHECKING = 1, RTC_ICE_CONNECTED = 2, RTC_ICE_COMPLETED = 3, RTC_ICE_FAILED = 4, RTC_ICE_DISCONNECTED = 5, RTC_ICE_CLOSED = 6 } rtcIceState;
typedef enum { RTC_GATHERING_NEW = 0, RTC_GATHERING_INPROGRESS = 1, RTC_GATHERING_COMPLETE = 2 } rtcGatheringState;
typedef enum { RTC_SIGNALING_STABLE = 0, RTC_SIGNALING_HAVE_LOCAL_OFFER = 1, RTC_SIGNALING_HAVE_REMOTE_OFFER = 2 } rtcSignalingState;

// Structs
typedef struct {
    const char **iceServers;
    int iceServersCount;
    const char *proxyServer;
    const char *bindAddress;
    int certificateType;
    int iceTransportPolicy;
    bool enableIceTcp;
    bool enableIceUdpMux;
    bool disableAutoNegotiation;
    bool forceMediaTransport;
    uint16_t portRangeBegin;
    uint16_t portRangeEnd;
    int mtu;
    int maxMessageSize;
} rtcConfiguration;

typedef struct {
    int direction; // rtcDirection
    int codec;     // rtcCodec
    int payloadType;
    uint32_t ssrc;
    const char *mid;
    const char *name;
    const char *msid;
    const char *trackId;
    const char *profile;
} rtcTrackInit;

typedef struct {
    uint32_t ssrc;
    const char *cname;
    uint8_t payloadType;
    uint32_t clockRate;
    uint16_t sequenceNumber;
    uint32_t timestamp;
    uint16_t maxFragmentSize;
    // NAL separator for H264
    int nalSeparator; // rtcNalUnitSeparator
} rtcPacketizerInit;

// Callbacks
typedef void (*rtcDescriptionCallbackFunc)(int pc, const char *sdp, const char *type, void *ptr);
typedef void (*rtcCandidateCallbackFunc)(int pc, const char *cand, const char *mid, void *ptr);
typedef void (*rtcStateChangeCallbackFunc)(int pc, int state, void *ptr);
typedef void (*rtcIceStateChangeCallbackFunc)(int pc, int state, void *ptr);
typedef void (*rtcGatheringStateCallbackFunc)(int pc, int state, void *ptr);
typedef void (*rtcOpenCallbackFunc)(int id, void *ptr);
typedef void (*rtcClosedCallbackFunc)(int id, void *ptr);
typedef void (*rtcMessageCallbackFunc)(int id, const char *message, int size, void *ptr);
typedef void (*rtcDataChannelCallbackFunc)(int pc, int dc, void *ptr);
typedef void (*rtcPliHandlerCallbackFunc)(int tr, void *ptr);
typedef void (*rtcRembHandlerCallbackFunc)(int tr, unsigned int bitrate, void *ptr);

// PeerConnection
int rtcCreatePeerConnection(const rtcConfiguration *config);
int rtcClosePeerConnection(int pc);
int rtcDeletePeerConnection(int pc);
int rtcSetLocalDescriptionCallback(int pc, rtcDescriptionCallbackFunc cb);
int rtcSetLocalCandidateCallback(int pc, rtcCandidateCallbackFunc cb);
int rtcSetStateChangeCallback(int pc, rtcStateChangeCallbackFunc cb);
int rtcSetIceStateChangeCallback(int pc, rtcIceStateChangeCallbackFunc cb);
int rtcSetGatheringStateChangeCallback(int pc, rtcGatheringStateCallbackFunc cb);
int rtcSetLocalDescription(int pc, const char *type);
int rtcSetRemoteDescription(int pc, const char *sdp, const char *type);
int rtcAddRemoteCandidate(int pc, const char *cand, const char *mid);
int rtcGetLocalDescription(int pc, char *buffer, int size);
int rtcGetLocalDescriptionType(int pc, char *buffer, int size);
void rtcSetUserPointer(int id, void *ptr);
void *rtcGetUserPointer(int id);

// Track
int rtcAddTrackEx(int pc, const rtcTrackInit *init);
int rtcDeleteTrack(int tr);
int rtcSetOpenCallback(int id, rtcOpenCallbackFunc cb);
int rtcSetClosedCallback(int id, rtcClosedCallbackFunc cb);
int rtcSendMessage(int id, const char *data, int size);
int rtcSetH264Packetizer(int tr, const rtcPacketizerInit *init);
int rtcChainPliHandler(int tr, rtcPliHandlerCallbackFunc cb);
int rtcChainRembHandler(int tr, rtcRembHandlerCallbackFunc cb);
int rtcChainRtcpNackResponder(int tr, unsigned int maxStoredPacketsCount);
int rtcChainRtcpSrReporter(int tr);
int rtcChainPacingHandler(int tr, double bitsPerSecond, int sendIntervalMs);
int rtcSetTrackRtpTimestamp(int id, uint32_t timestamp);

// DataChannel
int rtcSetDataChannelCallback(int pc, rtcDataChannelCallbackFunc cb);
int rtcCreateDataChannel(int pc, const char *label);
int rtcSetMessageCallback(int id, rtcMessageCallbackFunc cb);

// Logging
typedef void (*rtcLogCallbackFunc)(int level, const char *message);
void rtcInitLogger(int level, rtcLogCallbackFunc cb);

#endif
