// Core's q-apps.js injects a lexical const; Home exposes a window property.
// Keep this name separate from the app's own bridge wrapper.
declare const qortalRequest: unknown;

export type InjectedRequest = <T = unknown>(request: Record<string, unknown>) => Promise<T>;

export function getInjectedQortalRequest(): InjectedRequest | undefined {
  if (typeof window !== 'undefined' && typeof window.qortalRequest === 'function') return window.qortalRequest;
  try {
    if (typeof qortalRequest === 'function') return qortalRequest as InjectedRequest;
  } catch {
    // A lexical binding can temporarily be in its initialization phase.
  }
  return undefined;
}
