#!/usr/bin/env node

// Bin wrapper for realagent.
// Locates the prebuilt Go binary in ~/.realagent/bin/ and forwards
// all CLI arguments and stdio to it. If the binary is not found or is
// older than the latest on the distribution server, automatically
// downloads it.
//
// Exit codes are propagated from the Go binary.

'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const BINARY_NAME = process.platform === 'win32'
  ? 'realagent-mcp-server.exe'
  : 'realagent-mcp-server';

const INSTALL_DIR = path.join(os.homedir(), '.realagent', 'bin');
const binPath = path.join(INSTALL_DIR, BINARY_NAME);

const VERSION_API = process.env.REALAGENT_API ||
  'https://realagentmcp.guoxinvc.cn/latest';

// ── Helpers ──────────────────────────────────────────────────────

function binaryVersion() {
  try {
    const v = spawnSync(binPath, ['version'], {
      stdio: 'pipe',
      encoding: 'utf8',
      timeout: 10000,
      windowsHide: true,
    });
    if (v.error || v.status !== 0) return null;
    // Output format: "realagent-mcp-server v1.2.4\n  go\t..."
    const got = v.stdout.toString().trim().split(/\s+/)[1]; // "v1.2.4"
    return got || null;
  } catch (_) {
    return null;
  }
}

function distServerVersion() {
  try {
    const resp = spawnSync(process.execPath, [
      '-e',
      `fetch("${VERSION_API}",{signal:AbortSignal.timeout(5000)}).then(r=>r.ok?r.json():Promise.reject(r.status)).then(d=>console.log(d.version)).catch(()=>process.exit(1))`,
    ], {
      stdio: 'pipe',
      encoding: 'utf8',
      timeout: 10000,
      windowsHide: true,
    });
    if (resp.error || resp.status !== 0) return null;
    const raw = resp.stdout.toString().trim();
    if (!raw) return null;
    // Normalize: always include "v" prefix (e.g. "v1.2.4").
    return raw.startsWith('v') ? raw : 'v' + raw;
  } catch (_) {
    return null;
  }
}

// Simple semver comparison: returns true if a < b.
function versionLess(a, b) {
  const parse = (s) => {
    s = s.replace(/^v/, '');
    const parts = s.split('.').map(Number);
    if (parts.length !== 3 || parts.some(isNaN)) return null;
    return parts;
  };
  const pa = parse(a), pb = parse(b);
  if (!pa || !pb) return false;
  for (let i = 0; i < 3; i++) {
    if (pa[i] < pb[i]) return true;
    if (pa[i] > pb[i]) return false;
  }
  return false;
}

function needsDownload() {
  if (!fs.existsSync(binPath)) return true;

  const binVer = binaryVersion();
  if (!binVer) return true;

  // Source of truth: dist-server. Compare binary version against what
  // the dist-server has available. This avoids the problem where the
  // npm package version was bumped but binaries haven't been uploaded
  // yet (or vice versa).
  const distVer = distServerVersion();
  if (distVer) {
    if (versionLess(binVer, distVer)) {
      console.error('[realagent] Binary %s < dist-server %s, downloading...', binVer, distVer);
      return true;
    }
    // Binary is up to date with dist-server — nothing to do.
    return false;
  }

  // Dist-server unreachable: fall back to npm package.json version.
  // This is a best-effort check — if npm and dist-server are out of
  // sync this may trigger unnecessarily, but install.js will download
  // the right binary from dist-server when it becomes reachable.
  try {
    const pkgVer = 'v' + JSON.parse(
      fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')
    ).version;
    if (versionLess(binVer, pkgVer)) {
      console.error('[realagent] Binary %s < npm %s (dist-server unreachable), downloading...', binVer, pkgVer);
      return true;
    }
  } catch (_) { /* proceed */ }

  return false;
}

// ── Main ─────────────────────────────────────────────────────────

if (needsDownload()) {
  console.error('[realagent] Downloading binary...');
  const installScript = path.join(__dirname, 'install.js');
  try {
    spawnSync(process.execPath, [installScript], { stdio: 'inherit', windowsHide: true });
  } catch (_) { /* fall through */ }
}

if (!fs.existsSync(binPath)) {
  console.error('');
  console.error('realagent-mcp-server: binary download failed.');
  console.error('Try running manually: node install.js');
  console.error('See: https://github.com/RedDateTech/RealAgentMCP');
  process.exit(1);
}

const args = process.argv.slice(2);
const result = spawnSync(binPath, args, {
  stdio: 'inherit',
  windowsHide: true,
});

if (result.error) {
  console.error(`realagent-mcp-server: failed to spawn: ${result.error.message}`);
  process.exit(1);
}

if (result.signal) {
  const sigCode = os.constants.signals[result.signal];
  process.exit(128 + (typeof sigCode === 'number' ? sigCode : 0));
}

process.exit(result.status ?? 0);
