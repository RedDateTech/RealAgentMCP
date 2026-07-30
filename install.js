#!/usr/bin/env node

// Postinstall script for realagent-mcp.
// Downloads the prebuilt Go binary for the current platform from the
// distribution server and installs it to ~/.realagent/bin/.
//
// On failure this script exits 0 so it never blocks npm install.
// Users can re-run it manually with: node install.js

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const zlib = require('zlib');
const { Transform } = require('stream');
const { spawnSync } = require('child_process');
const { pipeline } = require('stream/promises');

// ── Configuration ──────────────────────────────────────────────

const BINARY_NAME = process.platform === 'win32'
  ? 'realagent-mcp.exe'
  : 'realagent-mcp';

const INSTALL_DIR = path.join(os.homedir(), '.realagent', 'bin');
const VERSION_FILE = path.join(os.homedir(), '.realagent', '.npm-version');
const VERSION_API = process.env.REALAGENT_API ||
  'https://realagentmcp.guoxinvc.cn/latest';

// ── Platform detection ─────────────────────────────────────────

const PLATFORM_MAP = {
  darwin: { x64: 'darwin-amd64', arm64: 'darwin-arm64' },
  linux:  { x64: 'linux-amd64',  arm64: 'linux-arm64' },
  win32:  { x64: 'windows-amd64' },
};

function platformKey() {
  const m = PLATFORM_MAP[process.platform];
  if (!m) throw new Error(`Unsupported OS: ${process.platform}`);
  const key = m[process.arch];
  if (!key) throw new Error(`Unsupported arch: ${process.platform}-${process.arch}`);
  return key;
}

// ── Helpers ────────────────────────────────────────────────────

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

let stepCounter = 0;
function step(msg) {
  stepCounter++;
  console.log(`[realagent-mcp] [${stepCounter}/6] ${msg}`);
}

function log(msg) {
  console.log(`[realagent-mcp]        ${msg}`);
}

function warn(msg) {
  console.warn(`[realagent-mcp] [WARN] ${msg}`);
}

function ok(msg) {
  console.log(`[realagent-mcp]   ✓ ${msg}`);
}

// ── SHA256 verification ────────────────────────────────────────

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (d) => hash.update(d));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

async function verifyChecksum(filePath, expected) {
  // Expected format: "sha256:abc123..."
  const parts = expected.split(':');
  if (parts.length !== 2 || parts[0] !== 'sha256' || !parts[1].trim()) {
    warn(`bad checksum: ${expected ? expected.substring(0, 32) : '(none)'}...`);
    return true; // skip verification, don't block
  }
  const expectedHash = parts[1].trim();
  log(`verifying SHA256...`);
  const actual = await sha256File(filePath);
  if (actual !== expectedHash) {
    warn(`checksum mismatch — archive may be corrupted`);
    warn(`  expected: ${expectedHash.substring(0, 16)}...`);
    warn(`  actual:   ${actual.substring(0, 16)}...`);
    return false;
  }
  ok(`checksum verified`);
  return true;
}

// ── Progress stream ────────────────────────────────────────────

function progressStream(totalSize) {
  let downloaded = 0;
  let lastLog = 0;

  return new Transform({
    transform(chunk, encoding, callback) {
      downloaded += chunk.length;
      const now = Date.now();
      if (now - lastLog > 500 || downloaded === totalSize) {
        const pct = totalSize ? Math.round((downloaded / totalSize) * 100) : '?';
        process.stdout.write(`\r[realagent-mcp]        ${formatBytes(downloaded)} / ${formatBytes(totalSize)} (${pct}%)`);
        lastLog = now;
      }
      this.push(chunk);
      callback();
    },
    flush(callback) {
      process.stdout.write('\n');
      callback();
    },
  });
}

// ── Extraction ─────────────────────────────────────────────────
// Two-layer strategy:
//   1. Prefer a real `tar` — correct and full-featured. On Windows we call
//      the native bsdtar by ABSOLUTE PATH (SystemRoot\System32\tar.exe,
//      shipped on Win10 1803+), because PATH may resolve `tar` to MSYS2's
//      /usr/bin/tar, which misparses "C:\..." drive paths as a remote host
//      spec ("Cannot connect to C: resolve failed") and extracts nothing —
//      so the stale binary keeps running.
//   2. Fall back to an in-process tar.gz parser when `tar` is unavailable
//      or fails, so installs never hard-depend on a system binary.

function resolveTarBinary() {
  if (process.platform === 'win32') {
    const bsdtar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
    return fs.existsSync(bsdtar) ? bsdtar : null;
  }
  return 'tar';
}

