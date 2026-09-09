#!/usr/bin/env node
// Infrequent publisher: pick the best record from the local archive within the
// eligible window and publish the DATABASE dataset only (SNAPSHOT skipped).
//
// The selected record is built into a payload exactly once and then fanned out
// to every configured target: Qortium DATABASE/Network/Network always, and
// Qortal DATABASE/xnetwork/Network when explicitly opted in. Both chains receive
// the *same* immutable payload, and each keeps an independent receipt, so a
// failure on one never rebuilds or reshapes what the other gets.
//
// Spacing is enforced from the last *selected* record's timestamp, so records
// never land closer than MIN_GAP_HOURS even across day boundaries. Run this on
// a cadence (e.g. 2x/day); it self-skips until a new eligible record exists.
//
// Environment overrides use the QORTIUM_NETWORK_ prefix:
//   QORTIUM_NETWORK_ARCHIVE_DIR      snapshot archive (default target/preview-topology)
//   QORTIUM_NETWORK_QDN_DATA_PATH    payload build dir (default target/qdn-topology-data)
//   QORTIUM_NETWORK_AUTO_STATE_PATH  state file (default target/auto-publish-state.json)
//   QORTIUM_NETWORK_MIN_GAP_HOURS    minimum hours between published records (default 8)
//   QORTIUM_NETWORK_MAX_ATTEMPTS     failed-run threshold for an alert (default 5)
//   QORTIUM_NETWORK_PYTHON           python interpreter (default python3)
//   QORTIUM_NETWORK_QORTAL_PUBLISH   set to 1/true to also publish to Qortal
// See docs/dual-qdn-publishing.md for the Qortal-side settings. Publishing also
// reads the standard publish env (NODE_API_URL, NODE_API_KEY*,
// PREVIEW_ACCOUNTS_PATH, ...) handled by qdn-publish-lib.
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { databaseResource, parseCliFlags } from './qdn-publish-lib.mjs';
import {
  DEFAULT_MAX_ATTEMPTS,
  describeTarget,
  isPendingComplete,
  publishToTargets,
  resolveTargets,
  summarizePending,
} from './dual-publish.mjs';
import { acquireLock, hashPayloadDirectory, readState, writeState } from './dual-publish-state.mjs';
import { createQortiumAdapter } from './qortium-adapter.mjs';
import { createQortalAdapter } from './qortal-adapter.mjs';

const ENV_PREFIX = 'QORTIUM_NETWORK';
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readEnv = (name) => process.env[`${ENV_PREFIX}_${name}`];

const archiveDir = path.resolve(repoRoot, readEnv('ARCHIVE_DIR') ?? 'target/preview-topology');
const dataDir = path.resolve(repoRoot, readEnv('QDN_DATA_PATH') ?? 'target/qdn-topology-data');
const statePath = path.resolve(repoRoot, readEnv('AUTO_STATE_PATH') ?? 'target/auto-publish-state.json');
const minGapHours = Number(readEnv('MIN_GAP_HOURS') ?? 8);
const maxAttempts = Number(readEnv('MAX_ATTEMPTS') ?? DEFAULT_MAX_ATTEMPTS);

const pythonBin = readEnv('PYTHON') ?? 'python3';
if (!Number.isFinite(minGapHours) || minGapHours <= 0 || !Number.isSafeInteger(maxAttempts) || maxAttempts < 1) throw new Error('Invalid publish gap or alert threshold.');

const flags = parseCliFlags(process.argv.slice(2));

if (flags.help) {
  console.log('Usage: node scripts/auto-publish.mjs [--dry-run]');
  process.exit(0);
}

function parseTs(value) {
  const ms = Date.parse(value ?? '');

  return Number.isNaN(ms) ? null : ms;
}

function normalizeVersion(version) {
  if (!version) {
    return null;
  }

  const trimmed = version.startsWith('qortium-') ? version.slice('qortium-'.length) : version;

  return trimmed.split('-')[0] || null;
}

function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);

  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const diff = (pa[i] || 0) - (pb[i] || 0);

    if (diff !== 0) {
      return diff;
    }
  }

  return 0;
}

