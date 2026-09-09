// Fan one already-built DATABASE payload out to one or more chains.
//
// Qortium stays the default and only target; the Qortal target is opt-in via an
// explicit environment flag. Both targets consume the *same* immutable payload,
// and each keeps its own receipt, so a failure on one chain never changes the
// dataset the other chain will (or already did) receive.
//
// The chain-specific work sits behind a small adapter contract so the state
// machine below is testable without a node:
//
//   prepare(target, payload)            -> { signature, signedBytes58, fee, reference }
//   broadcast(target, prepared)         -> void   (throws when the result is unknown)
//   lookup(target, signature)           -> truthy when the chain has seen it
//   confirm(target, receipt, payload)   -> void   (throws until tx + content agree)
//
// `prepare` is the only step that signs. Its output is persisted *before*
// `broadcast` runs, so an ambiguous broadcast is always resolved by re-checking
// or re-sending the same signature — never by signing a second transaction.
import { TARGET_STATUS } from './dual-publish-state.mjs';

const ENV_PREFIX = 'QORTIUM_NETWORK';

export const DEFAULT_MAX_ATTEMPTS = 5;
export const QORTAL_DEFAULT_NAME = 'xnetwork';
export const QORTAL_DEFAULT_IDENTIFIER = 'Network';
/** Matches the description the single-chain publisher has always used. */
const DATABASE_DESCRIPTION = 'Qortium network topology latest database';

/** Raised by an adapter when a broadcast neither clearly succeeded nor failed. */
export class AmbiguousBroadcastError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AmbiguousBroadcastError';
  }
}

export class PayloadChangedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PayloadChangedError';
  }
}

function isEnabled(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value ?? '').trim().toLowerCase());
}

/**
 * Resolve the publish targets. Qortium is always present; Qortal is added only
 * when QORTIUM_NETWORK_QORTAL_PUBLISH is explicitly truthy.
 */
export function resolveTargets(env = process.env) {
  const read = (name) => env[`${ENV_PREFIX}_${name}`];
  const qortiumName = read('QDN_NAME') ?? 'Network';
  const qortiumIdentifier = read('QDN_IDENTIFIER') ?? 'Network';

  const title = read('QDN_TITLE') ?? 'Network';
  const targets = [
    {
      chain: 'qortium',
      description: DATABASE_DESCRIPTION,
      identifier: qortiumIdentifier,
      key: 'qortium',
      name: qortiumName,
      service: read('DATABASE_SERVICE') ?? 'DATABASE',
      title,
    },
  ];

  if (isEnabled(read('QORTAL_PUBLISH'))) {
    targets.push({
      chain: 'qortal',
      description: DATABASE_DESCRIPTION,
      identifier: read('QORTAL_QDN_IDENTIFIER') ?? QORTAL_DEFAULT_IDENTIFIER,
      key: 'qortal',
      name: read('QORTAL_QDN_NAME') ?? QORTAL_DEFAULT_NAME,
      service: read('QORTAL_DATABASE_SERVICE') ?? 'DATABASE',
      title: read('QORTAL_QDN_TITLE') ?? title,
    });
  }

  return targets;
}

export function describeTarget(target) {
  return `${target.chain}:qdn://${target.service}/${target.name}/${target.identifier}`;
}

/** True once every target in `targets` has a PUBLISHED receipt. */
export function isPendingComplete(pending, targets) {
  return targets.every((target) => pending.targets[target.key]?.status === TARGET_STATUS.PUBLISHED);
}

export function summarizePending(pending, targets) {
  return targets
    .map((target) => `${target.key}=${pending.targets[target.key]?.status ?? TARGET_STATUS.PENDING}`)
    .join(' ');
}

