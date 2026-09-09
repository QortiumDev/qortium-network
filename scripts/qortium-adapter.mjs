// Qortium chain adapter for the dual-target publisher.
//
// Uses the same local Core API + local Ed25519 signing path the single-chain
// publisher has always used (qdn-publish-lib), but split into prepare/broadcast/
// confirm so the orchestrator can persist a signature before it hits the wire.
import { retrySyncGate, verifyPayloadContent } from './publisher-content.mjs';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  appendQuery,
  broadcastSigned,
  buildConfig,
  computeAndSign,
  decodeBase58,
  encodeBase58,
  ensureNameRegistered,
  getApiKey,
  getLocalPreviewAccount,
  getResourceStatus,
  request,
  requestJson,
  waitFor,
} from './qdn-publish-lib.mjs';
import { AmbiguousBroadcastError } from './dual-publish.mjs';

const SIGNATURE_LENGTH = 64;

export function signatureOf(signedBytes58) {
  const bytes = decodeBase58(signedBytes58);

  return encodeBase58(bytes.subarray(bytes.length - SIGNATURE_LENGTH));
}

/**
 * Fetch a published file back out of QDN and compare it with the local payload.
 * A confirmed transaction alone does not prove the network can serve the data,
 * so success is only declared once the content round-trips.
 */
export async function assertPublishedContentMatches({ fetchFile, payload, relativeFile, label }) {
  const expected = crypto.createHash('sha256').update(readFileSync(path.join(payload.directory, relativeFile))).digest('hex');
  const served = await fetchFile(relativeFile);
  const actual = crypto.createHash('sha256').update(served).digest('hex');

  if (actual !== expected) {
    throw new Error(`${label}: served ${relativeFile} does not match the published payload.`);
  }
}

export function createQortiumAdapter({ log = console.log } = {}) {
  const config = buildConfig();
  let session = null;

  const open = () => {
    if (!session) {
      session = { account: getLocalPreviewAccount(config), apiKey: getApiKey(config) };
      log(`Qortium node: ${config.nodeApiUrl}`);
      log(`Qortium owner: ${session.account.accountAddress}`);
    }

    return session;
  };

  const assertSynced = async (apiKey) => {
    const status = await requestJson(config, apiKey, '/admin/status');

    // Unchanged gate: a partially synced node must never publish.
    if (!status || status.syncPercent !== 100 || status.isSynchronizing) {
      throw new Error(`Qortium node is not synced: ${JSON.stringify(status)}`);
    }
  };

  return {
    async broadcast(_target, prepared) {
      const { apiKey } = open();

      try {
        await broadcastSigned(config, apiKey, prepared.signedBytes58);
      } catch (error) {
        // The node answered something we cannot classify, or the connection
        // dropped mid-request: the transaction may or may not be in the mempool.
        throw new AmbiguousBroadcastError(
          `Qortium broadcast of ${prepared.signature} did not return a clear result: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },

    async confirm(target, receipt, payload) {
      const { apiKey } = open();

      await waitFor(`qortium transaction ${receipt.signature}`, async () => {
        const transaction = await requestJson(config, apiKey, `/transactions/signature/${receipt.signature}`);

        return typeof transaction?.blockHeight === 'number' && transaction.blockHeight > 0 ? transaction : null;
      });

      await waitFor(`qortium ${target.service}/${target.name}/${target.identifier}`, async () => {
        const status = await getResourceStatus(config, apiKey, target);

        if (status?.status === 'BLOCKED' || status?.status === 'BUILD_FAILED') {
          throw new Error(`Qortium resource status is ${status.status}.`);
        }

        return status?.status === 'READY' ? status : null;
      });

      return verifyPayloadContent(payload.directory, async relativeFile => Buffer.from(await request(config, apiKey,
        appendQuery(`/arbitrary/${target.service}/${encodeURIComponent(target.name)}/${encodeURIComponent(target.identifier)}`, { filepath: relativeFile }))));
    },

    async lookup(_target, signature) {
      const { apiKey } = open();

      try {
        return await requestJson(config, apiKey, `/transactions/signature/${signature}`);
      } catch (error) {
        if (error.status === 404) return null;
        throw error;
      }
    },

    async prepare(target, payload) {
      const { account, apiKey } = open();

      await retrySyncGate(() => assertSynced(apiKey));
      await ensureNameRegistered(config, apiKey, target.name, account);

      const rawUnsignedBytes58 = await request(
        config,
        apiKey,
        appendQuery(
          `/arbitrary/${target.service}/${encodeURIComponent(target.name)}/${encodeURIComponent(target.identifier)}`,
          { description: target.description, fee: 0, title: target.title },
        ),
        {
          body: payload.directory,
          headers: { 'Content-Type': 'text/plain' },
          method: 'POST',
        },
      );
      const signedBytes58 = await computeAndSign(config, apiKey, rawUnsignedBytes58, account.accountPrivateKey);

      return { fee: 0, reference: null, signature: signatureOf(signedBytes58), signedBytes58 };
    },
  };
}
