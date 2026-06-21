#!/usr/bin/env node
import { parseCliFlags, publishResources, topologyDataResources } from './qdn-publish-lib.mjs';

function usage() {
  console.log(`Usage: node scripts/publish-topology-data.mjs [--dry-run]

Publishes DATABASE/Network/Network and SNAPSHOT/Network/Network from target/qdn-topology-data.
Generate those payloads first with:
  python3 tools/network-topology-data.py --no-png

Environment overrides use the QORTIUM_NETWORK_ prefix, including:
  QORTIUM_NETWORK_NODE_API_URL
  QORTIUM_NETWORK_QDN_NAME
  QORTIUM_NETWORK_QDN_IDENTIFIER
  QORTIUM_NETWORK_QDN_TITLE
  QORTIUM_NETWORK_QDN_DATA_PATH
  QORTIUM_NETWORK_DATABASE_SERVICE
  QORTIUM_NETWORK_SNAPSHOT_SERVICE
  QORTIUM_NETWORK_NODE_API_KEY
  QORTIUM_NETWORK_NODE_API_KEY_PATH
  QORTIUM_NETWORK_PREVIEW_ACCOUNTS_PATH
  QORTIUM_NETWORK_PREVIEW_ACCOUNT_ROLE`);
}

const flags = parseCliFlags(process.argv.slice(2));

if (flags.help) {
  usage();
  process.exit(0);
}

try {
  await publishResources(topologyDataResources(), flags);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
