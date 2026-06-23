#!/usr/bin/env node
// Infrequent publisher: pick the best record from the local archive within the
// eligible window and publish DATABASE/Network/Network only (SNAPSHOT skipped).
//
// Spacing is enforced from the last *selected* record's timestamp, so records
// never land closer than MIN_GAP_HOURS even across day boundaries. Run this on
// a cadence (e.g. 2x/day); it self-skips until a new eligible record exists.
//
// Environment overrides use the QORTIUM_NETWORK_ prefix:
//   QORTIUM_NETWORK_ARCHIVE_DIR     snapshot archive (default target/preview-topology)
//   QORTIUM_NETWORK_QDN_DATA_PATH   payload build dir (default target/qdn-topology-data)
//   QORTIUM_NETWORK_AUTO_STATE_PATH state file (default target/auto-publish-state.json)
//   QORTIUM_NETWORK_MIN_GAP_HOURS   minimum hours between published records (default 8)
//   QORTIUM_NETWORK_PYTHON          python interpreter (default python3)
// Publishing also reads the standard publish env (NODE_API_URL, NODE_API_KEY*,
// PREVIEW_ACCOUNTS_PATH, ...) handled by qdn-publish-lib.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { databaseResource, parseCliFlags, publishResources } from './qdn-publish-lib.mjs';

const ENV_PREFIX = 'QORTIUM_NETWORK';
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readEnv = (name) => process.env[`${ENV_PREFIX}_${name}`];

const archiveDir = path.resolve(repoRoot, readEnv('ARCHIVE_DIR') ?? 'target/preview-topology');
const dataDir = path.resolve(repoRoot, readEnv('QDN_DATA_PATH') ?? 'target/qdn-topology-data');
const statePath = path.resolve(repoRoot, readEnv('AUTO_STATE_PATH') ?? 'target/auto-publish-state.json');
const minGapHours = Number(readEnv('MIN_GAP_HOURS') ?? 8);
const pythonBin = readEnv('PYTHON') ?? 'python3';

const flags = parseCliFlags(process.argv.slice(2));

if (flags.help) {
  console.log('Usage: node scripts/auto-publish.mjs [--dry-run]');
  process.exit(0);
}

function loadState() {
  try {
    return JSON.parse(readFileSync(statePath, 'utf8'));
  } catch {
    return {};
  }
}

function saveState(state) {
  mkdirSync(path.dirname(statePath), { recursive: true });
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
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

  for (const node of nodes) {
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

const state = loadState();
const lastTsMs = parseTs(state.lastRecordGeneratedAt);
const gapMs = minGapHours * 3_600_000;
const records = loadRecords();

if (records.length === 0) {
  console.log(`No archived records found in ${archiveDir}; nothing to publish.`);
  process.exit(0);
}

const eligible = records.filter((record) => (lastTsMs == null ? true : record.tsMs >= lastTsMs + gapMs));
const healthy = eligible.filter((record) => record.errorCount === 0 && record.consensus);

if (healthy.length === 0) {
  console.log(
    `No healthy eligible record (${eligible.length} eligible, ${records.length} archived, ` +
      `gap ${minGapHours}h since ${state.lastRecordGeneratedAt ?? 'never'}); skipping.`,
  );
  process.exit(0);
}

// Best = most peers, then edges, then version adoption, then most recent.
healthy.sort(
  (a, b) => b.peers - a.peers || b.edges - a.edges || b.versionPct - a.versionPct || b.tsMs - a.tsMs,
);

const best = healthy[0];

console.log(
  `Selected ${best.generatedAt} (peers ${best.peers}, edges ${best.edges}, ` +
    `${Math.round(best.versionPct * 100)}% latest) from ${healthy.length} healthy / ${eligible.length} eligible.`,
);

if (flags.dryRun) {
  console.log(`[dry-run] would build payload from ${best.file} and publish DATABASE only.`);
  process.exit(0);
}

// Accumulate this record into the DATABASE payload + index (SNAPSHOT untouched).
execFileSync(
  pythonBin,
  ['tools/network-topology-data.py', '--from-snapshot', best.file, '--qdn-data-dir', dataDir],
  { cwd: repoRoot, stdio: 'inherit' },
);

await publishResources([databaseResource()], { dryRun: false });

saveState({
  lastEdges: best.edges,
  lastPeers: best.peers,
  lastPublishAt: new Date().toISOString(),
  lastRecordFile: best.file,
  lastRecordGeneratedAt: best.generatedAt,
});

console.log(`Published DATABASE record ${best.generatedAt}.`);
