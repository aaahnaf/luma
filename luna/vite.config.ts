import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Luna Studio build config.
// - The app lives in ./studio (entry: studio/index.html).
// - `base: './'` makes the built site work under any Vercel path.
// - Output goes to ./dist, which vercel.json serves as static files.
export default defineConfig({
  root: 'studio',
  base: './',
  plugins: [react()],
  build: {
    outDir: '../dist',
    emptyOutDir: true,
  },
});
