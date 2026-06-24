import crypto from 'node:crypto';
import { existsSync, readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Standard PKCS8 DER prefix for an Ed25519 private key, followed by the 32-byte
// seed. Lets us build a Node key object from a raw seed for local signing.
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const TX_TYPE_ARBITRARY = 10;
// PaymentData = recipient(25) + assetId(8) + amount(8).
const ARBITRARY_PAYMENT_LENGTH = 25 + 8 + 8;

export const ENV_PREFIX = 'QORTIUM_NETWORK';
export const DEFAULT_NODE_API_URL = 'http://127.0.0.1:24891';
export const DEFAULT_NAME = 'Network';
export const DEFAULT_IDENTIFIER = 'Network';
export const DEFAULT_TITLE = 'Network';
export const DEFAULT_DESCRIPTION = 'Qortium network topology viewer and data.';

const POLL_INTERVAL_MS = 5_000;
const POLL_TIMEOUT_MS = 180_000;
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BASE58_BASE = BigInt(BASE58_ALPHABET.length);
const REGISTER_NAME_TRANSACTION_TYPE = 3;

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readEnv(name) {
  return process.env[`${ENV_PREFIX}_${name}`];
}

export function expandHomePath(filePath) {
  if (filePath === '~') {
    return homedir();
  }

  if (filePath.startsWith('~/')) {
    return path.join(homedir(), filePath.slice(2));
  }

  return filePath;
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function readText(filePath) {
  return readFileSync(filePath, 'utf8').trim();
}

function getNodeApiPort(nodeApiUrl) {
  try {
    const url = new URL(nodeApiUrl);

    if (url.port) {
      return Number(url.port);
    }

    return url.protocol === 'https:' ? 443 : 80;
  } catch {
    return null;
  }
}

function isLoopbackNodeApiUrl(nodeApiUrl) {
  try {
    const url = new URL(nodeApiUrl);
    const hostname = url.hostname.toLowerCase();

    return (
      hostname === 'localhost' ||
      hostname === '::1' ||
      hostname === '[::1]' ||
      /^127(?:\.\d{1,3}){3}$/.test(hostname)
    );
  } catch {
    return false;
  }
}

function getQortiumCoreProcessPaths(args, cwd) {
  const jarIndex = args.findIndex((arg) => arg === '-jar');
  const jarPath = jarIndex >= 0 ? args[jarIndex + 1] ?? '' : '';
  const settingsPath = jarIndex >= 0 ? args[jarIndex + 2] ?? '' : '';
  const jarName = path.basename(jarPath).toLowerCase();

  if (!jarName.startsWith('qortium') || !jarName.endsWith('.jar') || !settingsPath) {
    return null;
  }

  return {
    jarPath: path.isAbsolute(jarPath) ? jarPath : path.resolve(cwd, jarPath),
    settingsPath: path.isAbsolute(settingsPath) ? settingsPath : path.resolve(cwd, settingsPath),
  };
}

function getConfiguredApiKeyPath(settings, cwd) {
  const configuredApiKeyPath =
    settings && typeof settings.apiKeyPath === 'string' ? settings.apiKeyPath.trim() : '';
  const apiKeyDirectory = configuredApiKeyPath
    ? path.isAbsolute(configuredApiKeyPath)
      ? configuredApiKeyPath
      : path.resolve(cwd, configuredApiKeyPath)
    : cwd;

  return path.join(apiKeyDirectory, 'apikey.txt');
}

function getRunningLocalCoreApiKeyPath(nodeApiUrl) {
  if (process.platform !== 'linux' || !isLoopbackNodeApiUrl(nodeApiUrl)) {
    return null;
  }

  const requestedApiPort = getNodeApiPort(nodeApiUrl);
  const candidates = [];

  for (const entry of readdirSync('/proc', { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) {
      continue;
    }

    try {
      const procPath = path.join('/proc', entry.name);
      const args = readFileSync(path.join(procPath, 'cmdline'), 'utf8')
        .split('\0')
        .filter(Boolean);
      const cwd = readlinkSync(path.join(procPath, 'cwd'));
      const coreProcessPaths = getQortiumCoreProcessPaths(args, cwd);

      if (!coreProcessPaths) {
        continue;
      }

      const settings = readJson(coreProcessPaths.settingsPath);
      const apiPort = Number(settings?.apiPort);

      if (requestedApiPort && Number.isFinite(apiPort) && apiPort !== requestedApiPort) {
        continue;
      }

      const candidateApiKeyPath = getConfiguredApiKeyPath(settings, cwd);

      if (existsSync(candidateApiKeyPath) && readText(candidateApiKeyPath)) {
        candidates.push(candidateApiKeyPath);
      }
    } catch {
      // Processes can exit while /proc is being scanned.
    }
  }

  return candidates.length === 1 ? candidates[0] : null;
}

function decodeBase58(value) {
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

function encodeBase58(bytes) {
  let value = 0n;

  for (const byte of bytes) {
    value = value * 256n + BigInt(byte);
  }

  let encoded = '';

  while (value > 0n) {
    const remainder = Number(value % BASE58_BASE);

    value /= BASE58_BASE;
    encoded = BASE58_ALPHABET[remainder] + encoded;
  }

  for (const byte of bytes) {
    if (byte !== 0) {
      break;
    }

    encoded = '1' + encoded;
  }

  return encoded || '1';
}

function intBytes(value) {
  const bytes = Buffer.alloc(4);

  bytes.writeInt32BE(value);

  return bytes;
}

function longBytes(value) {
  const bytes = Buffer.alloc(8);

  bytes.writeBigInt64BE(BigInt(value));

  return bytes;
}

function sizedStringBytes(value) {
  const stringBytes = Buffer.from(value, 'utf8');

  return Buffer.concat([intBytes(stringBytes.length), stringBytes]);
}

function buildRegisterNameRawBytes58({ account, data, name, timestamp }) {
  const publicKey = decodeBase58(account.accountPublicKey);

  if (publicKey.length !== 32) {
    throw new Error(`Local account public key must decode to 32 bytes, got ${publicKey.length}.`);
  }

  return encodeBase58(
    Buffer.concat([
      intBytes(REGISTER_NAME_TRANSACTION_TYPE),
      longBytes(timestamp),
      intBytes(0),
      publicKey,
      intBytes(0),
      sizedStringBytes(name),
      sizedStringBytes(data),
      longBytes(0),
    ]),
  );
}

function appendQuery(pathname, query) {
  const queryParams = new URLSearchParams();

  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') {
      continue;
    }

    queryParams.set(key, String(value));
  }

  const queryString = queryParams.toString();

  return queryString ? `${pathname}?${queryString}` : pathname;
}

function buildConfig() {
  const nodeApiUrl = (readEnv('NODE_API_URL') ?? DEFAULT_NODE_API_URL).replace(/\/+$/, '');
  const apiKeyPath = expandHomePath(readEnv('NODE_API_KEY_PATH') ?? '~/git/qortium/preview/apikey.txt');
  const previewAccountsPath = expandHomePath(
    readEnv('PREVIEW_ACCOUNTS_PATH') ?? '~/git/qortium/preview/secrets/initial-minting-accounts.json',
  );

  return {
    apiKeyPath,
    nodeApiUrl,
    previewAccountsPath,
  };
}

function getApiKey(config) {
  const explicitApiKey = readEnv('NODE_API_KEY')?.trim();

  if (explicitApiKey) {
    return explicitApiKey;
  }

  if (readEnv('NODE_API_KEY_PATH')?.trim()) {
    return readText(config.apiKeyPath);
  }

  const runningCoreApiKeyPath = getRunningLocalCoreApiKeyPath(config.nodeApiUrl);

  if (runningCoreApiKeyPath) {
    return readText(runningCoreApiKeyPath);
  }

  return readText(config.apiKeyPath);
}

function getLocalPreviewAccount(config) {
  const previewAccounts = readJson(config.previewAccountsPath);
  const accountRole = readEnv('PREVIEW_ACCOUNT_ROLE') ?? 'local';
  const account = previewAccounts.accounts?.find((item) => item.role === accountRole);

  if (!account?.accountAddress || !account?.accountPrivateKey || !account?.accountPublicKey) {
    throw new Error(`Preview account with role ${accountRole} was not found in ${config.previewAccountsPath}.`);
  }

  return account;
}

async function request(config, apiKey, pathname, options = {}) {
  const response = await fetch(`${config.nodeApiUrl}${pathname}`, {
    ...options,
    headers: {
      ...(apiKey ? { 'X-API-KEY': apiKey } : {}),
      ...(options.headers ?? {}),
    },
  });
  const text = await response.text();

  if (!response.ok) {
    throw new Error(text || `${options.method ?? 'GET'} ${pathname} failed with HTTP ${response.status}.`);
  }

  return text;
}

async function requestJson(config, apiKey, pathname, options = {}) {
  const text = await request(config, apiKey, pathname, options);

  return text ? JSON.parse(text) : null;
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

  throw new Error(
    `Timed out waiting for ${label}.${lastError instanceof Error ? ` Last error: ${lastError.message}` : ''}`,
  );
}

// ARBITRARY transactions are signed over `toBytesForSigning`, which differs from
// the unsigned `toBytes` the node returns: it omits the 1-byte "is data raw?"
// flag and, for RAW_DATA, signs the SHA-256 of the data rather than the data
// itself. (Other tx types sign the unsigned bytes directly.) QDN file publishes
// are DATA_HASH, so signing == unsigned bytes minus that flag byte. Mirrors
// org.qortium.transform.transaction.ArbitraryTransactionTransformer.
function arbitrarySigningBytes(message) {
  // type(4) + timestamp(8) + groupId(4) + publicKey(32) + nonce(4)
  let offset = 4 + 8 + 4 + 32 + 4;
  const skipSizedString = () => {
    const length = message.readInt32BE(offset);
    offset += 4 + length;
  };

  skipSizedString(); // name
  skipSizedString(); // identifier
  offset += 4; // method
  skipSizedString(); // secret
  offset += 4; // compression
  const payments = message.readInt32BE(offset);
  offset += 4 + payments * ARBITRARY_PAYMENT_LENGTH;
  offset += 4; // service ID

  const flagOffset = offset; // the "is data raw?" byte
  const isRaw = message[flagOffset];
  const head = message.subarray(0, flagOffset);
  const dataLengthOffset = flagOffset + 1;

  if (isRaw === 0) {
    // DATA_HASH: drop the flag byte; data (the hash) is identical.
    return Buffer.concat([head, message.subarray(dataLengthOffset)]);
  }

  // RAW_DATA: replace the raw data with its SHA-256 digest.
  const dataLength = message.readInt32BE(dataLengthOffset);
  const dataOffset = dataLengthOffset + 4;
  const digest = crypto.createHash('sha256').update(message.subarray(dataOffset, dataOffset + dataLength)).digest();

  return Buffer.concat([
    head,
    message.subarray(dataLengthOffset, dataOffset), // 4-byte data length
    digest,
    message.subarray(dataOffset + dataLength), // size + metadataHash + fee
  ]);
}

// Sign the unsigned transaction bytes locally with the account's Ed25519 key
// (private key = 32-byte seed), appending the 64-byte signature. Needs no
// production-only endpoint, so it works against hardened (apiRestricted) seeds.
function signTransactionLocally(rawUnsignedWithNonce58, privateKey58) {
  const seed = decodeBase58(privateKey58).subarray(0, 32);

  if (seed.length !== 32) {
    throw new Error('Account private key must contain at least 32 bytes.');
  }

  const der = Buffer.concat([ED25519_PKCS8_PREFIX, seed]);
  const key = crypto.createPrivateKey({ format: 'der', key: der, type: 'pkcs8' });
  const message = decodeBase58(rawUnsignedWithNonce58);
  const signingBytes = message.readInt32BE(0) === TX_TYPE_ARBITRARY ? arbitrarySigningBytes(message) : message;
  const signature = crypto.sign(null, signingBytes, key);

  return encodeBase58(Buffer.concat([message, signature]));
}

async function signAndProcess(config, apiKey, rawUnsignedBytes58, privateKey58, computePath = '/arbitrary/compute') {
  const rawUnsignedWithNonce58 = await request(config, apiKey, computePath, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/plain',
    },
    body: rawUnsignedBytes58,
  });
  const signedBytes58 = signTransactionLocally(rawUnsignedWithNonce58, privateKey58);
  const processResult = await request(config, apiKey, '/transactions/process', {
    method: 'POST',
    headers: {
      'Content-Type': 'text/plain',
    },
    body: signedBytes58,
  });

  if (processResult.trim() !== 'true' && !processResult.includes('"type"')) {
    throw new Error(`Transaction was not accepted: ${processResult}`);
  }

  return signedBytes58;
}

