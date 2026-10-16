import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    ssr: 'src/backend/server.ts',
    target: 'node22',
    outDir: '.backend-dist',
    emptyOutDir: true,
    rollupOptions: {
      external: [/^node:/],
      output: { format: 'es', entryFileNames: 'server.js' },
    },
  },
})
