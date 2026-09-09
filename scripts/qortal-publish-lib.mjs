// Qortal chain client for the dual-target publisher.
//
// Deliberately self-contained: Qortal's ARBITRARY transaction carries a 64-byte
// `reference` field that the Qortium layout in qdn-publish-lib.mjs does not, so
// the byte handling cannot be shared. Everything here uses Node builtins only.
//
// Safety rules encoded below:
//   * the private key never leaves this process — we never call the remote
//     /transactions/sign, only /transactions/process with locally signed bytes;
//   * the unsigned transaction the node hands back is parsed and checked
//     (creator, name, identifier, service, reference, fee cap) *before* signing;
//   * the QDN name must already exist and be owned by the configured account —
//     this client never registers a name.
import crypto from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BASE58_BASE = BigInt(BASE58_ALPHABET.length);
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

const ENV_PREFIX = 'QORTIUM_NETWORK_QORTAL';
const TX_TYPE_ARBITRARY = 10;
const REFERENCE_LENGTH = 64;
const PUBLIC_KEY_LENGTH = 32;
const SIGNATURE_LENGTH = 64;
const PAYMENT_LENGTH = 25 + 8 + 8;
/** Qortal amounts are 8-decimal fixed point. */
export const QORT_UNIT = 100_000_000n;

export const DEFAULT_QORTAL_API_URL = 'https://appnode.qortal.org';
export const DEFAULT_QORTAL_ADDRESS = 'QaLdnApWW3hps1qXM8cpsL1pVgw7RtyJmN';
/** Cloudflare in front of the public API rejects the default fetch UA. */
export const DEFAULT_QORTAL_USER_AGENT = 'curl/8.7.1';
export const DEFAULT_MAX_FEE_QORT = '0.01';

export function decodeBase58(value) {
  let decoded = 0n;

  for (const character of value) {
    const index = BASE58_ALPHABET.indexOf(character);

    if (index === -1) {
      throw new Error(`Invalid Base58 character: ${character}`);
    }

    decoded = decoded * BASE58_BASE + BigInt(index);
  }

  const bytes = [];

  while (decoded > 0n) {
    bytes.unshift(Number(decoded % 256n));
    decoded /= 256n;
  }

  for (const character of value) {
    if (character !== '1') {
      break;
    }

    bytes.unshift(0);
  }

  return Buffer.from(bytes);
}

export function encodeBase58(bytes) {
  let value = 0n;

  for (const byte of bytes) {
    value = value * 256n + BigInt(byte);
  }

  let encoded = '';

  while (value > 0n) {
    encoded = BASE58_ALPHABET[Number(value % BASE58_BASE)] + encoded;
    value /= BASE58_BASE;
  }

  for (const byte of bytes) {
    if (byte !== 0) {
      break;
    }

    encoded = `1${encoded}`;
  }

  return encoded;
}

/**
 * Parse a Qortal ARBITRARY transaction (signed or unsigned).
 *
 * Layout: type(4) timestamp(8) groupId(4) reference(64) publicKey(32) nonce(4)
 *   name identifier method(4) secret compression(4) payments service(4)
 *   isDataRaw(1) data size(4) metadataHash fee(8) [signature(64)]
 * where sized fields are a 4-byte big-endian length followed by the bytes.
 */
export function parseQortalArbitraryTransaction(message) {
  let offset = 0;
  const bytes = length => {
    if (!Number.isSafeInteger(length) || length < 0 || offset + length > message.length) throw new Error('Malformed Qortal transaction length.');
    const value = message.subarray(offset, offset + length);
    offset += length;
    return value;
  };
  const int32 = () => bytes(4).readInt32BE(0);
  const int64 = () => bytes(8).readBigInt64BE(0);
  const sized = () => bytes(int32());
  if (int32() !== TX_TYPE_ARBITRARY) throw new Error('Expected ARBITRARY transaction.');
  const timestamp = Number(int64());
  const txGroupId = int32();
  const reference = bytes(64), publicKey = bytes(32), nonce = int32();
  const name = sized().toString('utf8'), identifier = sized().toString('utf8');
  const method = int32(), secret = sized(), compression = int32(), paymentCount = int32();
  if (paymentCount < 0 || paymentCount > 400) throw new Error('Invalid payment count.');
  bytes(paymentCount * PAYMENT_LENGTH);
  const service = int32(), isDataRawOffset = offset, isDataRaw = bytes(1)[0], dataOffset = offset;
  const data = sized(), size = int32(), metadataHash = sized(), fee = int64();
  if (![0, 1].includes(isDataRaw) || (isDataRaw === 0 && data.length !== 32)) throw new Error('Invalid Qortal data hash/type.');
  if (size < 0 || ![0, 32].includes(metadataHash.length)) throw new Error('Invalid Qortal data size/metadata.');
  const unsignedLength = offset;
  if (![0, 64].includes(message.length - offset)) throw new Error('Unexpected trailing Qortal transaction bytes.');
  const signature = message.length === offset ? null : bytes(64);
  return { compression, data, dataOffset, fee, identifier, isDataRaw, isDataRawOffset,
    method, name, nonce, publicKey, reference, service, signature, size, timestamp,
    txGroupId, unsignedLength, secret, paymentCount, metadataHash };
}