async function getNameInfo(config, name) {
  const response = await fetch(`${config.nodeApiUrl}/names/${encodeURIComponent(name)}`);

  if (response.status === 404) {
    return null;
  }

  const text = await response.text();

  if (!response.ok) {
    throw new Error(text || `Name lookup failed with HTTP ${response.status}.`);
  }

  return JSON.parse(text);
}

async function ensureNameRegistered(config, apiKey, name, account) {
  const existingName = await getNameInfo(config, name);

  if (existingName) {
    if (existingName.owner !== account.accountAddress) {
      throw new Error(`${name} is already registered to ${existingName.owner}.`);
    }

    console.log(`Name already registered: ${name} (${existingName.owner})`);
    return;
  }

  console.log(`Registering name with mempow: ${name}`);

  const rawRegisterBytes58 = buildRegisterNameRawBytes58({
    account,
    timestamp: Date.now(),
    name,
    data: JSON.stringify({
      app: DEFAULT_TITLE,
      purpose: DEFAULT_DESCRIPTION,
    }),
  });

  await signAndProcess(config, apiKey, rawRegisterBytes58, account.accountPrivateKey, '/transactions/mempow/compute');
  await waitFor(`name ${name}`, async () => {
    const nameInfo = await getNameInfo(config, name);

    return nameInfo?.owner === account.accountAddress ? nameInfo : null;
  });

  console.log(`Name registered: ${name}`);
}

