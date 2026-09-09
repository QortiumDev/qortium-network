import crypto from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertUnsignedTransactionMatches,
  buildQortalConfig,
  crc32,
  decodeBase58,
  encodeBase58,
  formatQort,
  loadQortalAccount,
  parseQort,
  parseQortalArbitraryTransaction,
  qortalArbitrarySigningBytes,
  signQortalTransaction,
  zipDirectory,
} from './qortal-publish-lib.mjs';

const temporaryDirectories = [];

function makeTempDir() {
  const directory = mkdtempSync(path.join(tmpdir(), 'qortal-publish-'));

  temporaryDirectories.push(directory);

  return directory;
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop(), { force: true, recursive: true });
  }
});

const int32 = (value) => {
  const buffer = Buffer.alloc(4);

  buffer.writeInt32BE(value);

  return buffer;
};

const int64 = (value) => {
  const buffer = Buffer.alloc(8);

  buffer.writeBigInt64BE(BigInt(value));

  return buffer;
};

const sized = (value) => Buffer.concat([int32(value.length), Buffer.from(value)]);

/** Build a Qortal ARBITRARY transaction, including its 64-byte reference. */
function buildArbitrary({
  data = crypto.createHash('sha256').update('payload').digest(),
  fee = 1_000_000,
  identifier = 'Network',
  isDataRaw = 0,
  name = 'xnetwork',
  publicKey = Buffer.alloc(32, 7),
  reference = Buffer.alloc(64, 3),
  service = 1700,
} = {}) {
  return Buffer.concat([
    int32(10),
    int64(1_757_000_000_000),
    int32(0),
    reference,
    publicKey,
    int32(0), // nonce
    sized(name),
    sized(identifier),
    int32(0), // method
    int32(0), // secret length
    int32(0), // compression
    int32(0), // payment count
    int32(service),
    Buffer.from([isDataRaw]),
    sized(data),
    int32(data.length),
    int32(0), // metadata hash length
    int64(fee),
  ]);
}

describe('base58', () => {
  it('round-trips arbitrary bytes including leading zeroes', () => {
    for (const bytes of [Buffer.alloc(0), Buffer.from([0, 0, 1, 2, 3]), crypto.randomBytes(64)]) {
      expect(decodeBase58(encodeBase58(bytes))).toEqual(bytes);
    }
  });
});

describe('Qortal ARBITRARY transaction bytes', () => {
  it('parses the 64-byte reference field that the Qortium layout does not have', () => {
    const reference = crypto.randomBytes(64);
    const publicKey = crypto.randomBytes(32);
    const parsed = parseQortalArbitraryTransaction(buildArbitrary({ publicKey, reference }));

    expect(parsed.reference).toEqual(reference);
    expect(parsed.publicKey).toEqual(publicKey);
    expect(parsed.name).toBe('xnetwork');
    expect(parsed.identifier).toBe('Network');
    expect(parsed.service).toBe(1700);
    expect(parsed.fee).toBe(1_000_000n);
    expect(parsed.signature).toBeNull();
  });

  it('drops the is-raw flag for DATA_HASH and hashes the data for RAW_DATA', () => {
    const hashed = buildArbitrary();

    expect(qortalArbitrarySigningBytes(hashed)).toHaveLength(hashed.length - 1);

    const raw = Buffer.from('a raw payload that is longer than a digest', 'utf8');
    const signing = qortalArbitrarySigningBytes(buildArbitrary({ data: raw, isDataRaw: 1 }));

    expect(signing.includes(crypto.createHash('sha256').update(raw).digest())).toBe(true);
    expect(signing.includes(raw)).toBe(false);
  });

  it('produces a signature the Ed25519 public key verifies over the signing bytes', () => {
    const seed = crypto.randomBytes(32);
    const key = crypto.createPrivateKey({
      format: 'der',
      key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]),
      type: 'pkcs8',
    });
    const publicKey = crypto.createPublicKey(key).export({ format: 'der', type: 'spki' }).subarray(-32);
    const unsigned = buildArbitrary({ publicKey });
    const { signature58, signedBytes58 } = signQortalTransaction(encodeBase58(unsigned), encodeBase58(seed));
    const signature = decodeBase58(signature58);

    expect(signature).toHaveLength(64);
    expect(crypto.verify(null, qortalArbitrarySigningBytes(unsigned), key, signature)).toBe(true);
    expect(decodeBase58(signedBytes58)).toEqual(Buffer.concat([unsigned, signature]));
    expect(parseQortalArbitraryTransaction(decodeBase58(signedBytes58)).signature).toEqual(signature);
  });
});