function scoreRecord(snap) {
  const nodes = Object.values(snap.nodes ?? {});
  const errorCount = Object.keys(snap.errors ?? {}).length;
  const heights = new Set();

  // Consensus means the seed operators agree on height — a sanity check that the
  // snapshot was taken at a coherent moment. Discovered peers are deliberately
  // excluded: on a live network some peer is almost always mid-sync at a different
  // height, which would otherwise make every record fail the consensus gate.
  for (const node of nodes) {
    if (node?.role !== 'seed') {
      continue;
    }

    const height = node?.status?.height;

    if (typeof height === 'number') {
      heights.add(height);
    }
  }

  const topology = snap.topology ?? {};
  const peers = Object.keys(topology.graphNodes ?? {}).length;
  const edges = (topology.edges ?? []).length;

  // Distinct observed peers and their reported version (first non-null wins).
  const peerVersion = new Map();

  for (const node of nodes) {
    for (const layer of ['chainPeers', 'dataPeers']) {
      for (const peer of node?.[layer] ?? []) {
        const id = peer.nodeId || peer.address;

        if (!id) {
          continue;
        }

        const version = normalizeVersion(peer.version);

        if (version && !peerVersion.get(id)) {
          peerVersion.set(id, version);
        } else if (!peerVersion.has(id)) {
          peerVersion.set(id, null);
        }
      }
    }
  }

  let latest = null;

  for (const version of peerVersion.values()) {
    if (version && (!latest || compareVersions(version, latest) > 0)) {
      latest = version;
    }
  }

  const total = peerVersion.size;
  let onLatest = 0;

  for (const version of peerVersion.values()) {
    if (version && latest && version === latest) {
      onLatest += 1;
    }
  }

  return {
    consensus: heights.size <= 1,
    edges,
    errorCount,
    generatedAt: snap.generatedAt,
    peers,
    tsMs: parseTs(snap.generatedAt),
    versionPct: total ? onLatest / total : 0,
  };
}

function loadRecords() {
  let files = [];

  try {
    files = readdirSync(archiveDir);
  } catch {
    return [];
  }

  const records = [];

  for (const file of files) {
    if (!/^preview-topology-\d{8}T\d{6}Z\.json$/.test(file)) {
      continue;
    }

    const filePath = path.join(archiveDir, file);

    try {
      const snap = JSON.parse(readFileSync(filePath, 'utf8'));

      if (!snap?.topology?.graphNodes) {
        continue;
      }

      const score = scoreRecord(snap);

      if (score.tsMs == null) {
        continue;
      }

      records.push({ ...score, file: filePath });
    } catch {
      // Skip unreadable/partial files.
    }
  }

  return records;
}

function selectRecord(state) {
  const lastTsMs = parseTs(state.lastRecordGeneratedAt);
  const gapMs = minGapHours * 3_600_000;
  const records = loadRecords();

  if (records.length === 0) {
    console.log(`No archived records found in ${archiveDir}; nothing to publish.`);

    return null;
  }

  const eligible = records.filter((record) => (lastTsMs == null ? true : record.tsMs >= lastTsMs + gapMs));
  const healthy = eligible.filter((record) => record.errorCount === 0 && record.consensus);

  if (healthy.length === 0) {
    console.log(
      `No healthy eligible record (${eligible.length} eligible, ${records.length} archived, ` +
        `gap ${minGapHours}h since ${state.lastRecordGeneratedAt ?? 'never'}); skipping.`,
    );

    return null;
  }

  // Best = most peers, then edges, then version adoption, then most recent.
  healthy.sort((a, b) => b.peers - a.peers || b.edges - a.edges || b.versionPct - a.versionPct || b.tsMs - a.tsMs);

  const best = healthy[0];

  console.log(
    `Selected ${best.generatedAt} (peers ${best.peers}, edges ${best.edges}, ` +
      `${Math.round(best.versionPct * 100)}% latest) from ${healthy.length} healthy / ${eligible.length} eligible.`,
  );

  return best;
}

// Adapters are constructed lazily so a misconfigured Qortal target surfaces as
// that target's own failure instead of aborting the Qortium publish.
function createAdapters(targets) {
  const adapters = {};

  for (const target of targets) {
    const create = target.chain === 'qortal' ? createQortalAdapter : createQortiumAdapter;
    let adapter;

    Object.defineProperty(adapters, target.key, {
      enumerable: true,
      get: () => (adapter ??= create()),
    });
  }

  return adapters;
}

const targets = resolveTargets();

