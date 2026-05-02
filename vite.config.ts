import { defineConfig } from 'vite';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import viteReact from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';

export default defineConfig({
  plugins: [
    tanstackStart({
      srcDirectory: 'src/web',
    }),
    tailwindcss(),
    viteReact(),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  ssr: {
    external: ['bun', 'bun:sqlite', 'dockerode', 'ssh2', 'cpu-features'],
  },
  optimizeDeps: {
    exclude: ['bun', 'bun:sqlite', 'dockerode', 'ssh2', 'cpu-features'],
  },
});