function parseTarOctal(buf, off, len) {
  const s = buf.subarray(off, off + len).toString('ascii').replace(/\0[\s\S]*$/, '').trim();
  return s ? parseInt(s, 8) : 0;
}

function readTarString(buf, off, len) {
  return buf.subarray(off, off + len).toString('utf8').replace(/\0[\s\S]*$/, '');
}

// Reads an entry's size field. Base-256 encoding (high bit set, for sizes
// >= 8 GiB) isn't supported — fail loudly instead of misparsing the body.
function parseTarSize(hdr) {
  if (hdr[124] & 0x80) throw new Error('unsupported base-256 size field (entry >= 8 GiB)');
  const size = parseTarOctal(hdr, 124, 12);
  if (!Number.isFinite(size) || size < 0) throw new Error('invalid tar entry size');
  return size;
}

// Parses PAX extended-header records ("len key=value\n") into a map.
function parsePax(buf) {
  const rec = {};
  const text = buf.toString('utf8');
  let i = 0;
  while (i < text.length) {
    const sp = text.indexOf(' ', i);
    if (sp < 0) break;
    const len = parseInt(text.substring(i, sp), 10);
    if (!Number.isInteger(len) || len <= 0 || i + len > text.length) break;
    const eq = text.indexOf('=', sp);
    if (eq > sp && eq < i + len) {
      rec[text.substring(sp + 1, eq)] = text.substring(eq + 1, i + len - 1);
    }
    i += len;
  }
  return rec;
}

function extractTarGz(archivePath, destDir) {
  const data = zlib.gunzipSync(fs.readFileSync(archivePath));
  const BLOCK = 512;
  let pos = 0;
  let pendingName = null;
  let globalPax = {}; // PAX type 'g' global attributes — persist across all subsequent entries

  const checksumOk = (hdr) => {
    // Stored checksum is octal at offset 148; compute with that field as spaces.
    const stored = parseTarOctal(hdr, 148, 8);
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += (i >= 148 && i < 156) ? 32 : hdr[i];
    return sum === stored;
  };

  while (pos + BLOCK <= data.length) {
    const hdr = data.subarray(pos, pos + BLOCK);
    pos += BLOCK;
    // A zero-filled block signals end of archive.
    if (hdr.every((b) => b === 0)) break;
    if (!checksumOk(hdr)) throw new Error('corrupt tar entry (bad header checksum)');

    const type = String.fromCharCode(hdr[156]);
    const size = parseTarSize(hdr);
    const body = data.subarray(pos, pos + size);
    // Guard against truncated archives — a short body would otherwise produce a
    // corrupt binary that looks like it installed successfully.
    if (body.length < size) throw new Error('truncated archive (entry shorter than its size)');
    pos += Math.ceil(size / BLOCK) * BLOCK;

    // Meta entries describe the following entry rather than holding file data.
    if (type === 'L') { pendingName = readTarString(body, 0, body.length); continue; } // GNU long name
    if (type === 'x') { // PAX extended header (per-entry — consumed by the next entry)
      const pax = parsePax(body);
      if (pax.path) pendingName = pax.path;
      continue;
    }
    if (type === 'g') { // PAX global extended header (persists across all subsequent entries)
      Object.assign(globalPax, parsePax(body));
      continue;
    }
    if (type === 'K') continue; // GNU long linkname

    let name = pendingName || globalPax.path || readTarString(hdr, 0, 100);
    pendingName = null;
    const prefix = readTarString(hdr, 345, 155); // ustar prefix
    if (prefix) name = `${prefix}/${name}`;
    if (!name) continue;

    const outPath = path.join(destDir, name);
    // Refuse path traversal outside the install dir.
    const rel = path.relative(destDir, outPath);
    if (rel === '..' || rel.startsWith(`..${path.sep}`)) {
      throw new Error(`refusing unsafe archive path: ${name}`);
    }

    if (type === '5' || name.endsWith('/')) {
      fs.mkdirSync(outPath, { recursive: true });
    } else if (type === '0' || type === '\0') {
      // Regular file ('\0' is the legacy regular-file typeflag).
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, body);
    }
    // else: links ('1'/'2'), devices ('3'/'4'), FIFO ('6'), reserved ('7') —
    // not expected in a single-binary archive; skip without a bogus write.
  }
}

// Locate the extracted binary inside a directory tree. Archives normally place
// it at the root, but tolerate a single wrapping directory.
function findExtractedBinary(dir, binaryName) {
  const root = path.join(dir, binaryName);
  if (fs.existsSync(root)) return root;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const nested = path.join(dir, entry.name, binaryName);
        if (fs.existsSync(nested)) return nested;
      }
    }
  } catch (_) {}
  return null;
}

