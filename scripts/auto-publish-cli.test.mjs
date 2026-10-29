// End-to-end checks for the publisher CLI that never touch a node: every case
// here either dry-runs or fails before any chain call is attempted.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { STATE_VERSION, TARGET_STATUS } from './dual-publish-state.mjs';

const scriptPath = fileURLToPath(new URL('./auto-publish.mjs', import.meta.url));
const repoRoot = path.dirname(path.dirname(scriptPath));
const temporaryDirectories = [];

function makeTempDir() {
  const directory = mkdtempSync(path.join(tmpdir(), 'qortium-auto-publish-'));

  temporaryDirectories.push(directory);

  return directory;
}

function runPublisher(environment, args = ['--dry-run']) {
  try {
    return {
      code: 0,
      output: execFileSync(process.execPath, [scriptPath, ...args], {
        cwd: repoRoot,
        encoding: 'utf8',
        env: { ...process.env, ...environment },
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    };
  } catch (error) {
    return { code: error.status ?? 1, output: `${error.stdout ?? ''}${error.stderr ?? ''}` };
  }
}

function makeEnvironment(directory) {
  return {
    QORTIUM_NETWORK_ARCHIVE_DIR: path.join(directory, 'archive'),
    QORTIUM_NETWORK_AUTO_STATE_PATH: path.join(directory, 'state.json'),
    QORTIUM_NETWORK_QDN_DATA_PATH: path.join(directory, 'payload'),
  };
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop(), { force: true, recursive: true });
  }
});

