#!/usr/bin/env node
// Frequent, cheap collector: capture one topology snapshot into the local
// archive and prune old files. No QDN publishing happens here.
//
// Environment overrides use the QORTIUM_NETWORK_ prefix:
//   QORTIUM_NETWORK_ARCHIVE_DIR      where snapshots are stored (default target/preview-topology)
//   QORTIUM_NETWORK_RETENTION_DAYS   prune archive files older than this (default 14)
//   QORTIUM_NETWORK_LOCAL_NODE       node key queried over localhost, e.g. netcup
//   QORTIUM_NETWORK_COLLECT_TIMEOUT  per-endpoint curl timeout seconds (default 8)
//   QORTIUM_NETWORK_PYTHON           python interpreter (default python3)
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ENV_PREFIX = 'QORTIUM_NETWORK';
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readEnv = (name) => process.env[`${ENV_PREFIX}_${name}`];

const archiveDir = path.resolve(repoRoot, readEnv('ARCHIVE_DIR') ?? 'target/preview-topology');
const retentionDays = Number(readEnv('RETENTION_DAYS') ?? 14);
const pythonBin = readEnv('PYTHON') ?? 'python3';
const localNode = readEnv('LOCAL_NODE');
const timeout = readEnv('COLLECT_TIMEOUT') ?? '8';

const args = [
  'tools/network-topology-data.py',
  '--no-qdn-data',
  '--no-png',
  '--timestamp',
  '--max-extra-peers',
  '-1',
  '--output-dir',
  archiveDir,
  '--timeout',
  String(timeout),
];

if (localNode) {
  args.push('--local-node', localNode);
}

// The tool exits 2 when a node fails to respond; keep the snapshot (the
// publisher gates those out) instead of treating it as a fatal error.
try {
  execFileSync(pythonBin, args, { cwd: repoRoot, stdio: 'inherit' });
} catch (error) {
  if (typeof error.status === 'number' && error.status !== 2) {
    throw error;
  }
}

if (retentionDays > 0 && existsSync(archiveDir)) {
  const cutoff = Date.now() - retentionDays * 86_400_000;
  let pruned = 0;

  for (const file of readdirSync(archiveDir)) {
    if (!/^preview-topology-.*\.(json|svg|png)$/.test(file)) {
      continue;
    }

    const filePath = path.join(archiveDir, file);

    try {
      if (statSync(filePath).mtimeMs < cutoff) {
        unlinkSync(filePath);
        pruned += 1;
      }
    } catch {
      // File may vanish between readdir and stat; ignore.
    }
  }

  if (pruned > 0) {
    console.log(`Pruned ${pruned} archive file(s) older than ${retentionDays} days.`);
  }
}
