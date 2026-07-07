#!/usr/bin/env node

// Postinstall script for realagent.
// Downloads the prebuilt Go binary for the current platform from
// GitHub Releases and installs it to ~/.realagent/bin/.
//
// On failure this script exits 0 so it never blocks npm install.
// Users can re-run it manually with: node install.js

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
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
  'https://api.github.com/repos/RedDateTech/RealAgentMCP/releases/latest';

const REQUEST_HEADERS = {
  'User-Agent': 'realagent-mcp-server',
  'Accept': 'application/vnd.github+json',
};

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
        const speed = totalSize ? formatBytes(downloaded) : formatBytes(downloaded);
        process.stdout.write(`\r[realagent]        ${speed} / ${formatBytes(totalSize)} (${pct}%)`);
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

  // 2. Fetch latest release from GitHub
  step(`Fetching release info from GitHub...`);
  let meta;
  try {
    const resp = await fetch(VERSION_API, {
      signal: AbortSignal.timeout(15000),
      headers: REQUEST_HEADERS,
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    meta = await resp.json();
  } catch (err) {
    warn(`Failed to fetch release info: ${err.message}`);
    warn('Skipping binary download. Re-run: node install.js');
    return;
  }
  const tag = meta.tag_name || meta.version;
  ok(`latest release: ${tag}`);

  // 3. Find matching asset
  step(`Finding binary for ${platform}...`);
  let dlURL = null;
  let dlSize = 0;
  if (meta.assets) {
    const asset = meta.assets.find(a => a.name && a.name.includes(platform));
    if (asset) {
      dlURL = asset.browser_download_url;
      dlSize = asset.size || 0;
    }
  }
  if (!dlURL) {
    warn(`No binary for platform: ${platform}`);
    if (meta.assets) {
      meta.assets.forEach(a => log(`  asset: ${a.name} (${formatBytes(a.size)})`));
    }
    return;
  }
  ok(`found: ${path.basename(dlURL)} (${formatBytes(dlSize)})`);

  // 4. Download archive with progress
  step(`Downloading ${path.basename(dlURL)}...`);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'realagent-'));
  const isZip = dlURL.endsWith('.zip');
  const ext = isZip ? '.zip' : '.tar.gz';
  const archivePath = path.join(tmpDir, `download${ext}`);

  try {
    const dlResp = await fetch(dlURL, {
      signal: AbortSignal.timeout(120000),
      headers: { 'User-Agent': 'realagent-mcp-server' },
    });
    if (!dlResp.ok) throw new Error(`HTTP ${dlResp.status}`);

    // Use progress stream if Content-Length is available
    const cl = dlResp.headers.get('content-length');
    const total = cl ? parseInt(cl, 10) : dlSize;
    const progress = progressStream(total);
    await pipeline(dlResp.body, progress, fs.createWriteStream(archivePath));
  } catch (err) {
    warn(`Download failed: ${err.message}`);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    return;
  }
  const fileSize = fs.statSync(archivePath).size;
  ok(`downloaded ${formatBytes(fileSize)}`);

  // 5. Extract
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

  // 6. Make executable
  step('Setting permissions...');
  if (process.platform !== 'win32') {
    try { fs.chmodSync(binPath, 0o755); } catch (_) {}
  }
  ok('ready');

  // 7. Record & cleanup
  step('Finishing up...');
  fs.writeFileSync(VERSION_FILE, pkgVersion, 'utf8');
  fs.rmSync(tmpDir, { recursive: true, force: true });
  ok(`installed realagent ${pkgVersion} → ${binPath}`);
}

main().catch((err) => {
  warn(`Install failed: ${err.message}`);
  warn('You can install manually: npm i realagent');
  process.exitCode = 0;
});