/**
 * ARBITRARY transactions are signed over `toBytesForSigning`, which drops the
 * 1-byte "is data raw?" flag and, for RAW_DATA, signs the SHA-256 of the data
 * instead of the data itself. Mirrors Qortal's ArbitraryTransactionTransformer.
 */
export function qortalArbitrarySigningBytes(message) {
  const parsed = parseQortalArbitraryTransaction(message);
  const head = message.subarray(0, parsed.isDataRawOffset);
  const tail = message.subarray(parsed.dataOffset, parsed.unsignedLength);

  if (parsed.isDataRaw === 0) {
    // DATA_HASH: the data field already holds the hash.
    return Buffer.concat([head, tail]);
  }

  const digest = crypto.createHash('sha256').update(parsed.data).digest();
  const dataLengthBytes = message.subarray(parsed.dataOffset, parsed.dataOffset + 4);
  const afterData = message.subarray(parsed.dataOffset + 4 + parsed.data.length, parsed.unsignedLength);

  return Buffer.concat([head, dataLengthBytes, digest, afterData]);
}

/** Sign locally with the account's Ed25519 seed and append the 64-byte signature. */
export function signQortalTransaction(unsignedBytes58, privateKey58) {
  const privateBytes = decodeBase58(privateKey58);
  if (![32, 64].includes(privateBytes.length)) throw new Error('Invalid Ed25519 key length.');
  const seed = privateBytes.subarray(0, 32);

  if (seed.length !== 32) {
    throw new Error('Qortal account private key must contain at least 32 bytes.');
  }

  const message = decodeBase58(unsignedBytes58);
  const key = crypto.createPrivateKey({
    format: 'der',
    key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]),
    type: 'pkcs8',
  });
  if (parseQortalArbitraryTransaction(message).signature) throw new Error('Refusing to sign an already signed transaction.');
  const signingBytes = qortalArbitrarySigningBytes(message);
  const signature = crypto.sign(null, signingBytes, key);
  if (!crypto.verify(null, signingBytes, crypto.createPublicKey(key), signature)) throw new Error('Local signature verification failed.');

  return { signature58: encodeBase58(signature), signedBytes58: encodeBase58(Buffer.concat([message, signature])) };
}

/**
 * Reject anything about the node-built transaction that we did not ask for
 * before it is signed: a wrong creator, a redirected resource, or a fee above
 * the operator's cap.
 */
export function assertUnsignedTransactionMatches(parsed, expected) {
  const problems = [];
  if (parsed.signature || parsed.paymentCount !== 0 || ![0, 32].includes(parsed.secret.length) || parsed.txGroupId !== 0) problems.push('unexpected signature, payments, secret or group');
  if (![0, 1].includes(parsed.method) || ![0, 1].includes(parsed.compression)) problems.push('unsupported publication method/compression');
  if (expected.fee !== undefined && parsed.fee !== expected.fee) problems.push('fee differs from requested unit fee');
  if (expected.now !== undefined && Math.abs(parsed.timestamp - expected.now) > 300000) problems.push('unexpected timestamp');

  if (encodeBase58(parsed.publicKey) !== expected.publicKey58) {
    problems.push('creator public key does not match the configured account');
  }

  if (parsed.name !== expected.name) {
    problems.push(`name is ${JSON.stringify(parsed.name)} (expected ${JSON.stringify(expected.name)})`);
  }

  if (parsed.identifier !== expected.identifier) {
    problems.push(`identifier is ${JSON.stringify(parsed.identifier)} (expected ${JSON.stringify(expected.identifier)})`);
  }

  if (parsed.service !== expected.service) {
    problems.push(`service is ${parsed.service} (expected ${expected.service})`);
  }

  if (parsed.fee > expected.maxFee) {
    problems.push(`fee ${formatQort(parsed.fee)} exceeds the cap ${formatQort(expected.maxFee)}`);
  }

  if (parsed.fee < 0n) {
    problems.push(`fee ${parsed.fee} is negative`);
  }

  if (expected.reference58 && encodeBase58(parsed.reference) !== expected.reference58) {
    problems.push('reference does not match the account last reference');
  }

  if (problems.length > 0) {
    throw new Error(`Refusing to sign the Qortal transaction: ${problems.join('; ')}.`);
  }
}

