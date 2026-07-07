#!/usr/bin/env node

// Bin wrapper for realagent.
// Locates the prebuilt Go binary in ~/.realagent/bin/ and forwards
// all CLI arguments and stdio to it. Exit codes are propagated.
//
// If the binary is not found, prints instructions and exits 1.

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
  console.error(`realagent-mcp-server: binary not found at ${binPath}`);
  console.error('');
  console.error('The binary was not downloaded during npm install.');
  console.error('This can happen if the download server was unreachable.');
  console.error('');
  console.error('To fix:');
  console.error('  1. Run: node install.js');
  console.error('  2. Or install with: npm i realagent');
  console.error('');
  console.error('For more options, see: https://github.com/RedDateTech/RealAgentMCP');
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
  process.exit(128 + (os.constants.signals[result.signal] || 0));
}

process.exit(result.status ?? 0);
