import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const config = JSON.parse(
  readFileSync(path.resolve(__dirname, '..', 'config.json'), 'utf-8'),
);

const serverOrigin = `http://127.0.0.1:${config.port}`;

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_TOKEN__: JSON.stringify(config.token),
  },
  server: {
    host: '127.0.0.1',
    port: config.clientPort,
    proxy: {
      '/api': { target: serverOrigin, changeOrigin: false },
      '/ws': { target: serverOrigin, ws: true, changeOrigin: false },
    },
  },
});
