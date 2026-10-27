import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  root: path.resolve(import.meta.dirname, 'client'),
  plugins: [react()],
  build: { outDir: path.resolve(import.meta.dirname, 'dist'), emptyOutDir: true, chunkSizeWarningLimit: 1500 },
  server: { port: 5173, proxy: { '/api': 'http://127.0.0.1:4310' } },
});
