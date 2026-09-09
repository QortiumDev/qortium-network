import { normalizeQdnJson, qdnRequest } from './qdnRequest';

export const RESOURCE_READY_TIMEOUT_MS = 90_000;
export const RESOURCE_READY_POLL_MS = 3_000;

type Resource = { service: string; name: string; identifier: string };
type Options = {
  signal: AbortSignal;
  onProgress: (message: string) => void;
  request?: (request: { action: string; [key: string]: unknown }) => Promise<unknown>;
};

function abortError() { return new DOMException('Resource loading cancelled.', 'AbortError'); }

// Bound even a host request that never settles. Cancellation stops new requests;
// the host owns any read already in flight and may finish it independently.
function bounded<T>(work: Promise<T>, remaining: number, signal: AbortSignal, timeoutMessage: () => string): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); };
    const abort = () => { cleanup(); reject(abortError()); };
    const timer = setTimeout(() => { cleanup(); reject(new Error(timeoutMessage())); }, Math.max(0, remaining));
    signal.addEventListener('abort', abort, { once: true });
    work.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
}

export async function waitForQdnResource(resource: Resource, { signal, onProgress, request = qdnRequest }: Options): Promise<void> {
  const deadline = Date.now() + RESOURCE_READY_TIMEOUT_MS;
  let progress = 'Waiting for the node to prepare the network data…';
  const timeoutMessage = () => `${progress} The node is not ready yet. Try Refresh later, or choose another Qortal/Qortium node in your host.`;
  while (true) {
    if (signal.aborted) throw abortError();
    if (Date.now() >= deadline) throw new Error(timeoutMessage());
    onProgress(progress);
    const raw = await bounded(request({ action: 'GET_QDN_RESOURCE_STATUS', ...resource, build: true }), deadline - Date.now(), signal, timeoutMessage);
    const value = normalizeQdnJson(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value) || typeof (value as { status?: unknown }).status !== 'string') {
      throw new Error('The node returned an invalid QDN resource status.');
    }
    const state = value as { status: string; localChunkCount?: number; totalChunkCount?: number };
    if (state.status === 'READY') { onProgress('Loading network topology…'); return; }
    if (['BLOCKED', 'BUILD_FAILED', 'UNSUPPORTED'].includes(state.status)) {
      throw new Error(`The node reports network data as ${state.status.toLowerCase().replaceAll('_', ' ')}.`);
    }
    const count = state.localChunkCount, total = state.totalChunkCount;
    const chunks = Number.isInteger(count) && Number.isInteger(total) && count! >= 0 && total! > 0 && count! <= total!
      ? ` (${count} of ${total} chunks)` : '';
    progress = state.status === 'DOWNLOADING'
      ? `Downloading network data${chunks}…`
      : `Preparing network data${chunks}…`;
    onProgress(progress);
    await bounded(new Promise<void>(resolve => setTimeout(resolve, RESOURCE_READY_POLL_MS)), deadline - Date.now(), signal, timeoutMessage);
  }
}