export function formatQort(raw) {
  const value = BigInt(raw);
  const whole = value / QORT_UNIT;
  const fraction = (value % QORT_UNIT).toString().padStart(8, '0');

  return `${whole}.${fraction}`;
}

export function parseQort(text) {
  const trimmed = String(text).trim();

  if (!/^\d+(\.\d{1,8})?$/.test(trimmed)) {
    throw new Error(`Not a QORT amount: ${JSON.stringify(text)}`);
  }

  const [whole, fraction = ''] = trimmed.split('.');

  return BigInt(whole) * QORT_UNIT + BigInt(fraction.padEnd(8, '0').slice(0, 8));
}

// --- Minimal STORE-only ZIP writer ------------------------------------------
// The remote Qortal API cannot read a local directory, so a payload has to be
// uploaded. Building the archive here (stored, not deflated) keeps the client on
// Node builtins and makes the upload byte-for-byte reproducible.

const CRC32_TABLE = (() => {
  const table = new Int32Array(256);

  for (let index = 0; index < 256; index += 1) {
    let value = index;

    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xed_b8_83_20 ^ (value >>> 1) : value >>> 1;
    }

    table[index] = value;
  }

  return table;
})();

export function crc32(buffer) {
  let crc = -1;

  for (const byte of buffer) {
    crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }

  return (crc ^ -1) >>> 0;
}

function listFilesRecursively(directory, prefix = '') {
  const files = [];

  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const full = path.join(directory, entry.name);
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;

    if (entry.isDirectory()) {
      files.push(...listFilesRecursively(full, relative));
    } else if (entry.isFile()) {
      files.push({ full, relative });
    }
  }

  return files;
}

/** Deterministic stored-entry zip of `directory` (fixed 1980-01-01 timestamps). */
export function zipDirectory(directory) {
  const files = listFilesRecursively(directory);
  const local = [];
  const central = [];
  let offset = 0;

  for (const file of files) {
    const nameBytes = Buffer.from(file.relative, 'utf8');
    const contents = readFileSync(file.full);
    const checksum = crc32(contents);

    const localHeader = Buffer.alloc(30);

    localHeader.writeUInt32LE(0x04_03_4b_50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt16LE(0, 10); // time
    localHeader.writeUInt16LE(0x00_21, 12); // date: 1980-01-01
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(contents.length, 18);
    localHeader.writeUInt32LE(contents.length, 22);
    localHeader.writeUInt16LE(nameBytes.length, 26);
    localHeader.writeUInt16LE(0, 28);

    const centralHeader = Buffer.alloc(46);

    centralHeader.writeUInt32LE(0x02_01_4b_50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0x00_21, 14);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(contents.length, 20);
    centralHeader.writeUInt32LE(contents.length, 24);
    centralHeader.writeUInt16LE(nameBytes.length, 28);
    centralHeader.writeUInt32LE(0, 30); // extra + comment lengths
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);

    local.push(localHeader, nameBytes, contents);
    central.push(centralHeader, nameBytes);
    offset += localHeader.length + nameBytes.length + contents.length;
  }

  const centralBuffer = Buffer.concat(central);
  const end = Buffer.alloc(22);

  end.writeUInt32LE(0x06_05_4b_50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...local, centralBuffer, end]);
}

// --- Configuration ----------------------------------------------------------

function expandHomePath(filePath) {
  if (filePath === '~') {
    return homedir();
  }

  return filePath.startsWith('~/') ? path.join(homedir(), filePath.slice(2)) : filePath;
}

