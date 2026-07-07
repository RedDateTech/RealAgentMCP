#!/usr/bin/env node

// Bin wrapper for realagent.
// Locates the prebuilt Go binary in ~/.realagent/bin/ and forwards
// all CLI arguments and stdio to it. If the binary is not found,
// automatically downloads it from the distribution server.
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

if (!fs.existsSync(binPath)) {
  console.error('[realagent] Binary not found, downloading...');
  // Auto-download: run install.js (bundled in the npm package).
  // install.js is designed to be safe — exits 0 on failure,
  // so if it still fails below we fall through to the error.
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
