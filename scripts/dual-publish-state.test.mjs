import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  acquireLock,
  hashPayloadDirectory,
  migrateState,
  PublishLockedError,
  readState,
  StateCorruptError,
  STATE_VERSION,
  TARGET_STATUS,
  writeState,
} from './dual-publish-state.mjs';

const temporaryDirectories = [];

function makeTempDir() {
  const directory = mkdtempSync(path.join(tmpdir(), 'qortium-dual-publish-'));

  temporaryDirectories.push(directory);

  return directory;
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop(), { force: true, recursive: true });
  }
});

describe('state migration', () => {
  it('carries legacy v0 publish history forward so records are never republished', () => {
    const legacy = {
      lastEdges: 42,
      lastPeers: 17,
      lastPublishAt: '2026-09-08T12:00:00.000Z',
      lastRecordFile: '/archive/preview-topology-20260908T110000Z.json',
      lastRecordGeneratedAt: '2026-09-08T11:00:00.000Z',
    };

    expect(migrateState(legacy)).toEqual({ ...legacy, version: STATE_VERSION });
  });

  it('treats a missing state file as never published', () => {
    const directory = makeTempDir();

    expect(readState(path.join(directory, 'auto-publish-state.json'))).toEqual({ version: STATE_VERSION });
  });

  it('refuses corrupt state instead of silently resetting the publish history', () => {
    const directory = makeTempDir();
    const statePath = path.join(directory, 'auto-publish-state.json');

    writeFileSync(statePath, '{ this is not json');
    expect(() => readState(statePath)).toThrow(StateCorruptError);

    writeFileSync(statePath, '');
    expect(() => readState(statePath)).toThrow(StateCorruptError);

    writeFileSync(statePath, '[]');
    expect(() => readState(statePath)).toThrow(StateCorruptError);

    expect(() => migrateState({ version: 99 })).toThrow(/version/);
    expect(() => migrateState({ lastRecordGeneratedAt: 'yesterday' })).toThrow(StateCorruptError);
    expect(() => migrateState({ version: STATE_VERSION, pending: { payloadDigest: 'nope', recordGeneratedAt: 'x', targets: {} } })).toThrow(
      /payloadDigest/,
    );
  });

  it('rejects a broadcast target that has no signature to reconcile with', () => {
    const pending = {
      payloadDigest: 'sha256:abc',
      recordGeneratedAt: '2026-09-08T11:00:00.000Z',
      targets: { qortal: { status: TARGET_STATUS.UNCERTAIN } },
    };

    expect(() => migrateState({ pending, version: STATE_VERSION })).toThrow(/no signature/);
  });
});

describe('atomic state writes', () => {
  it('leaves no temp file behind and round-trips through readState', () => {
    const directory = makeTempDir();
    const statePath = path.join(directory, 'nested', 'auto-publish-state.json');
    const state = { lastRecordGeneratedAt: '2026-09-08T11:00:00.000Z', version: STATE_VERSION };

    writeState(statePath, state);

    expect(readState(statePath)).toEqual(state);
    expect(readFileSync(statePath, 'utf8').endsWith('\n')).toBe(true);
  });
});

describe('publish lock', () => {
  it('blocks overlapping runs even when the held lock is old', () => {
    const directory = makeTempDir();
    const lockPath = path.join(directory, 'state.json.lock');
    const now = Date.parse('2026-09-09T00:00:00.000Z');

    const release = acquireLock(lockPath, { now, ttlMs: 60_000 });

    expect(() => acquireLock(lockPath, { now: now + 1_000, ttlMs: 60_000 })).toThrow(PublishLockedError);

    expect(() => acquireLock(lockPath, { now: now + 120_000, ttlMs: 60_000 })).toThrow(PublishLockedError);
    release();
  });
});

describe('payload digest', () => {
  it('changes when any published byte changes and ignores directory walk order', () => {
    const directory = makeTempDir();

    mkdirSync(path.join(directory, 'records'));
    writeFileSync(path.join(directory, 'manifest.json'), '{"records":1}');
    writeFileSync(path.join(directory, 'records', 'a.json'), '{"a":1}');

    const digest = hashPayloadDirectory(directory);

    expect(digest).toMatch(/^sha256:[\da-f]{64}$/);
    expect(hashPayloadDirectory(directory)).toBe(digest);

    writeFileSync(path.join(directory, 'records', 'a.json'), '{"a":2}');
    expect(hashPayloadDirectory(directory)).not.toBe(digest);
  });
});
