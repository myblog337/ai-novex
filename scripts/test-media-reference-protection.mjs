import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

process.env.NODE_ENV = 'test-no-listen';

const { findMediaReferencesInContent } = await import('./lib/validators.mjs');
const { defaultStorageEngine, ALLOWED_JSON_FILES, getActiveMutexCount } = await import('./lib/storage.mjs');
const {
  server,
  HOST,
  PORT,
  EXPECTED_HOST,
  EXPECTED_ORIGIN,
  resetAuthStateForTesting,
  startServerForTesting,
} = await import('./cms-server.mjs');

const REAL_ROOT = process.cwd();

function makeValidPng(width = 40, height = 30) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8;
  ihdrData[9] = 2;
  const makeChunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    return Buffer.concat([len, Buffer.from(type, 'ascii'), data, Buffer.alloc(4)]);
  };
  return Buffer.concat([
    sig,
    makeChunk('IHDR', ihdrData),
    makeChunk('IDAT', Buffer.from([0x78, 0x9c, 0x03, 0x00])),
    makeChunk('IEND', Buffer.alloc(0)),
  ]);
}

async function requestLocal({ method = 'GET', reqPath = '/', headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const rawBody =
      body === null || body === undefined
        ? null
        : Buffer.isBuffer(body) || typeof body === 'string'
          ? body
          : JSON.stringify(body);
    const reqHeaders = { Host: EXPECTED_HOST, ...headers };
    if (rawBody !== null && !Object.keys(reqHeaders).some((k) => k.toLowerCase() === 'content-type')) {
      reqHeaders['Content-Type'] = 'application/json';
    }
    if (rawBody !== null && !Object.keys(reqHeaders).some((k) => k.toLowerCase() === 'content-length')) {
      reqHeaders['Content-Length'] = Buffer.byteLength(rawBody);
    }

    const req = http.request({ hostname: HOST, port: PORT, method, path: reqPath, headers: reqHeaders }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {}
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (rawBody !== null) req.write(rawBody);
    req.end();
  });
}

async function loginFreshSession() {
  const otp = resetAuthStateForTesting();
  const res = await requestLocal({
    method: 'POST',
    reqPath: '/api/auth/verify',
    headers: { Origin: EXPECTED_ORIGIN },
    body: { otp },
  });
  assert.equal(res.status, 200);
  const setCookie = Array.isArray(res.headers['set-cookie'])
    ? res.headers['set-cookie'][0]
    : res.headers['set-cookie'];
  return { cookiePair: setCookie.split(';')[0], csrfToken: res.json.csrfToken };
}

async function uploadSamplePng(auth, originalName = 'ref-test.png') {
  const png = makeValidPng();
  const res = await requestLocal({
    method: 'POST',
    reqPath: '/api/cms/media',
    headers: {
      Origin: EXPECTED_ORIGIN,
      Cookie: auth.cookiePair,
      'X-CSRF-Token': auth.csrfToken,
      'Content-Type': 'image/png',
      'X-Media-Filename': originalName,
      'X-Media-Alt': 'Reference test image',
    },
    body: png,
  });
  assert.equal(res.status, 201, `Upload failed: ${res.text}`);
  return { media: res.json.media, etag: res.headers.etag };
}

