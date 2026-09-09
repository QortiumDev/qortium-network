import { EDGE_KINDS } from './graphModel';
import { LOCAL_READ_ACTIONS } from './qdnRequest';

export const NETWORK_SCHEMA = 'org.qortium.network.topology.qdn-data.v1' as const;
export const NETWORK_QDN_NAME = 'Network' as const;
export const NETWORK_QDN_IDENTIFIER = 'Network' as const;
export const NETWORK_APP_SERVICE = 'APP' as const;
export const NETWORK_DATABASE_SERVICE = 'DATABASE' as const;
export const NETWORK_SNAPSHOT_SERVICE = 'SNAPSHOT' as const;
export const NETWORK_HISTORY_LIMIT = 1000 as const;
export const NETWORK_VIEWER_MAX_BYTES = 8_000_000 as const;
export const DATABASE_LATEST_FILENAME = 'latest.json' as const;
export const DATABASE_INDEX_FILENAME = 'index.json' as const;
export const QDN_MAX_BYTES = NETWORK_VIEWER_MAX_BYTES;
export const NETWORK_SNAPSHOT_ID_PATTERN = /^\d{8}T\d{6}Z$/;

export const QDN_RESOURCE = {
  identifier: NETWORK_QDN_IDENTIFIER,
  name: NETWORK_QDN_NAME,
  service: NETWORK_DATABASE_SERVICE,
} as const;

export const APP_RESOURCE = {
  identifier: NETWORK_QDN_IDENTIFIER,
  name: NETWORK_QDN_NAME,
  service: NETWORK_APP_SERVICE,
  title: NETWORK_QDN_NAME,
} as const;

export const DATABASE_RESOURCE = {
  identifier: NETWORK_QDN_IDENTIFIER,
  name: NETWORK_QDN_NAME,
  service: NETWORK_DATABASE_SERVICE,
  title: NETWORK_QDN_NAME,
} as const;

export const SNAPSHOT_RESOURCE = {
  identifier: NETWORK_QDN_IDENTIFIER,
  name: NETWORK_QDN_NAME,
  service: NETWORK_SNAPSHOT_SERVICE,
  title: NETWORK_QDN_NAME,
} as const;

export const DATABASE_FIXED_FILES = [
  'manifest.json',
  DATABASE_LATEST_FILENAME,
  DATABASE_INDEX_FILENAME,
  'records/summary.json',
  'records/topology.json',
  'records/errors.json',
] as const;

export const DATABASE_DYNAMIC_FILE_PATTERNS = [
  'records/nodes/<node-key>.json',
  'snapshots/<YYYYMMDDTHHMMSSZ>.json',
] as const;

export const SNAPSHOT_FIXED_FILES = [
  'manifest.json',
  'snapshot.json',
  'summary.json',
  'topology.json',
  'errors.json',
] as const;

export const SNAPSHOT_DYNAMIC_FILE_PATTERNS = ['nodes/<node-key>.json'] as const;

export const NETWORK_ENDPOINTS = ['/admin/info', '/admin/status', '/peers', '/peers/data'] as const;
export const NETWORK_EDGE_KINDS = [...EDGE_KINDS] as const;
export const NETWORK_READ_ACTIONS = [...LOCAL_READ_ACTIONS] as const;

export const NETWORK_DISCOVERY_DEFAULTS = {
  apiPort: 24891,
  gossipWindowHours: 6,
  maxExtraPeers: 40,
  maxHops: 4,
  maxNodes: 250,
  probeTimeoutSeconds: 5,
  probeWorkers: 12,
  timeoutSeconds: 8,
} as const;

