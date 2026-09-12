import { defineConfig } from 'vite';

export default defineConfig({
  // Репозиторный путь для GitHub Pages; для локального dev база не мешает.
  base: './',
  build: { target: 'es2022', chunkSizeWarningLimit: 900 },
});
