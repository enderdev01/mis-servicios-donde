import { defineConfig } from 'astro/config';

const apiTarget = 'http://127.0.0.1:3000';

export default defineConfig({
  output: 'static',
  // Absolute origin for canonical and og:image; Vercel sets this at build time.
  site: process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : undefined,
  // One route: two blocking sheets cost more than one inlined.
  build: { inlineStylesheets: 'always' },
  vite: {
    server: {
      proxy: {
        '/v1': {
          target: apiTarget,
          changeOrigin: true,
        },
        '/health': {
          target: apiTarget,
          changeOrigin: true,
        },
      },
    },
    ssr: {
      noExternal: ['cookie'],
    },
  },
});