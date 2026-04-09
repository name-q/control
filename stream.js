const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');
const ndc = require('node-datachannel');

const DEFAULTS = { fps: 30, scale: 1, bitrate: 2000 };

function getCaptureCommand() {
  const platform = os.platform();
  const base = path.join(__dirname, 'capture');
  if (platform === 'darwin') {
    const bin = path.join(base, 'macos', 'ScreenCapture.app', 'Contents', 'MacOS', 'capture');
    if (!fs.existsSync(bin)) return null;
    return bin;
  } else if (platform === 'win32') {
    const bin = path.join(base, 'windows', 'capture.exe');
    if (!fs.existsSync(bin)) return null;
    return bin;
  }
  return null;
}

function createStream(opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const bindAddress = cfg.bindAddress || '0.0.0.0';
  let proc = null;
  let buf = Buffer.alloc(0);
  let screenSize = null;
  let readyResolve = null;
  const readyPromise = new Promise(r => { readyResolve = r; });
  let latestCursor = null;

  // Peers: Map<ws, { pc, track, dc }>
  const peers = new Map();
  const pendingIce = new Map();

  function start() {
    if (proc) return;
    const bin = getCaptureCommand();
    if (!bin) { console.error('[stream] capture binary not found'); return; }
    proc = spawn(bin, [String(cfg.fps), String(cfg.scale), String(cfg.bitrate)], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    proc.stdout.on('data', (chunk) => { buf = Buffer.concat([buf, chunk]); parseOutput(); });
    proc.stderr.on('data', (d) => { const m = d.toString().trim(); if (m) console.log('[stream]', m); });
    proc.on('close', (code) => { console.log('[stream] capture exited', code); proc = null; });
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
        for (const [ws] of peers) {
          try { ws.send(JSON.stringify({ type: 'cursor', data: latestCursor })); } catch {}
        }
        continue;
      }
      if (line.startsWith('READY:')) {
        const parts = line.split(':');
        screenSize = { width: Number(parts[1]), height: Number(parts[2]) };
        buf = buf.subarray(nl + 1);
        console.log('[stream] screen:', screenSize);
        if (readyResolve) { readyResolve(); readyResolve = null; }
        continue;
      }
      if (line.startsWith('NALU:')) {
        const parts = line.substring(5).split(':');
        const len = parseInt(parts[0], 10);
        const dataStart = nl + 1;
        if (buf.length < dataStart + len) break;
        const naluData = buf.subarray(dataStart, dataStart + len);
        buf = buf.subarray(dataStart + len);
        broadcastNALU(naluData);
        continue;
      }
      buf = buf.subarray(nl + 1);
    }
    if (buf.length > 5 * 1024 * 1024) buf = Buffer.alloc(0);
  }

  function broadcastNALU(data) {
    for (const [, peer] of peers) {
      try {
        if (peer.track && peer.track.isOpen()) {
          peer.track.sendMessageBinary(data);
        }
      } catch {}
    }
  }

  // WebRTC signaling — server is offerer (has video track)
  function createPeer(ws) {
    const pc = new ndc.PeerConnection('server', {
      iceServers: [],
      bindAddress: bindAddress,
    });

    const video = new ndc.Video('video', 'sendonly');
    video.addH264Codec(96);
    const ssrc = (Math.random() * 0xFFFFFFFF) >>> 0;
    video.addSSRC(ssrc, 'screen');
    const rtpCfg = new ndc.RtpPacketizationConfig(ssrc, 'screen', 96, 90000);
    const packetizer = new ndc.H264RtpPacketizer('LongStartSequence', rtpCfg);
    const track = pc.addTrack(video);
    track.setMediaHandler(packetizer);

    // DataChannel for input
    pc.onDataChannel((dc) => {
      dc.onMessage((msg) => { if (ws._onDataChannelMessage) ws._onDataChannelMessage(msg); });
      if (peers.has(ws)) peers.get(ws).dc = dc;
    });

    // Send ICE candidates to browser
    pc.onLocalCandidate((candidate, mid) => {
      // node-datachannel gives "a=candidate:..." format, browser needs "candidate:..."
      const c = candidate.startsWith('a=') ? candidate.substring(2) : candidate;
      try { ws.send(JSON.stringify({ type: 'ice', candidate: { candidate: c, sdpMid: mid } })); } catch {}
    });

    // Send offer to browser
    pc.onLocalDescription((sdp, type) => {
      console.log('[stream] Sending', type, 'to browser');
      try { ws.send(JSON.stringify({ type, sdp })); } catch {}
    });

    pc.onStateChange((state) => console.log('[stream] connection:', state));
    pc.onIceStateChange((state) => console.log('[stream] ICE:', state));
    pc.onGatheringStateChange((state) => console.log('[stream] gathering:', state));
    pc.onSignalingStateChange((state) => console.log('[stream] signaling:', state));

    track.onOpen(() => console.log('[stream] Track open'));

    peers.set(ws, { pc, track, dc: null });

    if (!proc) start();
    requestKeyframe();

    // Server creates offer
    pc.setLocalDescription();
    console.log('[stream] Peer created, generating offer');
  }

  function handleAnswer(ws, sdp, type) {
    const peer = peers.get(ws);
    if (!peer) return;
    peer.pc.setRemoteDescription(sdp, type || 'answer');
    console.log('[stream] Answer applied');

    // Flush buffered ICE
    const buffered = pendingIce.get(ws);
    if (buffered) {
      for (const c of buffered) {
        try { peer.pc.addRemoteCandidate(c.candidate, c.mid); } catch {}
      }
      console.log('[stream] Flushed', buffered.length, 'ICE candidates');
      pendingIce.delete(ws);
    }
  }

  function handleIce(ws, candidate) {
    const peer = peers.get(ws);
    const c = candidate.candidate || candidate;
    const mid = candidate.sdpMid || '0';
    console.log('[stream] handleIce: c=' + c.substring(0, 60) + ' mid=' + mid);
    if (peer) {
      try { peer.pc.addRemoteCandidate(c, mid); } catch (e) { console.error('[stream] ICE err:', e.message); }
    } else {
      if (!pendingIce.has(ws)) pendingIce.set(ws, []);
      pendingIce.get(ws).push({ candidate: c, mid });
    }
  }

  function removePeer(ws) {
    const peer = peers.get(ws);
    if (peer) { peer.pc.close(); peers.delete(ws); }
    pendingIce.delete(ws);
    if (peers.size === 0 && proc) { console.log('[stream] no peers, stopping'); stop(); }
  }

  function requestKeyframe() { if (proc && proc.stdin.writable) proc.stdin.write('KEYFRAME\n'); }
  function setBitrate(kbps) {
    cfg.bitrate = kbps;
    if (proc && proc.stdin.writable) proc.stdin.write(`BITRATE:${kbps}\n`);
    console.log(`[stream] bitrate: ${kbps}kbps`);
  }
  function stop() {
    if (proc) { proc.kill(); proc = null; }
    for (const [, p] of peers) p.pc.close();
    peers.clear(); pendingIce.clear(); buf = Buffer.alloc(0);
  }
  function getScreenSize() { return screenSize; }

  return { ready: readyPromise, createPeer, handleAnswer, handleIce, removePeer, requestKeyframe, setBitrate, start, stop, getScreenSize };
}

module.exports = { createStream };
