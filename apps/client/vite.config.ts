import {defineConfig} from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  resolve: {alias: {'@tada/client-core': new URL('../../packages/client-core/src/index.ts', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')}},
  base: './',
  worker: {format: 'es'},
  server: {host: '127.0.0.1', port: 1430, strictPort: true},
  build: {target: 'es2022', sourcemap: false},
  test: {environment: 'jsdom', globals: true, setupFiles: ['./src/test/setup.ts'], clearMocks: true},
});
