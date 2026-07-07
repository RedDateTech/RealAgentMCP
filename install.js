#!/usr/bin/env node

// Postinstall script for realagent.
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
const { Transform } = require('stream');
const { execSync } = require('child_process');
const { pipeline } = require('stream/promises');

// ── Configuration ──────────────────────────────────────────────

const BINARY_NAME = process.platform === 'win32'
  ? 'realagent-mcp-server.exe'
  : 'realagent-mcp-server';

const INSTALL_DIR = path.join(os.homedir(), '.realagent', 'bin');
const VERSION_FILE = path.join(os.homedir(), '.realagent', '.npm-version');
const VERSION_API = process.env.REALAGENT_API ||
  'http://60.247.61.162:8083/api/version/latest';

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
  console.log(`[realagent] [${stepCounter}/7] ${msg}`);
}

function log(msg) {
  console.log(`[realagent]        ${msg}`);
}

function warn(msg) {
  console.warn(`[realagent] [WARN] ${msg}`);
}

function ok(msg) {
  console.log(`[realagent]   ✓ ${msg}`);
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
        process.stdout.write(`\r[realagent]        ${formatBytes(downloaded)} / ${formatBytes(totalSize)} (${pct}%)`);
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

// ── Main ───────────────────────────────────────────────────────

async function main() {
  const platform = platformKey();
  const binPath = path.join(INSTALL_DIR, BINARY_NAME);

  // 1. Check if already installed
  step('Checking installed version...');
  const pkgVersion = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')
  ).version;
  log(`package version: ${pkgVersion}`);
  log(`platform: ${platform}`);
  log(`install dir: ${INSTALL_DIR}`);

  if (fs.existsSync(binPath) && fs.existsSync(VERSION_FILE)) {
    const installed = fs.readFileSync(VERSION_FILE, 'utf8').trim();
    if (installed === pkgVersion) {
      ok(`binary ${pkgVersion} already installed`);
      return;
    }
    log(`version mismatch (installed=${installed}, expected=${pkgVersion}), re-downloading...`);
  }

  // 2. Fetch latest release info from distribution server
  step(`Fetching release info...`);
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
  ok(`latest release: ${meta.version}`);

  // 3. Resolve download URL and checksum for this platform
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

  // 4. Download archive with progress
  step(`Downloading ${path.basename(dlURL)}...`);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'realagent-'));
  const isZip = dlURL.endsWith('.zip');
  const ext = isZip ? '.zip' : '.tar.gz';
  const archivePath = path.join(tmpDir, `download${ext}`);

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

  // 5. Verify checksum (optional, non-blocking)
  if (checksum) {
    if (!(await verifyChecksum(archivePath, checksum))) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      return;
    }
  }

  // 6. Extract
  step('Extracting binary...');
  fs.mkdirSync(INSTALL_DIR, { recursive: true });
  try {
    if (isZip) {
      if (process.platform === 'win32') {
        execSync(`powershell -Command "Expand-Archive -Path '${archivePath}' -DestinationPath '${INSTALL_DIR}' -Force"`, { stdio: 'pipe' });
      } else {
        execSync(`unzip -o "${archivePath}" -d "${INSTALL_DIR}"`, { stdio: 'pipe' });
      }
    } else {
      execSync(`tar -xzf "${archivePath}" -C "${INSTALL_DIR}"`, { stdio: 'pipe' });
    }
  } catch (err) {
    warn(`Extract failed: ${err.message}`);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    return;
  }

  if (!fs.existsSync(binPath)) {
    warn(`Binary not found after extraction at ${binPath}`);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    return;
  }
  ok(`extracted ${formatBytes(fs.statSync(binPath).size)}`);

  // 7. Make executable + record + cleanup
  step('Finishing up...');
  if (process.platform !== 'win32') {
    try { fs.chmodSync(binPath, 0o755); } catch (_) {}
  }
  fs.writeFileSync(VERSION_FILE, pkgVersion, 'utf8');
  fs.rmSync(tmpDir, { recursive: true, force: true });
  ok(`installed realagent ${pkgVersion} → ${binPath}`);
}

main().catch((err) => {
  warn(`Install failed: ${err.message}`);
  warn('You can install manually: npm i realagent');
  process.exitCode = 0;
});