describe('auto-publish --dry-run', () => {
  it('selects a Netcup-only observation while preserving failed historical Regxa records and publisher state', () => {
    const directory = makeTempDir();
    const environment = makeEnvironment(directory);
    mkdirSync(environment.QORTIUM_NETWORK_ARCHIVE_DIR);
    const oldPath = path.join(environment.QORTIUM_NETWORK_ARCHIVE_DIR, 'preview-topology-20261028T120000Z.json');
    const newPath = path.join(environment.QORTIUM_NETWORK_ARCHIVE_DIR, 'preview-topology-20261029T120000Z.json');
    const graph = { graphNodes: { N: {}, A: {} }, edges: [] };
    const old = JSON.stringify({ generatedAt: '2026-10-28T12:00:00Z', errors: { regxa: 'unavailable' },
      nodes: { netcup: { role: 'seed', status: { height: 180000 } } },
      topology: { graphNodes: { ...graph.graphNodes, R: {}, P: {} }, edges: [] } });
    writeFileSync(oldPath, old);
    writeFileSync(newPath, JSON.stringify({ generatedAt: '2026-10-29T12:00:00Z', errors: {},
      nodes: { netcup: { role: 'seed', status: { height: 185000 } },
        publicPeer: { role: 'peer', status: { height: 184999 } } }, topology: graph }));
    const state = JSON.stringify({ version: STATE_VERSION, lastRecordGeneratedAt: '2026-10-26T04:32:03Z' });
    writeFileSync(environment.QORTIUM_NETWORK_AUTO_STATE_PATH, state);
    const { code, output } = runPublisher(environment);
    expect(code).toBe(0);
    expect(output).toContain(`would build payload from ${newPath}`);
    expect(output).toContain('1 healthy / 2 eligible');
    expect(readFileSync(oldPath, 'utf8')).toBe(old);
    expect(readFileSync(environment.QORTIUM_NETWORK_AUTO_STATE_PATH, 'utf8')).toBe(state);
    expect(existsSync(environment.QORTIUM_NETWORK_QDN_DATA_PATH)).toBe(false);
  });

  it('still rejects a snapshot when Netcup fails after Regxa retirement', () => {
    const directory = makeTempDir();
    const environment = makeEnvironment(directory);
    mkdirSync(environment.QORTIUM_NETWORK_ARCHIVE_DIR);
    writeFileSync(path.join(environment.QORTIUM_NETWORK_ARCHIVE_DIR, 'preview-topology-20261029T120000Z.json'),
      JSON.stringify({ generatedAt: '2026-10-29T12:00:00Z', errors: { netcup: 'unavailable' },
        nodes: { netcup: { role: 'seed', error: 'unavailable' } },
        topology: { graphNodes: { N: {} }, edges: [] } }));
    const { code, output } = runPublisher(environment);
    expect(code).toBe(0);
    expect(output).toContain('No healthy eligible record');
    expect(output).toContain('[dry-run] nothing to publish.');
  });

  it('writes nothing: no state file, no lock file, no payload', () => {
    const directory = makeTempDir();
    const environment = makeEnvironment(directory);
    const { code, output } = runPublisher(environment);

    expect(code).toBe(0);
    expect(output).toContain('qortium:qdn://DATABASE/Network/Network');
    expect(existsSync(environment.QORTIUM_NETWORK_AUTO_STATE_PATH)).toBe(false);
    expect(existsSync(`${environment.QORTIUM_NETWORK_AUTO_STATE_PATH}.lock`)).toBe(false);
    expect(existsSync(environment.QORTIUM_NETWORK_QDN_DATA_PATH)).toBe(false);
  });

  it('lists the Qortal target only when it is explicitly opted in', () => {
    const directory = makeTempDir();
    const environment = makeEnvironment(directory);

    expect(runPublisher(environment).output).not.toContain('qortal:');
    expect(runPublisher({ ...environment, QORTIUM_NETWORK_QORTAL_PUBLISH: '1' }).output).toContain(
      'qortal:qdn://DATABASE/xnetwork/Network',
    );
  });

  it('reports a pending record without disturbing it', () => {
    const directory = makeTempDir();
    const environment = makeEnvironment(directory);
    const state = {
      pending: {
        attempts: 2,
        payloadDigest: 'sha256:abc',
        payloadDir: path.join(directory, 'payload'),
        recordGeneratedAt: '2026-09-08T11:00:00.000Z',
        targets: { qortium: { attempts: 2, status: TARGET_STATUS.FAILED } },
      },
      version: STATE_VERSION,
    };
    const serialized = `${JSON.stringify(state, null, 2)}\n`;

    writeFileSync(environment.QORTIUM_NETWORK_AUTO_STATE_PATH, serialized);

    const { code, output } = runPublisher(environment);

    expect(code).toBe(0);
    expect(output).toContain('pending record 2026-09-08T11:00:00.000Z');
    expect(output).toContain('qortium=failed');
    expect(readFileSync(environment.QORTIUM_NETWORK_AUTO_STATE_PATH, 'utf8')).toBe(serialized);
  });

  it('refuses to run on corrupt state rather than republishing the archive', () => {
    const directory = makeTempDir();
    const environment = makeEnvironment(directory);

    writeFileSync(environment.QORTIUM_NETWORK_AUTO_STATE_PATH, '{"version": 42}');

    const { code, output } = runPublisher(environment);

    expect(code).not.toBe(0);
    expect(output).toContain('StateCorruptError');
  });
});

describe('auto-publish locking', () => {
  it('refuses to start while a fresh lock from another run is held', () => {
    const directory = makeTempDir();
    const environment = makeEnvironment(directory);

    writeFileSync(
      `${environment.QORTIUM_NETWORK_AUTO_STATE_PATH}.lock`,
      `${JSON.stringify({ pid: 1, startedAt: new Date().toISOString() })}\n`,
    );

    const { code, output } = runPublisher(environment, []);

    expect(code).not.toBe(0);
    expect(output).toContain('PublishLockedError');
    // The other run's lock must survive.
    expect(existsSync(`${environment.QORTIUM_NETWORK_AUTO_STATE_PATH}.lock`)).toBe(true);
  });

  it('releases its own lock when there is nothing to publish', () => {
    const directory = makeTempDir();
    const environment = makeEnvironment(directory);
    const { code } = runPublisher(environment, []);

    expect(code).toBe(0);
    expect(existsSync(`${environment.QORTIUM_NETWORK_AUTO_STATE_PATH}.lock`)).toBe(false);
  });
});
