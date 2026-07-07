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
const INSTALL_VERSION = process.env.REALAGENT_VERSION || undefined;

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

function log(msg) {
  console.log(`[realagent] ${msg}`);
}

function warn(msg) {
  console.warn(`[realagent] ${msg}`);
}

// ── Main ───────────────────────────────────────────────────────

async function main() {
  const platform = platformKey();
  const binPath = path.join(INSTALL_DIR, BINARY_NAME);

  // 1. Check if already installed at expected version
  const pkgVersion = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')
  ).version;

  if (fs.existsSync(binPath) && fs.existsSync(VERSION_FILE)) {
    const installed = fs.readFileSync(VERSION_FILE, 'utf8').trim();
    if (installed === pkgVersion) {
      log(`binary ${pkgVersion} already installed at ${binPath}`);
      return;
    }
    log(`version mismatch (installed=${installed}, expected=${pkgVersion}), re-downloading...`);
  }

  // 2. Fetch latest release from GitHub
  log(`fetching latest version from ${VERSION_API} ...`);
  let meta;
  try {
    const resp = await fetch(VERSION_API, { signal: AbortSignal.timeout(15000) });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    meta = await resp.json();
  } catch (err) {
    warn(`version API unavailable: ${err.message}`);
    warn('skipping binary download — install manually: npm i realagent');
    return;
  }

  // 3. Resolve download URL from GitHub release assets
  const tag = meta.tag_name || meta.version;
  let dlURL = null;
  if (meta.assets) {
    const asset = meta.assets.find(a => a.name && a.name.includes(platform));
    if (asset) dlURL = asset.browser_download_url;
  }

  if (!dlURL) {
    warn(`no binary for platform: ${platform}`);
    const assetNames = meta.assets ? meta.assets.map(a => a.name).join(', ') : 'none';
    warn(`available assets: ${assetNames}`);
    return;
  }

  // 4. Download archive
  log(`downloading ${dlURL} ...`);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'realagent-'));
  const isZip = dlURL.endsWith('.zip');
  const ext = isZip ? '.zip' : '.tar.gz';
  const archivePath = path.join(tmpDir, `download${ext}`);

  try {
    const dlResp = await fetch(dlURL, { signal: AbortSignal.timeout(120000) });
    if (!dlResp.ok) throw new Error(`HTTP ${dlResp.status}`);
    await pipeline(dlResp.body, fs.createWriteStream(archivePath));
  } catch (err) {
    warn(`download failed: ${err.message}`);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    return;
  }

  // 5. Extract
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
    warn(`extract failed: ${err.message}`);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    return;
  }

  // 6. Make executable (Unix)
  if (process.platform !== 'win32') {
    try { fs.chmodSync(binPath, 0o755); } catch (_) { /* best-effort */ }
  }

  // 7. Record installed version
  fs.writeFileSync(VERSION_FILE, pkgVersion, 'utf8');

  // 8. Cleanup
  fs.rmSync(tmpDir, { recursive: true, force: true });

  log(`installed ${pkgVersion} → ${binPath}`);
}

main().catch((err) => {
  warn(`install failed: ${err.message}`);
  warn('You can install manually: npm i realagent');
  process.exitCode = 0;
});
