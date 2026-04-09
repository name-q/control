const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');

const DEFAULTS = { fps: 30, scale: 1, bitrate: 3000 };

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
  let proc = null;
  let screenSize = null;
  let readyResolve = null;
  const readyPromise = new Promise(r => { readyResolve = r; });

  // One capture process per client (WebRTC is peer-to-peer)
  const clients = new Map(); // ws → proc

  function createPeer(ws) {
    const bin = getCaptureCommand();
    if (!bin) { console.error('[stream] capture binary not found'); return; }

    const p = spawn(bin, [String(cfg.fps), String(cfg.scale), String(cfg.bitrate), cfg.bindAddress || ''], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // stdout: signaling JSON + CURSOR lines
    let lineBuf = '';
    p.stdout.on('data', (chunk) => {
      lineBuf += chunk.toString();
      const lines = lineBuf.split('\n');
      lineBuf = lines.pop(); // keep incomplete line
      for (const line of lines) {
        if (!line.trim()) continue;
        if (line.startsWith('CURSOR:')) {
          const parts = line.split(':');
          try { ws.send(JSON.stringify({ type: 'cursor', data: { x: Number(parts[1]), y: Number(parts[2]) } })); } catch {}
          continue;
        }
        if (line.startsWith('READY:')) {
          const parts = line.split(':');
          screenSize = { width: Number(parts[1]), height: Number(parts[2]) };
          if (readyResolve) { readyResolve(); readyResolve = null; }
          continue;
        }
        // JSON signaling (offer, ice) — forward to browser
        try { ws.send(line); } catch {}
      }
    });

    p.stderr.on('data', (d) => {
      const msg = d.toString().trim();
      if (msg) console.log('[stream]', msg);
    });

    p.on('close', (code) => {
      console.log('[stream] capture exited', code);
      clients.delete(ws);
    });

    clients.set(ws, p);
    console.log('[stream] Peer created');
  }

  // Forward browser signaling to capture stdin
  function forwardToCapture(ws, msg) {
    const p = clients.get(ws);
    if (p && p.stdin.writable) {
      p.stdin.write(JSON.stringify(msg) + '\n');
    }
  }

  function removePeer(ws) {
    const p = clients.get(ws);
    if (p) { p.kill(); clients.delete(ws); }
  }

  function stop() {
    for (const [, p] of clients) p.kill();
    clients.clear();
  }

  function getScreenSize() { return screenSize; }

  return { ready: readyPromise, createPeer, forwardToCapture, removePeer, setBitrate, setScale, stop, getScreenSize };
}

module.exports = { createStream };
