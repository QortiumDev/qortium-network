/// <reference types="vite/client" />

interface Window {
  qdnRequest?: <T = unknown>(request: Record<string, unknown>) => Promise<T>;
  _qdnTheme?: unknown;
  _qdnAccent?: unknown;
  _qdnTextSize?: unknown;
}