// On Windows a running .exe is locked against overwrite (EBUSY) but can be
// RENAMED. Move a running binary aside so the new one can take its place.
// Returns the aside path, or null if nothing was moved (non-Windows / missing /
// rename failed). Uses .old, falling back to .old1, .old2, ... when a stale
// locked .old from a prior run is in the way, and best-effort deletes any stale
// aside copies that are no longer locked.
function stageBinaryAside(binPath) {
  if (process.platform !== 'win32') return null;
  const dir = path.dirname(binPath);
  const prefix = path.basename(binPath) + '.old';
  // Sweep stale aside copies from prior runs even when the binary is currently
  // missing — otherwise a leftover .old from a failed restore is never reaped.
  try {
    for (const f of fs.readdirSync(dir)) {
      if (f === prefix || (f.startsWith(prefix) && /^\d+$/.test(f.slice(prefix.length)))) {
        try { fs.rmSync(path.join(dir, f), { force: true }); } catch (_) {}
      }
    }
  } catch (_) {}
  if (!fs.existsSync(binPath)) return null;
  let aside = path.join(dir, prefix);
  for (let i = 1; fs.existsSync(aside); i++) aside = path.join(dir, prefix + i);
  try {
    fs.renameSync(binPath, aside);
    log(`moved running binary aside → ${path.basename(aside)}`);
    return aside;
  } catch (e) {
    log(`could not move running binary aside (${e.message}); install may fail if it's locked`);
    return null;
  }
}

// ── Main ───────────────────────────────────────────────────────