describe('pre-signing checks', () => {
  const publicKey = Buffer.alloc(32, 7);
  const reference = Buffer.alloc(64, 3);
  const parsed = parseQortalArbitraryTransaction(buildArbitrary());
  const expected = {
    identifier: 'Network',
    maxFee: parseQort('0.01'),
    name: 'xnetwork',
    publicKey58: encodeBase58(publicKey),
    reference58: encodeBase58(reference),
    service: 1700,
  };

  it('accepts a transaction that matches what was requested', () => {
    expect(() => assertUnsignedTransactionMatches(parsed, expected)).not.toThrow();
  });

  it('refuses to sign a redirected, foreign, or over-priced transaction', () => {
    expect(() => assertUnsignedTransactionMatches(parsed, { ...expected, name: 'somebody-else' })).toThrow(/name is/);
    expect(() => assertUnsignedTransactionMatches(parsed, { ...expected, identifier: 'Other' })).toThrow(/identifier/);
    expect(() => assertUnsignedTransactionMatches(parsed, { ...expected, service: 200 })).toThrow(/service/);
    expect(() => assertUnsignedTransactionMatches(parsed, { ...expected, publicKey58: encodeBase58(Buffer.alloc(32, 9)) })).toThrow(
      /creator public key/,
    );
    expect(() => assertUnsignedTransactionMatches(parsed, { ...expected, maxFee: parseQort('0.001') })).toThrow(/fee/);
    expect(() => assertUnsignedTransactionMatches(parsed, { ...expected, reference58: encodeBase58(Buffer.alloc(64, 4)) })).toThrow(
      /reference/,
    );
  });
});

describe('QORT amounts', () => {
  it('converts between decimal QORT and the 8-decimal on-chain integer', () => {
    expect(parseQort('0.01')).toBe(1_000_000n);
    expect(parseQort('1')).toBe(100_000_000n);
    expect(formatQort(1_000_000n)).toBe('0.01000000');
    expect(() => parseQort('-1')).toThrow();
    expect(() => parseQort('lots')).toThrow();
  });
});

describe('configuration', () => {
  it('defaults to the public Qortal API with a curl user agent, and requires an account path', () => {
    expect(() => buildQortalConfig({})).toThrow(/ACCOUNT_PATH/);

    const config = buildQortalConfig({ QORTIUM_NETWORK_QORTAL_ACCOUNT_PATH: '/tmp/account.json' });

    expect(config.apiUrl).toBe('https://appnode.qortal.org');
    expect(config.userAgent).toMatch(/^curl\//);
    expect(config.uploadMode).toBe('zip');
    expect(config.maxFee).toBe(parseQort('0.01'));

    // A loopback node can read the payload straight off disk.
    expect(
      buildQortalConfig({
        QORTIUM_NETWORK_QORTAL_ACCOUNT_PATH: '/tmp/account.json',
        QORTIUM_NETWORK_QORTAL_API_URL: 'http://127.0.0.1:12391',
      }).uploadMode,
    ).toBe('path');
  });

  it('rejects an account file that is not the expected owner', () => {
    const directory = makeTempDir();
    const accountPath = path.join(directory, 'account.json');

    writeFileSync(
      accountPath,
      JSON.stringify({
        accounts: [
          {
            accountAddress: 'QsomeoneElse00000000000000000000000',
            accountPrivateKey: 'key',
            accountPublicKey: 'pub',
            role: 'qortal',
          },
        ],
      }),
    );

    const config = buildQortalConfig({ QORTIUM_NETWORK_QORTAL_ACCOUNT_PATH: accountPath });

    expect(() => loadQortalAccount(config)).toThrow(/expects QaLdnApWW3hps1qXM8cpsL1pVgw7RtyJmN/);
  });
});

describe('payload archive', () => {
  it('builds a deterministic stored zip whose entries carry valid CRCs', () => {
    const directory = makeTempDir();

    writeFileSync(path.join(directory, 'manifest.json'), '{"records":1}');

    const archive = zipDirectory(directory);
    const contents = Buffer.from('{"records":1}');

    expect(archive.readUInt32LE(0)).toBe(0x04_03_4b_50);
    expect(archive.readUInt32LE(14)).toBe(crc32(contents));
    expect(archive.readUInt32LE(archive.length - 22)).toBe(0x06_05_4b_50);
    expect(archive.readUInt16LE(archive.length - 12)).toBe(1);
    // Reproducible: the same payload must upload as identical bytes on retry.
    expect(zipDirectory(directory)).toEqual(archive);
  });

  it('matches a known CRC32 vector', () => {
    expect(crc32(Buffer.from('123456789'))).toBe(0xcb_f4_39_26);
  });
});
