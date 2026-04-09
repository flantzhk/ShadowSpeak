import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

export default defineConfig({
  plugins: [react()],
  root: 'src',
  base: '/ShadowSpeak/apptest/',
  publicDir: resolve(__dirname, 'public'),
  build: {
    outDir: resolve(__dirname, 'apptest'),
    emptyOutDir: true,
    sourcemap: true,
    minify: false,
    rollupOptions: {
      input: {
        app: resolve(__dirname, 'src/app.html'),
        admin: resolve(__dirname, 'src/admin.html'),
      },
    },
  },
  server: {
    port: 8080,
  },
});