async function getResourceStatus(config, apiKey, resource) {
  return requestJson(
    config,
    apiKey,
    `/arbitrary/resource/status/${resource.service}/${encodeURIComponent(resource.name)}/${encodeURIComponent(
      resource.identifier,
    )}?build=true`,
  );
}

async function publishResource(config, apiKey, account, resource) {
  const resourcePathname = `/arbitrary/${resource.service}/${encodeURIComponent(resource.name)}/${encodeURIComponent(
    resource.identifier,
  )}`;
  const rawUnsignedBytes58 = await request(
    config,
    apiKey,
    appendQuery(resourcePathname, {
      title: resource.title,
      description: resource.description,
      fee: 0,
    }),
    {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain',
      },
      body: resource.sourcePath,
    },
  );

  await signAndProcess(config, apiKey, rawUnsignedBytes58, account.accountPrivateKey);
}

async function deleteResource(config, apiKey, account, resource) {
  const pathname = `/arbitrary/resource/${resource.service}/${encodeURIComponent(resource.name)}/${encodeURIComponent(
    resource.identifier,
  )}/delete`;
  const rawUnsignedBytes58 = await request(config, apiKey, appendQuery(pathname, { fee: 0 }), {
    method: 'POST',
    headers: {
      'Content-Type': 'text/plain',
    },
    body: '',
  });

  await signAndProcess(config, apiKey, rawUnsignedBytes58, account.accountPrivateKey);
}