function isLoopback(apiUrl) {
  try {
    const hostname = new URL(apiUrl).hostname.toLowerCase();

    return hostname === 'localhost' || hostname === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(hostname);
  } catch {
    return false;
  }
}

export function buildQortalConfig(env = process.env) {
  const read = (name) => env[`${ENV_PREFIX}_${name}`];
  const apiUrl = (read('API_URL') ?? DEFAULT_QORTAL_API_URL).replace(/\/+$/, '');
  const accountPath = read('ACCOUNT_PATH');

  if (!accountPath) {
    throw new Error(`${ENV_PREFIX}_ACCOUNT_PATH must point at the Qortal signing account file.`);
  }

  const endpoint = new URL(apiUrl);
  if (endpoint.username || endpoint.password || (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && isLoopback(apiUrl)))) throw new Error('Qortal endpoint must use HTTPS, or loopback HTTP, without URL credentials.');
  const uploadMode = read('UPLOAD_MODE') ?? (isLoopback(apiUrl) ? 'path' : 'zip');
  if (!['path', 'zip'].includes(uploadMode) || (uploadMode === 'path' && !isLoopback(apiUrl))) throw new Error('Remote Qortal nodes require zip upload.');
  return {
    accountPath: expandHomePath(accountPath),
    accountRole: read('ACCOUNT_ROLE') ?? 'qortal',
    apiKey: read('API_KEY')?.trim() || null,
    apiKeyPath: read('API_KEY_PATH') ? expandHomePath(read('API_KEY_PATH')) : null,
    apiUrl,
    expectedAddress: read('ADDRESS') ?? DEFAULT_QORTAL_ADDRESS,
    maxFee: parseQort(read('MAX_FEE') ?? DEFAULT_MAX_FEE_QORT),
    uploadMode,
    userAgent: read('USER_AGENT') ?? DEFAULT_QORTAL_USER_AGENT,
  };
}

/**
 * Load the signing account from a local file. Accepts either a bare account
 * object or the `{ accounts: [{ role, ... }] }` shape the Qortium tooling uses.
 */
export function loadQortalAccount(config) {
  const parsed = JSON.parse(readFileSync(config.accountPath, 'utf8'));
  const account = Array.isArray(parsed?.accounts)
    ? parsed.accounts.find((item) => item.role === config.accountRole)
    : parsed;

  if (!account?.accountAddress || !account?.accountPrivateKey || !account?.accountPublicKey) {
    throw new Error(
      `Qortal account with role ${config.accountRole} was not found in ${config.accountPath} ` +
        '(need accountAddress, accountPublicKey, accountPrivateKey).',
    );
  }

  if (config.expectedAddress && account.accountAddress !== config.expectedAddress) {
    throw new Error(
      `Qortal account file holds ${account.accountAddress} but ${ENV_PREFIX}_ADDRESS expects ${config.expectedAddress}.`,
    );
  }

  const privateBytes = decodeBase58(account.accountPrivateKey);
  if (![32, 64].includes(privateBytes.length)) throw new Error('Invalid Qortal account key length.');
  const privateKey = crypto.createPrivateKey({format:'der', type:'pkcs8', key:Buffer.concat([ED25519_PKCS8_PREFIX, privateBytes.subarray(0,32)])});
  const pub = crypto.createPublicKey(privateKey).export({format:'der', type:'spki'}).subarray(-32);
  const hash = crypto.createHash('ripemd160').update(crypto.createHash('sha256').update(pub).digest()).digest();
  const address = Buffer.concat([Buffer.from([58]), hash]);
  const checksum = crypto.createHash('sha256').update(crypto.createHash('sha256').update(address).digest()).digest().subarray(0,4);
  if (encodeBase58(pub) !== account.accountPublicKey || encodeBase58(Buffer.concat([address,checksum])) !== account.accountAddress) throw new Error('Qortal signing key does not match configured public identity.');
  return account;
}

export function readQortalApiKey(config) {
  if (config.apiKey) {
    return config.apiKey;
  }

  return config.apiKeyPath ? readFileSync(config.apiKeyPath, 'utf8').trim() : null;
}

export function assertPayloadReadable(directory) {
  if (!statSync(directory).isDirectory()) {
    throw new Error(`Qortal payload source is not a directory: ${directory}`);
  }
}
