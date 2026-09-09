// @ts-expect-error Node's test runtime provides this without adding Node types to the app bundle.
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import Reference from './Reference';
import {
  APP_RESOURCE,
  DATABASE_INDEX_FILENAME,
  DATABASE_LATEST_FILENAME,
  DATABASE_DYNAMIC_FILE_PATTERNS,
  DATABASE_FIXED_FILES,
  DATABASE_RESOURCE,
  NETWORK_EDGE_KINDS,
  NETWORK_ENDPOINTS,
  NETWORK_HISTORY_LIMIT,
  NETWORK_QDN_IDENTIFIER,
  NETWORK_QDN_NAME,
  NETWORK_READ_ACTIONS,
  NETWORK_REFERENCE_EXAMPLES,
  NETWORK_SCHEMA,
  NETWORK_VIEWER_MAX_BYTES,
  SNAPSHOT_DYNAMIC_FILE_PATTERNS,
  SNAPSHOT_FIXED_FILES,
  SNAPSHOT_RESOURCE,
} from './networkContract';

describe('Network Developers reference', () => {
  it('renders the live resource contract and operational boundaries', () => {
    const markup = renderToStaticMarkup(<Reference />);

    expect(markup).toContain(NETWORK_SCHEMA);
    expect(markup).toContain(DATABASE_LATEST_FILENAME);
    expect(markup).toContain(DATABASE_INDEX_FILENAME);
    expect(markup).toContain(`${APP_RESOURCE.service}/${APP_RESOURCE.name}/${APP_RESOURCE.identifier}`);
    expect(markup).toContain(`${DATABASE_RESOURCE.service}/${DATABASE_RESOURCE.name}/${DATABASE_RESOURCE.identifier}`);
    expect(markup).toContain(`${SNAPSHOT_RESOURCE.service}/${SNAPSHOT_RESOURCE.name}/${SNAPSHOT_RESOURCE.identifier}`);
    expect(markup).toContain(`${NETWORK_HISTORY_LIMIT.toLocaleString()} retained records`);
    expect(markup).toContain(`${NETWORK_HISTORY_LIMIT + 1} records`);
    expect(markup).toContain(NETWORK_VIEWER_MAX_BYTES.toLocaleString());
    expect(markup).toContain('not atomic');
    expect(markup).toContain('public and durable');
    expect(markup).toContain('bundled sample data');
    expect(markup).toContain('does not substitute the SNAPSHOT resource');
    expect(markup).toContain('aria-label="Developer reference sections"');
    expect(markup).toContain('aria-live="polite"');

    for (const value of [...NETWORK_EDGE_KINDS, ...NETWORK_ENDPOINTS, ...NETWORK_READ_ACTIONS]) {
      expect(markup).toContain(value);
    }

    for (const id of ['reference-data-model', 'reference-resources', 'reference-authority', 'reference-bridge', 'reference-examples']) {
      expect(markup).toContain(`id="${id}"`);
    }
  });

  it('exports complete contract examples with required markers and fields', () => {
    for (const id of ['manifest', 'index', 'summary', 'topology', 'errors', 'snapshot'] as const) {
      expect(() => JSON.parse(NETWORK_REFERENCE_EXAMPLES[id])).not.toThrow();
    }
    expect(NETWORK_REFERENCE_EXAMPLES.manifest).toContain(`"schema": "${NETWORK_SCHEMA}"`);
    expect(NETWORK_REFERENCE_EXAMPLES.manifest).toContain('"relatedResources"');
    expect(NETWORK_REFERENCE_EXAMPLES.index).toContain(`"schema": "${NETWORK_SCHEMA}.index"`);
    expect(NETWORK_REFERENCE_EXAMPLES.index).toContain('"snapshotId"');
    expect(NETWORK_REFERENCE_EXAMPLES.summary).toContain(`"schema": "${NETWORK_SCHEMA}.summary"`);
    expect(NETWORK_REFERENCE_EXAMPLES.summary).toContain('"edgeCountsByKind"');
    expect(NETWORK_REFERENCE_EXAMPLES.topology).toContain('"graphNodes"');
    expect(NETWORK_REFERENCE_EXAMPLES.topology).toContain('"edges"');
    expect(NETWORK_REFERENCE_EXAMPLES.errors).toBe('{}');
    expect(NETWORK_REFERENCE_EXAMPLES.snapshot).toContain('"generatedAt"');
    expect(NETWORK_REFERENCE_EXAMPLES.snapshot).toContain('"nodes"');
    expect(NETWORK_REFERENCE_EXAMPLES.snapshot).toContain('"topology"');
    expect(NETWORK_REFERENCE_EXAMPLES.fetchLatest).toContain(`maxBytes: ${NETWORK_VIEWER_MAX_BYTES}`);
    expect(NETWORK_REFERENCE_EXAMPLES.discoverHistory).toContain('snapshots/');
    expect(NETWORK_REFERENCE_EXAMPLES.capabilities).toContain("'SHOW_ACTIONS'");
  });

  it('keeps duplicated contract values aligned with the Python producer', () => {
    const producer = readFileSync(new URL('../tools/network-topology-data.py', import.meta.url), 'utf8');

    expect(producer).toContain(`QDN_DATA_SCHEMA = "${NETWORK_SCHEMA}"`);
    expect(producer).toContain(`QDN_MAX_HISTORY = ${NETWORK_HISTORY_LIMIT}`);
    for (const file of DATABASE_FIXED_FILES) expect(producer).toContain(`"${file}"`);
    for (const file of SNAPSHOT_FIXED_FILES) expect(producer).toContain(`"${file}"`);
    for (const pattern of [...DATABASE_DYNAMIC_FILE_PATTERNS, ...SNAPSHOT_DYNAMIC_FILE_PATTERNS]) {
      expect(pattern).toMatch(/[<>]/);
    }
    expect(producer).toContain('root / "DATABASE" / qdn_name / qdn_identifier');
    expect(producer).toContain('root / "SNAPSHOT" / qdn_name / qdn_identifier');
    expect(NETWORK_QDN_NAME).toBe(NETWORK_QDN_IDENTIFIER);
  });
});
