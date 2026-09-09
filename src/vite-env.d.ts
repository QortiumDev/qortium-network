/// <reference types="vite/client" />

declare const __APP_VERSION__: string;

interface Window {
  qortalRequest?: <T = unknown>(request: Record<string, unknown>) => Promise<T>;
  qdnRequest?: <T = unknown>(request: Record<string, unknown>) => Promise<T>;
  _qdnTheme?: unknown;
  _qdnAccent?: unknown;
  _qdnTextSize?: unknown;
  _qdnUiStyle?: unknown;
  _qdnUIStyle?: unknown;
}
