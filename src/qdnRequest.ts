import type { NodeApiFetchResult, QdnAction } from './types';

const DEFAULT_NODE_API_URL = 'http://127.0.0.1:24891';

export const LOCAL_READ_ACTIONS = [
  'FETCH_NODE_API',
  'FETCH_QDN_RESOURCE',
  'GET_NODE_STATUS',
  'IS_USING_PUBLIC_NODE',
  'LIST_QDN_RESOURCES',
  'SEARCH_QDN_RESOURCES',
  'SHOW_ACTIONS',
  'WHICH_UI',
] as const;

type QdnRequest = {
  action: string;
  maxBytes?: number;
  method?: string;
  path?: string;
  [key: string]: unknown;
};

export function getNodeApiUrl() {
  return (import.meta.env.VITE_QORTIUM_NODE_API_URL || DEFAULT_NODE_API_URL).replace(/\/+$/, '');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function parseResponseData(body: string, contentType: string) {
  if (!body) {
    return null;
  }

  if (contentType.toLowerCase().includes('json') || /^[\s\n\r]*[\[{]/.test(body)) {
    try {
      return JSON.parse(body) as unknown;
    } catch {
      return body;
    }
  }

  return body;
}

function sanitizeNodePath(path: unknown) {
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) {
    throw new Error('Node API paths must start with /.');
  }

  if (/[\x00-\x1F]/.test(path)) {
    throw new Error('Node API path contains invalid control characters.');
  }

  const url = new URL(path, DEFAULT_NODE_API_URL);

  return `${url.pathname}${url.search}`;
}

function sanitizeReadMethod(method: unknown) {
  const normalizedMethod = typeof method === 'string' && method.trim() ? method.trim().toUpperCase() : 'GET';

  if (normalizedMethod !== 'GET' && normalizedMethod !== 'HEAD') {
    throw new Error('Only GET and HEAD node API requests are supported.');
  }

  return normalizedMethod;
}

function appendQueryValue(queryParams: URLSearchParams, key: string, value: unknown) {
  if (Array.isArray(value)) {
    for (const item of value) {
      appendQueryValue(queryParams, key, item);
    }

    return;
  }

  if (typeof value === 'boolean' || typeof value === 'number') {
    queryParams.append(key, String(value));
    return;
  }

  if (typeof value === 'string' && value.trim()) {
    queryParams.append(key, value.trim());
  }
}

function getString(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

function buildQdnResourcesPath(request: QdnRequest, pathBase: string) {
  const queryParams = new URLSearchParams();
  const queryFields: Record<string, string> = {
    exactMatchNames: 'exactmatchnames',
    excludeBlocked: 'excludeblocked',
    identifier: 'identifier',
    includeMetadata: 'includemetadata',
    includeStatus: 'includestatus',
    limit: 'limit',
    name: 'name',
    offset: 'offset',
    query: 'query',
    reverse: 'reverse',
    service: 'service',
  };

  for (const [requestKey, queryKey] of Object.entries(queryFields)) {
    appendQueryValue(queryParams, queryKey, request[requestKey]);
  }

  const queryString = queryParams.toString();

  return `${pathBase}${queryString ? `?${queryString}` : ''}`;
}

function buildFetchQdnResourcePath(request: QdnRequest) {
  const service = getString(request.service).toUpperCase();
  const name = getString(request.name);
  const identifier = getString(request.identifier);
  const resourcePath = getString(request.path) || getString(request.filepath);
  const queryParams = new URLSearchParams();

  if (!service || !name) {
    throw new Error('QDN resource service and name are required.');
  }

  if (resourcePath) {
    queryParams.set('filepath', resourcePath);
  }

  for (const key of ['encoding', 'rebuild', 'async']) {
    const value = request[key];

    if (typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
      queryParams.set(key, String(value));
    }
  }

  const queryString = queryParams.toString();

  return `/arbitrary/${service}/${encodeURIComponent(name)}${identifier ? `/${encodeURIComponent(identifier)}` : ''}${
    queryString ? `?${queryString}` : ''
  }`;
}

function getContentLength(response: Response, bodyLength: number) {
  const rawLength = response.headers.get('content-length');
  const contentLength = rawLength ? Number(rawLength) : bodyLength;

  return Number.isFinite(contentLength) ? contentLength : undefined;
}

async function fetchLocalNodeApi(request: QdnRequest): Promise<NodeApiFetchResult> {
  const method = sanitizeReadMethod(request.method);
  const apiPath = sanitizeNodePath(request.path);
  const response = await fetch(`${getNodeApiUrl()}${apiPath}`, { method });
  const contentType = response.headers.get('content-type') ?? '';
  const body = method === 'HEAD' ? '' : await response.text();
  const bodyLength = new TextEncoder().encode(body).byteLength;
  const maxBytes = typeof request.maxBytes === 'number' ? request.maxBytes : 0;

  if (maxBytes > 0 && bodyLength > maxBytes) {
    throw new Error(`Node API response exceeded the ${maxBytes.toLocaleString()} byte limit.`);
  }

  return {
    body,
    contentLength: getContentLength(response, bodyLength),
    contentType,
    data: parseResponseData(body, contentType),
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
  };
}

async function fetchLocalNodeApiData(request: QdnRequest, path: string) {
  const result = await fetchLocalNodeApi({ ...request, action: 'FETCH_NODE_API', path });

  if (!result.ok) {
    throw new Error(result.body || `Node API failed with HTTP ${result.status}.`);
  }

  return result.data;
}

async function fallbackQdnRequest<T>(request: QdnRequest): Promise<T> {
  switch (request.action.toUpperCase()) {
    case 'FETCH_NODE_API':
      return (await fetchLocalNodeApi(request)) as T;
    case 'FETCH_QDN_RESOURCE':
      return (await fetchLocalNodeApiData(request, buildFetchQdnResourcePath(request))) as T;
    case 'GET_NODE_STATUS':
      return (await fetchLocalNodeApiData(request, '/admin/status')) as T;
    case 'IS_USING_PUBLIC_NODE':
      return false as T;
    case 'LIST_QDN_RESOURCES':
      return (await fetchLocalNodeApiData(request, buildQdnResourcesPath(request, '/arbitrary/resources'))) as T;
    case 'SEARCH_QDN_RESOURCES':
      return (await fetchLocalNodeApiData(request, buildQdnResourcesPath(request, '/arbitrary/resources/search'))) as T;
    case 'SHOW_ACTIONS':
      return [...LOCAL_READ_ACTIONS] as T;
    case 'WHICH_UI':
      return 'BROWSER_DEV' as T;
    default:
      throw new Error(`${request.action} is not available in local browser development.`);
  }
}

export function hasHomeBridge() {
  return typeof window !== 'undefined' && typeof window.qdnRequest === 'function';
}

export async function qdnRequest<T = unknown>(request: QdnRequest): Promise<T> {
  if (!isRecord(request) || typeof request.action !== 'string') {
    throw new Error('QDN requests must include an action.');
  }

  const bridgeRequest = typeof window !== 'undefined' ? window.qdnRequest : undefined;

  if (typeof bridgeRequest === 'function') {
    return bridgeRequest<T>(request);
  }

  return fallbackQdnRequest<T>(request);
}

export async function getAvailableActions(): Promise<QdnAction[]> {
  try {
    const actions = await qdnRequest<unknown>({ action: 'SHOW_ACTIONS' });

    return Array.isArray(actions) ? actions.filter((action): action is QdnAction => typeof action === 'string') : [];
  } catch {
    return [...LOCAL_READ_ACTIONS];
  }
}
