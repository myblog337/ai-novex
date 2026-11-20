import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import type {IncomingMessage, ServerResponse} from 'node:http';
import {defineConfig, type ProxyOptions} from 'vite';

const CMS_PROXY_TARGET = 'http://127.0.0.1:3001';
const CMS_EXPECTED_HOST = '127.0.0.1:3001';
const CMS_EXPECTED_ORIGIN = 'http://127.0.0.1:3001';
const VITE_EXPECTED_HOST = '127.0.0.1:3000';
const VITE_EXPECTED_ORIGIN = 'http://127.0.0.1:3000';
const ALLOWED_LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::ffff:127.0.0.1']);

function sendProxyForbidden(res: ServerResponse | undefined, message: string): void {
  if (!res || res.writableEnded) return;
  res.writeHead(403, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(
    JSON.stringify({
      error: 'Forbidden',
      message,
    }),
  );
}

function extractRawPath(rawUrl: string): string {
  const qIdx = rawUrl.indexOf('?');
  const hIdx = rawUrl.indexOf('#');
  const endIdx = qIdx === -1 ? hIdx : hIdx === -1 ? qIdx : Math.min(qIdx, hIdx);
  return endIdx === -1 ? rawUrl : rawUrl.slice(0, endIdx);
}

function createStrictCmsProxy(expectedPrefix: string): ProxyOptions {
  return {
    target: CMS_PROXY_TARGET,
    changeOrigin: true,
    ws: false,
    xfwd: false,
    bypass(req: IncomingMessage, res: ServerResponse | undefined) {
      const rawUrl = req.url || '/';
      const rawPath = extractRawPath(rawUrl);

      // Enforce exact route prefix boundary (/api/auth or /api/auth/*, /api/cms or /api/cms/*)
      if (rawPath !== expectedPrefix && !rawPath.startsWith(`${expectedPrefix}/`)) {
        return false;
      }

      // 1. Require direct loopback socket connection to Vite (never trust forwarding headers)
      const remoteIp = req.socket?.remoteAddress;
      if (!remoteIp || !ALLOWED_LOOPBACK_ADDRESSES.has(remoteIp)) {
        sendProxyForbidden(res, 'Access denied: loopback socket connection required');
        return rawUrl;
      }

      // 2. Require exact expected Vite development Host header
      const hostHeader = req.headers['host'];
      if (typeof hostHeader !== 'string' || hostHeader !== VITE_EXPECTED_HOST) {
        sendProxyForbidden(res, 'Access denied: invalid Host header');
        return rawUrl;
      }

      // 3. If Origin is present, require exact expected Vite development Origin
      const originHeader = req.headers['origin'];
      if (
        originHeader !== undefined &&
        (typeof originHeader !== 'string' || originHeader !== VITE_EXPECTED_ORIGIN)
      ) {
        sendProxyForbidden(res, 'Access denied: invalid Origin header');
        return rawUrl;
      }

      // 4. Reject cross-site and same-site (cross-port) browser requests; allow same-origin or none
      const secFetchSite = req.headers['sec-fetch-site'];
      if (
        secFetchSite !== undefined &&
        (typeof secFetchSite !== 'string' ||
          (secFetchSite !== 'same-origin' && secFetchSite !== 'none'))
      ) {
        sendProxyForbidden(res, 'Access denied: cross-site requests rejected');
        return rawUrl;
      }

      // 5. Reject Expect header so http-proxy always emits proxyReq
      if (req.headers['expect'] !== undefined) {
        sendProxyForbidden(res, 'Access denied: Expect header not permitted');
        return rawUrl;
      }

      return undefined;
    },
    configure(proxy) {
      proxy.on('proxyReq', (proxyReq, req) => {
        proxyReq.setHeader('host', CMS_EXPECTED_HOST);
        if (req.headers['origin'] === VITE_EXPECTED_ORIGIN) {
          proxyReq.setHeader('origin', CMS_EXPECTED_ORIGIN);
        } else {
          proxyReq.removeHeader('origin');
        }
        proxyReq.removeHeader('x-forwarded-for');
        proxyReq.removeHeader('x-forwarded-host');
        proxyReq.removeHeader('x-forwarded-proto');
        proxyReq.removeHeader('x-forwarded-port');
        proxyReq.removeHeader('forwarded');
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    dedupe: ['react', 'react-dom'],
  },
  optimizeDeps: {
    include: [
      'react',
      'react-dom',
      'react-dom/client',
      'react/jsx-runtime',
      'react/jsx-dev-runtime',
      'lucide-react',
      'marked',
    ],
  },
  build: {
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/react') || id.includes('node_modules/react-dom')) {
            return 'vendor-react';
          }
          if (id.includes('node_modules/lucide-react')) {
            return 'vendor-icons';
          }
        },
      },
    },
  },
  server: {
    host: '0.0.0.0',
    port: 3000,
    strictPort: true,
    allowedHosts: true,
    cors: false,
    proxy: {
      '/api/auth': createStrictCmsProxy('/api/auth'),
      '/api/cms': createStrictCmsProxy('/api/cms'),
    },
  },
});
