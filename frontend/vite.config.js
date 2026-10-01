import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    strictPort: true,
    // Same-origin API in development, mirroring the Nginx reverse proxy in containers.
    proxy: {
      '/api': {
        target: process.env.VITE_DEV_API_TARGET ?? 'http://localhost:4000',
        changeOrigin: false,
      },
    },
  },
  build: {
    sourcemap: true,
    target: 'es2022',
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./tests/setup.js'],
    include: ['src/**/*.test.{js,jsx}'],
    css: false,
  },
});
