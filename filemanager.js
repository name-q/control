const fs = require('fs');
const path = require('path');
const os = require('os');

// Root directory — defaults to home, can be overridden
let rootDir = process.cwd();

// Binary file extensions
const BINARY_EXTS = new Set([
  '.png','.jpg','.jpeg','.gif','.bmp','.ico','.webp','.svg',
  '.mp4','.mov','.avi','.mkv','.webm','.mp3','.wav','.flac','.aac',
  '.zip','.tar','.gz','.bz2','.7z','.rar','.dmg','.iso',
  '.exe','.dll','.so','.dylib','.o','.a','.class','.pyc',
  '.pdf','.doc','.docx','.xls','.xlsx','.ppt','.pptx',
  '.ttf','.otf','.woff','.woff2','.eot',
  '.sqlite','.db','.bin','.dat',
]);

// Directories to hide by default
const HIDDEN_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', '__pycache__',
  '.DS_Store', 'Thumbs.db', '.Trash', '.cache',
  '.next', '.nuxt', 'dist', 'build', '.output',
]);

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const DEFAULT_PAGE_LINES = 200;
const MAX_DIR_ENTRIES = 500;

function setRoot(dir) { rootDir = dir; }

// Security: resolve path and ensure it's within root
function safePath(p) {
  const resolved = path.resolve(rootDir, p);
  if (!resolved.startsWith(rootDir)) return null;
  return resolved;
}

function isBinary(ext) {
  return BINARY_EXTS.has((ext || '').toLowerCase());
}

// ========== fs.list ==========
function listDir(reqPath, showHidden) {
  const fullPath = safePath(reqPath);
  if (!fullPath) return { error: 'Access denied' };

  try {
    const entries = fs.readdirSync(fullPath, { withFileTypes: true });
    const result = [];

    for (const entry of entries) {
      if (!showHidden && (entry.name.startsWith('.') || HIDDEN_DIRS.has(entry.name))) continue;
      if (result.length >= MAX_DIR_ENTRIES) break;

      const entryPath = path.join(fullPath, entry.name);
      const ext = path.extname(entry.name);

      if (entry.isDirectory()) {
        result.push({ name: entry.name, type: 'dir' });
      } else if (entry.isFile()) {
        try {
          const stat = fs.statSync(entryPath);
          result.push({
            name: entry.name,
            type: 'file',
            size: stat.size,
            ext,
            binary: isBinary(ext),
            modified: stat.mtime.toISOString(),
          });
        } catch { /* skip unreadable files */ }
      }
    }

    // Sort: dirs first, then files, alphabetical
    result.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    return { path: reqPath, entries: result };
  } catch (e) {
    return { error: e.message };
  }
}

// ========== fs.read (paginated) ==========
function readFile(reqPath, offset = 0, limit = DEFAULT_PAGE_LINES) {
  const fullPath = safePath(reqPath);
  if (!fullPath) return { error: 'Access denied' };

  try {
    const stat = fs.statSync(fullPath);
    if (stat.size > MAX_FILE_SIZE) return { error: 'File too large', size: stat.size };
    if (isBinary(path.extname(fullPath))) return { error: 'Binary file', binary: true };

    const content = fs.readFileSync(fullPath, 'utf-8');
    const lines = content.split('\n');
    const totalLines = lines.length;
    const pageLines = lines.slice(offset, offset + limit);

    return {
      path: reqPath,
      content: pageLines.join('\n'),
      offset,
      limit,
      totalLines,
      modified: stat.mtime.toISOString(),
    };
  } catch (e) {
    return { error: e.message };
  }
}

// ========== fs.edit (line-level diff) ==========
function editFile(reqPath, edits, baseModified) {
  const fullPath = safePath(reqPath);
  if (!fullPath) return { error: 'Access denied' };

  try {
    const stat = fs.statSync(fullPath);

    // Conflict detection: check if file was modified since client read it
    if (baseModified && stat.mtime.toISOString() !== baseModified) {
      return { error: 'Conflict: file modified externally', serverModified: stat.mtime.toISOString() };
    }

    const content = fs.readFileSync(fullPath, 'utf-8');
    let lines = content.split('\n');

    // Apply edits in reverse order (so line numbers stay valid)
    const sorted = [...edits].sort((a, b) => b.line - a.line);
    for (const edit of sorted) {
      const idx = edit.line - 1; // 1-based to 0-based
      if (idx < 0 || idx > lines.length) continue;

      switch (edit.action) {
        case 'replace':
          if (idx < lines.length) lines[idx] = edit.content;
          break;
        case 'insert':
          lines.splice(idx, 0, edit.content);
          break;
        case 'delete':
          if (idx < lines.length) lines.splice(idx, 1);
          break;
      }
    }

    fs.writeFileSync(fullPath, lines.join('\n'), 'utf-8');
    const newStat = fs.statSync(fullPath);

    return {
      path: reqPath,
      success: true,
      totalLines: lines.length,
      modified: newStat.mtime.toISOString(),
    };
  } catch (e) {
    return { error: e.message };
  }
}

// ========== fs.info ==========
function fileInfo(reqPath) {
  const fullPath = safePath(reqPath);
  if (!fullPath) return { error: 'Access denied' };

  try {
    const stat = fs.statSync(fullPath);
    const ext = path.extname(fullPath);
    return {
      path: reqPath,
      size: stat.size,
      ext,
      binary: isBinary(ext),
      modified: stat.mtime.toISOString(),
      isDir: stat.isDirectory(),
    };
  } catch (e) {
    return { error: e.message };
  }
}

// ========== Handle WebSocket message ==========
function handleMessage(msg) {
  switch (msg.type) {
    case 'fs.list':
      return { type: 'fs.list', data: listDir(msg.path || '.', msg.showHidden) };
    case 'fs.read':
      return { type: 'fs.read', data: readFile(msg.path, msg.offset || 0, msg.limit || DEFAULT_PAGE_LINES) };
    case 'fs.edit':
      return { type: 'fs.edit', data: editFile(msg.path, msg.edits || [], msg.baseModified) };
    case 'fs.info':
      return { type: 'fs.info', data: fileInfo(msg.path) };
    case 'fs.setRoot':
      if (msg.path) { setRoot(path.resolve(msg.path)); return { type: 'fs.setRoot', data: { root: rootDir } }; }
      return { type: 'fs.setRoot', data: { root: rootDir } };
    default:
      return null;
  }
}

module.exports = { handleMessage, setRoot };
