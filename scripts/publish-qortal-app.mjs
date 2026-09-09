#!/usr/bin/env node
import { cpSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCliFlags } from './qdn-publish-lib.mjs';
import { acquireLock, hashPayloadDirectory, readState, writeState } from './dual-publish-state.mjs';
import { publishToTargets } from './dual-publish.mjs';
import { createQortalAdapter } from './qortal-adapter.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = path.resolve(root, process.env.QORTIUM_NETWORK_QORTAL_APP_PATH || 'dist-qortal');
const statePath = path.resolve(root, process.env.QORTIUM_NETWORK_QORTAL_APP_STATE_PATH || 'target/qortal-app-state.json');
const flags = parseCliFlags(process.argv.slice(2));
if (flags.help) { console.log('Usage: node scripts/publish-qortal-app.mjs [--dry-run]'); process.exit(0); }
const manifest = JSON.parse(readFileSync(path.join(directory, 'qortium-app.json'), 'utf8'));
if (manifest.network !== 'qortal' || manifest.name !== 'xnetwork') throw new Error('Build the Qortal artifact with npm run build:qortal first.');
const digest = hashPayloadDirectory(directory);
const target = { key: 'qortal', chain: 'qortal', service: 'APP', name: 'xnetwork', identifier: 'default', title: 'Network', description: 'View Qortium network topology and history.' };
if (flags.dryRun) {
  console.log(`[dry-run] APP/xnetwork/default version ${manifest.version}, ${digest}; no signing or upload.`);
  process.exit(0);
}
const release = acquireLock(`${statePath}.lock`);
try {
  const state = readState(statePath);
  if (!state.pending && state.lastReceipt?.payloadDigest === digest) {
    console.log('This artifact already has a confirmed publication receipt.');
  } else {
    if (!state.pending) {
      const staging = path.join(path.dirname(statePath), 'app-payloads');
      mkdirSync(staging, { recursive: true });
      const frozen = mkdtempSync(path.join(staging, 'qortal-'));
      cpSync(directory, frozen, { recursive: true });
      state.pending = { payloadDigest: hashPayloadDirectory(frozen), payloadDir: frozen, recordGeneratedAt: new Date().toISOString(), attempts: 0, targets: {} };
      writeState(statePath, state);
    }
    if (state.pending.payloadDigest !== digest) throw new Error('A different artifact is pending; reconcile its saved signature before publishing this build.');
    const pending = state.pending;
    const failures = await publishToTargets({ adapters: { qortal: createQortalAdapter() }, pending,
      payload: { directory: pending.payloadDir, digest: hashPayloadDirectory(pending.payloadDir) }, targets: [target], persist: () => writeState(statePath, state) });
    if (failures.length) process.exitCode = 1;
    else { state.lastReceipt = pending; delete state.pending; writeState(statePath, state); console.log('APP/xnetwork/default confirmed and all files verified.'); }
  }
} finally { release(); }
