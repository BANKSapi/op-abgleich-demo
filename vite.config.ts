import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // xfwd: X-Forwarded-For setzen, damit die API die IP des Nutzers an BANKSapi weitergeben kann
      '/api': { target: 'http://localhost:3001', xfwd: true },
    },
  },
});
