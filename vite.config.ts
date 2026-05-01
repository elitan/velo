import { defineConfig } from 'vite';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import viteReact from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';

export default defineConfig({
  plugins: [
    tanstackRouter({
      target: 'react',
      routesDirectory: './src/web/routes',
      generatedRouteTree: './src/web/routeTree.gen.ts',
      autoCodeSplitting: false,
      codeSplittingOptions: {
        addHmr: false,
      },
    }),
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
});
