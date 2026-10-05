import { defineConfig } from 'vite'
import { crx } from '@crxjs/vite-plugin'
import manifest from './src/manifest.config'

// CRXJS wires up MV3: builds the service worker, the chat page, the content
// overlay, and auto-manages web_accessible_resources / HMR.
export default defineConfig({
  plugins: [crx({ manifest })],
  // Build-time defaults baked into the bundle. For a store build set
  // SB_DEFAULT_API_KEY so the extension works with no setup; empty means "use
  // the key from local settings" (dev / BYOK). Never commit the key.
  define: {
    __SB_DEFAULT_API_KEY__: JSON.stringify(process.env.SB_DEFAULT_API_KEY ?? ''),
    __SB_DEFAULT_BASE_URL__: JSON.stringify(process.env.SB_DEFAULT_BASE_URL ?? 'https://openrouter.ai/api/v1'),
  },
  build: {
    target: 'esnext',
    rollupOptions: {
      input: {
        // The chat window: an extension page embedded as an iframe by the
        // overlay (or opened as a detached popup window by the SW fallback).
        chat: 'src/chat/chat.html',
        // Selection overlay + chat-window host: NOT a declared content script
        // (that would cost the all-sites install warning). The SW injects it on
        // demand, which needs a stable, module-free file — hence the fixed name.
        overlay: 'src/content/overlay.ts',
      },
      output: {
        // chrome.scripting.executeScript runs files as CLASSIC scripts: the
        // overlay entry must keep a known path and contain no import statements
        // (its only import is type-only, erased at compile time).
        entryFileNames: (chunk) =>
          chunk.name === 'overlay' ? 'content/overlay.js' : 'assets/[name]-[hash].js',
      },
    },
  },
  server: { port: 5173, strictPort: true },
})
