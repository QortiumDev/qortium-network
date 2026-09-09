import { readFileSync } from 'node:fs';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

const packageJson = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version: string;
};

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  const network = env.VITE_QDN_NETWORK || 'qortium';
  if (!['qortium', 'qortal'].includes(network)) throw new Error('VITE_QDN_NETWORK must be qortium or qortal.');
  return {
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
          source: `${JSON.stringify({ name: network === 'qortal' ? 'xnetwork' : 'Network', version: packageJson.version, network }, null, 2)}\n`,
        });
      },
    },
  ],
  test: {
    environment: 'node',
    globals: true,
  },
  };
});