function assertPublishSource(resource) {
  if (!existsSync(resource.sourcePath)) {
    throw new Error(`Publish source does not exist for ${resource.service}: ${resource.sourcePath}`);
  }

  if (resource.requiredFile && !existsSync(path.join(resource.sourcePath, resource.requiredFile))) {
    throw new Error(
      `Publish source is missing ${resource.requiredFile} for ${resource.service}: ${resource.sourcePath}`,
    );
  }
}

export function appResource() {
  return {
    description: 'QDN network topology viewer for Qortium Home',
    identifier: readEnv('QDN_IDENTIFIER') ?? DEFAULT_IDENTIFIER,
    name: readEnv('QDN_NAME') ?? DEFAULT_NAME,
    requiredFile: 'index.html',
    service: readEnv('QDN_SERVICE') ?? 'APP',
    sourcePath: path.resolve(repoRoot, readEnv('DIST_PATH') ?? 'dist'),
    title: readEnv('QDN_TITLE') ?? DEFAULT_TITLE,
  };
}

export function databaseResource() {
  const dataRoot = path.resolve(repoRoot, readEnv('QDN_DATA_PATH') ?? 'target/qdn-topology-data');
  const name = readEnv('QDN_NAME') ?? DEFAULT_NAME;
  const identifier = readEnv('QDN_IDENTIFIER') ?? DEFAULT_IDENTIFIER;
  const title = readEnv('QDN_TITLE') ?? DEFAULT_TITLE;

  return {
    description: 'Qortium network topology latest database',
    identifier,
    name,
    requiredFile: 'manifest.json',
    service: readEnv('DATABASE_SERVICE') ?? 'DATABASE',
    sourcePath: path.join(dataRoot, 'DATABASE', name, identifier),
    title,
  };
}