export const NETWORK_REFERENCE_EXAMPLES = {
  capabilities: `const actions = await window.qdnRequest({ action: 'SHOW_ACTIONS' });
const canReadDatabase = actions.includes('FETCH_QDN_RESOURCE');
const canListResources = actions.includes('LIST_QDN_RESOURCES');
const runtime = actions.includes('WHICH_UI')
  ? await window.qdnRequest({ action: 'WHICH_UI' })
  : 'unknown';

// This app only reads public data. Write or admin actions are not part of
// Network's advertised bridge contract, even if a future host exposes them.`,
  fetchLatest: `const latest = await window.qdnRequest({
  action: 'FETCH_QDN_RESOURCE',
  service: '${NETWORK_DATABASE_SERVICE}',
  name: '${NETWORK_QDN_NAME}',
  identifier: '${NETWORK_QDN_IDENTIFIER}',
  path: '${DATABASE_LATEST_FILENAME}',
  async: false,
  maxBytes: ${NETWORK_VIEWER_MAX_BYTES},
});

if (!latest || typeof latest !== 'object' ||
    !latest.topology?.graphNodes || !Array.isArray(latest.topology.edges)) {
  throw new Error('Invalid Network topology snapshot');
}`,
  discoverHistory: `const index = await window.qdnRequest({
  action: 'FETCH_QDN_RESOURCE',
  service: '${NETWORK_DATABASE_SERVICE}',
  name: '${NETWORK_QDN_NAME}',
  identifier: '${NETWORK_QDN_IDENTIFIER}',
  path: '${DATABASE_INDEX_FILENAME}',
  async: false,
  maxBytes: ${NETWORK_VIEWER_MAX_BYTES},
});

const records = Array.isArray(index.records) ? index.records : [];
const newest = records[0]?.snapshotId;
const historical = newest
  ? await window.qdnRequest({
      action: 'FETCH_QDN_RESOURCE',
      service: '${NETWORK_DATABASE_SERVICE}',
      name: '${NETWORK_QDN_NAME}',
      identifier: '${NETWORK_QDN_IDENTIFIER}',
      path: \`snapshots/\${newest}.json\`,
      async: false,
      maxBytes: ${NETWORK_VIEWER_MAX_BYTES},
    })
  : null;`,
  verifyListing: `const resources = await window.qdnRequest({
  action: 'LIST_QDN_RESOURCES',
  service: '${NETWORK_DATABASE_SERVICE}',
  name: '${NETWORK_QDN_NAME}',
  identifier: '${NETWORK_QDN_IDENTIFIER}',
  includeMetadata: true,
  includeStatus: true,
});

// Search/list metadata identifies candidates. Fetch and validate the payload
// before treating graph data as usable. A listing is not an authority proof.`,
  publishData: `# Run from the qortium-network repository with a trusted local Core.
python3 tools/network-topology-data.py --no-png
npm run qdn:publish:data

# The producer writes DATABASE and SNAPSHOT payloads before the publisher sends
# them as separate QDN publications. A partial publication is possible.`,
  verifyState: `const status = await window.qdnRequest({
  action: 'LIST_QDN_RESOURCES',
  service: '${NETWORK_DATABASE_SERVICE}',
  name: '${NETWORK_QDN_NAME}',
  identifier: '${NETWORK_QDN_IDENTIFIER}',
  includeStatus: true,
});

// Inspect the returned publication status, then fetch the exact manifest and
// payload through FETCH_QDN_RESOURCE. Do not infer READY from search metadata.`,
  snapshot: `{
  "generatedAt": "2026-09-08T13:27:07.038931+00:00",
  "errors": {},
  "nodes": {
    "example-seed": {
      "label": "N",
      "name": "ExampleSeed",
      "role": "seed",
      "publicHost": "198.51.100.10",
      "info": {
        "nodeId": "node-id-from-admin-info",
        "buildVersion": "qortium-1.8.0-05cbc08"
      },
      "status": {
        "height": 122570,
        "syncPhase": "SYNCED",
        "numberOfConnections": 1,
        "numberOfDataConnections": 1
      },
      "chainPeers": [
        {
          "address": "203.0.113.10:24892",
          "direction": "OUTBOUND",
          "handshakeStatus": "COMPLETED",
          "nodeId": "peer-node-id",
          "transport": "IP",
          "version": "qortium-1.8.0-05cbc08"
        }
      ],
      "dataPeers": [
        {
          "address": "203.0.113.10:24894",
          "direction": "OUTBOUND",
          "handshakeStatus": "COMPLETED",
          "nodeId": "peer-data-node-id",
          "transport": "IP",
          "version": "qortium-1.8.0-05cbc08"
        }
      ]
    }
  },
  "peerExchange": [],
  "discovery": {
    "enabled": true,
    "hops": 1,
    "maxHops": 4,
    "maxNodes": 250,
    "apiPort": 24891,
    "probedHostCount": 1,
    "reachableNodeCount": 0,
    "queriedNodeCount": 1,
    "frontierRemaining": []
  },
  "topology": {
    "namedLabels": { "example-seed": "N" },
    "graphNodes": {
      "N": {
        "id": "N",
        "label": "N",
        "kind": "operator",
        "group": "operator",
        "role": "seed",
        "name": "ExampleSeed",
        "host": "198.51.100.10",
        "chainCount": 1,
        "dataCount": 1,
        "peerCount": 2,
        "status": "SYNCED",
        "height": 122570,
        "version": "qortium-1.8.0-05cbc08",
        "observedBy": []
      },
      "X:203.0.113.10": {
        "id": "X:203.0.113.10",
        "label": "P1",
        "kind": "observed",
        "role": "peer",
        "host": "203.0.113.10",
        "group": "both",
        "chainCount": 1,
        "dataCount": 1,
        "peerCount": 2,
        "nodeIds": ["peer-node-id"],
        "version": "qortium-1.8.0-05cbc08",
        "connectedTo": ["N"],
        "observedBy": ["N"]
      }
    },
    "extraNodes": {},
    "edges": [
      {
        "source": "N",
        "target": "X:203.0.113.10",
        "kind": "IP_CHAIN",
        "count": 1,
        "samples": [
          {
            "reportedBy": "example-seed",
            "direction": "OUTBOUND",
            "address": "203.0.113.10:24892",
            "transport": "IP",
            "version": "qortium-1.8.0-05cbc08",
            "nodeId": "peer-node-id"
          }
        ]
      }
    ]
  }
}`,
  manifest: `{
  "schema": "${NETWORK_SCHEMA}",
  "generatedAt": "2026-09-08T13:27:07.038931+00:00",
  "snapshotId": "20260908T132707Z",
  "resource": {
    "service": "${NETWORK_DATABASE_SERVICE}",
    "name": "${NETWORK_QDN_NAME}",
    "identifier": "${NETWORK_QDN_IDENTIFIER}",
    "title": "Network"
  },
  "relatedResources": {
    "app": { "service": "APP", "name": "Network", "identifier": "Network", "title": "Network" },
    "database": { "service": "DATABASE", "name": "Network", "identifier": "Network", "title": "Network" },
    "snapshot": { "service": "SNAPSHOT", "name": "Network", "identifier": "Network", "title": "Network" }
  },
  "files": [
    "manifest.json",
    "latest.json",
    "index.json",
    "records/summary.json",
    "records/topology.json",
    "records/errors.json",
    "records/nodes/example-seed.json",
    "snapshots/20260908T132707Z.json"
  ]
}`,
  index: `{
  "schema": "${NETWORK_SCHEMA}.index",
  "generatedAt": "2026-09-08T13:27:07.038931+00:00",
  "latest": "20260908T132707Z",
  "count": 1,
  "records": [
    {
      "snapshotId": "20260908T132707Z",
      "generatedAt": "2026-09-08T13:27:07.038931+00:00",
      "graphNodeCount": 64,
      "edgeCount": 239,
      "observedPeerCount": 62,
      "operatorCount": 2,
      "hasErrors": false
    }
  ]
}`,
  summary: `{
  "schema": "${NETWORK_SCHEMA}.summary",
  "generatedAt": "2026-09-08T13:27:07.038931+00:00",
  "operatorCount": 2,
  "observedPeerCount": 62,
  "graphNodeCount": 64,
  "edgeCount": 239,
  "edgeCountsByKind": {
    "IP_CHAIN": 50,
    "IP_DATA": 35,
    "I2P_CHAIN": 88,
    "I2P_DATA": 66
  },
  "gossipRecordCount": 0,
  "peerVersionCounts": { "1.8.0": 40, "1.7.3": 24 },
  "hasErrors": false,
  "errors": {},
  "operators": [
    {
      "key": "example-seed",
      "label": "N",
      "name": "ExampleSeed",
      "role": "seed",
      "publicHost": "198.51.100.10",
      "buildVersion": "qortium-1.8.0-05cbc08",
      "nodeId": "node-id-from-admin-info",
      "height": 122570,
      "syncPhase": "SYNCED",
      "chainCount": 1,
      "dataCount": 1,
      "error": null
    }
  ]
}`,
  topology: `{
  "namedLabels": { "example-seed": "N" },
  "graphNodes": {
    "N": {
      "id": "N",
      "label": "N",
      "kind": "operator",
      "group": "operator",
      "role": "seed",
      "name": "ExampleSeed",
      "host": "198.51.100.10",
      "chainCount": 1,
      "dataCount": 1,
      "peerCount": 2,
      "status": "SYNCED",
      "height": 122570,
      "version": "qortium-1.8.0-05cbc08",
      "observedBy": []
    },
    "X:203.0.113.10": {
      "id": "X:203.0.113.10",
      "label": "P1",
      "kind": "observed",
      "role": "peer",
      "host": "203.0.113.10",
      "group": "both",
      "chainCount": 1,
      "dataCount": 1,
      "peerCount": 2,
      "nodeIds": ["peer-node-id"],
      "versions": ["qortium-1.8.0-05cbc08"],
      "version": "qortium-1.8.0-05cbc08",
      "connectedTo": ["N"],
      "observedBy": ["N"]
    }
  },
  "extraNodes": {},
  "edges": [
    {
      "source": "N",
      "target": "X:203.0.113.10",
      "kind": "IP_CHAIN",
      "count": 1,
      "samples": [
        {
          "reportedBy": "example-seed",
          "direction": "OUTBOUND",
          "address": "203.0.113.10:24892",
          "transport": "IP",
          "version": "qortium-1.8.0-05cbc08",
          "nodeId": "peer-node-id"
        }
      ]
    }
  ]
}`,
  errors: `{}`,
} as const;

export type NetworkReferenceExample = keyof typeof NETWORK_REFERENCE_EXAMPLES;
