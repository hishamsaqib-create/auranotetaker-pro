/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';
import { defineConfig } from 'vite';

// Strict Content Security Policy for production builds (docs/deployment.md section 7).
// Scripts (including the audio worklet), styles and fonts come only from the app's own origin. The other
// hosts are Base44 and the Speechmatics EU real-time endpoint (lib/speech/speechmatics.ts).
export const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self' https://base44.app wss://base44.app wss://eu.rt.speechmatics.com",
  "media-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

function contentSecurityPolicy(): Plugin {
  return {
    name: 'auranotetaker-csp',
    apply: 'build', // the dev server needs inline scripts for hot reload
    transformIndexHtml(html) {
      // After the charset declaration, which must come first.
      return html.replace('<meta charset="UTF-8" />', `<meta charset="UTF-8" />\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`);
    },
  };
}

export default defineConfig({
  plugins: [react(), contentSecurityPolicy()],
  build: {
    sourcemap: false,
    assetsInlineLimit: 0, // never inline assets as data: URIs; everything is served from 'self'
  },
  test: {
    environment: 'node',
    include: ['lib/**/*.test.ts', 'src/**/*.test.{ts,tsx}', 'tests/**/*.test.ts'],
  },
});
