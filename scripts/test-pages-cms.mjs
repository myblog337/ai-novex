import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

process.env.NODE_ENV = 'test-no-listen';

const {
  ALLOWED_CUSTOM_PAGE_FIELDS,
  FORBIDDEN_CUSTOM_PAGE_SEO_FIELDS,
  RESERVED_PAGE_ROUTES,
  RESERVED_PAGE_SLUGS,
  isReservedPageSlug,
  isValidCustomPageId,
  isValidCustomPageSlug,
  inspectCustomPageContentSafety,
  validateCustomPage,
  validatePages,
} = await import('./lib/validators.mjs');

const {
  defaultStorageEngine,
  ALLOWED_JSON_FILES,
  resolveSecureJsonPath,
  getActiveMutexCount,
} = await import('./lib/storage.mjs');

const {
  server,
  HOST,
  PORT,
  EXPECTED_HOST,
  EXPECTED_ORIGIN,
  resetAuthStateForTesting,
  startServerForTesting,
  parseCustomPagePath,
  computeCustomPageETag,
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
    path.join(contentDir, 'pages.json'),
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

    if (
      rawBody !== null &&
      !Object.keys(reqHeaders).some((k) => k.toLowerCase() === 'content-type')
    ) {
      reqHeaders['Content-Type'] = 'application/json';
    }
    if (
      rawBody !== null &&
      !Object.keys(reqHeaders).some((k) => k.toLowerCase() === 'content-length')
    ) {
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
  assert.ok(!responseText.includes('pages.json'), 'Response leaked internal filename pages.json');
  assert.ok(!responseText.includes('/content/'), 'Response leaked internal /content/ path');
  assert.ok(!responseText.includes('.backups'), 'Response leaked .backups directory');
}

describe('Task 114-H0 — Custom Static Pages Data Model, Secure Storage & CRUD API', () => {
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

    const rawTmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ainovex-pages-test-'));
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

  it('1. Storage allowlist registration, initial pages.json validation, and path protection', async () => {
    assert.ok(ALLOWED_JSON_FILES.includes('pages.json'), 'pages.json must be in ALLOWED_JSON_FILES');

    const pages = await defaultStorageEngine.readJson('pages.json');
    assert.ok(Array.isArray(pages), 'pages.json must be an array');
    const check = validatePages(pages);
    assert.equal(check.isValid, true, JSON.stringify(check.errors));

    // Arbitrary paths and store deletion must remain rejected
    assert.throws(() => resolveSecureJsonPath('../package.json', tempRoot));
    assert.throws(() => resolveSecureJsonPath('content/pages.json', tempRoot));
    assert.throws(() => resolveSecureJsonPath('/tmp/pages.json', tempRoot));
    await assert.rejects(() => defaultStorageEngine.deleteJson('pages.json'), {
      code: 'FORBIDDEN_OPERATION',
    });
  });

  it('2. Valid page creation, default unpublished state, listing, and single retrieval', async () => {
    const createRes = await requestLocal({
      method: 'POST',
      reqPath: '/api/cms/pages',
      headers: {
        Origin: EXPECTED_ORIGIN,
        Cookie: auth.cookiePair,
        'X-CSRF-Token': auth.csrfToken,
      },
      body: {
        page: {
          slug: 'ai-glossary',
          title: '  AI Glossary & Terminology  ',
          content: '# AI Glossary\n\nPlain Markdown body with **bold** text and [safe link](https://example.com).',
        },
      },
    });

    assert.equal(createRes.status, 201, `Expected 201, got ${createRes.status}: ${createRes.text}`);
    assert.equal(createRes.json?.success, true);

    const created = createRes.json?.page;
    assert.ok(created && typeof created.id === 'string' && isValidCustomPageId(created.id));
    assert.equal(created.slug, 'ai-glossary');
    assert.equal(created.title, 'AI Glossary & Terminology');
    assert.equal(created.isPublished, false, 'New page must default to isPublished: false');
    assert.ok(typeof created.createdAt === 'string' && created.createdAt.endsWith('Z'));
    assert.equal(created.updatedAt, created.createdAt);
    assert.deepEqual(Object.keys(created).sort(), [...ALLOWED_CUSTOM_PAGE_FIELDS].sort());

    const postETag = createRes.headers.etag;
    assert.ok(/^"[0-9a-f]{64}"$/.test(postETag), `Expected strong SHA-256 ETag, got ${postETag}`);
    assert.equal(createRes.headers.location, `/api/cms/pages/${created.id}`);
    assert.equal(postETag, computeCustomPageETag(created));

    // Listing
    const listRes = await requestLocal({
      method: 'GET',
      reqPath: '/api/cms/pages',
      headers: { Cookie: auth.cookiePair },
    });
    assert.equal(listRes.status, 200);
    assert.equal(listRes.json?.success, true);
    assert.equal(listRes.json?.total, 1);
    assert.equal(listRes.json?.pages?.length, 1);
    assert.equal(listRes.json.pages[0].id, created.id);

    // Single retrieval
    const getRes = await requestLocal({
      method: 'GET',
      reqPath: `/api/cms/pages/${created.id}`,
      headers: { Cookie: auth.cookiePair },
    });
    assert.equal(getRes.status, 200);
    assert.equal(getRes.headers.etag, postETag);
    assert.deepEqual(getRes.json?.page, created);

    // Missing ID -> 404
    const missingGet = await requestLocal({
      method: 'GET',
      reqPath: '/api/cms/pages/nonexistent-page-id-123',
      headers: { Cookie: auth.cookiePair },
    });
    assert.equal(missingGet.status, 404);
  });

  it('3. Rejects creating a pre-published page on POST and allows updating via PUT with ETag rotation', async () => {
    // Reject isPublished: true on creation
    const pubOnCreate = await requestLocal({
      method: 'POST',
      reqPath: '/api/cms/pages',
      headers: {
        Origin: EXPECTED_ORIGIN,
        Cookie: auth.cookiePair,
        'X-CSRF-Token': auth.csrfToken,
      },
      body: {
        page: {
          slug: 'cannot-publish-on-create',
          title: 'Pre-published Attempt',
          content: 'Draft content.',
          isPublished: true,
        },
      },
    });
    assert.equal(pubOnCreate.status, 400);

    // Create second unpublished page explicitly passing isPublished: false
    const createRes2 = await requestLocal({
      method: 'POST',
      reqPath: '/api/cms/pages',
      headers: {
        Origin: EXPECTED_ORIGIN,
        Cookie: auth.cookiePair,
        'X-CSRF-Token': auth.csrfToken,
      },
      body: {
        page: {
          slug: 'partner-program',
          title: 'Partner Program',
          content: '## Partner Overview\n\nDetails coming soon.',
          isPublished: false,
        },
      },
    });
    assert.equal(createRes2.status, 201);
    const page2 = createRes2.json.page;
    const etag1 = createRes2.headers.etag;
    assert.equal(page2.isPublished, false);

    // Ensure at least 2ms passes so updatedAt advances cleanly when clock ticks
    await new Promise((r) => setTimeout(r, 5));

    // Update page2 via PUT with valid If-Match
    const updateRes = await requestLocal({
      method: 'PUT',
      reqPath: `/api/cms/pages/${page2.id}`,
      headers: {
        Origin: EXPECTED_ORIGIN,
        Cookie: auth.cookiePair,
        'X-CSRF-Token': auth.csrfToken,
        'If-Match': etag1,
      },
      body: {
        page: {
          id: page2.id,
          slug: 'partners',
          title: 'Partner Program Updated',
          content: '## Partner Overview\n\nUpdated Markdown guide.',
          isPublished: true,
        },
      },
    });

    assert.equal(updateRes.status, 200, `Update failed: ${updateRes.text}`);
    const updated = updateRes.json.page;
    const etag2 = updateRes.headers.etag;
    assert.equal(updated.id, page2.id, 'id must remain immutable');
    assert.equal(updated.createdAt, page2.createdAt, 'createdAt must remain immutable');
    assert.ok(Date.parse(updated.updatedAt) >= Date.parse(updated.createdAt));
    assert.equal(updated.slug, 'partners');
    assert.equal(updated.title, 'Partner Program Updated');
    assert.equal(updated.isPublished, true);
    assert.notEqual(etag2, etag1, 'ETag must rotate after update');

    // Stale If-Match using old etag1 must fail with 412
    const stalePut = await requestLocal({
      method: 'PUT',
      reqPath: `/api/cms/pages/${page2.id}`,
      headers: {
        Origin: EXPECTED_ORIGIN,
        Cookie: auth.cookiePair,
        'X-CSRF-Token': auth.csrfToken,
        'If-Match': etag1,
      },
      body: {
        page: { title: 'Stale Write Should Fail' },
      },
    });
    assert.equal(stalePut.status, 412);
  });

  it('4. Rejects duplicate IDs and duplicate slugs across API and storage validation', async () => {
    const listRes = await requestLocal({
      method: 'GET',
      reqPath: '/api/cms/pages',
      headers: { Cookie: auth.cookiePair },
    });
    assert.equal(listRes.status, 200);
    const existingPages = listRes.json.pages;
    assert.ok(existingPages.length >= 2);
    const first = existingPages[0];
    const second = existingPages[1];

    // Duplicate slug on POST -> 409 Conflict
    const dupSlugPost = await requestLocal({
      method: 'POST',
      reqPath: '/api/cms/pages',
      headers: {
        Origin: EXPECTED_ORIGIN,
        Cookie: auth.cookiePair,
        'X-CSRF-Token': auth.csrfToken,
      },
      body: {
        page: {
          slug: first.slug,
          title: 'Duplicate Slug Attempt',
          content: 'Body content.',
        },
      },
    });
    assert.equal(dupSlugPost.status, 409);

    // Duplicate slug on PUT -> 409 Conflict
    const getSecond = await requestLocal({
      method: 'GET',
      reqPath: `/api/cms/pages/${second.id}`,
      headers: { Cookie: auth.cookiePair },
    });
    const dupSlugPut = await requestLocal({
      method: 'PUT',
      reqPath: `/api/cms/pages/${second.id}`,
      headers: {
        Origin: EXPECTED_ORIGIN,
        Cookie: auth.cookiePair,
        'X-CSRF-Token': auth.csrfToken,
        'If-Match': getSecond.headers.etag,
      },
      body: {
        page: {
          slug: first.slug,
        },
      },
    });
    assert.equal(dupSlugPut.status, 409);

    // Direct schema validator rejects duplicate id and duplicate slug
    const dupIdVal = validatePages([
      first,
      { ...second, id: first.id, slug: 'unique-other-slug' },
    ]);
    assert.equal(dupIdVal.isValid, false);
    assert.ok(dupIdVal.errors.some((e) => e.code === 'DUPLICATE_ID'));

    const dupSlugVal = validatePages([
      first,
      { ...second, slug: first.slug },
    ]);
    assert.equal(dupSlugVal.isValid, false);
    assert.ok(dupSlugVal.errors.some((e) => e.code === 'DUPLICATE_SLUG'));
  });

  it('5. Enforces strict slug rules, reserved route collision protection, and path traversal rejection', async () => {
    const reservedCases = [
      '/',
      '/tools',
      'tools',
      '/blog',
      'blog',
      '/categories',
      'categories',
      '/category',
      'category',
      '/author',
      'author',
      '/about',
      'about',
      '/contact',
      'contact',
      '/privacy',
      'privacy',
      '/terms',
      'terms',
      '/editorial-policy',
      'editorial-policy',
      '/affiliate-disclosure',
      'affiliate-disclosure',
      '/404',
      '404',
      '/api',
      'api',
      'assets',
      'images',
      'best-ai-tools-bulk-product-catalog-enrichment',
    ];

    for (const candidate of reservedCases) {
      assert.equal(
        isReservedPageSlug(candidate),
        true,
        `Expected isReservedPageSlug("${candidate}") to be true`
      );
      assert.equal(
        isValidCustomPageSlug(candidate),
        false,
        `Expected isValidCustomPageSlug("${candidate}") to be false`
      );

      const res = await requestLocal({
        method: 'POST',
        reqPath: '/api/cms/pages',
        headers: {
          Origin: EXPECTED_ORIGIN,
          Cookie: auth.cookiePair,
          'X-CSRF-Token': auth.csrfToken,
        },
        body: {
          page: {
            slug: candidate,
            title: 'Reserved Collision Test',
            content: 'Should be rejected.',
          },
        },
      });
      assert.equal(res.status, 400, `Expected 400 for reserved slug "${candidate}", got ${res.status}`);
    }

    assert.ok(RESERVED_PAGE_ROUTES.includes('/api'));
    assert.ok(RESERVED_PAGE_SLUGS.includes('editorial-policy'));

    const malformedSlugs = [
      '',
      ' ',
      'a',
      'Uppercase-Slug',
      'under_score',
      '-leading-hyphen',
      'trailing-hyphen-',
      'double--hyphen',
      '../secret',
      'foo/bar',
      'foo\\bar',
      'foo%2fbar',
      'foo%2e%2ebar',
      'bad\0null',
      'page.html',
      'page.md',
      'a'.repeat(81),
    ];

    for (const badSlug of malformedSlugs) {
      assert.equal(
        isValidCustomPageSlug(badSlug),
        false,
        `Expected invalid slug "${badSlug}" to fail`
      );
      const res = await requestLocal({
        method: 'POST',
        reqPath: '/api/cms/pages',
        headers: {
          Origin: EXPECTED_ORIGIN,
          Cookie: auth.cookiePair,
          'X-CSRF-Token': auth.csrfToken,
        },
        body: {
          page: {
            slug: badSlug,
            title: 'Malformed Slug Test',
            content: 'Should be rejected.',
          },
        },
      });
      assert.equal(res.status, 400, `Expected 400 for malformed slug "${badSlug}", got ${res.status}`);
    }

    // URL path traversal and encoded traversal checks on :id routes
    const traversalTargets = [
      { reqPath: '/api/cms/pages/%2e%2e', expected: 400 },
      { reqPath: '/api/cms/pages/..%2fseo', expected: 400 },
      { reqPath: '/api/cms/pages/foo%5cbar', expected: 400 },
      { reqPath: '/api/cms/pages/id%00evil', expected: 400 },
      { reqPath: '/api/cms/pages/%252e%252e', expected: 400 },
      { reqPath: '/api/cms/pages/%zz', expected: 400 },
      { reqPath: '/api/cms/pages/UPPERCASE-ID', expected: 400 },
      { reqPath: '/api/cms/pages/../../etc/passwd', expected: 404 },
      { reqPath: '/api/cms/pages/valid-id/extra', expected: 404 },
      { reqPath: '/api/cms/pages/', expected: 404 },
    ];

    for (const t of traversalTargets) {
      const parsed = parseCustomPagePath(t.reqPath);
      assert.equal(parsed.statusCode, t.expected, `Parser mismatch for ${t.reqPath}`);

      const getRes = await requestLocal({
        method: 'GET',
        reqPath: t.reqPath,
        headers: { Cookie: auth.cookiePair },
      });
      assert.equal(getRes.status, t.expected, `GET status mismatch for ${t.reqPath}`);

      const putRes = await requestLocal({
        method: 'PUT',
        reqPath: t.reqPath,
        headers: {
          Origin: EXPECTED_ORIGIN,
          Cookie: auth.cookiePair,
          'X-CSRF-Token': auth.csrfToken,
          'If-Match': `"${'a'.repeat(64)}"`,
        },
        body: { page: { title: 'Blocked' } },
      });
      assert.equal(putRes.status, t.expected, `PUT status mismatch for ${t.reqPath}`);

      const delRes = await requestLocal({
        method: 'DELETE',
        reqPath: t.reqPath,
        headers: {
          Origin: EXPECTED_ORIGIN,
          Cookie: auth.cookiePair,
          'X-CSRF-Token': auth.csrfToken,
          'If-Match': `"${'a'.repeat(64)}"`,
        },
      });
      assert.equal(delRes.status, t.expected, `DELETE status mismatch for ${t.reqPath}`);
    }
  });

  it('6. Rejects unknown fields, SEO fields, prototype pollution, immutable modifications, and unsafe/invalid content', async () => {
    const pagesRes = await requestLocal({
      method: 'GET',
      reqPath: '/api/cms/pages',
      headers: { Cookie: auth.cookiePair },
    });
    const targetPage = pagesRes.json.pages[0];
    const targetGet = await requestLocal({
      method: 'GET',
      reqPath: `/api/cms/pages/${targetPage.id}`,
      headers: { Cookie: auth.cookiePair },
    });
    const currentETag = targetGet.headers.etag;

    // Unknown top-level wrapper keys
    const badWrapper = await requestLocal({
      method: 'POST',
      reqPath: '/api/cms/pages',
      headers: {
        Origin: EXPECTED_ORIGIN,
        Cookie: auth.cookiePair,
        'X-CSRF-Token': auth.csrfToken,
      },
      body: {
        page: { slug: 'valid-wrap', title: 'Valid Title', content: 'Valid content.' },
        extraWrapper: true,
      },
    });
    assert.equal(badWrapper.status, 400);

    // Unknown field on page
    const unknownFieldRes = await requestLocal({
      method: 'POST',
      reqPath: '/api/cms/pages',
      headers: {
        Origin: EXPECTED_ORIGIN,
        Cookie: auth.cookiePair,
        'X-CSRF-Token': auth.csrfToken,
      },
      body: {
        page: {
          slug: 'unknown-field-test',
          title: 'Unknown Field',
          content: 'Body text.',
          authorSecret: 'nope',
        },
      },
    });
    assert.equal(unknownFieldRes.status, 400);

    // SEO fields explicitly rejected on both POST and PUT
    for (const seoField of ['seoTitle', 'metaDescription', 'ogTitle', 'canonicalUrl', 'schemaType', 'seo', 'robots']) {
      const seoPost = await requestLocal({
        method: 'POST',
        reqPath: '/api/cms/pages',
        headers: {
          Origin: EXPECTED_ORIGIN,
          Cookie: auth.cookiePair,
          'X-CSRF-Token': auth.csrfToken,
        },
        body: {
          page: {
            slug: 'seo-reject-test',
            title: 'SEO Reject Test',
            content: 'Body text.',
            [seoField]: 'Should fail',
          },
        },
      });
      assert.equal(seoPost.status, 400, `POST should reject SEO field "${seoField}"`);

      const seoPut = await requestLocal({
        method: 'PUT',
        reqPath: `/api/cms/pages/${targetPage.id}`,
        headers: {
          Origin: EXPECTED_ORIGIN,
          Cookie: auth.cookiePair,
          'X-CSRF-Token': auth.csrfToken,
          'If-Match': currentETag,
        },
        body: {
          page: {
            [seoField]: 'Should fail',
          },
        },
      });
      assert.equal(seoPut.status, 400, `PUT should reject SEO field "${seoField}"`);
    }
    assert.ok(FORBIDDEN_CUSTOM_PAGE_SEO_FIELDS.includes('seoTitle'));

    // Prototype pollution JSON string
    const protoPost = await requestLocal({
      method: 'POST',
      reqPath: '/api/cms/pages',
      headers: {
        Origin: EXPECTED_ORIGIN,
        Cookie: auth.cookiePair,
        'X-CSRF-Token': auth.csrfToken,
      },
      body: '{"page":{"slug":"proto-test","title":"Proto Test","content":"Body","__proto__":{"admin":true}}}',
    });
    assert.equal(protoPost.status, 400);

    // Client-supplied id/createdAt/updatedAt on POST
    for (const immutableKey of ['id', 'createdAt', 'updatedAt']) {
      const immPost = await requestLocal({
        method: 'POST',
        reqPath: '/api/cms/pages',
        headers: {
          Origin: EXPECTED_ORIGIN,
          Cookie: auth.cookiePair,
          'X-CSRF-Token': auth.csrfToken,
        },
        body: {
          page: {
            slug: 'immutable-create-test',
            title: 'Immutable Create Test',
            content: 'Valid Markdown.',
            [immutableKey]: immutableKey === 'id' ? 'forged-id' : '2026-01-01T00:00:00.000Z',
          },
        },
      });
      assert.equal(immPost.status, 400, `POST must reject client "${immutableKey}"`);
    }

    // Immutable id/createdAt/updatedAt change attempts on PUT
    const forgedIdPut = await requestLocal({
      method: 'PUT',
      reqPath: `/api/cms/pages/${targetPage.id}`,
      headers: {
        Origin: EXPECTED_ORIGIN,
        Cookie: auth.cookiePair,
        'X-CSRF-Token': auth.csrfToken,
        'If-Match': currentETag,
      },
      body: {
        page: {
          id: 'different-id-999',
          title: 'Forged ID',
        },
      },
    });
    assert.equal(forgedIdPut.status, 400);

    const forgedCreatedPut = await requestLocal({
      method: 'PUT',
      reqPath: `/api/cms/pages/${targetPage.id}`,
      headers: {
        Origin: EXPECTED_ORIGIN,
        Cookie: auth.cookiePair,
        'X-CSRF-Token': auth.csrfToken,
        'If-Match': currentETag,
      },
      body: {
        page: {
          createdAt: '2020-01-01T00:00:00.000Z',
          title: 'Forged CreatedAt',
        },
      },
    });
    assert.equal(forgedCreatedPut.status, 400);

    // Invalid and unsafe content vectors
    const invalidContents = [
      '',
      '   \n\t  ',
      12345,
      null,
      'Null byte \0 inside content',
      '<script>alert(1)</script>',
      '<iframe src="https://evil.example"></iframe>',
      '<img src="x" onerror="alert(1)" />',
      '[click](javascript:alert(1))',
      '[click](data:text/html,<script>alert(1)</script>)',
    ];

    for (const badContent of invalidContents) {
      if (typeof badContent === 'string') {
        assert.equal(inspectCustomPageContentSafety(badContent).ok, false);
      }
      const res = await requestLocal({
        method: 'POST',
        reqPath: '/api/cms/pages',
        headers: {
          Origin: EXPECTED_ORIGIN,
          Cookie: auth.cookiePair,
          'X-CSRF-Token': auth.csrfToken,
        },
        body: {
          page: {
            slug: 'invalid-content-test',
            title: 'Invalid Content Test',
            content: badContent,
          },
        },
      });
      assert.equal(res.status, 400, `Expected 400 for invalid content: ${String(badContent)}`);
    }

    // Legitimate prose mentioning normal words like "only = true" or Markdown code must succeed
    assert.equal(
      inspectCustomPageContentSafety('# Guide\n\nSetting `only = true` in Markdown prose is safe.').ok,
      true
    );

    // Content-Type enforcement -> 415
    const wrongCt = await requestLocal({
      method: 'POST',
      reqPath: '/api/cms/pages',
      headers: {
        Origin: EXPECTED_ORIGIN,
        Cookie: auth.cookiePair,
        'X-CSRF-Token': auth.csrfToken,
        'Content-Type': 'text/plain',
      },
      body: '{"page":{"slug":"wrong-ct","title":"Wrong CT","content":"Body"}}',
    });
    assert.equal(wrongCt.status, 415);
  });

  it('7. Enforces Authentication (401), CSRF (403), Origin/Sec-Fetch-Site (403), and If-Match (428/400/412)', async () => {
    const pagesRes = await requestLocal({
      method: 'GET',
      reqPath: '/api/cms/pages',
      headers: { Cookie: auth.cookiePair },
    });
    const target = pagesRes.json.pages[0];
    const targetGet = await requestLocal({
      method: 'GET',
      reqPath: `/api/cms/pages/${target.id}`,
      headers: { Cookie: auth.cookiePair },
    });
    const validETag = targetGet.headers.etag;

    // Unauthenticated requests -> 401
    const unauthList = await requestLocal({ method: 'GET', reqPath: '/api/cms/pages' });
    const unauthGet = await requestLocal({ method: 'GET', reqPath: `/api/cms/pages/${target.id}` });
    const unauthPost = await requestLocal({
      method: 'POST',
      reqPath: '/api/cms/pages',
      headers: { Origin: EXPECTED_ORIGIN },
      body: { page: { slug: 'unauth', title: 'Unauth', content: 'Body' } },
    });
    const unauthPut = await requestLocal({
      method: 'PUT',
      reqPath: `/api/cms/pages/${target.id}`,
      headers: { Origin: EXPECTED_ORIGIN, 'If-Match': validETag },
      body: { page: { title: 'Unauth Put' } },
    });
    const unauthDel = await requestLocal({
      method: 'DELETE',
      reqPath: `/api/cms/pages/${target.id}`,
      headers: { Origin: EXPECTED_ORIGIN, 'If-Match': validETag },
    });
    assert.equal(unauthList.status, 401);
    assert.equal(unauthGet.status, 401);
    assert.equal(unauthPost.status, 401);
    assert.equal(unauthPut.status, 401);
    assert.equal(unauthDel.status, 401);

    // Missing / wrong CSRF -> 403
    for (const badCsrf of [undefined, 'wrong-csrf-token']) {
      const headers = {
        Origin: EXPECTED_ORIGIN,
        Cookie: auth.cookiePair,
        ...(badCsrf ? { 'X-CSRF-Token': badCsrf } : {}),
      };
      const pRes = await requestLocal({
        method: 'POST',
        reqPath: '/api/cms/pages',
        headers,
        body: { page: { slug: 'csrf-test', title: 'CSRF Test', content: 'Body' } },
      });
      const uRes = await requestLocal({
        method: 'PUT',
        reqPath: `/api/cms/pages/${target.id}`,
        headers: { ...headers, 'If-Match': validETag },
        body: { page: { title: 'CSRF Put' } },
      });
      const dRes = await requestLocal({
        method: 'DELETE',
        reqPath: `/api/cms/pages/${target.id}`,
        headers: { ...headers, 'If-Match': validETag },
      });
      assert.equal(pRes.status, 403);
      assert.equal(uRes.status, 403);
      assert.equal(dRes.status, 403);
    }

    // Invalid Origin and Sec-Fetch-Site -> 403
    const badOrigin = await requestLocal({
      method: 'POST',
      reqPath: '/api/cms/pages',
      headers: {
        Origin: 'https://evil.example',
        Cookie: auth.cookiePair,
        'X-CSRF-Token': auth.csrfToken,
      },
      body: { page: { slug: 'origin-test', title: 'Origin Test', content: 'Body' } },
    });
    assert.equal(badOrigin.status, 403);

    const crossSite = await requestLocal({
      method: 'GET',
      reqPath: '/api/cms/pages',
      headers: {
        Cookie: auth.cookiePair,
        'Sec-Fetch-Site': 'cross-site',
      },
    });
    assert.equal(crossSite.status, 403);

    // Missing If-Match -> 428
    const missingPutIfMatch = await requestLocal({
      method: 'PUT',
      reqPath: `/api/cms/pages/${target.id}`,
      headers: {
        Origin: EXPECTED_ORIGIN,
        Cookie: auth.cookiePair,
        'X-CSRF-Token': auth.csrfToken,
      },
      body: { page: { title: 'Missing If-Match' } },
    });
    assert.equal(missingPutIfMatch.status, 428);

    const missingDelIfMatch = await requestLocal({
      method: 'DELETE',
      reqPath: `/api/cms/pages/${target.id}`,
      headers: {
        Origin: EXPECTED_ORIGIN,
        Cookie: auth.cookiePair,
        'X-CSRF-Token': auth.csrfToken,
      },
    });
    assert.equal(missingDelIfMatch.status, 428);

    // Malformed / weak / wildcard / uppercase If-Match -> 400
    for (const badIfMatch of [`W/${validETag}`, '*', '"*"', `${validETag}, ${validETag}`, `"${'A'.repeat(64)}"`, 'not-quoted']) {
      const badPut = await requestLocal({
        method: 'PUT',
        reqPath: `/api/cms/pages/${target.id}`,
        headers: {
          Origin: EXPECTED_ORIGIN,
          Cookie: auth.cookiePair,
          'X-CSRF-Token': auth.csrfToken,
          'If-Match': badIfMatch,
        },
        body: { page: { title: 'Invalid If-Match' } },
      });
      assert.equal(badPut.status, 400, `Expected 400 for If-Match: ${badIfMatch}`);

      const badDel = await requestLocal({
        method: 'DELETE',
        reqPath: `/api/cms/pages/${target.id}`,
        headers: {
          Origin: EXPECTED_ORIGIN,
          Cookie: auth.cookiePair,
          'X-CSRF-Token': auth.csrfToken,
          'If-Match': badIfMatch,
        },
      });
      assert.equal(badDel.status, 400, `Expected 400 on DELETE for If-Match: ${badIfMatch}`);
    }

    // Wrong 64-hex ETag -> 412
    const wrongEtagDel = await requestLocal({
      method: 'DELETE',
      reqPath: `/api/cms/pages/${target.id}`,
      headers: {
        Origin: EXPECTED_ORIGIN,
        Cookie: auth.cookiePair,
        'X-CSRF-Token': auth.csrfToken,
        'If-Match': `"${'0'.repeat(64)}"`,
      },
    });
    assert.equal(wrongEtagDel.status, 412);

    // Non-empty body on DELETE -> 400
    const bodyOnDel = await requestLocal({
      method: 'DELETE',
      reqPath: `/api/cms/pages/${target.id}`,
      headers: {
        Origin: EXPECTED_ORIGIN,
        Cookie: auth.cookiePair,
        'X-CSRF-Token': auth.csrfToken,
        'If-Match': validETag,
      },
      body: { confirm: true },
    });
    assert.equal(bodyOnDel.status, 400);
  });

  it('8. Deleting pages works cleanly, removes from store, and enforces unpublished isolation', async () => {
    // Create an unpublished page with sensitive draft string to test public isolation
    const secretMarker = 'SECRET_UNPUBLISHED_CUSTOM_PAGE_DRAFT_CONTENT_114H0';
    const createRes = await requestLocal({
      method: 'POST',
      reqPath: '/api/cms/pages',
      headers: {
        Origin: EXPECTED_ORIGIN,
        Cookie: auth.cookiePair,
        'X-CSRF-Token': auth.csrfToken,
      },
      body: {
        page: {
          slug: 'secret-draft-page',
          title: 'Secret Draft Page',
          content: `# Confidential\n\n${secretMarker}`,
        },
      },
    });
    assert.equal(createRes.status, 201);
    const draftPage = createRes.json.page;
    assert.equal(draftPage.isPublished, false);

    // Verify public / unauthenticated endpoints NEVER expose unpublished page data
    const publicChecks = [
      '/api/cms/health',
      '/api/cms/pages',
      `/api/cms/pages/${draftPage.id}`,
      '/secret-draft-page',
      '/pages/secret-draft-page',
      '/content/pages.json',
    ];
    for (const p of publicChecks) {
      const r = await requestLocal({ method: 'GET', reqPath: p });
      assert.ok([200, 401, 404].includes(r.status), `Unexpected status ${r.status} for ${p}`);
      assert.equal(
        r.text.includes(secretMarker),
        false,
        `Unauthenticated endpoint "${p}" leaked unpublished page content`
      );
    }

    // Delete all pages one by one and confirm final store can safely become []
    const listRes = await requestLocal({
      method: 'GET',
      reqPath: '/api/cms/pages',
      headers: { Cookie: auth.cookiePair },
    });
    assert.equal(listRes.status, 200);
    for (const p of listRes.json.pages) {
      const g = await requestLocal({
        method: 'GET',
        reqPath: `/api/cms/pages/${p.id}`,
        headers: { Cookie: auth.cookiePair },
      });
      const del = await requestLocal({
        method: 'DELETE',
        reqPath: `/api/cms/pages/${p.id}`,
        headers: {
          Origin: EXPECTED_ORIGIN,
          Cookie: auth.cookiePair,
          'X-CSRF-Token': auth.csrfToken,
          'If-Match': g.headers.etag,
        },
      });
      assert.equal(del.status, 200);
      assert.equal(del.json?.deleted, true);
      assert.equal(del.headers.etag, undefined);

      const afterDelGet = await requestLocal({
        method: 'GET',
        reqPath: `/api/cms/pages/${p.id}`,
        headers: { Cookie: auth.cookiePair },
      });
      assert.equal(afterDelGet.status, 404);
    }

    const finalList = await requestLocal({
      method: 'GET',
      reqPath: '/api/cms/pages',
      headers: { Cookie: auth.cookiePair },
    });
    assert.equal(finalList.status, 200);
    assert.deepEqual(finalList.json.pages, []);
  });

  it('9. Atomic rollback on failed writes, fail-closed corruption handling, and mutex release', async () => {
    const pagesPath = path.join(tempRoot, 'content', 'pages.json');

    // Seed one page so PUT/DELETE rollback can also be verified
    const seedRes = await requestLocal({
      method: 'POST',
      reqPath: '/api/cms/pages',
      headers: {
        Origin: EXPECTED_ORIGIN,
        Cookie: auth.cookiePair,
        'X-CSRF-Token': auth.csrfToken,
      },
      body: {
        page: {
          slug: 'rollback-target',
          title: 'Rollback Target',
          content: 'Original content before failed write.',
        },
      },
    });
    assert.equal(seedRes.status, 201);
    const seedPage = seedRes.json.page;
    const seedETag = seedRes.headers.etag;
    const beforeWrite = await hashFile(pagesPath);

    const addedTestFlag = !process.argv.includes('--test');
    if (addedTestFlag) process.argv.push('--test');
    try {
      // Simulate failure on POST
      const failPost = await requestLocal({
        method: 'POST',
        reqPath: '/api/cms/pages',
        headers: {
          Origin: EXPECTED_ORIGIN,
          Cookie: auth.cookiePair,
          'X-CSRF-Token': auth.csrfToken,
          'x-test-simulate-failure-at-index': '0',
        },
        body: {
          page: {
            slug: 'should-rollback-post',
            title: 'Rollback Post',
            content: 'Should not persist.',
          },
        },
      });
      assert.equal(failPost.status, 500);
      assertNoPathOrInternalLeak(failPost.text, tempRoot);

      // Simulate failure on PUT
      const failPut = await requestLocal({
        method: 'PUT',
        reqPath: `/api/cms/pages/${seedPage.id}`,
        headers: {
          Origin: EXPECTED_ORIGIN,
          Cookie: auth.cookiePair,
          'X-CSRF-Token': auth.csrfToken,
          'If-Match': seedETag,
          'x-test-simulate-failure-at-index': '0',
        },
        body: {
          page: { title: 'Should Rollback Put' },
        },
      });
      assert.equal(failPut.status, 500);
      assertNoPathOrInternalLeak(failPut.text, tempRoot);

      // Simulate failure on DELETE
      const failDel = await requestLocal({
        method: 'DELETE',
        reqPath: `/api/cms/pages/${seedPage.id}`,
        headers: {
          Origin: EXPECTED_ORIGIN,
          Cookie: auth.cookiePair,
          'X-CSRF-Token': auth.csrfToken,
          'If-Match': seedETag,
          'x-test-simulate-failure-at-index': '0',
        },
      });
      assert.equal(failDel.status, 500);
      assertNoPathOrInternalLeak(failDel.text, tempRoot);
    } finally {
      if (addedTestFlag) {
        const idx = process.argv.lastIndexOf('--test');
        if (idx >= 0) process.argv.splice(idx, 1);
      }
    }

    const afterRollback = await hashFile(pagesPath);
    assert.equal(
      afterRollback.sha256,
      beforeWrite.sha256,
      'pages.json bytes must remain identical after rolled-back mutations'
    );
    assert.equal(getActiveMutexCount(), 0, 'Active mutex count must be 0 after failed writes');

    // Corrupted pages.json must fail closed (never silently repaired)
    await fs.promises.writeFile(pagesPath, JSON.stringify({ corrupted: true }), 'utf8');
    await assert.rejects(() => defaultStorageEngine.readJson('pages.json'), {
      code: 'SCHEMA_VALIDATION_FAILED',
    });
    const corruptGet = await requestLocal({
      method: 'GET',
      reqPath: '/api/cms/pages',
      headers: { Cookie: auth.cookiePair },
    });
    assert.equal(corruptGet.status, 500);
    assertNoPathOrInternalLeak(corruptGet.text, tempRoot);

    // Restore valid bytes and confirm recovery
    await fs.promises.writeFile(pagesPath, afterRollback.bytes);
    const recovered = await requestLocal({
      method: 'GET',
      reqPath: '/api/cms/pages',
      headers: { Cookie: auth.cookiePair },
    });
    assert.equal(recovered.status, 200);
    assert.equal(recovered.json.pages.length, 1);
    assert.equal(getActiveMutexCount(), 0);
  });

  it('10. Existing Article, Category, and Tool CRUD regression checks remain healthy', async () => {
    // Categories CRUD regression
    const catList = await requestLocal({
      method: 'GET',
      reqPath: '/api/cms/categories',
      headers: { Cookie: auth.cookiePair },
    });
    assert.equal(catList.status, 200);
    assert.ok(Array.isArray(catList.json.categories) && catList.json.categories.length > 0);

    const catCreate = await requestLocal({
      method: 'POST',
      reqPath: '/api/cms/categories',
      headers: {
        Origin: EXPECTED_ORIGIN,
        Cookie: auth.cookiePair,
        'X-CSRF-Token': auth.csrfToken,
      },
      body: {
        category: {
          name: 'Test Regression Category',
          slug: 'regression-cat-h0',
          description: 'Temporary isolated category for CRUD regression testing.',
          icon: 'Code',
        },
      },
    });
    assert.equal(catCreate.status, 201);

    const catGet = await requestLocal({
      method: 'GET',
      reqPath: '/api/cms/categories/regression-cat-h0',
      headers: { Cookie: auth.cookiePair },
    });
    assert.equal(catGet.status, 200);

    const catUpdate = await requestLocal({
      method: 'PUT',
      reqPath: '/api/cms/categories/regression-cat-h0',
      headers: {
        Origin: EXPECTED_ORIGIN,
        Cookie: auth.cookiePair,
        'X-CSRF-Token': auth.csrfToken,
        'If-Match': catGet.headers.etag,
      },
      body: { category: { name: 'Updated Regression Category' } },
    });
    assert.equal(catUpdate.status, 200);

    // Tools CRUD regression
    const toolsList = await requestLocal({
      method: 'GET',
      reqPath: '/api/cms/tools',
      headers: { Cookie: auth.cookiePair },
    });
    assert.equal(toolsList.status, 200);
    assert.ok(Array.isArray(toolsList.json.tools) && toolsList.json.tools.length > 0);

    const toolCreate = await requestLocal({
      method: 'POST',
      reqPath: '/api/cms/tools',
      headers: {
        Origin: EXPECTED_ORIGIN,
        Cookie: auth.cookiePair,
        'X-CSRF-Token': auth.csrfToken,
      },
      body: {
        tool: {
          name: 'Regression Tool H0',
          slug: 'regression-tool-h0',
          url: 'https://example.com/regression-tool',
          description: 'Temporary regression tool to verify Tool CRUD continues working.',
          category: 'regression-cat-h0',
          tags: ['testing'],
          pricing: 'Free',
          isFeatured: false,
          icon: '/images/chatgpt.svg',
        },
      },
    });
    assert.equal(toolCreate.status, 201);

    const toolUpdate = await requestLocal({
      method: 'PUT',
      reqPath: '/api/cms/tools/regression-tool-h0',
      headers: {
        Origin: EXPECTED_ORIGIN,
        Cookie: auth.cookiePair,
        'X-CSRF-Token': auth.csrfToken,
        'If-Match': toolCreate.headers.etag,
      },
      body: { tool: { pricing: 'Freemium' } },
    });
    assert.equal(toolUpdate.status, 200);

    const toolDel = await requestLocal({
      method: 'DELETE',
      reqPath: '/api/cms/tools/regression-tool-h0',
      headers: {
        Origin: EXPECTED_ORIGIN,
        Cookie: auth.cookiePair,
        'X-CSRF-Token': auth.csrfToken,
        'If-Match': toolUpdate.headers.etag,
      },
    });
    assert.equal(toolDel.status, 200);

    // Delete unused test category
    const catDel = await requestLocal({
      method: 'DELETE',
      reqPath: '/api/cms/categories/regression-cat-h0',
      headers: {
        Origin: EXPECTED_ORIGIN,
        Cookie: auth.cookiePair,
        'X-CSRF-Token': auth.csrfToken,
        'If-Match': catUpdate.headers.etag,
      },
    });
    assert.equal(catDel.status, 200);

    // Articles CRUD regression (create, get, delete)
    const artList = await requestLocal({
      method: 'GET',
      reqPath: '/api/cms/articles',
      headers: { Cookie: auth.cookiePair },
    });
    assert.equal(artList.status, 200);
    assert.ok(Array.isArray(artList.json.articles) && artList.json.articles.length > 0);
    const existingCatSlug = catList.json.categories[0].slug;

    const artCreate = await requestLocal({
      method: 'POST',
      reqPath: '/api/cms/articles',
      headers: {
        Origin: EXPECTED_ORIGIN,
        Cookie: auth.cookiePair,
        'X-CSRF-Token': auth.csrfToken,
      },
      body: {
        article: {
          slug: 'regression-article-h0',
          title: 'Regression Article H0 Title',
          excerpt: 'Valid article excerpt for regression testing alongside pages.',
          category: existingCatSlug,
          author: 'Md Shamim',
          publishedAt: '2026-10-10',
          isPublished: false,
          featuredImage: '/images/articles/best-free-ai-tools-2026.webp',
          imageAlt: 'Regression article hero image',
          readingTime: '3 min read',
          tags: ['AI', 'Regression'],
          metaTitle: 'Regression Article H0 SEO Title',
          metaDescription: 'Valid article meta description for isolated regression test suite.',
        },
        content: '# Regression Article H0\n\nBody text.',
      },
    });
    assert.equal(artCreate.status, 201, `Article POST failed: ${artCreate.text}`);

    const artGet = await requestLocal({
      method: 'GET',
      reqPath: '/api/cms/articles/regression-article-h0',
      headers: { Cookie: auth.cookiePair },
    });
    assert.equal(artGet.status, 200);

    const artUpdate = await requestLocal({
      method: 'PUT',
      reqPath: '/api/cms/articles/regression-article-h0',
      headers: {
        Origin: EXPECTED_ORIGIN,
        Cookie: auth.cookiePair,
        'X-CSRF-Token': auth.csrfToken,
        'If-Match': artGet.headers.etag,
      },
      body: {
        article: {
          title: 'Updated Regression Article H0 Title',
        },
        content: '# Regression Article H0\n\nUpdated body text.',
      },
    });
    assert.equal(artUpdate.status, 200, `Article PUT failed: ${artUpdate.text}`);

    const artDel = await requestLocal({
      method: 'DELETE',
      reqPath: '/api/cms/articles/regression-article-h0',
      headers: {
        Origin: EXPECTED_ORIGIN,
        Cookie: auth.cookiePair,
        'X-CSRF-Token': auth.csrfToken,
        'If-Match': artUpdate.headers.etag,
      },
    });
    assert.equal(artDel.status, 200);
  });
});
