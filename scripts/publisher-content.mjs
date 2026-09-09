import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

export function payloadFiles(directory, prefix = '') {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...payloadFiles(full, relative));
    else if (entry.isFile()) files.push({ relative, full });
    else throw new Error('Publication payload contains a non-regular file.');
  }
  return files.sort((a, b) => a.relative.localeCompare(b.relative));
}

// Verify every expected file, including history. A matching manifest alone
// cannot prove that a node serves the selected snapshot or its historical data.
export async function verifyPayloadContent(directory, fetchFile) {
  const files = payloadFiles(directory);
  if (!files.length) throw new Error('Publication payload is empty.');
  let cursor = 0, failure;
  await Promise.all(Array.from({ length: Math.min(4, files.length) }, async () => {
    while (cursor < files.length && !failure) {
      try {
      const file = files[cursor++];
      const expected = createHash('sha256').update(readFileSync(file.full)).digest('hex');
      const actual = createHash('sha256').update(await fetchFile(file.relative)).digest('hex');
      if (actual !== expected) throw new Error(`QDN content mismatch: ${file.relative}`);
      } catch (error) { failure ??= error instanceof Error ? error : new Error(String(error)); }
    }
  }));
  if (failure) throw failure;
  return { verifiedFiles: files.length };
}

export async function retrySyncGate(check, { attempts = 3, delayMs = 15000, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  for (let i = 0; i < attempts; i++) {
    try { return await check(); }
    catch (error) {
      if (!/node is not synced/.test(error.message) || i === attempts - 1) throw error;
      await sleep(delayMs * (i + 1));
    }
  }
}
