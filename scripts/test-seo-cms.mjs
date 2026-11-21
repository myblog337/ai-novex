import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

process.env.NODE_ENV = 'test-no-listen';

const {
  validateSeoDefaults,
  validateSeoPageRecord,
  validateSeoConfig,
  resolveEffectiveSeo,
  normalizeSeoPagePath,
  isValidSeoPageId,
  isValidSeoPagePath,
} = await import('./lib/validators.mjs');

const {
  defaultStorageEngine,
  ALLOWED_JSON_FILES,
  getActiveMutexCount,
} = await import('./lib/storage.mjs');

const {
  server,
  HOST,
  PORT,
  EXPECTED_HOST,
  EXPECTED_ORIGIN,
  COOKIE_NAME,
  resetAuthStateForTesting,
  startServerForTesting,
  parseSeoPagePath,
  computeSeoDefaultsETag,
  computeSeoPageETag,
  computeSeoConfigETag,
} = await import('./cms-server.mjs');

const REAL_ROOT = process.cwd();

async function hashFile(filePath) {
  const bytes = await fs.promises.readFile(filePath);
  return {
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    size: bytes.length,
    bytes,
  };
}

async function captureProductionSnapshot() {
  const contentDir = path.join(REAL_ROOT, 'content');
  const articlesDir = path.join(contentDir, 'articles');
  const files = [
    path.join(contentDir, 'articles.json'),
    path.join(contentDir, 'categories.json'),
    path.join(contentDir, 'tools.json'),
    path.join(contentDir, 'settings.json'),
    path.join(contentDir, 'ads.json'),
    path.join(contentDir, 'seo.json'),
  ];
  if (fs.existsSync(articlesDir)) {
    for (const entry of (await fs.promises.readdir(articlesDir)).sort()) {
      if (entry.endsWith('.md')) {
        files.push(path.join(articlesDir, entry));
      }
    }
  }
  const map = new Map();
  for (const f of files) {
    const info = await hashFile(f);
    map.set(f, info.sha256);
  }
  const prodBackupsExists = fs.existsSync(path.join(REAL_ROOT, '.backups'));
  const prodBackupsList = prodBackupsExists
    ? (await fs.promises.readdir(path.join(REAL_ROOT, '.backups'))).sort()
    : [];
  return { map, prodBackupsExists, prodBackupsList };
}

async function assertProductionUnchanged(before) {
  const after = await captureProductionSnapshot();
  assert.equal(after.map.size, before.map.size, 'Production content file count changed');
  for (const [f, sha] of before.map.entries()) {
    assert.equal(after.map.get(f), sha, `Production file was modified: ${path.basename(f)}`);
  }
  assert.equal(
    after.prodBackupsExists,
    before.prodBackupsExists,
    'Production .backups existence changed'
  );
  assert.deepEqual(
    after.prodBackupsList,
    before.prodBackupsList,
    'Production .backups contents changed'
  );
}

async function requestLocal({
  method = 'GET',
  reqPath = '/',
  headers = {},
  body = null,
}) {
  return new Promise((resolve, reject) => {
    const hasBody = body !== null && body !== undefined;
    const rawBody = hasBody
      ? typeof body === 'string' || Buffer.isBuffer(body)
        ? body
        : JSON.stringify(body)
      : null;

    const reqHeaders = {
      Host: EXPECTED_HOST,
      ...headers,
    };

    if (rawBody !== null && !Object.keys(reqHeaders).some((k) => k.toLowerCase() === 'content-type')) {
      reqHeaders['Content-Type'] = 'application/json';
    }
    if (rawBody !== null && !Object.keys(reqHeaders).some((k) => k.toLowerCase() === 'content-length')) {
      reqHeaders['Content-Length'] = Buffer.byteLength(rawBody);
    }

    const req = http.request(
      {
        hostname: HOST,
        port: PORT,
        method,
        path: reqPath,
        headers: reqHeaders,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {}
          resolve({
            status: res.statusCode,
            headers: res.headers,
            text,
            json,
          });
        });
      }
    );

    req.on('error', reject);
    if (rawBody !== null) {
      req.write(rawBody);
    }
    req.end();
  });
}

async function loginFreshSession() {
  const otp = resetAuthStateForTesting();
  const res = await requestLocal({
    method: 'POST',
    reqPath: '/api/auth/verify',
    headers: {
      Origin: EXPECTED_ORIGIN,
    },
    body: { otp },
  });
  assert.equal(res.status, 200, `Login failed: ${res.text}`);
  const setCookie = Array.isArray(res.headers['set-cookie'])
    ? res.headers['set-cookie'][0]
    : res.headers['set-cookie'];
  assert.ok(setCookie, 'Expected Set-Cookie header from login');
  const cookiePair = setCookie.split(';')[0];
  const csrfToken = res.json?.csrfToken;
  assert.ok(typeof csrfToken === 'string' && csrfToken.length > 0, 'Expected csrfToken');
  return { cookiePair, csrfToken };
}

