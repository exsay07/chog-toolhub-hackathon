import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Ports are overridable so E2E runs can coexist with a running dev server.
const API_PORT = process.env.API_PORT ?? '8787';
const WEB_PORT = Number(process.env.WEB_PORT ?? 5173);

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: { 'process.env': {} },
  server: {
    port: WEB_PORT,
    strictPort: true,
    host: 'localhost',
    proxy: {
      // App socket and the Perpl relay sockets (/api/perpl/<net>/ws/<kind>).
      '^/api/(ws|perpl/[a-z]+/ws/.*)': { target: `ws://127.0.0.1:${API_PORT}`, ws: true },
      '/api': { target: `http://127.0.0.1:${API_PORT}` },
    },
  },
  build: {
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        // Vendor groups by priority. Crypto primitives (@noble) go with viem, which the sign-in page
        // needs; Solana's stack stays in its own chunk, loaded only by the trading features.
        codeSplitting: {
          includeDependenciesRecursively: false,
          groups: [
            { name: 'viem', test: /node_modules\/(viem|ox|abitype|@noble|@scure)\//, priority: 30 },
            {
              name: 'solana',
              test: /node_modules\/(@solana|@solana-program|bn\.js|borsh|buffer|bs58|base-x|safe-buffer|jayson|rpc-websockets|superstruct|uuid|eventemitter3|text-encoding-utf-8|base64-js|ieee754)\//,
              priority: 20,
            },
            { name: 'charts', test: /node_modules\/(lightweight-charts|fancy-canvas)\//, priority: 10 },
            {
              name: 'react',
              test: /node_modules\/(react|react-dom|scheduler|react-router)\//,
              priority: 10,
            },
          ],
        },
      },
    },
  },
});
