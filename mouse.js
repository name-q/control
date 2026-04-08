const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const platform = os.platform();
let proc = null;
let screenSize = { width: 1920, height: 1080 };
let readyResolve = null;
const readyPromise = new Promise(r => { readyResolve = r; });

// ========== macOS: JXA + CoreGraphics ==========
const JXA_HELPER = `
ObjC.import("CoreGraphics");
ObjC.import("Cocoa");
function getPos() {
  var e = $.CGEventCreate(null);
  var p = $.CGEventGetLocation(e);
  return { x: p.x, y: p.y };
}
function post(type, x, y, btn) {
  var p = $.CGPointMake(x, y);
  var e = $.CGEventCreateMouseEvent(null, type, p, btn);
  $.CGEventPost(0, e);
}
var screenW = $.CGDisplayPixelsWide($.CGMainDisplayID());
var screenH = $.CGDisplayPixelsHigh($.CGMainDisplayID());
$.NSFileHandle.fileHandleWithStandardOutput.writeData(
  $.NSString.alloc.initWithString("READY:" + screenW + ":" + screenH + "\\n").dataUsingEncoding($.NSUTF8StringEncoding)
);
var stdin = $.NSFileHandle.fileHandleWithStandardInput;
var buf = "";
while (true) {
  var data = stdin.availableData;
  if (data.length === 0) break;
  buf += $.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding).js;
  var lines = buf.split("\\n");
  buf = lines.pop();
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim();
    if (!line) continue;
    try {
      var cmd = JSON.parse(line);
      var pos, nx, ny;
      switch (cmd.t) {
        case "mv":
          pos = getPos();
          nx = Math.max(0, Math.min(screenW, pos.x + cmd.dx));
          ny = Math.max(0, Math.min(screenH, pos.y + cmd.dy));
          post($.kCGEventMouseMoved, nx, ny, 0);
          break;
        case "mt":
          post($.kCGEventMouseMoved, Math.max(0, Math.min(screenW, cmd.x)), Math.max(0, Math.min(screenH, cmd.y)), 0);
          break;
        case "cl":
          pos = getPos();
          post($.kCGEventLeftMouseDown, pos.x, pos.y, $.kCGMouseButtonLeft);
          post($.kCGEventLeftMouseUp, pos.x, pos.y, $.kCGMouseButtonLeft);
          break;
        case "rc":
          pos = getPos();
          post($.kCGEventRightMouseDown, pos.x, pos.y, $.kCGMouseButtonRight);
          post($.kCGEventRightMouseUp, pos.x, pos.y, $.kCGMouseButtonRight);
          break;
        case "md":
          pos = getPos();
          post($.kCGEventLeftMouseDown, pos.x, pos.y, $.kCGMouseButtonLeft);
          break;
        case "mu":
          pos = getPos();
          post($.kCGEventLeftMouseUp, pos.x, pos.y, $.kCGMouseButtonLeft);
          break;
        case "sc":
          var ev = $.CGEventCreateScrollWheelEvent(null, 0, 2, Math.round(-cmd.dy), Math.round(-cmd.dx));
          $.CGEventPost(0, ev);
          break;
      }
    } catch(ex) {}
  }
}
`;

const WIN_HELPER = [
'Add-Type @"',
'using System;',
'using System.Runtime.InteropServices;',
'public class Mouse {',
'    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);',
'    [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);',
'    [DllImport("user32.dll")] public static extern void mouse_event(uint f, int dx, int dy, int d, IntPtr e);',
'    [DllImport("user32.dll")] public static extern int GetSystemMetrics(int i);',
'    public struct POINT { public int X, Y; }',
'    public const uint LDOWN=0x02, LUP=0x04, RDOWN=0x08, RUP=0x10, WHEEL=0x800, HWHEEL=0x1000;',
'}',
'"@',
'$sw = [Mouse]::GetSystemMetrics(0)',
'$sh = [Mouse]::GetSystemMetrics(1)',
'Write-Host "READY:${sw}:${sh}"',
'while ($true) {',
'    $line = [Console]::ReadLine()',
'    if ($line -eq $null) { break }',
'    try {',
'        $cmd = $line | ConvertFrom-Json',
'        $p = New-Object Mouse+POINT',
'        [Mouse]::GetCursorPos([ref]$p) | Out-Null',
'        switch ($cmd.t) {',
'            "mv" {',
'                $nx = [Math]::Max(0, [Math]::Min($sw, $p.X + [int]$cmd.dx))',
'                $ny = [Math]::Max(0, [Math]::Min($sh, $p.Y + [int]$cmd.dy))',
'                [Mouse]::SetCursorPos($nx, $ny) | Out-Null',
'            }',
'            "mt" { [Mouse]::SetCursorPos([int]$cmd.x, [int]$cmd.y) | Out-Null }',
'            "cl" { [Mouse]::mouse_event([Mouse]::LDOWN,0,0,0,[IntPtr]::Zero); [Mouse]::mouse_event([Mouse]::LUP,0,0,0,[IntPtr]::Zero) }',
'            "rc" { [Mouse]::mouse_event([Mouse]::RDOWN,0,0,0,[IntPtr]::Zero); [Mouse]::mouse_event([Mouse]::RUP,0,0,0,[IntPtr]::Zero) }',
'            "md" { [Mouse]::mouse_event([Mouse]::LDOWN,0,0,0,[IntPtr]::Zero) }',
'            "mu" { [Mouse]::mouse_event([Mouse]::LUP,0,0,0,[IntPtr]::Zero) }',
'            "sc" { [Mouse]::mouse_event([Mouse]::WHEEL,0,0,[int](-$cmd.dy*120),[IntPtr]::Zero) }',
'        }',
'    } catch {}',
'}',
].join('\n');

