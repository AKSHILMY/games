import { defineConfig } from 'vite';

// Relative base so the build works from any static host path (e.g. GitHub Pages /<repo>/).
export default defineConfig({
  base: './',
  build: { target: 'es2020', chunkSizeWarningLimit: 800 },
});
