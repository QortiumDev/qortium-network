// Qortal chain adapter for the dual-target publisher.
//
// Mirrors the Qortium adapter's prepare/broadcast/lookup/confirm contract, but
// talks to a Qortal node (public API by default) and applies the extra checks a
// fee-paying, already-registered-name publish needs.
import { acquireLock } from './dual-publish-state.mjs';
import path from 'node:path';
import { retrySyncGate, verifyPayloadContent } from './publisher-content.mjs';
import { AmbiguousBroadcastError } from './dual-publish.mjs';
import {
  assertPayloadReadable,
  assertUnsignedTransactionMatches,
  buildQortalConfig,
  decodeBase58,
  encodeBase58,
  formatQort,
  loadQortalAccount,
  parseQort,
  parseQortalArbitraryTransaction,
  readQortalApiKey,
  signQortalTransaction,
  zipDirectory,
} from './qortal-publish-lib.mjs';

const POLL_INTERVAL_MS = 5_000;
const POLL_TIMEOUT_MS = 300_000;

/** Numeric service IDs used by Qortal's ARBITRARY transactions. */
export const QORTAL_SERVICE_IDS = {
  APP: 1000, DATABASE: 1700, SNAPSHOT: 1710,
};

export function qortalServiceId(service) {
  const id = QORTAL_SERVICE_IDS[service];

  if (id === undefined) {
    throw new Error(`Unknown Qortal service ${service}; set an explicit service the publisher knows about.`);
  }

  return id;
}