// --dry-run touches nothing: no lock file, no payload build, no state write.
if (flags.dryRun) {
  const state = readState(statePath);

  for (const target of targets) {
    console.log(`Target: ${describeTarget(target)}`);
  }

  if (state.pending) {
    console.log(
      `[dry-run] pending record ${state.pending.recordGeneratedAt} ` +
        `(attempt ${state.pending.attempts}/${maxAttempts}): ${summarizePending(state.pending, targets)}`,
    );
  } else {
    const best = selectRecord(state);

    console.log(
      best
        ? `[dry-run] would build payload from ${best.file} and publish DATABASE to ${targets.length} target(s).`
        : '[dry-run] nothing to publish.',
    );
  }

  process.exit(0);
}

async function run() {
  const state = readState(statePath);
  const persist = () => writeState(statePath, state);

  if (!state.pending) {
    const best = selectRecord(state);

    if (!best) {
      const age = state.lastPublishAt ? Date.now() - Date.parse(state.lastPublishAt) : 0;
      const stale = age > 26 * 3600000;
      state.lastStatus = { at: new Date().toISOString(), outcome: stale ? 'stale-no-healthy-record' : 'waiting-for-eligible-record' };
      persist();
      if (stale) console.error('ALERT: published topology is older than 26 hours and no healthy record is eligible.');
      return stale ? 1 : 0;
    }

    // Accumulate this record into the DATABASE payload + index (SNAPSHOT
    // untouched). This is the only place the payload is built: every retry
    // republishes these exact bytes.
    execFileSync(pythonBin, ['tools/network-topology-data.py', '--from-snapshot', best.file, '--qdn-data-dir', dataDir], {
      cwd: repoRoot,
      stdio: 'inherit',
    });

    const source = databaseResource().sourcePath;
    const queueRoot = path.join(path.dirname(statePath), 'pending-payloads');
    mkdirSync(queueRoot, { recursive: true });
    const directory = mkdtempSync(path.join(queueRoot, 'record-'));
    cpSync(source, directory, { recursive: true });

    state.pending = {
      attempts: 0,
      createdAt: new Date().toISOString(),
      payloadDigest: hashPayloadDirectory(directory),
      payloadDir: directory,
      recordEdges: best.edges,
      recordFile: best.file,
      recordGeneratedAt: best.generatedAt,
      recordPeers: best.peers,
      targets: {},
    };
    persist();
  } else {
    console.log(
      `Resuming pending record ${state.pending.recordGeneratedAt}: ${summarizePending(state.pending, targets)}`,
    );
  }

  const pending = state.pending;

  pending.attempts += 1;
  persist();

  const payload = { digest: hashPayloadDirectory(pending.payloadDir), directory: pending.payloadDir };
  const failures = await publishToTargets({
    adapters: createAdapters(targets),
    payload,
    pending,
    persist,
    targets,
  });

  if (isPendingComplete(pending, targets)) {
    state.lastEdges = pending.recordEdges;
    state.lastPeers = pending.recordPeers;
    state.lastPublishAt = new Date().toISOString();
    state.lastRecordFile = pending.recordFile;
    state.lastRecordGeneratedAt = pending.recordGeneratedAt;
    const previousPayload = state.lastReceipt?.payloadDir;
    state.lastReceipt = pending;
    state.lastStatus = { at: new Date().toISOString(), outcome: 'published' };
    writeState(path.join(path.dirname(statePath), 'publish-receipts', pending.recordGeneratedAt.replace(/[^0-9]/g, '') + '.json'), pending);
    delete state.pending;
    delete state.lastFailure;
    persist();

    const queueRoot = path.resolve(path.dirname(statePath), 'pending-payloads') + path.sep;
    if (typeof previousPayload === 'string' && path.resolve(previousPayload).startsWith(queueRoot) && previousPayload !== pending.payloadDir) rmSync(previousPayload, {recursive:true, force:true});
    console.log(`Published DATABASE record ${pending.recordGeneratedAt} to ${targets.length} target(s).`);

    return 0;
  }

  if (pending.attempts >= maxAttempts) {
    console.error(`ALERT: record ${pending.recordGeneratedAt} remains incomplete after ${pending.attempts} runs. Keeping its payload and signatures for reconciliation.`);
  }

  console.error(
    `Record ${pending.recordGeneratedAt} is incomplete after attempt ${pending.attempts}/${maxAttempts}: ` +
      `${summarizePending(pending, targets)}. Will retry on the next run.`,
  );

  return 1;
}

const release = acquireLock(`${statePath}.lock`);
let exitCode = 1;

try {
  exitCode = await run();
} finally {
  release();
}

process.exit(exitCode);
