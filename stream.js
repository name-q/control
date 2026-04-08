const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');

const DEFAULTS = { fps: 30, scale: 1, quality: 0.8 };

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
  console.error('[stream] Unsupported platform:', platform);
  return null;
}

function createStream(opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const wsClients = new Set();
  let proc = null;
  let buf = Buffer.alloc(0);
  let screenSize = null;
  let readyResolve = null;
  const readyPromise = new Promise(r => { readyResolve = r; });

  function start() {
    if (proc) return;
    const bin = getCaptureCommand();
    if (!bin) return;

    proc = spawn(bin, [String(cfg.fps), String(cfg.scale), String(cfg.quality)], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    proc.stdout.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      parseFrames();
    });
    proc.stderr.on('data', (d) => {
      const msg = d.toString().trim();
      if (msg) console.log('[stream]', msg);
    });

    proc.on('close', (code) => {
      console.log('[stream] capture exited with code', code);
      proc = null;
    });

    console.log(`[stream] capture started (${os.platform()}), fps=${cfg.fps} scale=${cfg.scale}`);
  }

  let frameCount = 0;
  let latestFrame = null;
  let latestCursor = null; // {x, y} in screen coords
  let sendTimer = null;

  function parseFrames() {
    while (true) {
      const nl = buf.indexOf(0x0a);
      if (nl === -1) break;

      const line = buf.subarray(0, nl).toString('utf8');

      if (line.startsWith('CURSOR:')) {
        const parts = line.split(':');
        latestCursor = { x: Number(parts[1]), y: Number(parts[2]) };
        buf = buf.subarray(nl + 1);
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

      if (line.startsWith('FRAME:')) {
        // Protocol: FRAME:<len>:<ts>:<type>\n<data>
        const parts = line.substring(6).split(':');
        const len = parseInt(parts[0], 10);
        const frameType = parts[2] ? parseInt(parts[2], 10) : 1;
        const dataStart = nl + 1;
        if (buf.length < dataStart + len) break;

        if (frameType === 3) {
          // Skip frame — no data, don't overwrite latest
          buf = buf.subarray(dataStart + len);
          continue;
        }

        const payload = Buffer.from(buf.subarray(dataStart, dataStart + len));
        buf = buf.subarray(dataStart + len);
        frameCount++;

        // Prepend 1-byte type header: [type][payload]
        const msg = Buffer.allocUnsafe(1 + payload.length);
        msg[0] = frameType;
        payload.copy(msg, 1);

        // Keyframes are never dropped — critical for sync
        if (frameType === 1) {
          latestFrame = msg;
        } else {
          latestFrame = msg;
        }
        continue;
      }

      buf = buf.subarray(nl + 1);
    }
    if (buf.length > 5 * 1024 * 1024) buf = Buffer.alloc(0);
  }

  function startSendLoop() {
    if (sendTimer) return;
    const interval = Math.round(1000 / cfg.fps);
    sendTimer = setInterval(() => {
      for (const ws of wsClients) {
        try {
          if (ws.readyState !== 1) { wsClients.delete(ws); continue; }
          // Always send cursor (tiny JSON, never drop)
          if (latestCursor) {
            ws.send(JSON.stringify({ type: 'cursor', data: latestCursor }));
          }
          if (latestFrame) {
            const isKeyframe = latestFrame[0] === 1;
            // Keyframes are never dropped — critical for visual consistency
            // Delta frames: drop if socket has more than 1 frame queued
            if (isKeyframe || ws.bufferedAmount < 300 * 1024) {
              ws.send(latestFrame, { binary: true });
            }
          }
        } catch { wsClients.delete(ws); }
      }
      if (latestFrame) latestFrame = null;
    }, interval);
  }

  function stopSendLoop() {
    if (sendTimer) { clearInterval(sendTimer); sendTimer = null; }
  }

  function requestKeyframe() {
    if (proc && proc.stdin.writable) {
      proc.stdin.write('KEYFRAME\n');
    }
  }

  function addWsClient(ws) {
    wsClients.add(ws);
    ws.on('close', () => { wsClients.delete(ws); autoStop(); });
    if (!proc) start();
    requestKeyframe(); // new client needs a full frame to start
    startSendLoop();
  }

  function removeWsClient(ws) {
    wsClients.delete(ws);
    autoStop();
  }

  function autoStop() {
    if (wsClients.size === 0 && proc) {
      console.log('[stream] no clients, stopping capture');
      stop();
    }
  }

  function stop() {
    stopSendLoop();
    if (proc) { proc.kill(); proc = null; }
    wsClients.clear();
    buf = Buffer.alloc(0);
    latestFrame = null;
  }

  function setQuality(newScale, newQuality) {
    cfg.scale = newScale;
    cfg.quality = newQuality;
    if (proc && proc.stdin.writable) {
      proc.stdin.write(`QUALITY:${newScale}:${newQuality}\n`);
    }
    console.log(`[stream] quality changed: scale=${newScale} quality=${newQuality}`);
  }

  function getScreenSize() { return screenSize; }
  function clientCount() { return wsClients.size; }

  return { ready: readyPromise, addWsClient, removeWsClient, setQuality, start, stop, getScreenSize, clientCount };
}

module.exports = { createStream };