function init() {
  if (platform === 'darwin') {
    const helperPath = path.join(os.tmpdir(), 'remote-mouse-helper.js');
    fs.writeFileSync(helperPath, JXA_HELPER);
    proc = spawn('osascript', ['-l', 'JavaScript', helperPath], { stdio: ['pipe', 'pipe', 'pipe'] });
  } else if (platform === 'win32') {
    const helperPath = path.join(os.tmpdir(), 'remote-mouse-helper.ps1');
    fs.writeFileSync(helperPath, WIN_HELPER);
    proc = spawn('powershell', ['-ExecutionPolicy', 'Bypass', '-File', helperPath], { stdio: ['pipe', 'pipe', 'pipe'] });
  } else {
    console.error('[mouse] Unsupported platform:', platform);
    readyResolve();
    return;
  }

  proc.stdout.on('data', (chunk) => {
    const lines = chunk.toString().split('\n');
    for (const line of lines) {
      if (line.startsWith('READY:')) {
        const parts = line.split(':');
        screenSize = { width: Number(parts[1]), height: Number(parts[2]) };
        if (readyResolve) { readyResolve(); readyResolve = null; }
      }
    }
  });

  proc.stderr.on('data', (d) => {
    const msg = d.toString().trim();
    if (msg) console.error('[mouse]', msg);
  });

  proc.on('close', (code) => {
    console.error('[mouse] process exited with code', code);
    proc = null;
  });
}

init();

function send(obj) {
  if (proc && proc.stdin.writable) proc.stdin.write(JSON.stringify(obj) + '\n');
}

function getScreenSize() { return screenSize; }
function moveTo(x, y) { send({ t: 'mt', x, y }); }
function moveBy(dx, dy) { send({ t: 'mv', dx, dy }); }
function click() { send({ t: 'cl' }); }
function rightClick() { send({ t: 'rc' }); }
function mouseDown() { send({ t: 'md' }); }
function mouseUp() { send({ t: 'mu' }); }
function scroll(dx, dy) { send({ t: 'sc', dx, dy }); }

function typeText(text) {
  if (platform === 'darwin') {
    const escaped = text.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    execSync(`osascript -e 'set the clipboard to "${escaped}"' -e 'tell application "System Events" to keystroke "v" using command down'`);
  } else if (platform === 'win32') {
    const escaped = text.replace(/'/g, "''");
    execSync(`powershell -Command "Set-Clipboard '${escaped}'; Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^v')"`);
  }
}

function comboKey(keyCode, modifiers) {
  if (platform === 'darwin') {
    // modifiers: array of strings like ['command', 'shift', 'option', 'control']
    // keyCode: macOS virtual key code (integer)
    const modStr = modifiers.length
      ? ' using {' + modifiers.map(m => m + ' down').join(', ') + '}'
      : '';
    execSync(`osascript -e 'tell application "System Events" to key code ${keyCode}${modStr}'`);
  } else if (platform === 'win32') {
    // modifiers: array of Windows VK codes (integers)
    // keyCode: Windows VK code (integer)
    const lines = [
      'Add-Type @"',
      'using System; using System.Runtime.InteropServices;',
      'public class KB {',
      '  [DllImport("user32.dll")] public static extern void keybd_event(byte k, byte s, uint f, UIntPtr e);',
      '  public const uint DOWN=0, UP=2;',
      '}',
      '"@',
    ];
    for (const vk of modifiers) lines.push(`[KB]::keybd_event(${vk}, 0, [KB]::DOWN, [UIntPtr]::Zero)`);
    lines.push(`[KB]::keybd_event(${keyCode}, 0, [KB]::DOWN, [UIntPtr]::Zero)`);
    lines.push(`[KB]::keybd_event(${keyCode}, 0, [KB]::UP, [UIntPtr]::Zero)`);
    for (const vk of [...modifiers].reverse()) lines.push(`[KB]::keybd_event(${vk}, 0, [KB]::UP, [UIntPtr]::Zero)`);
    const script = lines.join('\n').replace(/"/g, '\\"');
    execSync(`powershell -Command "${script}"`);
  }
}

function destroy() { if (proc) { proc.kill(); proc = null; } }

module.exports = { ready: readyPromise, getScreenSize, moveTo, moveBy, click, rightClick, mouseDown, mouseUp, scroll, typeText, comboKey, destroy };
