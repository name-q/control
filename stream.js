const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { RTCPeerConnection, MediaStreamTrack, useH264, H264RtpPayload, RtpPacket, RtpHeader } = require('werift');

const DEFAULTS = { fps: 30, scale: 1, bitrate: 2000 };
const H264_CLOCK_RATE = 90000;

function getCaptureCommand() {
  const platform = os.platform();
  const base = path.join(__dirname, 'capture');
  if (platform === 'darwin') {
    const bin = path.join(base, 'macos', 'ScreenCapture.app', 'Contents', 'MacOS', 'capture');
    if (!fs.existsSync(bin)) {
      console.error('[stream] capture binary not found. Run: cd capture/macos && ./build.sh');
      return null;
    }
    return bin;
  } else if (platform === 'win32') {
    const bin = path.join(base, 'windows', 'capture.exe');
    if (!fs.existsSync(bin)) {
      console.error('[stream] capture.exe not found. Run: cd capture\\windows && build.bat');
      return null;
    }
    return bin;
  }
  return null;
}

function createStream(opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  let proc = null;
  let buf = Buffer.alloc(0);
  let screenSize = null;
  let readyResolve = null;
  const readyPromise = new Promise(r => { readyResolve = r; });
  let latestCursor = null;

  // WebRTC peers: Map<ws, { pc, track, sender }>
  const peers = new Map();

  // H264 RTP state
  let seqNum = 0;
  let rtpTimestamp = 0;
  const ssrc = Math.floor(Math.random() * 0xFFFFFFFF);

  function start() {
    if (proc) return;
    const bin = getCaptureCommand();
    if (!bin) return;

    proc = spawn(bin, [String(cfg.fps), String(cfg.scale), String(cfg.bitrate)], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    proc.stdout.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      parseOutput();
    });
    proc.stderr.on('data', (d) => {
      const msg = d.toString().trim();
      if (msg) console.log('[stream]', msg);
    });
    proc.on('close', (code) => {
      console.log('[stream] capture exited with code', code);
      proc = null;
    });

    console.log(`[stream] capture started, fps=${cfg.fps} bitrate=${cfg.bitrate}kbps`);
  }

  function parseOutput() {
    while (true) {
      const nl = buf.indexOf(0x0a);
      if (nl === -1) break;
      const line = buf.subarray(0, nl).toString('utf8');

      if (line.startsWith('CURSOR:')) {
        const parts = line.split(':');
        latestCursor = { x: Number(parts[1]), y: Number(parts[2]) };
        buf = buf.subarray(nl + 1);
        // Broadcast cursor to all peers via their WebSocket
        for (const [ws] of peers) {
          try { ws.send(JSON.stringify({ type: 'cursor', data: latestCursor })); } catch {}
        }
        continue;
      }

      if (line.startsWith('READY:')) {
        const parts = line.split(':');
        screenSize = { width: Number(parts[1]), height: Number(parts[2]) };
        buf = buf.subarray(nl + 1);
        console.log('[stream] screen size:', screenSize);
        if (readyResolve) { readyResolve(); readyResolve = null; }
        continue;
      }

      if (line.startsWith('NALU:')) {
        // NALU:<len>:<ts>:<isKey>
        const parts = line.substring(5).split(':');
        const len = parseInt(parts[0], 10);
        const ts = parseInt(parts[1], 10);
        const isKey = parts[2] === '1';
        const dataStart = nl + 1;
        if (buf.length < dataStart + len) break;

        const naluData = Buffer.from(buf.subarray(dataStart, dataStart + len));
        buf = buf.subarray(dataStart + len);

        // Feed H264 NALUs to all WebRTC peers
        feedNALU(naluData, ts, isKey);
        continue;
      }

      buf = buf.subarray(nl + 1);
    }
    if (buf.length > 5 * 1024 * 1024) buf = Buffer.alloc(0);
  }

  function feedNALU(annexBData, timestamp, isKey) {
    // Parse Annex-B NALUs (split by 00 00 00 01 start codes)
    const nalus = parseAnnexB(annexBData);

    // Convert timestamp to RTP clock (90kHz)
    rtpTimestamp = Math.floor(timestamp * 90) & 0xFFFFFFFF;

    for (const nalu of nalus) {
      if (nalu.length === 0) continue;

      // Write RTP-packetized NALU to each peer's track
      for (const [, peer] of peers) {
        try {
          peer.track.writeRtp(nalu, { isKeyframe: isKey });
        } catch {}
      }
    }
  }

  function parseAnnexB(data) {
    const nalus = [];
    let i = 0;
    while (i < data.length) {
      // Find start code (00 00 00 01 or 00 00 01)
      let scLen = 0;
      if (i + 3 < data.length && data[i] === 0 && data[i+1] === 0 && data[i+2] === 0 && data[i+3] === 1) {
        scLen = 4;
      } else if (i + 2 < data.length && data[i] === 0 && data[i+1] === 0 && data[i+2] === 1) {
        scLen = 3;
      } else {
        i++;
        continue;
      }
      i += scLen;

      // Find next start code
      let end = data.length;
      for (let j = i; j < data.length - 3; j++) {
        if (data[j] === 0 && data[j+1] === 0 && ((data[j+2] === 0 && data[j+3] === 1) || data[j+2] === 1)) {
          end = j;
          break;
        }
      }

      nalus.push(data.subarray(i, end));
      i = end;
    }
    return nalus;
  }

  // WebRTC signaling
  async function handleOffer(ws, sdp) {
    const pc = new RTCPeerConnection({
      iceServers: [],
      codecs: { video: [useH264()] },
      iceUseIpv4: true,
      iceUseIpv6: false,
    });

    const track = new MediaStreamTrack({ kind: 'video' });
    pc.addTrack(track);

    // DataChannel for input (created by browser)
    pc.ondatachannel = (ev) => {
      const dc = ev.channel;
      dc.onmessage = (e) => {
        if (ws._onDataChannelMessage) ws._onDataChannelMessage(e.data);
      };
      if (peers.has(ws)) peers.get(ws).dataChannel = dc;
    };

    // Trickle ICE: send candidates as they arrive
    pc.onicecandidate = (ev) => {
      if (ev.candidate) {
        try { ws.send(JSON.stringify({ type: 'ice', candidate: ev.candidate })); } catch {}
      }
    };

    await pc.setRemoteDescription({ type: 'offer', sdp });
    const answer = await pc.createAnswer();

    peers.set(ws, { pc, track, dataChannel: null });

    // Non-blocking: setLocalDescription triggers ICE gathering
    // Don't await — it blocks until gathering completes
    pc.setLocalDescription(answer).catch(() => {});

    if (!proc) start();
    requestKeyframe();

    console.log('[stream] WebRTC peer connected');
    return answer.sdp;
  }

  async function handleIce(ws, candidate) {
    const peer = peers.get(ws);
    if (peer) {
      await peer.pc.addIceCandidate(candidate);
    }
  }

  function removePeer(ws) {
    const peer = peers.get(ws);
    if (peer) {
      peer.pc.close();
      peers.delete(ws);
      if (peers.size === 0 && proc) {
        console.log('[stream] no peers, stopping capture');
        stop();
      }
    }
  }

  function requestKeyframe() {
    if (proc && proc.stdin.writable) proc.stdin.write('KEYFRAME\n');
  }

  function setBitrate(kbps) {
    cfg.bitrate = kbps;
    if (proc && proc.stdin.writable) proc.stdin.write(`BITRATE:${kbps}\n`);
    console.log(`[stream] bitrate changed: ${kbps}kbps`);
  }

  function stop() {
    if (proc) { proc.kill(); proc = null; }
    for (const [, peer] of peers) peer.pc.close();
    peers.clear();
    buf = Buffer.alloc(0);
  }

  function getScreenSize() { return screenSize; }
  function getPeerCount() { return peers.size; }

  return {
    ready: readyPromise,
    handleOffer, handleIce, removePeer,
    requestKeyframe, setBitrate,
    start, stop, getScreenSize, getPeerCount,
  };
}

module.exports = { createStream };
