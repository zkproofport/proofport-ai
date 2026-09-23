import { defineConfig } from 'vite';

export default defineConfig({
  base: '/approval/',
  publicDir: false,
  build: { outDir: '../../public/approval', emptyOutDir: true, sourcemap: false },
});
