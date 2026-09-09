// Durable state for the dual-target QDN publisher.
//
// The publisher may be interrupted between signing and broadcasting a
// transaction, or after one chain has accepted a record but the other has not.
// State therefore has to survive a crash without ever losing a signature (which
// would risk a second, duplicate spend) and without silently republishing a
// record that already landed.
//
// Layout (version 1):
//   {
//     "version": 1,
//     "lastRecordGeneratedAt": "...",   // gap gate; also present in legacy v0
//     "lastPublishAt": "...", "lastRecordFile": "...",
//     "lastPeers": 0, "lastEdges": 0,
//     "lastFailure": { ... retired pending ... },
//     "pending": {
//       "recordGeneratedAt": "...", "recordFile": "...", "createdAt": "...",
//       "payloadDigest": "sha256:...", "payloadDir": "...", "attempts": 1,
//       "targets": { "<key>": { "status": ..., "signature": ..., ... } }
//     }
//   }
//
// A missing state file means "never published". Anything else that does not
// parse as the schema above is a hard error: silently resetting would replay
// the whole archive onto the chain.
import crypto from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const STATE_VERSION = 1;

/** Per-target lifecycle. Only PUBLISHED is terminal-success. */
export const TARGET_STATUS = {
  /** Signed and persisted, but the broadcast result is unknown. Never re-sign. */
  BROADCAST: 'broadcast',
  FAILED: 'failed',
  PENDING: 'pending',
  PUBLISHED: 'published',
  UNCERTAIN: 'uncertain',
};

const LEGACY_KEYS = ['lastEdges', 'lastPeers', 'lastPublishAt', 'lastRecordFile', 'lastRecordGeneratedAt'];
const TARGET_STATUSES = new Set(Object.values(TARGET_STATUS));

export class StateCorruptError extends Error {
  constructor(message) {
    super(message);
    this.name = 'StateCorruptError';
  }
}

export class PublishLockedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PublishLockedError';
  }
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertTimestamp(value, label) {
  if (value === undefined || value === null) {
    return null;
  }

  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new StateCorruptError(`${label} is not an ISO timestamp: ${JSON.stringify(value)}`);
  }

  return value;
}

function normalizeTargetState(key, raw) {
  if (!isPlainObject(raw)) {
    throw new StateCorruptError(`pending.targets.${key} is not an object.`);
  }

  if (!TARGET_STATUSES.has(raw.status)) {
    throw new StateCorruptError(`pending.targets.${key}.status is unknown: ${JSON.stringify(raw.status)}`);
  }

  if (raw.signature !== undefined && typeof raw.signature !== 'string') {
    throw new StateCorruptError(`pending.targets.${key}.signature is not a string.`);
  }

  // A broadcast/uncertain target without a signature can never be reconciled,
  // so treating it as merely "retryable" would risk signing a second spend.
  if ((raw.status === TARGET_STATUS.BROADCAST || raw.status === TARGET_STATUS.UNCERTAIN || raw.status === TARGET_STATUS.PUBLISHED) && !raw.signature) {
    throw new StateCorruptError(`pending.targets.${key} is ${raw.status} but has no signature.`);
  }

  assertTimestamp(raw.broadcastAt, `pending.targets.${key}.broadcastAt`);
  assertTimestamp(raw.confirmedAt, `pending.targets.${key}.confirmedAt`);

  return { ...raw, attempts: Number(raw.attempts ?? 0) };
}

function normalizePending(raw) {
  if (raw === undefined || raw === null) {
    return null;
  }

  if (!isPlainObject(raw)) {
    throw new StateCorruptError('pending is not an object.');
  }

  if (typeof raw.payloadDigest !== 'string' || !raw.payloadDigest.startsWith('sha256:')) {
    throw new StateCorruptError('pending.payloadDigest is missing or malformed.');
  }

  if (typeof raw.recordGeneratedAt !== 'string') {
    throw new StateCorruptError('pending.recordGeneratedAt is missing.');
  }

  assertTimestamp(raw.recordGeneratedAt, 'pending.recordGeneratedAt');

  if (!isPlainObject(raw.targets)) {
    throw new StateCorruptError('pending.targets is not an object.');
  }

  const targets = {};

  for (const [key, value] of Object.entries(raw.targets)) {
    targets[key] = normalizeTargetState(key, value);
  }

  return { ...raw, attempts: Number(raw.attempts ?? 0), targets };
}

