import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: '/admin/',
  plugins: [react()],
  build: {sourcemap: false, outDir: 'dist', emptyOutDir: true},
  server: {proxy: {'/admin/api': 'http://127.0.0.1:8080'}},
});