describe('Task 115-B — Reference-Safe Media Deletion & Content Reference Detector', () => {
  let tmpRoot;
  let origProjectRoot;
  let origBackupDir;
  let origUploadTmp;
  let weStartedServer = false;
  let auth;

  const baseStoresBackup = {};

  let addedTestFlag = false;

  before(async () => {
    if (!process.argv.includes('--test')) {
      process.argv.push('--test');
      addedTestFlag = true;
    }
    origProjectRoot = defaultStorageEngine.projectRoot;
    origBackupDir = defaultStorageEngine.backupDir;
    origUploadTmp = process.env.AINOVEX_CMS_UPLOAD_TMP_DIR;

    const rawTmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ainovex-media-refs-'));
    tmpRoot = await fs.promises.realpath(rawTmp);
    const tmpContent = path.join(tmpRoot, 'content');
    const tmpArticles = path.join(tmpContent, 'articles');
    const tmpUpload = path.join(tmpRoot, 'upload-tmp');
    await fs.promises.mkdir(tmpArticles, { recursive: true });
    await fs.promises.mkdir(tmpUpload, { recursive: true });
    await fs.promises.mkdir(path.join(tmpRoot, 'public', 'images', 'media'), { recursive: true });

    for (const fileName of ALLOWED_JSON_FILES) {
      const content = await fs.promises.readFile(path.join(REAL_ROOT, 'content', fileName), 'utf8');
      baseStoresBackup[fileName] = content;
      await fs.promises.writeFile(path.join(tmpContent, fileName), content, 'utf8');
    }
    const srcArticles = path.join(REAL_ROOT, 'content', 'articles');
    for (const entry of await fs.promises.readdir(srcArticles)) {
      if (entry.endsWith('.md')) {
        await fs.promises.copyFile(path.join(srcArticles, entry), path.join(tmpArticles, entry));
      }
    }

    defaultStorageEngine.projectRoot = tmpRoot;
    defaultStorageEngine.backupDir = path.join(tmpRoot, '.backups');
    process.env.AINOVEX_CMS_UPLOAD_TMP_DIR = tmpUpload;

    weStartedServer = await startServerForTesting(server, PORT, HOST);
    auth = await loginFreshSession();
  });

  beforeEach(async () => {
    for (const [fileName, raw] of Object.entries(baseStoresBackup)) {
      await fs.promises.writeFile(path.join(tmpRoot, 'content', fileName), raw, 'utf8');
    }
  });

  after(async () => {
    try {
      if (weStartedServer && server.listening) {
        await new Promise((resolve) => server.close(resolve));
      }
    } finally {
      if (addedTestFlag) {
        const idx = process.argv.lastIndexOf('--test');
        if (idx >= 0) process.argv.splice(idx, 1);
      }
      defaultStorageEngine.projectRoot = origProjectRoot;
      defaultStorageEngine.backupDir = origBackupDir;
      if (origUploadTmp === undefined) {
        delete process.env.AINOVEX_CMS_UPLOAD_TMP_DIR;
      } else {
        process.env.AINOVEX_CMS_UPLOAD_TMP_DIR = origUploadTmp;
      }
      if (tmpRoot && fs.existsSync(tmpRoot)) {
        await fs.promises.rm(tmpRoot, { recursive: true, force: true });
      }
    }
    assert.equal(getActiveMutexCount(), 0);
  });

  it('detects root-relative, absolute same-site, query/fragment, Markdown, HTML, srcset (no-space), and CSS references while avoiding false positives', () => {
    const filename = 'media-0123456789abcdef0123456789abcdef.png';
    const url = `/images/media/${filename}`;
    const record = { id: crypto.randomUUID(), filename, url };

    const matchingTexts = new Map([
      ['md-link', `Here is ![alt](${url})`],
      ['md-query-frag', `![alt](${url}?w=800#hero)`],
      ['abs-origin', `https://ai-novex.netlify.app${url}?v=2`],
      ['html-src', `<img src="${url}" alt="pic">`],
      ['srcset-nospace', `<img srcset="${url} 1x,/images/media/other.png 2x">`],
      ['srcset-nospace-bare', `<img srcset="/images/media/a.png,${url},/images/media/b.png">`],
      ['css-url', `background-image: url(${url});`],
    ]);

    const refs = findMediaReferencesInContent(record, { articleMarkdowns: matchingTexts });
    assert.equal(refs.length, matchingTexts.size);
    for (const ref of refs) {
      assert.equal(ref.store, 'articleMarkdown');
      assert.equal(JSON.stringify(ref).includes(REAL_ROOT), false);
    }

    // False positives must produce zero hits
    const nonMatchingTexts = new Map([
      ['prefix-other', `![alt](/images/media/other-${filename})`],
      ['suffix-bak', `![alt](${url}.bak)`],
      ['suffix-extra', `![alt](${url}2)`],
      ['wrong-dir', `![alt](/other/images/media/${filename})`],
      ['wrong-subpath', `![alt](/sub${url})`],
    ]);
    const falseRefs = findMediaReferencesInContent(record, { articleMarkdowns: nonMatchingTexts });
    assert.deepEqual(falseRefs, []);
  });

  it('detects references across every required content store (articles, markdown, categories, tools, pages, seo.pages OG & Twitter, seo.defaults, settings, ads)', () => {
    const filename = 'media-fedcba9876543210fedcba9876543210.webp';
    const url = `/images/media/${filename}`;
    const record = { id: crypto.randomUUID(), filename, url };

    const refs = findMediaReferencesInContent(record, {
      articles: [{ slug: 'art-1', featuredImage: url }],
      articleMarkdowns: new Map([['art-2', `Body ![img](${url}?size=lg)`]]),
      categories: [{ slug: 'cat-1', iconImage: url }],
      tools: [{ slug: 'tool-1', icon: `https://ai-novex.netlify.app${url}` }],
      pages: [{ slug: 'custom-1', content: `<img src="${url}#top">` }],
      seo: {
        defaults: { defaultOgImage: url },
        pages: {
          '/about/': { ogImage: url },
          '/contact/': { twitterImage: `${url}?tw=1` },
        },
      },
      settings: { defaultOgImage: url },
      ads: { slots: { header: { customCode: `<a href="/go"><img src="${url}"></a>` } } },
    });

    const storeSet = new Set(refs.map((r) => r.store));
    for (const expected of [
      'articles',
      'articleMarkdown',
      'categories',
      'tools',
      'pages',
      'seo.defaults',
      'seo.pages',
      'settings',
      'ads',
    ]) {
      assert.ok(storeSet.has(expected), `Missing reference detection for store "${expected}"`);
    }
    assert.ok(refs.some((r) => r.store === 'seo.pages' && r.field === 'ogImage'));
    assert.ok(refs.some((r) => r.store === 'seo.pages' && r.field === 'twitterImage'));
  });

  it('blocks DELETE /api/cms/media/:id with 409 Conflict across each live CMS store and allows delete once unreferenced', async () => {
    const { media, etag } = await uploadSamplePng(auth, 'protected-asset.png');
    const assetPath = path.join(tmpRoot, 'public', 'images', 'media', media.filename);

    const mutateStore = async (fileName, mutator) => {
      const p = path.join(tmpRoot, 'content', fileName);
      const data = JSON.parse(await fs.promises.readFile(p, 'utf8'));
      const next = mutator(data);
      await fs.promises.writeFile(p, JSON.stringify(next, null, 2) + '\n', 'utf8');
    };

    const assertBlockedWithStore = async (expectedStore, setupFn, restoreFn) => {
      await setupFn();
      const delRes = await requestLocal({
        method: 'DELETE',
        reqPath: `/api/cms/media/${media.id}`,
        headers: {
          Origin: EXPECTED_ORIGIN,
          Cookie: auth.cookiePair,
          'X-CSRF-Token': auth.csrfToken,
          'If-Match': etag,
        },
      });
      assert.equal(delRes.status, 409, `Expected 409 for ${expectedStore}, got ${delRes.status}: ${delRes.text}`);
      assert.ok(Array.isArray(delRes.json?.references) && delRes.json.references.length > 0);
      assert.ok(delRes.json.references.some((r) => r.store === expectedStore));
      assert.equal(delRes.text.includes(tmpRoot), false, 'Must not expose tempRoot in 409 response');
      assert.equal(delRes.text.includes(REAL_ROOT), false, 'Must not expose REAL_ROOT in 409 response');
      assert.equal(fs.existsSync(assetPath), true, 'Physical file must remain intact on 409');
      await restoreFn();
    };

    // 1. Articles metadata
    await assertBlockedWithStore(
      'articles',
      () =>
        mutateStore('articles.json', (arr) => {
          arr[0].ogImage = `${media.url}?v=1`;
          return arr;
        }),
      () => fs.promises.writeFile(path.join(tmpRoot, 'content', 'articles.json'), baseStoresBackup['articles.json'])
    );

    // 2. Article Markdown body (no-space srcset)
    const mdTarget = path.join(tmpRoot, 'content', 'articles', 'best-free-ai-tools-2026.md');
    const origMd = await fs.promises.readFile(mdTarget, 'utf8');
    await assertBlockedWithStore(
      'articleMarkdown',
      () =>
        fs.promises.writeFile(
          mdTarget,
          `${origMd}\n<img srcset="/images/media/other.png 1x,${media.url} 2x">\n`,
          'utf8'
        ),
      () => fs.promises.writeFile(mdTarget, origMd, 'utf8')
    );

    // 3. Categories
    await assertBlockedWithStore(
      'categories',
      () =>
        mutateStore('categories.json', (arr) => {
          arr[0].description = `${arr[0].description} ${media.url}`;
          return arr;
        }),
      () => fs.promises.writeFile(path.join(tmpRoot, 'content', 'categories.json'), baseStoresBackup['categories.json'])
    );

    // 4. Tools
    await assertBlockedWithStore(
      'tools',
      () =>
        mutateStore('tools.json', (arr) => {
          arr[0].icon = media.url;
          return arr;
        }),
      () => fs.promises.writeFile(path.join(tmpRoot, 'content', 'tools.json'), baseStoresBackup['tools.json'])
    );

    // 5. Custom Pages
    await assertBlockedWithStore(
      'pages',
      () =>
        mutateStore('pages.json', () => [
          {
            id: crypto.randomUUID(),
            title: 'Media Test Page',
            slug: 'media-test-page',
            content: `![img](https://ai-novex.netlify.app${media.url}#hero)`,
            isPublished: true,
            createdAt: '2026-04-01T00:00:00.000Z',
            updatedAt: '2026-04-01T00:00:00.000Z',
          },
        ]),
      () => fs.promises.writeFile(path.join(tmpRoot, 'content', 'pages.json'), baseStoresBackup['pages.json'])
    );

    // 6. Page-level SEO OG Image
    await assertBlockedWithStore(
      'seo.pages',
      () =>
        mutateStore('seo.json', (seo) => {
          seo.pages.about = { ...(seo.pages.about || {}), ogImage: media.url };
          return seo;
        }),
      () => fs.promises.writeFile(path.join(tmpRoot, 'content', 'seo.json'), baseStoresBackup['seo.json'])
    );

    // 7. Page-level SEO Twitter Image
    await assertBlockedWithStore(
      'seo.pages',
      () =>
        mutateStore('seo.json', (seo) => {
          seo.pages.about = { ...(seo.pages.about || {}), twitterImage: media.url };
          return seo;
        }),
      () => fs.promises.writeFile(path.join(tmpRoot, 'content', 'seo.json'), baseStoresBackup['seo.json'])
    );

    // 8. Global SEO defaults
    await assertBlockedWithStore(
      'seo.defaults',
      () =>
        mutateStore('seo.json', (seo) => {
          seo.defaults.defaultOgImage = media.url;
          return seo;
        }),
      () => fs.promises.writeFile(path.join(tmpRoot, 'content', 'seo.json'), baseStoresBackup['seo.json'])
    );

    // 9. Settings
    await assertBlockedWithStore(
      'settings',
      () =>
        mutateStore('settings.json', (settings) => {
          settings.defaultOgImage = media.url;
          return settings;
        }),
      () => fs.promises.writeFile(path.join(tmpRoot, 'content', 'settings.json'), baseStoresBackup['settings.json'])
    );

    // 10. Ads
    await assertBlockedWithStore(
      'ads',
      () =>
        mutateStore('ads.json', (ads) => {
          const firstSlotKey = Object.keys(ads.slots)[0];
          ads.slots[firstSlotKey].customCode = `<img src="${media.url}" alt="ad">`;
          return ads;
        }),
      () => fs.promises.writeFile(path.join(tmpRoot, 'content', 'ads.json'), baseStoresBackup['ads.json'])
    );

    // False-positive guard: similar filename in markdown must NOT block delete
    await fs.promises.writeFile(mdTarget, `${origMd}\n![other](/images/media/other-${media.filename})\n`, 'utf8');
    const delOk = await requestLocal({
      method: 'DELETE',
      reqPath: `/api/cms/media/${media.id}`,
      headers: {
        Origin: EXPECTED_ORIGIN,
        Cookie: auth.cookiePair,
        'X-CSRF-Token': auth.csrfToken,
        'If-Match': etag,
      },
    });
    assert.equal(delOk.status, 200, `Expected unreferenced delete 200, got ${delOk.status}: ${delOk.text}`);
    assert.equal(fs.existsSync(assetPath), false);
    await fs.promises.writeFile(mdTarget, origMd, 'utf8');
  });
});
