import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { resolveConfig } from 'vite';

process.env.NODE_ENV = 'test-no-listen';
const cms = await import('./cms-server.mjs');

const VITE_HOST = '127.0.0.1';
const VITE_PORT = 3000;
const CMS_HOST = '127.0.0.1';
const CMS_PORT = 3001;

function httpRequest({ host = '127.0.0.1', port, method = 'GET', path = '/', headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host,
        port,
        method,
        path,
        headers,
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            json = null;
          }
          resolve({
            status: res.statusCode,
            headers: res.headers,
            text,
            json,
          });
        });
      },
    );
    req.on('error', reject);
    if (body !== null) {
      req.write(typeof body === 'string' ? body : JSON.stringify(body));
    }
    req.end();
  });
}

function assertNoPermissiveCorsHeaders(headers) {
  for (const key of Object.keys(headers)) {
    const lower = key.toLowerCase();
    assert.equal(
      lower.startsWith('access-control-'),
      false,
      `Unexpected CORS header "${key}" present`,
    );
  }
}

function extractSessionCookiePair(setCookieHeader) {
  assert.ok(setCookieHeader, 'Expected Set-Cookie header');
  const cookies = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
  const sessionSetCookie = cookies.find((c) => c.startsWith(`${cms.COOKIE_NAME}=`));
  assert.ok(sessionSetCookie, `Expected Set-Cookie for ${cms.COOKIE_NAME}`);
  const cookiePair = sessionSetCookie.split(';')[0];
  return { raw: sessionSetCookie, pair: cookiePair };
}

async function ensureCmsListening() {
  if (cms.server.listening) {
    return async () => {};
  }
  await new Promise((resolve, reject) => {
    const onError = (err) => {
      cms.server.off('error', onError);
      reject(err);
    };
    cms.server.once('error', onError);
    cms.server.listen(CMS_PORT, CMS_HOST, () => {
      cms.server.off('error', onError);
      resolve();
    });
  });
  return async () => {
    await new Promise((resolve) => cms.server.close(() => resolve()));
  };
}

test('Vite config defines strict /api/auth and /api/cms proxy rules without path rewriting or CORS', async () => {
  const config = await resolveConfig({}, 'serve');
  assert.equal(config.server.cors, false, 'Vite server.cors must be disabled');
  assert.ok(config.server.proxy, 'Vite server.proxy must be defined');

  for (const prefix of ['/api/auth', '/api/cms']) {
    const rule = config.server.proxy[prefix];
    assert.ok(rule && typeof rule === 'object', `Missing proxy rule for ${prefix}`);
    assert.equal(rule.target, 'http://127.0.0.1:3001');
    assert.equal(rule.changeOrigin, true);
    assert.equal(rule.ws, false);
    assert.equal(rule.xfwd, false);
    assert.equal(rule.rewrite, undefined, `Proxy rule for ${prefix} must not rewrite paths`);
    assert.equal(typeof rule.bypass, 'function', `Proxy rule for ${prefix} must define bypass guard`);
    assert.equal(typeof rule.configure, 'function', `Proxy rule for ${prefix} must define configure hook`);
  }
});

test('Vite proxy bypass rejects non-loopback socket connections even with spoofed headers', async () => {
  const config = await resolveConfig({}, 'serve');
  const authRule = config.server.proxy['/api/auth'];
  const cmsRule = config.server.proxy['/api/cms'];

  for (const [prefix, rule] of [
    ['/api/auth/verify', authRule],
    ['/api/cms/health', cmsRule],
  ]) {
    let statusCode = null;
    let headers = {};
    let body = '';
    let writableEnded = false;
    const mockReq = {
      url: prefix,
      method: 'GET',
      socket: { remoteAddress: '203.0.113.42' },
      headers: {
        host: '127.0.0.1:3000',
        origin: 'http://127.0.0.1:3000',
        'sec-fetch-site': 'same-origin',
        'x-forwarded-for': '127.0.0.1',
        'x-forwarded-host': '127.0.0.1:3000',
      },
    };
    const mockRes = {
      get writableEnded() {
        return writableEnded;
      },
      writeHead(code, h) {
        statusCode = code;
        headers = h || {};
        return this;
      },
      end(chunk) {
        if (chunk) body += chunk;
        writableEnded = true;
      },
    };

    const result = rule.bypass(mockReq, mockRes, rule);
    assert.equal(result, prefix);
    assert.equal(writableEnded, true);
    assert.equal(statusCode, 403);
    assertNoPermissiveCorsHeaders(headers);
    assert.match(body, /loopback/i);
  }
});

