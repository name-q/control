const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const { WebSocketServer } = require('ws');

// ========== Auto-build capture binary on startup ==========
function ensureCaptureBuild() {
  const platform = os.platform();
  const base = path.join(__dirname, 'capture');

  if (platform === 'darwin') {
    const bin = path.join(base, 'macos', 'ScreenCapture.app', 'Contents', 'MacOS', 'capture');
    if (!fs.existsSync(bin)) {
      console.log('[build] Compiling macOS capture...');
      try {
        execSync('bash build.sh', { cwd: path.join(base, 'macos'), stdio: 'inherit' });
        console.log('[build] Done.');
      } catch (e) {
        console.error('[build] Failed:', e.message);
        process.exit(1);
      }
    }
  } else if (platform === 'win32') {
    const bin = path.join(base, 'windows', 'capture.exe');
    if (!fs.existsSync(bin)) {
      console.log('[build] Compiling Windows capture...');
      try {
        execSync('build.bat', { cwd: path.join(base, 'windows'), stdio: 'inherit', shell: true });
        console.log('[build] Done.');
      } catch (e) {
        console.error('[build] Failed:', e.message);
        process.exit(1);
      }
    }
  }
}

ensureCaptureBuild();

const mouse = require('./mouse');
const { createStream } = require('./stream');

const PORT = process.env.PORT || 9000;

const MIME = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
};

const stream = createStream();

const server = http.createServer((req, res) => {
  let filePath = path.join(__dirname, 'public', req.url === '/' ? 'index.html' : req.url);
  const ext = path.extname(filePath);
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  console.log('Client connected');
  ws.send(JSON.stringify({ type: 'screen', data: { ...mouse.getScreenSize(), platform: os.platform() } }));

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      switch (msg.type) {
        case 'move':    mouse.moveBy(msg.data.dx, msg.data.dy); break;
        case 'moveTo':  mouse.moveTo(msg.data.x, msg.data.y); break;
        case 'click':   mouse.click(); break;
        case 'rightClick': mouse.rightClick(); break;
        case 'mouseDown':  mouse.mouseDown(); break;
        case 'mouseUp':    mouse.mouseUp(); break;
        case 'scroll':     mouse.scroll(msg.data.dx || 0, msg.data.dy || 0); break;
        case 'typeText':   mouse.typeText(msg.data.text || ''); break;
        case 'combo':      mouse.comboKey(msg.data.keyCode, msg.data.modifiers || []); break;
        case 'startStream': stream.addWsClient(ws); break;
        case 'stopStream':  stream.removeWsClient(ws); break;
        case 'setQuality':  stream.setQuality(msg.data.scale, msg.data.quality); break;
        case 'ping':        ws.send(JSON.stringify({ type: 'pong' })); break;
      }
    } catch (e) {
      console.error('Error:', e.message);
    }
  });

  ws.on('close', () => console.log('Client disconnected'));
});

function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return '127.0.0.1';
}

mouse.ready.then(() => {
  server.listen(PORT, '0.0.0.0', () => {
    const ip = getLocalIP();
    console.log(`\nRemote Mouse Control Server`);
    console.log(`Local:   http://localhost:${PORT}`);
    console.log(`Network: http://${ip}:${PORT}`);
    console.log(`\nOpen the Network URL on your phone to start controlling.\n`);
  });
});

process.on('SIGINT', () => { stream.stop(); mouse.destroy(); process.exit(); });
