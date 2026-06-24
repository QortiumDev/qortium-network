#!/usr/bin/env node
// Delete the DATABASE/Network/Network QDN resource on-chain (removes every
// accumulated record). Use to clear stale/invalid history; a later publish
// recreates the resource fresh. Run with --dry-run to preview without sending.
//
// Reads the standard publish env (NODE_API_URL, NODE_API_KEY*, PREVIEW_ACCOUNTS_PATH, ...)
// handled by qdn-publish-lib, the same as the publisher.
import { databaseResource, deleteResources, parseCliFlags } from './qdn-publish-lib.mjs';

const flags = parseCliFlags(process.argv.slice(2));

if (flags.help) {
  console.log('Usage: node scripts/delete-qdn-data.mjs [--dry-run]');
  process.exit(0);
}

await deleteResources([databaseResource()], { dryRun: flags.dryRun });