async function waitFor(label, predicate) {
  const startedAt = Date.now();
  let lastError;

  while (Date.now() - startedAt < POLL_TIMEOUT_MS) {
    try {
      const result = await predicate();

      if (result) {
        return result;
      }
    } catch (error) {
      lastError = error;
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  throw new Error(`Timed out waiting for ${label}.${lastError ? ` Last error: ${lastError.message}` : ''}`);
}

export function createQortalAdapter({ env = process.env, log = console.log } = {}) {
  const config = buildQortalConfig(env);
  let session = null;
  let releaseAccount = null;

  const open = () => {
    if (!session) {
      session = { account: loadQortalAccount(config), apiKey: readQortalApiKey(config) };
      log(`Qortal node: ${config.apiUrl} (upload mode ${config.uploadMode})`);
      log(`Qortal owner: ${session.account.accountAddress}`);
    }

    if (!releaseAccount) releaseAccount = acquireLock(env.QORTIUM_NETWORK_QORTAL_ACCOUNT_LOCK_PATH || path.join(path.dirname(config.accountPath), 'qdn-account-' + session.account.accountAddress + '.lock'));
    return session;
  };

  // API keys are request-scoped and never logged; only public values are printed.
  const call = async (pathname, options = {}) => {
    const { apiKey } = open();
    const response = await fetch(`${config.apiUrl}${pathname}`, {
      ...options,
      signal: options.signal ?? AbortSignal.timeout(180000),
      headers: {
        'User-Agent': config.userAgent,
        ...(apiKey ? { 'X-API-KEY': apiKey } : {}),
        ...(options.headers ?? {}),
      },
    });
    const body = Buffer.from(await response.arrayBuffer());

    if (!response.ok) {
      const error = new Error(
        `${options.method ?? 'GET'} ${pathname} failed with HTTP ${response.status}: ${body.toString('utf8').slice(0, 500)}`,
      );

      error.status = response.status;

      throw error;
    }

    return body;
  };

  const callText = async (pathname, options) => (await call(pathname, options)).toString('utf8');
  const callJson = async (pathname, options) => {
    const text = await callText(pathname, options);

    return text ? JSON.parse(text) : null;
  };

  const resourcePath = (target, suffix = '') =>
    `/arbitrary/${target.service}/${encodeURIComponent(target.name)}${target.identifier && target.identifier !== 'default' ? '/' + encodeURIComponent(target.identifier) : ''}${suffix}`;

  return {
    release() { releaseAccount?.(); releaseAccount = null; },
    async broadcast(target, prepared) {
      let result;

      try {
        result = await callText('/transactions/process', {
          body: prepared.signedBytes58,
          headers: { 'Content-Type': 'text/plain' },
          method: 'POST',
        });
      } catch (error) {
        // Timeouts, 5xx and Cloudflare interstitials all leave the outcome
        // unknown: the transaction may already be in the mempool.
        throw new AmbiguousBroadcastError(
          `Qortal broadcast of ${prepared.signature} for ${target.name}/${target.identifier} ` +
            `did not return a clear result: ${error.message}`,
        );
      }

      if (result.trim() !== 'true' && !result.includes('"type"')) {
        throw new AmbiguousBroadcastError(`Qortal node answered ${JSON.stringify(result.slice(0, 200))}.`);
      }
    },

    async confirm(target, receipt, payload) {
      await waitFor(`qortal transaction ${receipt.signature}`, async () => {
        const transaction = await callJson(`/transactions/signature/${receipt.signature}`);

        return typeof transaction?.blockHeight === 'number' && transaction.blockHeight > 0 ? transaction : null;
      });

      await waitFor(`qortal ${target.service}/${target.name}/${target.identifier}`, async () => {
        const status = await callJson(
          `/arbitrary/resource/status/${target.service}/${encodeURIComponent(target.name)}/` +
            `${encodeURIComponent(target.identifier)}?build=true`,
        );

        if (status?.status === 'BLOCKED' || status?.status === 'BUILD_FAILED') {
          throw new Error(`Qortal resource status is ${status.status}.`);
        }

        return status?.status === 'READY' ? status : null;
      });

      return verifyPayloadContent(payload.directory, relativeFile => call(`${resourcePath(target)}?filepath=${encodeURIComponent(relativeFile)}`));
    },

    async lookup(_target, signature) {
      try {
        return await callJson(`/transactions/signature/${signature}`);
      } catch (error) {
        if (error.status === 404) {
          return null;
        }

        // Unknown lookup failure: report "not found" only when we are sure.
        throw error;
      }
    },

    async prepare(target, payload) {
      const { account } = open();

      assertPayloadReadable(payload.directory);

      await retrySyncGate(async () => {
        const status = await callJson('/admin/status');
        if (!status || status.syncPercent !== 100 || status.isSynchronizing !== false) throw new Error('Qortal node is not synced.');
      });

      // The name must already exist and belong to us. This client never
      // registers names.
      const nameInfo = await callJson(`/names/${encodeURIComponent(target.name)}`).catch((error) => {
        if (error.status === 404) {
          return null;
        }

        throw error;
      });

      if (!nameInfo) {
        throw new Error(`Qortal name ${target.name} is not registered; register it manually before publishing.`);
      }

      if (nameInfo.owner !== account.accountAddress) {
        throw new Error(`Qortal name ${target.name} is owned by ${nameInfo.owner}, not ${account.accountAddress}.`);
      }

      const balance = parseQort(await callText(`/addresses/balance/${account.accountAddress}`));

      if (balance < config.maxFee) {
        throw new Error(
          `Qortal balance ${formatQort(balance)} QORT is below the fee cap ${formatQort(config.maxFee)} QORT.`,
        );
      }

      const feeText = (await callText('/transactions/unitfee?txType=ARBITRARY')).trim();
      if (!/^\d+$/.test(feeText)) throw new Error('Invalid Qortal unit fee response.');
      const fee = BigInt(feeText);
      if (fee <= 0n || fee > config.maxFee) throw new Error('Qortal unit fee exceeds the configured positive fee cap.');
      const unconfirmed = await callJson('/transactions/unconfirmed?creator=' + encodeURIComponent(account.accountPublicKey) + '&limit=0');
      if (!Array.isArray(unconfirmed) || unconfirmed.length) throw new Error('Qortal signing account has pending transactions; retry after confirmation.');
      const reference58 = (await callText(`/addresses/lastreference/${account.accountAddress}`)).trim();
      const publishQuery = new URLSearchParams({ fee: String(fee) });
      if (target.title) publishQuery.set('title', target.title);
      if (target.description) publishQuery.set('description', target.description);
      const unsignedBytes58 = (
        config.uploadMode === 'path'
          ? await callText(resourcePath(target, '?' + publishQuery), {
              body: payload.directory,
              headers: { 'Content-Type': 'text/plain' },
              method: 'POST',
            })
          : await callText(`${resourcePath(target)}/zip?${publishQuery}`, {
              body: zipDirectory(payload.directory).toString('base64'),
              headers: { 'Content-Type': 'text/plain' },
              method: 'POST',
            })
      ).trim();

      const parsed = parseQortalArbitraryTransaction(decodeBase58(unsignedBytes58));

      assertUnsignedTransactionMatches(parsed, {
        identifier: target.identifier === 'default' ? '' : target.identifier,
        maxFee: config.maxFee,
        fee, now: Date.now(),
        name: target.name,
        publicKey58: account.accountPublicKey,
        reference58,
        service: qortalServiceId(target.service),
      });

      if (balance < parsed.fee) {
        throw new Error(`Qortal balance ${formatQort(balance)} QORT cannot cover fee ${formatQort(parsed.fee)} QORT.`);
      }

      const { signature58, signedBytes58 } = signQortalTransaction(unsignedBytes58, account.accountPrivateKey);

      log(
        `Qortal ${target.service}/${target.name}/${target.identifier}: fee ${formatQort(parsed.fee)} QORT, ` +
          `reference ${encodeBase58(parsed.reference)}`,
      );

      return {
        fee: formatQort(parsed.fee),
        reference: encodeBase58(parsed.reference),
        signature: signature58,
        signedBytes58,
      };
    },
  };
}
