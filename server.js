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

function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    if (name.startsWith('utun') || name.startsWith('tun') || name.startsWith('tap') || name.startsWith('vir')) continue;
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return '127.0.0.1';
}

// Detect VPN/proxy TUN hijacking and fix LAN routing
function ensureLanRoute(localIP) {
  if (os.platform() !== 'darwin' && os.platform() !== 'linux') return;
  try {
    const { execSync } = require('child_process');

    // Find the real interface's subnet info
    const interfaces = os.networkInterfaces();
    let realNetmask = null, realCidr = null;
    for (const name of Object.keys(interfaces)) {
      if (name.startsWith('utun') || name.startsWith('tun') || name.startsWith('tap') || name.startsWith('vir')) continue;
      for (const iface of interfaces[name]) {
        if (iface.address === localIP) {
          realNetmask = iface.netmask;
          realCidr = iface.cidr;
          break;
        }
      }
      if (realNetmask) break;
    }
    if (!realNetmask) return;

    // Calculate network address and prefix length from CIDR
    // e.g., "10.22.11.140/24" → network "10.22.11.0", prefix 24
    const parts = localIP.split('.').map(Number);
    const maskParts = realNetmask.split('.').map(Number);
    const networkParts = parts.map((p, i) => p & maskParts[i]);
    const network = networkParts.join('.');
    const prefixLen = maskParts.reduce((acc, m) => acc + (m >>> 0).toString(2).split('1').length - 1, 0);

    // For /24 or smaller subnets, also check the broader network
    // e.g., if we're on 10.22.11.0/24, phone might be on 10.22.12.0/24
    // We need to find the right scope to route
    const testTargets = [];
    if (prefixLen >= 24) {
      // Test a neighboring subnet — change the 3rd octet
      const neighbor = [...networkParts];
      neighbor[2] = (neighbor[2] + 1) % 256;
      testTargets.push({ ip: neighbor.join('.'), subnet: networkParts.slice(0, 2).join('.') + '.0.0/16' });
    }
    // Always test the exact subnet
    testTargets.push({ ip: network, subnet: `${network}/${prefixLen}` });

    const gateway = execSync(`netstat -rn | grep "^default.*en0" | awk '{print $2}'`, { encoding: 'utf8' }).trim();
    if (!gateway) return;

    for (const target of testTargets) {
      try {
        const routeCheck = execSync(`route -n get ${target.ip} 2>/dev/null`, { encoding: 'utf8' });
        if (routeCheck.includes('utun') || routeCheck.includes('tun')) {
          console.log(`[network] VPN/proxy TUN detected — ${target.subnet} routed through VPN`);
          try {
            execSync(`sudo -n route add -net ${target.subnet} ${gateway} 2>/dev/null`);
            console.log(`[network] Route added: ${target.subnet} via ${gateway}`);
          } catch {
            try {
              execSync(`osascript -e 'do shell script "route add -net ${target.subnet} ${gateway}" with administrator privileges'`);
              console.log(`[network] Route added: ${target.subnet} via ${gateway}`);
            } catch {
              console.log(`[network] Please run: sudo route add -net ${target.subnet} ${gateway}`);
            }
          }
        }
      } catch {}
    }
  } catch {}
}

const localIP = getLocalIP();
ensureLanRoute(localIP);
const stream = createStream({ bindAddress: localIP });

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

function handleInput(msg) {
  switch (msg.type) {
    case 'move':      mouse.moveBy(msg.data.dx, msg.data.dy); break;
    case 'moveTo':    mouse.moveTo(msg.data.x, msg.data.y); break;
    case 'click':     mouse.click(); break;
    case 'rightClick': mouse.rightClick(); break;
    case 'mouseDown': mouse.mouseDown(); break;
    case 'mouseUp':   mouse.mouseUp(); break;
    case 'scroll':    mouse.scroll(msg.data.dx || 0, msg.data.dy || 0); break;
    case 'typeText':  mouse.typeText(msg.data.text || ''); break;
    case 'combo':     mouse.comboKey(msg.data.keyCode, msg.data.modifiers || []); break;
  }
}

wss.on('connection', (ws) => {
  console.log('Client connected');
  ws.send(JSON.stringify({ type: 'screen', data: { ...mouse.getScreenSize(), platform: os.platform() } }));

  // DataChannel input handler (capture → stdout → stream.js → here)
  ws._onDcMessage = (data) => {
    try { handleInput(typeof data === 'string' ? JSON.parse(data) : data); } catch {}
  };

  ws.on('message', async (raw) => {
    try {
      const msg = JSON.parse(raw);
      switch (msg.type) {
        // WebRTC signaling — forward to capture process
        case 'startStream':
          stream.createPeer(ws);
          break;
        case 'answer':
        case 'ice':
          stream.forwardToCapture(ws, msg);
          break;

        // Quality control — single command with both bitrate and scale
        case 'setQuality':
          stream.forwardToCapture(ws, { type: 'quality', kbps: msg.data.kbps, scale: msg.data.scale });
          break;

        case 'stats':
          break;
        }

        case 'ping':
          ws.send(JSON.stringify({ type: 'pong' }));
          break;

        // Input commands
        default:
          handleInput(msg);
          break;
      }
    } catch (e) {
      console.error('Error:', e.message);
    }
  });

  ws.on('close', () => {
    stream.removePeer(ws);
    console.log('Client disconnected');
  });
});


mouse.ready.then(() => {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`\nRemote Mouse Control Server`);
    console.log(`Local:   http://localhost:${PORT}`);
    console.log(`Network: http://${localIP}:${PORT}`);
    console.log(`WebRTC bind: ${localIP}`);
    console.log(`\nOpen the Network URL on your phone to start controlling.\n`);
  });
});

process.on('SIGINT', () => { stream.stop(); mouse.destroy(); process.exit(); });