async function runTarget({ adapter, log, now, payload, target, targetState, persist }) {
  targetState.attempts += 1;
  targetState.service = target.service;
  targetState.name = target.name;
  targetState.identifier = target.identifier;
  delete targetState.lastError;

  if (targetState.signature && targetState.status === TARGET_STATUS.FAILED) targetState.status = TARGET_STATUS.UNCERTAIN;
  if (targetState.status === TARGET_STATUS.UNCERTAIN) {
    // The previous run signed and sent, but never learned the outcome. Resolve
    // it with the *stored* signature; signing again could spend twice.
    log(`${describeTarget(target)}: reconciling uncertain broadcast ${targetState.signature}`);

    if (await adapter.lookup(target, targetState.signature)) {
      log(`${describeTarget(target)}: earlier broadcast was accepted.`);
      targetState.status = TARGET_STATUS.BROADCAST;
    } else if (targetState.signedBytes58) {
      await adapter.broadcast(target, {
        reference: targetState.reference,
        signature: targetState.signature,
        signedBytes58: targetState.signedBytes58,
      });
      targetState.status = TARGET_STATUS.BROADCAST;
    } else {
      throw new Error(
        `${describeTarget(target)} has signature ${targetState.signature} but no stored bytes to re-send; ` +
          'resolve it manually before retrying.',
      );
    }

    await persist();
  }

  if (targetState.status !== TARGET_STATUS.BROADCAST) {
    const prepared = await adapter.prepare(target, payload);

    targetState.broadcastAt = new Date(now()).toISOString();
    targetState.fee = prepared.fee;
    targetState.reference = prepared.reference;
    targetState.signature = prepared.signature;
    targetState.signedBytes58 = prepared.signedBytes58;
    targetState.status = TARGET_STATUS.UNCERTAIN;

    // Persisted before the wire call: from here on the signature is recoverable
    // no matter how the process dies.
    await persist();

    await adapter.broadcast(target, prepared);

    targetState.status = TARGET_STATUS.BROADCAST;
    await persist();
  }

  targetState.contentVerification = await adapter.confirm(target, { signature: targetState.signature }, payload);

  targetState.confirmedAt = new Date(now()).toISOString();
  targetState.status = TARGET_STATUS.PUBLISHED;
  await persist();

  log(`${describeTarget(target)}: published (${targetState.signature}).`);
}

/**
 * Drive every target once. Targets are independent: an already-PUBLISHED target
 * is skipped without re-spending, and a failing target does not stop the others.
 * Returns the per-target failures (empty when all targets are published).
 */
export async function publishToTargets({
  adapters,
  log = console.log,
  now = Date.now,
  payload,
  pending,
  persist,
  targets,
}) {
  if (payload.digest !== pending.payloadDigest) {
    throw new PayloadChangedError(
      `Pending payload digest ${pending.payloadDigest} no longer matches ${payload.digest} in ${payload.directory}; ` +
        'the retry would publish a different dataset.',
    );
  }

  for (const [key, receipt] of Object.entries(pending.targets)) {
    const target = targets.find(item => item.key === key);
    if (!target || ['service', 'name', 'identifier'].some(field => receipt[field] !== undefined && receipt[field] !== target[field])) {
      throw new Error('Pending publication destinations changed; reconcile the saved receipts before changing targets.');
    }
  }
  const failures = [];

  for (const target of targets) {
    const targetState = (pending.targets[target.key] ??= { attempts: 0, status: TARGET_STATUS.PENDING });

    if (targetState.status === TARGET_STATUS.PUBLISHED) {
      log(`${describeTarget(target)}: already published (${targetState.signature ?? 'no signature'}); skipping.`);
      continue;
    }

    let adapter;
    try {
      // Resolved inside the try because adapter construction itself validates
      // that chain's configuration, and a broken target must not stop the rest.
      adapter = adapters[target.key];

      if (!adapter) {
        throw new Error(`No adapter configured for target ${target.key}.`);
      }

      await runTarget({ adapter, log, now, payload, persist, target, targetState });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const alreadySent = Boolean(targetState.signature);

      // Only a target that never got as far as signing may be marked FAILED:
      // FAILED restarts at `prepare`, so downgrading an already-sent target
      // (say, because confirmation timed out) would sign a *second* spend.
      if (!alreadySent) {
        targetState.status = TARGET_STATUS.FAILED;
      }

      targetState.lastError = message;
      failures.push({ message, target: target.key });
      log(`${describeTarget(target)}: ${targetState.status} - ${message}`);
      await persist();
    } finally {
      adapter?.release?.();
    }
  }

  return failures;
}
