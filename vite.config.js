import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    proxy: {
      '/api/intelligence': 'http://127.0.0.1:8788',
      '/api': 'http://127.0.0.1:8787',
    },
  },
});