export function topologyDataResources() {
  const dataRoot = path.resolve(repoRoot, readEnv('QDN_DATA_PATH') ?? 'target/qdn-topology-data');
  const name = readEnv('QDN_NAME') ?? DEFAULT_NAME;
  const identifier = readEnv('QDN_IDENTIFIER') ?? DEFAULT_IDENTIFIER;
  const title = readEnv('QDN_TITLE') ?? DEFAULT_TITLE;

  return [
    databaseResource(),
    {
      description: 'Qortium network topology point-in-time snapshot',
      identifier,
      name,
      requiredFile: 'manifest.json',
      service: readEnv('SNAPSHOT_SERVICE') ?? 'SNAPSHOT',
      sourcePath: path.join(dataRoot, 'SNAPSHOT', name, identifier),
      title,
    },
  ];
}

export async function publishResources(resources, { dryRun = false } = {}) {
  for (const resource of resources) {
    assertPublishSource(resource);
  }

  const config = buildConfig();

  console.log(`Node: ${config.nodeApiUrl}`);

  for (const resource of resources) {
    console.log(`Resource: qdn://${resource.service}/${resource.name}/${resource.identifier}`);
    console.log(`Source: ${resource.sourcePath}`);
  }

  if (dryRun) {
    console.log('Dry run complete. No transactions were created.');
    return;
  }

  const apiKey = getApiKey(config);
  const account = getLocalPreviewAccount(config);

  console.log(`Owner: ${account.accountAddress}`);
  console.log('API key: loaded');

  const status = await requestJson(config, apiKey, '/admin/status');

  if (!status || status.syncPercent !== 100 || status.isSynchronizing) {
    throw new Error(`Node is not synced: ${JSON.stringify(status)}`);
  }

  const published = [];

  for (const resource of resources) {
    await ensureNameRegistered(config, apiKey, resource.name, account);
    await publishResource(config, apiKey, account, resource);

    const readyStatus = await waitFor(`${resource.service}/${resource.name}/${resource.identifier}`, async () => {
      const resourceStatus = await getResourceStatus(config, apiKey, resource);

      if (resourceStatus?.status === 'READY') {
        return resourceStatus;
      }

      if (resourceStatus?.status === 'BLOCKED' || resourceStatus?.status === 'BUILD_FAILED') {
        throw new Error(`${resource.service}/${resource.name}/${resource.identifier} status is ${resourceStatus.status}.`);
      }

      return null;
    });

    console.log(`Ready: qdn://${resource.service}/${resource.name}/${resource.identifier}`);
    console.log(`Status: ${readyStatus.status}${readyStatus.description ? ` - ${readyStatus.description}` : ''}`);
    published.push({
      resource,
      status: readyStatus,
    });
  }

  return published;
}

/**
 * Build, sign, and submit an on-chain ARBITRARY *delete* transaction for each
 * resource — removing it from QDN entirely (all its accumulated records). The
 * transaction takes effect once minted into a block; a later publish recreates
 * the resource fresh. Only service/name/identifier are used (no source needed).
 */
export async function deleteResources(resources, { dryRun = false } = {}) {
  const config = buildConfig();

  console.log(`Node: ${config.nodeApiUrl}`);
  for (const resource of resources) {
    console.log(`Delete: qdn://${resource.service}/${resource.name}/${resource.identifier}`);
  }

  if (dryRun) {
    console.log('Dry run complete. No transactions were created.');
    return [];
  }

  const apiKey = getApiKey(config);
  const account = getLocalPreviewAccount(config);

  console.log(`Owner: ${account.accountAddress}`);
  console.log('API key: loaded');

  const status = await requestJson(config, apiKey, '/admin/status');
  if (!status || status.syncPercent !== 100 || status.isSynchronizing) {
    throw new Error(`Node is not synced: ${JSON.stringify(status)}`);
  }

  const deleted = [];
  for (const resource of resources) {
    await deleteResource(config, apiKey, account, resource);
    console.log(`Delete transaction submitted: qdn://${resource.service}/${resource.name}/${resource.identifier}`);
    deleted.push(resource);
  }

  return deleted;
}

export function parseCliFlags(argv) {
  return {
    dryRun: argv.includes('--dry-run'),
    help: argv.includes('--help') || argv.includes('-h'),
  };
}
