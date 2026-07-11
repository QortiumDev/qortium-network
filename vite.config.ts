import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const packageJson = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version: string;
};

export default defineConfig({
  base: './',
  define: {
    __APP_VERSION__: JSON.stringify(`v${packageJson.version}`),
  },
  plugins: [
    react(),
    {
      name: 'qortium-app-manifest',
      generateBundle() {
        this.emitFile({
          type: 'asset',
          fileName: 'qortium-app.json',
          source: `${JSON.stringify({ name: 'Network', version: packageJson.version }, null, 2)}\n`,
        });
      },
    },
  ],
  test: {
    environment: 'node',
    globals: true,
  },
});