function assertNoPathOrInternalLeak(responseText, tempRoot) {
  assert.ok(!responseText.includes(tempRoot), 'Response leaked tempRoot filesystem path');
  assert.ok(!responseText.includes(REAL_ROOT), 'Response leaked REAL_ROOT filesystem path');
  assert.ok(!responseText.includes('seo.json'), 'Response leaked internal filename seo.json');
  assert.ok(!responseText.includes('/content/'), 'Response leaked internal /content/ path');
  assert.ok(!responseText.includes('.backups'), 'Response leaked .backups directory');
}

describe('Task 113 — Global Page-Level SEO Data Model & Secure CMS API', () => {
  let prodSnapshot;
  let tempRoot;
  let tempBackupDir;
  let origProjectRoot;
  let origBackupDir;
  let weStartedServer = false;
  let auth;

  before(async () => {
    prodSnapshot = await captureProductionSnapshot();

    origProjectRoot = defaultStorageEngine.projectRoot;
    origBackupDir = defaultStorageEngine.backupDir;

    const rawTmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ainovex-seo-test-'));
    tempRoot = await fs.promises.realpath(rawTmp);
    tempBackupDir = path.join(tempRoot, '.backups');

    const tmpContent = path.join(tempRoot, 'content');
    const tmpArticles = path.join(tmpContent, 'articles');
    await fs.promises.mkdir(tmpArticles, { recursive: true });

    for (const fileName of ALLOWED_JSON_FILES) {
      await fs.promises.copyFile(
        path.join(REAL_ROOT, 'content', fileName),
        path.join(tmpContent, fileName)
      );
    }

    const srcArticlesDir = path.join(REAL_ROOT, 'content', 'articles');
    for (const entry of await fs.promises.readdir(srcArticlesDir)) {
      if (entry.endsWith('.md')) {
        await fs.promises.copyFile(
          path.join(srcArticlesDir, entry),
          path.join(tmpArticles, entry)
        );
      }
    }

    defaultStorageEngine.projectRoot = tempRoot;
    defaultStorageEngine.backupDir = tempBackupDir;

    weStartedServer = await startServerForTesting(server, PORT, HOST);
    auth = await loginFreshSession();
  });

  after(async () => {
    try {
      if (weStartedServer && server.listening) {
        await new Promise((resolve) => server.close(resolve));
      }
    } finally {
      defaultStorageEngine.projectRoot = origProjectRoot;
      defaultStorageEngine.backupDir = origBackupDir;
      if (tempRoot && fs.existsSync(tempRoot)) {
        await fs.promises.rm(tempRoot, { recursive: true, force: true });
      }
    }
    await assertProductionUnchanged(prodSnapshot);
  });

  it('1. Storage allowlist and isolated seed content/seo.json pass strict schema validation', async () => {
    assert.ok(ALLOWED_JSON_FILES.includes('seo.json'), 'seo.json must be in ALLOWED_JSON_FILES');
    const seo = await defaultStorageEngine.readJson('seo.json');
    const check = validateSeoConfig(seo);
    assert.equal(check.isValid, true, JSON.stringify(check.errors));

    const articles = await defaultStorageEngine.readJson('articles.json');
    assert.ok(Array.isArray(articles) && articles.length > 0);
  });

  it('2. Supports CRUD, page-type integrity, and resolution for every required page type', async () => {
    const pageFixtures = [
      {
        pageId: 'article:how-to-summarize-a-pdf-with-ai',
        pageType: 'article',
        path: '/blog/how-to-summarize-a-pdf-with-ai',
        slug: 'how-to-summarize-a-pdf-with-ai',
        seoTitle: 'Summarize PDFs Faster with AI | AINOVEX',
        metaDescription: 'Step-by-step guide to summarizing long PDF documents accurately using AI.',
        focusKeyword: 'summarize pdf with ai',
        secondaryKeywords: ['ai pdf reader', 'document summarizer'],
        canonicalUrl: 'https://ai-novex.netlify.app/blog/how-to-summarize-a-pdf-with-ai/',
        index: true,
        follow: true,
        maxImagePreview: 'large',
        maxSnippet: 160,
        maxVideoPreview: -1,
        ogTitle: 'Summarize PDFs Faster with AI',
        ogDescription: 'Practical AI PDF workflows tested by AINOVEX.',
        ogImage: '/images/articles/how-to-summarize-a-pdf-with-ai-og.webp',
        ogType: 'article',
        twitterTitle: 'Summarize PDFs with AI',
        twitterDescription: 'Tested workflow for accurate PDF summaries.',
        twitterImage: '/images/articles/how-to-summarize-a-pdf-with-ai.webp',
        twitterCard: 'summary_large_image',
        schemaType: 'Article',
        customStructuredData: {
          '@context': 'https://schema.org',
          '@type': 'TechArticle',
          headline: 'How to Summarize a PDF with AI',
        },
        breadcrumb: {
          enabled: true,
          label: 'PDF Summarizer Guide',
          items: [
            { name: 'Home', path: '/' },
            { name: 'Blog', path: '/blog/' },
            { name: 'PDF Guide', path: '/blog/how-to-summarize-a-pdf-with-ai/' },
          ],
        },
        imageAlt: 'Person reading AI generated PDF summary',
        ogImageAlt: 'OpenGraph preview for PDF summarization guide',
        twitterImageAlt: 'Twitter card preview for PDF summarization guide',
        customImageAlts: {
          hero_banner: 'Workflow diagram of AI PDF summarization',
          step_1: 'Uploading a research PDF to an AI assistant',
        },
      },
      {
        pageId: 'category:ai-writing',
        pageType: 'category',
        path: '/category/ai-writing/',
        slug: 'ai-writing',
        seoTitle: 'AI Writing Tools & Guides | AINOVEX',
        schemaType: 'CollectionPage',
      },
      {
        pageId: 'tool:chatgpt',
        pageType: 'tool',
        path: '/tools/chatgpt/',
        slug: 'chatgpt',
        seoTitle: 'ChatGPT Review, Pricing & Alternatives | AINOVEX',
        schemaType: 'SoftwareApplication',
      },
      {
        pageId: 'author:md-shamim',
        pageType: 'author',
        path: '/author/md-shamim/',
        slug: 'md-shamim',
        seoTitle: 'Md Shamim — Author Profile | AINOVEX',
        ogType: 'profile',
        schemaType: 'ProfilePage',
      },
      {
        pageId: 'static:methodology-v2',
        pageType: 'static',
        path: '/guides/v2_intro/step-1',
        slug: 'step-1',
        seoTitle: 'Testing Methodology v2 | AINOVEX',
        schemaType: 'WebPage',
      },
    ];

    for (const fixture of pageFixtures) {
      const createRes = await requestLocal({
        method: 'POST',
        reqPath: '/api/cms/seo/pages',
        headers: {
          Origin: EXPECTED_ORIGIN,
          Cookie: auth.cookiePair,
          'X-CSRF-Token': auth.csrfToken,
        },
        body: { page: fixture },
      });
      assert.equal(createRes.status, 201, `Create failed for ${fixture.pageId}: ${createRes.text}`);
      assert.ok(createRes.headers.etag, 'Expected ETag on 201 create');
      assert.equal(createRes.headers.location, `/api/cms/seo/pages/${fixture.pageId}`);
      assert.equal(createRes.json.page.pageId, fixture.pageId);
      assert.equal(createRes.json.page.pageType, fixture.pageType);
      assert.equal(
        createRes.json.page.path,
        normalizeSeoPagePath(fixture.path),
        'Expected canonical normalized path on stored record'
      );
      assert.ok(createRes.json.page.createdAt);
      assert.ok(createRes.json.page.updatedAt);

      const getRes = await requestLocal({
        method: 'GET',
        reqPath: `/api/cms/seo/pages/${fixture.pageId}`,
        headers: { Cookie: auth.cookiePair },
      });
      assert.equal(getRes.status, 200);
      assert.equal(getRes.headers.etag, createRes.headers.etag);

      const resolveRes = await requestLocal({
        method: 'GET',
        reqPath: `/api/cms/seo/resolve?path=${encodeURIComponent(fixture.path)}`,
        headers: { Cookie: auth.cookiePair },
      });
      assert.equal(resolveRes.status, 200);
      assert.equal(resolveRes.json.matched, true);
      assert.equal(resolveRes.json.effective.pageId, fixture.pageId);
      assert.equal(resolveRes.json.effective.seoTitle, fixture.seoTitle);
    }

    // Verify existing static page types seeded in content/seo.json (home, about, contact, privacy, terms, static)
    for (const seededId of ['home', 'about', 'contact', 'privacy', 'terms', 'static:editorial-policy']) {
      const res = await requestLocal({
        method: 'GET',
        reqPath: `/api/cms/seo/pages/${seededId}`,
        headers: { Cookie: auth.cookiePair },
      });
      assert.equal(res.status, 200, `Seeded page ${seededId} should be readable`);
    }

    // Filter by pageType and arbitrary valid path
    const filterTypeRes = await requestLocal({
      method: 'GET',
      reqPath: '/api/cms/seo/pages?pageType=article',
      headers: { Cookie: auth.cookiePair },
    });
    assert.equal(filterTypeRes.status, 200);
    assert.equal(filterTypeRes.json.pages.length, 1);
    assert.equal(filterTypeRes.json.pages[0].pageId, 'article:how-to-summarize-a-pdf-with-ai');

    const filterPathRes = await requestLocal({
      method: 'GET',
      reqPath: '/api/cms/seo/pages?path=%2Fguides%2Fv2_intro%2Fstep-1',
      headers: { Cookie: auth.cookiePair },
    });
    assert.equal(filterPathRes.status, 200);
    assert.equal(filterPathRes.json.total, 1);
    assert.equal(filterPathRes.json.pages[0].pageId, 'static:methodology-v2');

    // Unmatched arbitrary path falls back cleanly to global defaults
    const unmatchedResolve = await requestLocal({
      method: 'GET',
      reqPath: '/api/cms/seo/resolve?path=%2Ffuture-unconfigured-page',
      headers: { Cookie: auth.cookiePair },
    });
    assert.equal(unmatchedResolve.status, 200);
    assert.equal(unmatchedResolve.json.matched, false);
    assert.equal(unmatchedResolve.json.page, null);
    assert.equal(unmatchedResolve.json.effective.path, '/future-unconfigured-page/');
    assert.equal(unmatchedResolve.json.effective.hasPageOverride, false);
    assert.equal(
      unmatchedResolve.json.effective.seoTitle,
      'AINOVEX - Discover the Best AI Tools & Resources'
    );
  });

  it('3. Strict per-page & defaults isolation: updating or clearing one page never overwrites another', async () => {
    const aboutBefore = await requestLocal({
      method: 'GET',
      reqPath: '/api/cms/seo/pages/about',
      headers: { Cookie: auth.cookiePair },
    });
    const contactBefore = await requestLocal({
      method: 'GET',
      reqPath: '/api/cms/seo/pages/contact',
      headers: { Cookie: auth.cookiePair },
    });
    const defaultsBefore = await requestLocal({
      method: 'GET',
      reqPath: '/api/cms/seo/defaults',
      headers: { Cookie: auth.cookiePair },
    });
    assert.equal(aboutBefore.status, 200);
    assert.equal(contactBefore.status, 200);
    assert.equal(defaultsBefore.status, 200);

    // Update About page only
    const aboutPut = await requestLocal({
      method: 'PUT',
      reqPath: '/api/cms/seo/pages/about',
      headers: {
        Origin: EXPECTED_ORIGIN,
        Cookie: auth.cookiePair,
        'X-CSRF-Token': auth.csrfToken,
        'If-Match': aboutBefore.headers.etag,
      },
      body: {
        page: {
          seoTitle: 'About AINOVEX Editorial Standards Updated',
          metaDescription: 'Updated meta description exclusively for the About page.',
          index: false,
          ogImage: '/images/og-default.png',
        },
      },
    });
    assert.equal(aboutPut.status, 200, aboutPut.text);
    assert.notEqual(aboutPut.headers.etag, aboutBefore.headers.etag);
    assert.equal(aboutPut.json.page.createdAt, aboutBefore.json.page.createdAt);
    assert.equal(aboutPut.json.page.seoTitle, 'About AINOVEX Editorial Standards Updated');

    // Clear seoTitle & index override on About via explicit null -> inherits global default cleanly
    const aboutClear = await requestLocal({
      method: 'PUT',
      reqPath: '/api/cms/seo/pages/about',
      headers: {
        Origin: EXPECTED_ORIGIN,
        Cookie: auth.cookiePair,
        'X-CSRF-Token': auth.csrfToken,
        'If-Match': aboutPut.headers.etag,
      },
      body: {
        page: {
          seoTitle: null,
          index: null,
        },
      },
    });
    assert.equal(aboutClear.status, 200, aboutClear.text);
    assert.equal('seoTitle' in aboutClear.json.page, false);
    assert.equal(
      aboutClear.json.effective.seoTitle,
      defaultsBefore.json.defaults.defaultSeoTitle
    );
    assert.equal(aboutClear.json.effective.index, defaultsBefore.json.defaults.defaultIndex);

    // Verify Contact page and Global Defaults were NOT modified
    const contactAfter = await requestLocal({
      method: 'GET',
      reqPath: '/api/cms/seo/pages/contact',
      headers: { Cookie: auth.cookiePair },
    });
    const defaultsAfter = await requestLocal({
      method: 'GET',
      reqPath: '/api/cms/seo/defaults',
      headers: { Cookie: auth.cookiePair },
    });
    assert.equal(contactAfter.headers.etag, contactBefore.headers.etag);
    assert.deepEqual(contactAfter.json.page, contactBefore.json.page);
    assert.equal(defaultsAfter.headers.etag, defaultsBefore.headers.etag);
    assert.deepEqual(defaultsAfter.json.defaults, defaultsBefore.json.defaults);

    // Update global defaults without touching page overrides
    const defaultsPut = await requestLocal({
      method: 'PUT',
      reqPath: '/api/cms/seo/defaults',
      headers: {
        Origin: EXPECTED_ORIGIN,
        Cookie: auth.cookiePair,
        'X-CSRF-Token': auth.csrfToken,
        'If-Match': defaultsBefore.headers.etag,
      },
      body: {
        defaults: {
          defaultSeoTitle: 'AINOVEX Global Default SEO Title v2',
          defaultTwitterSite: '@ainovex_ai',
        },
      },
    });
    assert.equal(defaultsPut.status, 200, defaultsPut.text);
    assert.notEqual(defaultsPut.headers.etag, defaultsBefore.headers.etag);
    assert.equal(
      defaultsPut.json.defaults.defaultSeoTitle,
      'AINOVEX Global Default SEO Title v2'
    );
    assert.equal(defaultsPut.json.defaults.defaultTwitterSite, '@ainovex_ai');

    // Contact override remains unchanged, while About now resolves to updated default title
    const contactAfterDefaults = await requestLocal({
      method: 'GET',
      reqPath: '/api/cms/seo/pages/contact',
      headers: { Cookie: auth.cookiePair },
    });
    assert.equal(contactAfterDefaults.headers.etag, contactBefore.headers.etag);

    const aboutResolveAfterDefaults = await requestLocal({
      method: 'GET',
      reqPath: '/api/cms/seo/resolve?path=%2Fabout%2F',
      headers: { Cookie: auth.cookiePair },
    });
    assert.equal(
      aboutResolveAfterDefaults.json.effective.seoTitle,
      'AINOVEX Global Default SEO Title v2'
    );
  });

  it('4. Rejects invalid/duplicate pageIds, duplicate normalized paths, and path/pageType mismatches', async () => {
    // Duplicate pageId (409)
    const dupIdRes = await requestLocal({
      method: 'POST',
      reqPath: '/api/cms/seo/pages',
      headers: {
        Origin: EXPECTED_ORIGIN,
        Cookie: auth.cookiePair,
        'X-CSRF-Token': auth.csrfToken,
      },
      body: {
        page: {
          pageId: 'about',
          pageType: 'about',
          path: '/about-copy/',
          slug: 'about-copy',
        },
      },
    });
    assert.equal(dupIdRes.status, 409);

    // Duplicate normalized path with different pageId & omitted trailing slash (409)
    const dupPathRes = await requestLocal({
      method: 'POST',
      reqPath: '/api/cms/seo/pages',
      headers: {
        Origin: EXPECTED_ORIGIN,
        Cookie: auth.cookiePair,
        'X-CSRF-Token': auth.csrfToken,
      },
      body: {
        page: {
          pageId: 'static:about-alias',
          pageType: 'static',
          path: '/about',
          slug: 'about-alias',
        },
      },
    });
    assert.equal(dupPathRes.status, 409);

    // PUT moving one page onto another page's path -> 409 Conflict
    const contactCur = await requestLocal({
      method: 'GET',
      reqPath: '/api/cms/seo/pages/contact',
      headers: { Cookie: auth.cookiePair },
    });
    const stealPathRes = await requestLocal({
      method: 'PUT',
      reqPath: '/api/cms/seo/pages/contact',
      headers: {
        Origin: EXPECTED_ORIGIN,
        Cookie: auth.cookiePair,
        'X-CSRF-Token': auth.csrfToken,
        'If-Match': contactCur.headers.etag,
      },
      body: {
        page: { path: '/privacy' },
      },
    });
    assert.equal(stealPathRes.status, 409);

    // Invalid pageId formats in body & URL path parser
    for (const badId of ['../etc/passwd', 'Upper_Case', '-leading-hyphen', 'has space', 'a'.repeat(129)]) {
      const badCreate = await requestLocal({
        method: 'POST',
        reqPath: '/api/cms/seo/pages',
        headers: {
          Origin: EXPECTED_ORIGIN,
          Cookie: auth.cookiePair,
          'X-CSRF-Token': auth.csrfToken,
        },
        body: {
          page: {
            pageId: badId,
            pageType: 'static',
            path: '/valid-test-path/',
            slug: 'valid-test-path',
          },
        },
      });
      assert.equal(badCreate.status, 400, `Expected 400 for invalid pageId "${badId}"`);
    }

    // Raw-path traversal & encoded separator checks on route parser
    for (const badRawPath of [
      '/api/cms/seo/pages/..%2fetc',
      '/api/cms/seo/pages/foo%2fbar',
      '/api/cms/seo/pages/foo%5cbar',
      '/api/cms/seo/pages/foo\\bar',
      '/api/cms/seo/pages/%2e%2e',
      '/api/cms/seo/pages/foo%2520bar',
      '/api/cms/seo/pages/InvalidUpper',
      '/api/cms/seo/pages/foo%ZZ',
    ]) {
      const parsed = parseSeoPagePath(badRawPath);
      assert.equal(parsed.statusCode, 400, `parseSeoPagePath should return 400 for ${badRawPath}`);
      const res = await requestLocal({
        method: 'GET',
        reqPath: badRawPath,
        headers: { Cookie: auth.cookiePair },
      });
      assert.equal(res.status, 400, `GET should return 400 for ${badRawPath}`);
      assertNoPathOrInternalLeak(res.text, tempRoot);
    }

    // Home/path mismatches
    const nonHomeAtRoot = await requestLocal({
      method: 'POST',
      reqPath: '/api/cms/seo/pages',
      headers: {
        Origin: EXPECTED_ORIGIN,
        Cookie: auth.cookiePair,
        'X-CSRF-Token': auth.csrfToken,
      },
      body: {
        page: { pageId: 'static:root-hijack', pageType: 'static', path: '/', slug: 'home' },
      },
    });
    assert.equal(nonHomeAtRoot.status, 400);

    const homeOffRoot = await requestLocal({
      method: 'POST',
      reqPath: '/api/cms/seo/pages',
      headers: {
        Origin: EXPECTED_ORIGIN,
        Cookie: auth.cookiePair,
        'X-CSRF-Token': auth.csrfToken,
      },
      body: {
        page: { pageId: 'home-two', pageType: 'home', path: '/not-root/', slug: 'home' },
      },
    });
    assert.equal(homeOffRoot.status, 400);

    // Body pageId mismatch on PUT
    const idMismatch = await requestLocal({
      method: 'PUT',
      reqPath: '/api/cms/seo/pages/contact',
      headers: {
        Origin: EXPECTED_ORIGIN,
        Cookie: auth.cookiePair,
        'X-CSRF-Token': auth.csrfToken,
        'If-Match': contactCur.headers.etag,
      },
      body: { page: { pageId: 'privacy', seoTitle: 'Mismatch' } },
    });
    assert.equal(idMismatch.status, 400);
  });

  it('5. Rejects invalid URLs, malformed SEO fields, prototype pollution, and client timestamps', async () => {
    const contactCur = await requestLocal({
      method: 'GET',
      reqPath: '/api/cms/seo/pages/contact',
      headers: { Cookie: auth.cookiePair },
    });

    const invalidPayloads = [
      { page: { canonicalUrl: 'javascript:alert(1)' } },
      { page: { canonicalUrl: 'https://user:pass@example.com/contact/' } },
      { page: { canonicalUrl: 'http://127.1/contact/' } },
      { page: { canonicalUrl: 'https://example.com:080/contact/' } },
      { page: { ogImage: '//evil.com/og.png' } },
      { page: { twitterImage: 'data:image/png;base64,AAAA' } },
      { page: { seoTitle: 'ab' } },
      { page: { seoTitle: 'x'.repeat(161) } },
      { page: { seoTitle: 'Title\nWithControlChar' } },
      { page: { metaDescription: 'Too short' } },
      { page: { secondaryKeywords: ['ai', 'AI'] } },
      { page: { maxImagePreview: 'huge' } },
      { page: { maxSnippet: -2 } },
      { page: { schemaType: 'InvalidSchemaType' } },
      { page: { ogType: 'invalid_og' } },
      { page: { twitterCard: 'unknown_card' } },
      { page: { customStructuredData: { '@type': 'WebPage', note: '</script><script>alert(1)</script>' } } },
      { page: { customStructuredData: { '@type': 'WebPage', url: 'javascript:alert(1)' } } },
      { page: { breadcrumb: { enabled: 'yes' } } },
      { page: { breadcrumb: { items: [{ name: 'Bad', path: 'no-leading-slash' }] } } },
      { page: { customImageAlts: { 'invalid key!': 'Some alt text' } } },
      { page: { createdAt: '2026-01-01T00:00:00.000Z' } },
      { page: { updatedAt: '2026-01-01T00:00:00.000Z' } },
      { page: { unknownField: 'nope' } },
    ];

    for (const badBody of invalidPayloads) {
      const res = await requestLocal({
        method: 'PUT',
        reqPath: '/api/cms/seo/pages/contact',
        headers: {
          Origin: EXPECTED_ORIGIN,
          Cookie: auth.cookiePair,
          'X-CSRF-Token': auth.csrfToken,
          'If-Match': contactCur.headers.etag,
        },
        body: badBody,
      });
      assert.equal(
        res.status,
        400,
        `Expected 400 for malformed payload ${JSON.stringify(badBody)}, got ${res.status}: ${res.text}`
      );
      assertNoPathOrInternalLeak(res.text, tempRoot);
    }

    // Raw JSON prototype pollution key check (__proto__)
    const protoRes = await requestLocal({
      method: 'PUT',
      reqPath: '/api/cms/seo/pages/contact',
      headers: {
        Origin: EXPECTED_ORIGIN,
        Cookie: auth.cookiePair,
        'X-CSRF-Token': auth.csrfToken,
        'If-Match': contactCur.headers.etag,
        'Content-Type': 'application/json',
      },
      body: '{"page":{"seoTitle":"Contact AINOVEX Safe Title","__proto__":{"admin":true}}}',
    });
    assert.equal(protoRes.status, 400);

    // Invalid path query param on resolve
    for (const badPathQuery of ['/blog//double', '/blog/../etc', '/blog?x=1', '/Upper']) {
      const qRes = await requestLocal({
        method: 'GET',
        reqPath: `/api/cms/seo/resolve?path=${encodeURIComponent(badPathQuery)}`,
        headers: { Cookie: auth.cookiePair },
      });
      assert.equal(qRes.status, 400, `Expected 400 for resolve path ${badPathQuery}`);
    }
  });

  it('6. Enforces Authentication, CSRF, Origin/Sec-Fetch-Site, Media-Type, and DELETE body rules', async () => {
    const endpoints = [
      ['GET', '/api/cms/seo'],
      ['GET', '/api/cms/seo/defaults'],
      ['GET', '/api/cms/seo/pages'],
      ['GET', '/api/cms/seo/pages/home'],
      ['GET', '/api/cms/seo/resolve?path=%2F'],
      ['PUT', '/api/cms/seo/defaults'],
      ['POST', '/api/cms/seo/pages'],
      ['PUT', '/api/cms/seo/pages/home'],
      ['DELETE', '/api/cms/seo/pages/home'],
    ];

    for (const [method, reqPath] of endpoints) {
      const noAuth = await requestLocal({
        method,
        reqPath,
        headers: method === 'GET' ? {} : { Origin: EXPECTED_ORIGIN },
        body: method === 'GET' || method === 'DELETE' ? null : {},
      });
      assert.equal(noAuth.status, 401, `${method} ${reqPath} without auth must return 401`);

      const badCookie = await requestLocal({
        method,
        reqPath,
        headers: {
          Cookie: `${COOKIE_NAME}=forged-session-token`,
          ...(method === 'GET' ? {} : { Origin: EXPECTED_ORIGIN }),
        },
        body: method === 'GET' || method === 'DELETE' ? null : {},
      });
      assert.equal(badCookie.status, 401, `${method} ${reqPath} with bad cookie must return 401`);
    }

    // Missing / wrong CSRF on mutating endpoints -> 403
    for (const [method, reqPath, body] of [
      ['PUT', '/api/cms/seo/defaults', { defaults: { siteName: 'AINOVEX' } }],
      ['POST', '/api/cms/seo/pages', { page: { pageId: 'x', pageType: 'static', path: '/x/', slug: 'x' } }],
      ['PUT', '/api/cms/seo/pages/about', { page: { seoTitle: 'Test Title' } }],
      ['DELETE', '/api/cms/seo/pages/about', null],
    ]) {
      const noCsrf = await requestLocal({
        method,
        reqPath,
        headers: { Origin: EXPECTED_ORIGIN, Cookie: auth.cookiePair },
        body,
      });
      assert.equal(noCsrf.status, 403, `${method} ${reqPath} missing CSRF must return 403`);

      const badCsrf = await requestLocal({
        method,
        reqPath,
        headers: {
          Origin: EXPECTED_ORIGIN,
          Cookie: auth.cookiePair,
          'X-CSRF-Token': 'wrong-token',
        },
        body,
      });
      assert.equal(badCsrf.status, 403, `${method} ${reqPath} wrong CSRF must return 403`);
    }

    // Cross-site Sec-Fetch-Site -> 403
    const crossSite = await requestLocal({
      method: 'GET',
      reqPath: '/api/cms/seo',
      headers: {
        Cookie: auth.cookiePair,
        'Sec-Fetch-Site': 'cross-site',
      },
    });
    assert.equal(crossSite.status, 403);

    // Unsupported Content-Type -> 415
    const wrongMedia = await requestLocal({
      method: 'POST',
      reqPath: '/api/cms/seo/pages',
      headers: {
        Origin: EXPECTED_ORIGIN,
        Cookie: auth.cookiePair,
        'X-CSRF-Token': auth.csrfToken,
        'Content-Type': 'text/plain',
      },
      body: 'not json',
    });
    assert.equal(wrongMedia.status, 415);

    // DELETE with non-empty body -> 400
    const delWithBody = await requestLocal({
      method: 'DELETE',
      reqPath: '/api/cms/seo/pages/static:methodology-v2',
      headers: {
        Origin: EXPECTED_ORIGIN,
        Cookie: auth.cookiePair,
        'X-CSRF-Token': auth.csrfToken,
      },
      body: { unexpected: true },
    });
    assert.equal(delWithBody.status, 400);
  });

  it('7. Enforces strong ETag / If-Match preconditions and concurrent writer safety', async () => {
    const pageRes = await requestLocal({
      method: 'GET',
      reqPath: '/api/cms/seo/pages/static:methodology-v2',
      headers: { Cookie: auth.cookiePair },
    });
    assert.equal(pageRes.status, 200);
    const validEtag = pageRes.headers.etag;
    assert.match(validEtag, /^"[0-9a-f]{64}"$/);

    // 428 Missing If-Match
    const missingEtag = await requestLocal({
      method: 'PUT',
      reqPath: '/api/cms/seo/pages/static:methodology-v2',
      headers: {
        Origin: EXPECTED_ORIGIN,
        Cookie: auth.cookiePair,
        'X-CSRF-Token': auth.csrfToken,
      },
      body: { page: { seoTitle: 'Updated Methodology' } },
    });
    assert.equal(missingEtag.status, 428);

    // 400 Weak / wildcard / uppercase / malformed If-Match
    for (const badTag of [`W/${validEtag}`, '*', `"${'A'.repeat(64)}"`, 'invalid-etag', `${validEtag}, ${validEtag}`]) {
      const invalidEtagRes = await requestLocal({
        method: 'PUT',
        reqPath: '/api/cms/seo/pages/static:methodology-v2',
        headers: {
          Origin: EXPECTED_ORIGIN,
          Cookie: auth.cookiePair,
          'X-CSRF-Token': auth.csrfToken,
          'If-Match': badTag,
        },
        body: { page: { seoTitle: 'Updated Methodology' } },
      });
      assert.equal(invalidEtagRes.status, 400, `Expected 400 for bad If-Match ${badTag}`);
    }

    // 412 Stale ETag
    const staleRes = await requestLocal({
      method: 'PUT',
      reqPath: '/api/cms/seo/pages/static:methodology-v2',
      headers: {
        Origin: EXPECTED_ORIGIN,
        Cookie: auth.cookiePair,
        'X-CSRF-Token': auth.csrfToken,
        'If-Match': `"${'0'.repeat(64)}"`,
      },
      body: { page: { seoTitle: 'Updated Methodology' } },
    });
    assert.equal(staleRes.status, 412);

    // Concurrent two PUTs racing with same ETag: exactly one wins (200) and one gets 412
    const [r1, r2] = await Promise.all([
      requestLocal({
        method: 'PUT',
        reqPath: '/api/cms/seo/pages/static:methodology-v2',
        headers: {
          Origin: EXPECTED_ORIGIN,
          Cookie: auth.cookiePair,
          'X-CSRF-Token': auth.csrfToken,
          'If-Match': validEtag,
        },
        body: { page: { seoTitle: 'Concurrent Writer One Wins' } },
      }),
      requestLocal({
        method: 'PUT',
        reqPath: '/api/cms/seo/pages/static:methodology-v2',
        headers: {
          Origin: EXPECTED_ORIGIN,
          Cookie: auth.cookiePair,
          'X-CSRF-Token': auth.csrfToken,
          'If-Match': validEtag,
        },
        body: { page: { seoTitle: 'Concurrent Writer Two Conflict' } },
      }),
    ]);
    const statuses = [r1.status, r2.status].sort();
    assert.deepEqual(statuses, [200, 412], `Expected [200, 412], got ${JSON.stringify(statuses)}`);

    const winner = r1.status === 200 ? r1 : r2;
    const delRes = await requestLocal({
      method: 'DELETE',
      reqPath: '/api/cms/seo/pages/static:methodology-v2',
      headers: {
        Origin: EXPECTED_ORIGIN,
        Cookie: auth.cookiePair,
        'X-CSRF-Token': auth.csrfToken,
        'If-Match': winner.headers.etag,
      },
    });
    assert.equal(delRes.status, 200);
    assert.equal(delRes.json.deleted, true);

    const afterDel = await requestLocal({
      method: 'GET',
      reqPath: '/api/cms/seo/pages/static:methodology-v2',
      headers: { Cookie: auth.cookiePair },
    });
    assert.equal(afterDel.status, 404);
  });

  it('8. Storage rollback, pre-write backups, sanitized store-failure responses, and mutex cleanup', async () => {
    const seoPath = path.join(tempRoot, 'content', 'seo.json');
    const beforeWrite = await hashFile(seoPath);

    // Pre-write backups exist in isolated .backups dir (from earlier writes in this suite)
    const backups = await defaultStorageEngine.listBackups('seo.json');
    assert.ok(backups.length > 0, 'Expected pre-write backups for seo.json in isolated backupDir');

    // Simulated HTTP mutation failure rolls back seo.json byte-for-byte
    const contactCur = await requestLocal({
      method: 'GET',
      reqPath: '/api/cms/seo/pages/contact',
      headers: { Cookie: auth.cookiePair },
    });
    assert.equal(contactCur.status, 200);

    const addedTestFlag = !process.argv.includes('--test');
    if (addedTestFlag) process.argv.push('--test');
    try {
      const simFailRes = await requestLocal({
        method: 'PUT',
        reqPath: '/api/cms/seo/pages/contact',
        headers: {
          Origin: EXPECTED_ORIGIN,
          Cookie: auth.cookiePair,
          'X-CSRF-Token': auth.csrfToken,
          'If-Match': contactCur.headers.etag,
          'x-test-simulate-failure-at-index': '0',
        },
        body: { page: { seoTitle: 'This Write Must Roll Back Cleanly' } },
      });
      assert.equal(simFailRes.status, 500);
      assertNoPathOrInternalLeak(simFailRes.text, tempRoot);
    } finally {
      if (addedTestFlag) {
        const idx = process.argv.lastIndexOf('--test');
        if (idx >= 0) process.argv.splice(idx, 1);
      }
    }

    const afterRollback = await hashFile(seoPath);
    assert.equal(
      afterRollback.sha256,
      beforeWrite.sha256,
      'seo.json bytes must be identical after rolled-back mutation'
    );
    assert.equal(getActiveMutexCount(), 0, 'All file mutexes must be released after failure');

    // Corrupted store returns sanitized 500 without leaking filesystem path or filename
    await fs.promises.writeFile(seoPath, '{"broken": true}', 'utf8');
    const corruptGet = await requestLocal({
      method: 'GET',
      reqPath: '/api/cms/seo',
      headers: { Cookie: auth.cookiePair },
    });
    assert.equal(corruptGet.status, 500);
    assertNoPathOrInternalLeak(corruptGet.text, tempRoot);

    // Restore valid seo.json bytes in isolated dir and confirm full verification
    await fs.promises.writeFile(seoPath, afterRollback.bytes);
    const recoveredGet = await requestLocal({
      method: 'GET',
      reqPath: '/api/cms/seo',
      headers: { Cookie: auth.cookiePair },
    });
    assert.equal(recoveredGet.status, 200);
    assert.ok(isValidSeoPageId('home') && isValidSeoPagePath('/'));
    assert.equal(validateSeoDefaults(recoveredGet.json.seo.defaults, { isCmsInput: false }).isValid, true);
    assert.equal(
      validateSeoPageRecord(recoveredGet.json.seo.pages.home, { isCmsInput: false }).isValid,
      true
    );
    assert.equal(getActiveMutexCount(), 0);
  });
});