test('End-to-end Vite proxy <-> CMS server auth, cookie, CSRF, and strict rejection checks', async () => {
  const stopCms = await ensureCmsListening();
  try {
    // 1. Browser-origin GET /api/cms/health through Vite proxy
    const healthWithOrigin = await httpRequest({
      host: VITE_HOST,
      port: VITE_PORT,
      method: 'GET',
      path: '/api/cms/health',
      headers: {
        Host: '127.0.0.1:3000',
        Origin: 'http://127.0.0.1:3000',
        'Sec-Fetch-Site': 'same-origin',
      },
    });
    assert.equal(healthWithOrigin.status, 200);
    assert.equal(healthWithOrigin.json?.status, 'ok');
    assert.equal(healthWithOrigin.json?.service, 'ainovex-cms');
    assertNoPermissiveCorsHeaders(healthWithOrigin.headers);

    // Same-origin GET without Origin header
    const healthNoOrigin = await httpRequest({
      host: VITE_HOST,
      port: VITE_PORT,
      method: 'GET',
      path: '/api/cms/health',
      headers: {
        Host: '127.0.0.1:3000',
        'Sec-Fetch-Site': 'same-origin',
      },
    });
    assert.equal(healthNoOrigin.status, 200);
    assert.equal(healthNoOrigin.json?.status, 'ok');
    assertNoPermissiveCorsHeaders(healthNoOrigin.headers);

    // 2. Path preservation check on /api/cms/tools/chatgpt (unauthenticated -> 401 from CMS)
    const unauthToolRes = await httpRequest({
      host: VITE_HOST,
      port: VITE_PORT,
      method: 'GET',
      path: '/api/cms/tools/chatgpt',
      headers: {
        Host: '127.0.0.1:3000',
        'Sec-Fetch-Site': 'same-origin',
      },
    });
    assert.equal(unauthToolRes.status, 401);
    assert.equal(unauthToolRes.json?.error, 'Unauthorized');
    assertNoPermissiveCorsHeaders(unauthToolRes.headers);

    // 3. OTP verification through Vite proxy preserves exact cookie security attributes
    const freshOtp = cms.resetAuthStateForTesting();
    const verifyRes = await httpRequest({
      host: VITE_HOST,
      port: VITE_PORT,
      method: 'POST',
      path: '/api/auth/verify',
      headers: {
        Host: '127.0.0.1:3000',
        Origin: 'http://127.0.0.1:3000',
        'Sec-Fetch-Site': 'same-origin',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ otp: freshOtp }),
    });
    assert.equal(verifyRes.status, 200);
    assert.equal(verifyRes.json?.success, true);
    assert.equal(typeof verifyRes.json?.csrfToken, 'string');
    assert.ok(verifyRes.json.csrfToken.length >= 32);
    assertNoPermissiveCorsHeaders(verifyRes.headers);

    const { raw: rawSetCookie, pair: cookiePair } = extractSessionCookiePair(
      verifyRes.headers['set-cookie'],
    );
    assert.match(
      rawSetCookie,
      new RegExp(
        `^${cms.COOKIE_NAME}=[0-9a-f]{64}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${cms.COOKIE_MAX_AGE_SECONDS}$`,
      ),
    );
    assert.equal(/;\s*Domain=/i.test(rawSetCookie), false);
    assert.equal(/;\s*SameSite=None/i.test(rawSetCookie), false);

    // 4. Authenticated GET /api/cms/tools with cookie through Vite proxy
    const toolsRes = await httpRequest({
      host: VITE_HOST,
      port: VITE_PORT,
      method: 'GET',
      path: '/api/cms/tools',
      headers: {
        Host: '127.0.0.1:3000',
        'Sec-Fetch-Site': 'same-origin',
        Cookie: cookiePair,
      },
    });
    assert.equal(toolsRes.status, 200);
    assert.equal(toolsRes.json?.success, true);
    assert.ok(Array.isArray(toolsRes.json?.tools));
    assertNoPermissiveCorsHeaders(toolsRes.headers);

    // 5. CSRF enforcement on authenticated mutating request through Vite proxy
    const missingCsrfRes = await httpRequest({
      host: VITE_HOST,
      port: VITE_PORT,
      method: 'POST',
      path: '/api/cms/tools',
      headers: {
        Host: '127.0.0.1:3000',
        Origin: 'http://127.0.0.1:3000',
        'Sec-Fetch-Site': 'same-origin',
        'Content-Type': 'application/json',
        Cookie: cookiePair,
      },
      body: JSON.stringify({}),
    });
    assert.equal(missingCsrfRes.status, 403);
    assert.equal(missingCsrfRes.json?.error, 'Forbidden');

    // With valid Cookie + X-CSRF-Token on /api/cms/tools (reaches schema/payload validation 400 without altering content)
    const validCsrfBadBodyRes = await httpRequest({
      host: VITE_HOST,
      port: VITE_PORT,
      method: 'POST',
      path: '/api/cms/tools',
      headers: {
        Host: '127.0.0.1:3000',
        Origin: 'http://127.0.0.1:3000',
        'Sec-Fetch-Site': 'same-origin',
        'Content-Type': 'application/json',
        Cookie: cookiePair,
        'X-CSRF-Token': verifyRes.json.csrfToken,
      },
      body: JSON.stringify({}),
    });
    assert.equal(validCsrfBadBodyRes.status, 400);
    assert.equal(validCsrfBadBodyRes.json?.error, 'Bad Request');

    // Authenticated POST /api/auth/logout with Cookie + X-CSRF-Token succeeds and invalidates session
    const logoutRes = await httpRequest({
      host: VITE_HOST,
      port: VITE_PORT,
      method: 'POST',
      path: '/api/auth/logout',
      headers: {
        Host: '127.0.0.1:3000',
        Origin: 'http://127.0.0.1:3000',
        'Sec-Fetch-Site': 'same-origin',
        'Content-Type': 'application/json',
        Cookie: cookiePair,
        'X-CSRF-Token': verifyRes.json.csrfToken,
      },
      body: JSON.stringify({}),
    });
    assert.equal(logoutRes.status, 200);
    assert.equal(logoutRes.json?.success, true);
    assertNoPermissiveCorsHeaders(logoutRes.headers);

    const afterLogoutRes = await httpRequest({
      host: VITE_HOST,
      port: VITE_PORT,
      method: 'GET',
      path: '/api/cms/tools',
      headers: {
        Host: '127.0.0.1:3000',
        'Sec-Fetch-Site': 'same-origin',
        Cookie: cookiePair,
      },
    });
    assert.equal(afterLogoutRes.status, 401);

    // 6. Untrusted requests through Vite proxy are rejected
    const untrustedProxyCases = [
      {
        name: 'untrusted Host evil.com:3000',
        headers: { Host: 'evil.com:3000' },
      },
      {
        name: 'untrusted Host localhost:3000',
        headers: { Host: 'localhost:3000' },
      },
      {
        name: 'untrusted Origin https://evil.com',
        headers: { Host: '127.0.0.1:3000', Origin: 'https://evil.com' },
      },
      {
        name: 'untrusted Origin http://localhost:3000',
        headers: { Host: '127.0.0.1:3000', Origin: 'http://localhost:3000' },
      },
      {
        name: 'untrusted Origin http://127.0.0.1:4000',
        headers: { Host: '127.0.0.1:3000', Origin: 'http://127.0.0.1:4000' },
      },
      {
        name: 'cross-site Sec-Fetch-Site',
        headers: { Host: '127.0.0.1:3000', 'Sec-Fetch-Site': 'cross-site' },
      },
      {
        name: 'same-site (cross-port) Sec-Fetch-Site',
        headers: { Host: '127.0.0.1:3000', 'Sec-Fetch-Site': 'same-site' },
      },
      {
        name: 'spoofed X-Forwarded-Host with evil Host',
        headers: {
          Host: 'evil.com:3000',
          'X-Forwarded-Host': '127.0.0.1:3000',
          'X-Forwarded-For': '127.0.0.1',
        },
      },
      {
        name: 'OPTIONS CORS preflight from another origin',
        method: 'OPTIONS',
        headers: {
          Host: '127.0.0.1:3000',
          Origin: 'http://localhost:8080',
          'Access-Control-Request-Method': 'POST',
        },
      },
    ];

    for (const testCase of untrustedProxyCases) {
      const res = await httpRequest({
        host: VITE_HOST,
        port: VITE_PORT,
        method: testCase.method || 'GET',
        path: '/api/cms/health',
        headers: testCase.headers,
      });
      assert.equal(res.status, 403, `Expected 403 for ${testCase.name}, got ${res.status}`);
      assertNoPermissiveCorsHeaders(res.headers);
    }

    // Prefix boundary /api/auth-evil must not proxy to CMS
    const boundaryRes = await httpRequest({
      host: VITE_HOST,
      port: VITE_PORT,
      method: 'GET',
      path: '/api/auth-evil',
      headers: { Host: '127.0.0.1:3000' },
    });
    assert.equal(boundaryRes.status, 404);
    assertNoPermissiveCorsHeaders(boundaryRes.headers);

    // 7. Direct requests to CMS server (127.0.0.1:3001) with untrusted Host/Origin or Vite Origin remain rejected
    const directCmsCases = [
      {
        name: 'direct browser cross-origin from Vite (Origin: http://127.0.0.1:3000)',
        headers: { Host: '127.0.0.1:3001', Origin: 'http://127.0.0.1:3000' },
      },
      {
        name: 'direct request with untrusted Host evil.com:3001',
        headers: { Host: 'evil.com:3001' },
      },
      {
        name: 'direct request with Host localhost:3001',
        headers: { Host: 'localhost:3001' },
      },
      {
        name: 'direct request with untrusted Origin https://evil.com',
        headers: { Host: '127.0.0.1:3001', Origin: 'https://evil.com' },
      },
      {
        name: 'direct request with Sec-Fetch-Site: cross-site',
        headers: { Host: '127.0.0.1:3001', 'Sec-Fetch-Site': 'cross-site' },
      },
      {
        name: 'direct request with spoofed X-Forwarded-Host and untrusted Host',
        headers: { Host: 'evil.com:3001', 'X-Forwarded-Host': '127.0.0.1:3001' },
      },
    ];

    for (const testCase of directCmsCases) {
      const res = await httpRequest({
        host: CMS_HOST,
        port: CMS_PORT,
        method: 'GET',
        path: '/api/cms/health',
        headers: testCase.headers,
      });
      assert.equal(res.status, 403, `Expected CMS 403 for ${testCase.name}, got ${res.status}`);
      assertNoPermissiveCorsHeaders(res.headers);
    }

    // 8. Direct CMS non-loopback rejection check
    assert.equal(cms.isLoopbackAddress('203.0.113.10'), false);
    assert.equal(cms.isLoopbackAddress('10.0.0.5'), false);
    assert.equal(cms.isLoopbackAddress('127.0.0.1'), true);
    assert.equal(cms.isLoopbackAddress('::ffff:127.0.0.1'), true);
  } finally {
    cms.resetAuthStateForTesting();
    await stopCms();
  }
});