/**
 * Validate and migrate raw parsed JSON into the current schema. Legacy v0 state
 * (the flat `last*` object the single-chain publisher wrote) is carried forward
 * so upgrading a deployed host never republishes already-published records.
 */
export function migrateState(raw) {
  if (raw === undefined || raw === null) throw new StateCorruptError('State must be an object.');

  if (!isPlainObject(raw)) {
    throw new StateCorruptError('State file is not a JSON object.');
  }

  if (raw.version !== undefined && raw.version !== STATE_VERSION) {
    throw new StateCorruptError(
      `State file version ${JSON.stringify(raw.version)} is not supported (expected ${STATE_VERSION}).`,
    );
  }

  if (Object.keys(raw).length && raw.version === undefined && !LEGACY_KEYS.some(key => key in raw)) throw new StateCorruptError('Unrecognized legacy state.');
  const migrated = { version: STATE_VERSION };
  if (raw.lastReceipt) migrated.lastReceipt = raw.lastReceipt;
  if (raw.lastStatus) migrated.lastStatus = raw.lastStatus;

  for (const key of LEGACY_KEYS) {
    if (raw[key] !== undefined) {
      migrated[key] = raw[key];
    }
  }

  assertTimestamp(migrated.lastRecordGeneratedAt, 'lastRecordGeneratedAt');
  assertTimestamp(migrated.lastPublishAt, 'lastPublishAt');

  if (raw.lastFailure !== undefined) {
    migrated.lastFailure = raw.lastFailure;
  }

  const pending = normalizePending(raw.pending);

  if (pending) {
    migrated.pending = pending;
  }

  return migrated;
}

export function readState(statePath) {
  let text;

  try {
    text = readFileSync(statePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { version: STATE_VERSION };
    }

    throw error;
  }

  if (text.trim() === '') {
    throw new StateCorruptError(`State file is empty: ${statePath}`);
  }

  let parsed;

  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new StateCorruptError(`State file is not valid JSON (${statePath}): ${error.message}`);
  }

  return migrateState(parsed);
}

/** Write via a temp file + rename so a crash never leaves a half-written state. */
export function writeState(statePath, state) {
  const directory = path.dirname(statePath);
  const tempPath = path.join(directory, `.${path.basename(statePath)}.${process.pid}.tmp`);

  mkdirSync(directory, { recursive: true });
  writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`, {mode:0o600});
  const file = openSync(tempPath, 'r');
  try { fsyncSync(file); } finally { closeSync(file); }
  renameSync(tempPath, statePath);
  if (process.platform !== 'win32') {
    const dir = openSync(directory, 'r');
    try { fsyncSync(dir); } finally { closeSync(dir); }
  }
}

/** Exclusive lock. Never steal a live or possibly live writer's lock by age.
 * After a killed process, verify its PID is gone and reconcile its saved receipt
 * before removing the stale lock explicitly. Normal failures release it below.
 */
export function acquireLock(lockPath, { now = Date.now() } = {}) {
  const payload = JSON.stringify({ pid: process.pid, startedAt: new Date(now).toISOString(), token: crypto.randomUUID() });
  mkdirSync(path.dirname(lockPath), { recursive: true });
  try { writeFileSync(lockPath, payload, { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if (error.code === 'EEXIST') throw new PublishLockedError(`Another publish run holds ${lockPath}; reconcile its PID and receipt before removing an abandoned lock.`);
    throw error;
  }
  return () => { if (readFileSync(lockPath, 'utf8') === payload) rmSync(lockPath); };
}

/**
 * Content digest of a built payload directory. Recorded when a pending record is
 * created and re-checked on every retry: the retry must publish byte-identical
 * data, so a changed payload is a hard error rather than a silent swap.
 */
export function hashPayloadDirectory(directory) {
  const hash = crypto.createHash('sha256');

  const walk = (current, prefix) => {
    const entries = readdirSync(current, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1));

    for (const entry of entries) {
      const full = path.join(current, entry.name);
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        walk(full, relative);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      hash.update(relative);
      hash.update('\0');
      hash.update(crypto.createHash('sha256').update(readFileSync(full)).digest());
      hash.update('\n');
    }
  };

  walk(directory, '');

  return `sha256:${hash.digest('hex')}`;
}
