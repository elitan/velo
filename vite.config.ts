import { defineConfig } from 'vite';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import viteReact from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';
import { cpSync, mkdirSync } from 'node:fs';

export default defineConfig({
  plugins: [
    tanstackStart({
      srcDirectory: 'src/web',
    }),
    tailwindcss(),
    viteReact(),
    copyMigrations(),
  ],
  resolve: {
    alias: {
      '#api': path.resolve(__dirname, './src/api'),
      '#config': path.resolve(__dirname, './src/config'),
      '#db': path.resolve(__dirname, './src/db'),
      '#errors': path.resolve(__dirname, './src/errors/index.ts'),
      '#lib': path.resolve(__dirname, './src/lib'),
      '#managers': path.resolve(__dirname, './src/managers'),
      '#server': path.resolve(__dirname, './src/server'),
      '#utils': path.resolve(__dirname, './src/utils'),
      '#web': path.resolve(__dirname, './src/web'),
    },
  },
  ssr: {
    external: ['bun', 'bun:sqlite', 'dockerode', 'ssh2', 'cpu-features'],
  },
  optimizeDeps: {
    exclude: ['bun', 'bun:sqlite', 'dockerode', 'ssh2', 'cpu-features'],
  },
});

function copyMigrations() {
  return {
    name: 'copy-migrations',
    closeBundle() {
      const target = path.resolve(__dirname, 'dist/server/assets/migrations');

      mkdirSync(target, { recursive: true });
      cpSync(path.resolve(__dirname, 'src/db/migrations'), target, {
        recursive: true,
      });
    },
  };
}