async function main() {
  const platform = platformKey();
  const binPath = path.join(INSTALL_DIR, BINARY_NAME);

  // 1. Fetch latest release info from distribution server
  step(`Fetching release info...`);
  const pkgVersion = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')
  ).version;
  log(`npm package: ${pkgVersion}`);
  log(`platform: ${platform}`);
  log(`install dir: ${INSTALL_DIR}`);

  let meta;
  try {
    const resp = await fetch(VERSION_API, { signal: AbortSignal.timeout(15000) });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    meta = await resp.json();
  } catch (err) {
    warn(`Failed to fetch release info: ${err.message}`);
    warn('Skipping binary download. Re-run: node install.js');
    return;
  }
  // Normalize: dist-server version always has "v" prefix (e.g. "v1.2.4").
  const distVer = (meta.version && !meta.version.startsWith('v'))
    ? 'v' + meta.version
    : meta.version;
  if (!distVer) {
    warn('Latest release info missing version field');
    warn('Skipping binary download. Re-run: node install.js');
    return;
  }
  ok(`latest release: ${distVer}`);

  // Compare against dist-server version (source of truth), not npm version.
  // npm and dist-server may diverge during release.
  if (fs.existsSync(binPath) && fs.existsSync(VERSION_FILE)) {
    const installed = fs.readFileSync(VERSION_FILE, 'utf8').trim();
    // Handle legacy cache entries that lacked the "v" prefix.
    const normalized = installed.startsWith('v') ? installed : 'v' + installed;
    if (normalized === distVer) {
      ok(`binary ${distVer} already installed`);
      return;
    }
    log(`version mismatch (installed=${normalized}, dist=${distVer}), re-downloading...`);
  }

  // 2. Resolve download URL and checksum for this platform
  step(`Finding binary for ${platform}...`);
  const dlURL = meta.downloads ? meta.downloads[platform] : null;
  const checksum = meta.checksums ? meta.checksums[platform] : null;

  if (!dlURL) {
    warn(`No binary for platform: ${platform}`);
    if (meta.downloads) {
      Object.entries(meta.downloads).forEach(([p, u]) => log(`  ${p}: ${path.basename(u)}`));
    }
    return;
  }
  ok(`found: ${path.basename(dlURL)}`);

  // 3. Download archive with progress
  step(`Downloading ${path.basename(dlURL)}...`);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'realagent-'));
  // All platforms ship .tar.gz (Windows is tar-only; macOS/Linux use tar.gz too).
  const archivePath = path.join(tmpDir, 'download.tar.gz');

  try {
    const dlResp = await fetch(dlURL, { signal: AbortSignal.timeout(120000) });
    if (!dlResp.ok) throw new Error(`HTTP ${dlResp.status}`);
    if (!dlResp.body) throw new Error('response body is empty');

    const cl = dlResp.headers.get('content-length');
    const total = cl ? parseInt(cl, 10) : 0;
    const progress = progressStream(total);
    await pipeline(dlResp.body, progress, fs.createWriteStream(archivePath));
  } catch (err) {
    warn(`Download failed: ${err.message}`);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    return;
  }
  const fileSize = fs.statSync(archivePath).size;
  ok(`downloaded ${formatBytes(fileSize)}`);

  // 4. Verify checksum (optional, non-blocking)
  if (checksum) {
    if (!(await verifyChecksum(archivePath, checksum))) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      return;
    }
  }

  // 5. Extract into a temp dir, then atomically move the binary into place.
  step('Extracting binary...');
  fs.mkdirSync(INSTALL_DIR, { recursive: true });

  // Reap .extract-* dirs left by a previous interrupted install. Unlike tmpDir
  // (under os.tmpdir), these live in ~/.realagent/bin and nothing else cleans
  // them — repeated Ctrl-C / OOM mid-extract would otherwise accumulate them.
  try {
    for (const f of fs.readdirSync(INSTALL_DIR)) {
      if (f.startsWith('.extract-')) {
        try { fs.rmSync(path.join(INSTALL_DIR, f), { recursive: true, force: true }); } catch (_) {}
      }
    }
  } catch (_) {}

  // Extract into a temp dir ON THE SAME FILESYSTEM as INSTALL_DIR (a subdir) so
  // the final placement can be an atomic rename. Extracting to a temp location
  // avoids two hazards when the binary is currently running:
  //   - Windows: a running .exe is locked and can't be overwritten (EBUSY).
  //   - Unix:    overwriting a running binary IN PLACE corrupts the running
  //              process (it has the file mmap'd); a rename-replace lets it keep
  //              its old inode.
  let extractDir;
  try {
    extractDir = fs.mkdtempSync(path.join(INSTALL_DIR, '.extract-'));
  } catch (err) {
    warn(`Failed to create extract dir: ${err.message}`);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    return;
  }
  const abortExtract = () => {
    fs.rmSync(extractDir, { recursive: true, force: true });
    fs.rmSync(tmpDir, { recursive: true, force: true });
  };
  let srcBinary = null;
  try {
    // Prefer a real `tar` (correct + full-featured). On Windows the absolute
    // bsdtar path dodges the MSYS2 /usr/bin/tar drive-path bug; fall back to
    // in-process extraction only if tar is missing or errors out.
    const tarBin = resolveTarBinary();
    let extracted = false;
    if (tarBin) {
      // spawnSync with an arg array bypasses the shell entirely, so paths
      // containing spaces, '$', backticks, or '%VAR%' can't be misinterpreted.
      const r = spawnSync(tarBin, ['-xzf', archivePath, '-C', extractDir], {
        stdio: 'pipe', windowsHide: true,
      });
      if (r.error || r.status !== 0) {
        const msg = r.error ? r.error.message : `exit status ${r.status}`;
        log(`system tar failed (${String(msg).split('\n')[0]}); falling back to in-process extraction`);
      } else {
        extracted = true;
      }
    }
    if (!extracted) extractTarGz(archivePath, extractDir);
    srcBinary = findExtractedBinary(extractDir, BINARY_NAME);
  } catch (err) {
    warn(`Extract failed: ${err.message}`);
    abortExtract();
    return;
  }
  if (!srcBinary) {
    warn(`Binary (${BINARY_NAME}) not found after extraction`);
    abortExtract();
    return;
  }

  // Place the binary at binPath. On Windows, move a running .exe aside first
  // (rename is allowed on a locked running exe); on Unix (asidePath is null)
  // the rename atomically replaces it while the running process keeps the old
  // inode. Restore the staged copy if the move fails so the user isn't left
  // without a binary.
  const asidePath = stageBinaryAside(binPath);
  try {
    fs.renameSync(srcBinary, binPath);
  } catch (err) {
    if (asidePath && fs.existsSync(asidePath)) { try { fs.renameSync(asidePath, binPath); } catch (_) {} }
    warn(`Failed to place binary: ${err.message}`);
    abortExtract();
    return;
  }
  // Reap the aside now — if the old binary isn't running this deletes it
  // immediately; if it's still locked the rmSync fails silently and the next
  // install's sweep reaps it. Avoids leaving a stale .old on a routine update.
  if (asidePath) { try { fs.rmSync(asidePath, { force: true }); } catch (_) {} }
  fs.rmSync(extractDir, { recursive: true, force: true });
  ok(`extracted ${formatBytes(fs.statSync(binPath).size)}`);

  // 6. Make executable + record + cleanup
  step('Finishing up...');
  if (process.platform !== 'win32') {
    try { fs.chmodSync(binPath, 0o755); } catch (_) {}
  }
  fs.writeFileSync(VERSION_FILE, distVer, 'utf8');
  fs.rmSync(tmpDir, { recursive: true, force: true });
  ok(`installed realagent-mcp ${distVer} → ${binPath}`);
}

main().catch((err) => {
  warn(`Install failed: ${err.message}`);
  warn('You can install manually: npm i -g realagent-mcp');
  process.exitCode = 0;
});
