export type HostingNetwork = 'qortium' | 'qortal';

// Each QDN destination gets an explicitly configured artifact from this same
// codebase. Bridge presence cannot identify the chain: Home exposes both.
export function parseHostingNetwork(value: unknown): HostingNetwork {
  if (value === undefined || value === '' || value === 'qortium') return 'qortium';
  if (value === 'qortal') return 'qortal';
  throw new Error('VITE_QDN_NETWORK must be qortium or qortal.');
}

export const HOSTING_NETWORK = parseHostingNetwork(import.meta.env.VITE_QDN_NETWORK);
export const DEVELOPERS_ENABLED = HOSTING_NETWORK === 'qortium';

export function databaseResourceFor(network: HostingNetwork) {
  return { service: 'DATABASE', name: network === 'qortal' ? 'xnetwork' : 'Network', identifier: 'Network' } as const;
}

export const RUNTIME_DATABASE_RESOURCE = databaseResourceFor(HOSTING_NETWORK);
