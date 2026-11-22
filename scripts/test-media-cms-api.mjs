import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

process.env.NODE_ENV = 'test-no-listen';

const { ALLOWED_MEDIA_FIELDS, MAX_MEDIA_FILE_SIZE_BYTES } = await import('./lib/validators.mjs');
const { defaultStorageEngine, ALLOWED_JSON_FILES, getActiveMutexCount } = await import('./lib/storage.mjs');
const {
  server,
  HOST,
  PORT,
  EXPECTED_HOST,
  EXPECTED_ORIGIN,
  resetAuthStateForTesting,
  startServerForTesting,
  MAX_MEDIA_MULTIPART_BODY,
} = await import('./cms-server.mjs');

const REAL_ROOT = process.cwd();

function makeValidPng(width = 120, height = 80) {
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

function makeValidJpeg(width = 320, height = 240) {
  const soi = Buffer.from([0xff, 0xd8]);
  const app0 = Buffer.from([
    0xff, 0xe0, 0x00, 0x10,
    0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
  ]);
  const sof0 = Buffer.from([
    0xff, 0xc0, 0x00, 0x11, 0x08,
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    0x03,
    0x01, 0x11, 0x00,
    0x02, 0x11, 0x01,
    0x03, 0x11, 0x01,
  ]);
  const sos = Buffer.from([
    0xff, 0xda, 0x00, 0x0c, 0x03, 0x01, 0x00, 0x02, 0x11, 0x03, 0x11, 0x00, 0x3f, 0x00, 0xaa,
  ]);
  const eoi = Buffer.from([0xff, 0xd9]);
  return Buffer.concat([soi, app0, sof0, sos, eoi]);
}

function makeValidWebp(width = 400, height = 300) {
  const payload = Buffer.alloc(12);
  payload[0] = 0x2f;
  const packed = ((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14);
  payload.writeUInt32LE(packed >>> 0, 1);
  const chunkHeader = Buffer.alloc(8);
  chunkHeader.write('VP8L', 0, 'ascii');
  chunkHeader.writeUInt32LE(payload.length, 4);
  const riffHeader = Buffer.alloc(12);
  riffHeader.write('RIFF', 0, 'ascii');
  riffHeader.writeUInt32LE(4 + 8 + payload.length, 4);
  riffHeader.write('WEBP', 8, 'ascii');
  return Buffer.concat([riffHeader, chunkHeader, payload]);
}

function makeValidGif(width = 64, height = 48) {
  const header = Buffer.from('GIF89a', 'ascii');
  const lsd = Buffer.alloc(7);
  lsd.writeUInt16LE(width, 0);
  lsd.writeUInt16LE(height, 2);
  const imgDesc = Buffer.alloc(10);
  imgDesc[0] = 0x2c;
  imgDesc.writeUInt16LE(width, 5);
  imgDesc.writeUInt16LE(height, 7);
  return Buffer.concat([header, lsd, imgDesc, Buffer.from([0x02, 0x02, 0x4c, 0x01, 0x00, 0x3b])]);
}

function buildMultipartPayload(parts, boundary = `----AinovexMediaBoundary${crypto.randomBytes(8).toString('hex')}`) {
  const buffers = [];
  for (const part of parts) {
    buffers.push(Buffer.from(`--${boundary}\r\n`, 'latin1'));
    let disp = `Content-Disposition: form-data; name="${part.name}"`;
    if (part.filename !== undefined) {
      disp += `; filename="${part.filename}"`;
    }
    buffers.push(Buffer.from(`${disp}\r\n`, 'utf8'));
    if (part.contentType) {
      buffers.push(Buffer.from(`Content-Type: ${part.contentType}\r\n`, 'utf8'));
    }
    buffers.push(Buffer.from('\r\n', 'latin1'));
    buffers.push(Buffer.isBuffer(part.data) ? part.data : Buffer.from(String(part.data), 'utf8'));
    buffers.push(Buffer.from('\r\n', 'latin1'));
  }
  buffers.push(Buffer.from(`--${boundary}--\r\n`, 'latin1'));
  return {
    contentType: `multipart/form-data; boundary=${boundary}`,
    body: Buffer.concat(buffers),
  };
}

async function requestLocal({ method = 'GET', reqPath = '/', headers = {}, body = null, omitContentLength = false }) {
  return new Promise((resolve, reject) => {
    const hasBody = body !== null && body !== undefined;
    const rawBody = hasBody
      ? Buffer.isBuffer(body) || typeof body === 'string'
        ? body
        : JSON.stringify(body)
      : null;

    const reqHeaders = { Host: EXPECTED_HOST, ...headers };
    if (rawBody !== null && !Object.keys(reqHeaders).some((k) => k.toLowerCase() === 'content-type')) {
      reqHeaders['Content-Type'] = 'application/json';
    }
    if (
      rawBody !== null &&
      !omitContentLength &&
      !Object.keys(reqHeaders).some((k) => k.toLowerCase() === 'content-length')
    ) {
      reqHeaders['Content-Length'] = Buffer.byteLength(rawBody);
    }

    const req = http.request({ hostname: HOST, port: PORT, method, path: reqPath, headers: reqHeaders }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        const text = raw.toString('utf8');
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {}
        resolve({ status: res.statusCode, headers: res.headers, raw, text, json });
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

function assertNoPathLeak(text, tempRoot) {
  assert.equal(text.includes(tempRoot), false, 'Response leaked tempRoot filesystem path');
  assert.equal(text.includes(REAL_ROOT), false, 'Response leaked REAL_ROOT filesystem path');
  assert.equal(text.includes('media.json'), false, 'Response leaked internal filename media.json');
  assert.equal(text.includes('/content/'), false, 'Response leaked /content/ path');
  assert.equal(text.includes('.backups'), false, 'Response leaked .backups directory');
}

async function captureProductionSnapshot() {
  const files = [
    ...ALLOWED_JSON_FILES.map((f) => path.join(REAL_ROOT, 'content', f)),
    path.join(REAL_ROOT, 'public', 'images', 'og-default.png'),
  ];
  const map = new Map();
  for (const f of files) {
    const bytes = await fs.promises.readFile(f);
    map.set(f, crypto.createHash('sha256').update(bytes).digest('hex'));
  }
  return map;
}

describe('Task 115-B — Complete Media Library HTTP API & Security Controls', () => {
  let prodSnapshot;
  let tmpRoot;
  let uploadTmpDir;
  let origProjectRoot;
  let origBackupDir;
  let origUploadTmp;
  let weStartedServer = false;
  let auth;

  let addedTestFlag = false;

  before(async () => {
    if (!process.argv.includes('--test')) {
      process.argv.push('--test');
      addedTestFlag = true;
    }
    prodSnapshot = await captureProductionSnapshot();

    origProjectRoot = defaultStorageEngine.projectRoot;
    origBackupDir = defaultStorageEngine.backupDir;
    origUploadTmp = process.env.AINOVEX_CMS_UPLOAD_TMP_DIR;

    const rawTmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ainovex-media-api-'));
    tmpRoot = await fs.promises.realpath(rawTmp);
    uploadTmpDir = path.join(tmpRoot, 'upload-tmp');

    await fs.promises.mkdir(path.join(tmpRoot, 'content', 'articles'), { recursive: true });
    await fs.promises.mkdir(path.join(tmpRoot, 'public', 'images', 'media'), { recursive: true });
    await fs.promises.mkdir(uploadTmpDir, { recursive: true });

    for (const fileName of ALLOWED_JSON_FILES) {
      await fs.promises.copyFile(
        path.join(REAL_ROOT, 'content', fileName),
        path.join(tmpRoot, 'content', fileName)
      );
    }

    defaultStorageEngine.projectRoot = tmpRoot;
    defaultStorageEngine.backupDir = path.join(tmpRoot, '.backups');
    process.env.AINOVEX_CMS_UPLOAD_TMP_DIR = uploadTmpDir;

    weStartedServer = await startServerForTesting(server, PORT, HOST);
    auth = await loginFreshSession();
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
    const afterProd = await captureProductionSnapshot();
    for (const [f, sha] of prodSnapshot.entries()) {
      assert.equal(afterProd.get(f), sha, `Production file altered: ${f}`);
    }
  });

  it('enforces authentication, CSRF, and origin checks across all Media API routes', async () => {
    // Unauthenticated -> 401
    for (const [method, reqPath] of [
      ['GET', '/api/cms/media'],
      ['GET', '/api/cms/media/a1b2c3d4-e5f6-4789-abcd-0123456789ab'],
      ['POST', '/api/cms/media'],
      ['PATCH', '/api/cms/media/a1b2c3d4-e5f6-4789-abcd-0123456789ab'],
      ['DELETE', '/api/cms/media/a1b2c3d4-e5f6-4789-abcd-0123456789ab'],
    ]) {
      const res = await requestLocal({ method, reqPath, headers: { Origin: EXPECTED_ORIGIN } });
      assert.equal(res.status, 401, `Expected 401 for unauth ${method} ${reqPath}, got ${res.status}`);
    }

    // Missing/wrong CSRF -> 403
    const mp = buildMultipartPayload([
      { name: 'file', filename: 'x.png', contentType: 'image/png', data: makeValidPng() },
    ]);
    const noCsrfPost = await requestLocal({
      method: 'POST',
      reqPath: '/api/cms/media',
      headers: { Origin: EXPECTED_ORIGIN, Cookie: auth.cookiePair, 'Content-Type': mp.contentType },
      body: mp.body,
    });
    assert.equal(noCsrfPost.status, 403);

    // Cross-origin request -> 403
    const badOrigin = await requestLocal({
      method: 'GET',
      reqPath: '/api/cms/media',
      headers: { Origin: 'https://evil.example', Cookie: auth.cookiePair },
    });
    assert.equal(badOrigin.status, 403);
  });

  it('uploads JPEG, PNG, WebP, and GIF via multipart/form-data and direct binary, generating safe server IDs and filenames', async () => {
    const formats = [
      { ext: 'jpg', mime: 'image/jpeg', buf: makeValidJpeg(320, 240), orig: '<b>Hero Shot!.jpg', w: 320, h: 240 },
      { ext: 'png', mime: 'image/png', buf: makeValidPng(120, 80), orig: 'Diagram (v1).png', w: 120, h: 80 },
      { ext: 'webp', mime: 'image/webp', buf: makeValidWebp(400, 300), orig: 'Preview.webp', w: 400, h: 300 },
      { ext: 'gif', mime: 'image/gif', buf: makeValidGif(64, 48), orig: 'Anim.gif', w: 64, h: 48 },
    ];

    for (const fmt of formats) {
      const mp = buildMultipartPayload([
        { name: 'alt', data: `  Alt text for ${fmt.ext}  ` },
        { name: 'file', filename: fmt.orig, contentType: fmt.mime, data: fmt.buf },
      ]);
      const upRes = await requestLocal({
        method: 'POST',
        reqPath: '/api/cms/media',
        headers: {
          Origin: EXPECTED_ORIGIN,
          Cookie: auth.cookiePair,
          'X-CSRF-Token': auth.csrfToken,
          'Content-Type': mp.contentType,
        },
        body: mp.body,
      });
      assert.equal(upRes.status, 201, `Upload failed for ${fmt.ext}: ${upRes.text}`);
      assert.ok(upRes.headers.etag && upRes.headers.etag.startsWith('"'));
      assert.equal(upRes.headers.location, `/api/cms/media/${upRes.json.media.id}`);

      const rec = upRes.json.media;
      assert.deepEqual(Object.keys(rec).sort(), [...ALLOWED_MEDIA_FIELDS].sort());
      assert.match(rec.filename, new RegExp(`^media-[0-9a-f]{32}\\.${fmt.ext}$`));
      assert.notEqual(rec.filename, fmt.orig);
      assert.equal(rec.mimeType, fmt.mime);
      assert.equal(rec.width, fmt.w);
      assert.equal(rec.height, fmt.h);
      assert.equal(rec.size, fmt.buf.length);
      assert.equal(rec.checksum, crypto.createHash('sha256').update(fmt.buf).digest('hex'));
      assert.equal(rec.alt, `Alt text for ${fmt.ext}`);
      assert.equal(rec.originalName.includes('<b>'), false);
      assertNoPathLeak(upRes.text, tmpRoot);

      const diskBytes = await fs.promises.readFile(path.join(tmpRoot, 'public', 'images', 'media', rec.filename));
      assert.equal(diskBytes.equals(fmt.buf), true);
    }

    // Direct binary upload
    const binPng = makeValidPng(60, 40);
    const binRes = await requestLocal({
      method: 'POST',
      reqPath: '/api/cms/media',
      headers: {
        Origin: EXPECTED_ORIGIN,
        Cookie: auth.cookiePair,
        'X-CSRF-Token': auth.csrfToken,
        'Content-Type': 'image/png',
        'X-Media-Filename': 'direct-binary.png',
        'X-Media-Alt': 'Direct binary alt',
      },
      body: binPng,
    });
    assert.equal(binRes.status, 201, `Direct binary upload failed: ${binRes.text}`);
    assert.equal(binRes.json.media.originalName, 'direct-binary.png');
    assert.equal(binRes.json.media.alt, 'Direct binary alt');
    assert.equal((await fs.promises.readdir(uploadTmpDir)).length, 0);
  });

  it('rejects SVG, MIME spoofing, malformed payloads, unknown fields, and bad filenames without leaving temp files', async () => {
    const svgRes = await requestLocal({
      method: 'POST',
      reqPath: '/api/cms/media',
      headers: {
        Origin: EXPECTED_ORIGIN,
        Cookie: auth.cookiePair,
        'X-CSRF-Token': auth.csrfToken,
        'Content-Type': 'image/svg+xml',
      },
      body: '<svg xmlns="http://www.w3.org/2000/svg"/>',
    });
    assert.equal(svgRes.status, 415);

    const mpSvgPart = buildMultipartPayload([
      { name: 'file', filename: 'icon.svg', contentType: 'image/svg+xml', data: '<svg/>' },
    ]);
    const mpSvgRes = await requestLocal({
      method: 'POST',
      reqPath: '/api/cms/media',
      headers: {
        Origin: EXPECTED_ORIGIN,
        Cookie: auth.cookiePair,
        'X-CSRF-Token': auth.csrfToken,
        'Content-Type': mpSvgPart.contentType,
      },
      body: mpSvgPart.body,
    });
    assert.equal(mpSvgRes.status, 415);

    // SVG bytes disguised as image/png
    const mpSpoofSvg = buildMultipartPayload([
      {
        name: 'file',
        filename: 'fake.png',
        contentType: 'image/png',
        data: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
      },
    ]);
    const spoofSvgRes = await requestLocal({
      method: 'POST',
      reqPath: '/api/cms/media',
      headers: {
        Origin: EXPECTED_ORIGIN,
        Cookie: auth.cookiePair,
        'X-CSRF-Token': auth.csrfToken,
        'Content-Type': mpSpoofSvg.contentType,
      },
      body: mpSpoofSvg.body,
    });
    assert.equal(spoofSvgRes.status, 400);

    // JPEG bytes declared as image/png (MIME spoofing)
    const mpSpoofMime = buildMultipartPayload([
      { name: 'file', filename: 'fake.png', contentType: 'image/png', data: makeValidJpeg() },
    ]);
    const spoofMimeRes = await requestLocal({
      method: 'POST',
      reqPath: '/api/cms/media',
      headers: {
        Origin: EXPECTED_ORIGIN,
        Cookie: auth.cookiePair,
        'X-CSRF-Token': auth.csrfToken,
        'Content-Type': mpSpoofMime.contentType,
      },
      body: mpSpoofMime.body,
    });
    assert.equal(spoofMimeRes.status, 400);
    assert.match(spoofMimeRes.text, /does not match/i);

    // Traversal client filename
    const mpTrav = buildMultipartPayload([
      { name: 'file', filename: '../evil.png', contentType: 'image/png', data: makeValidPng() },
    ]);
    const travRes = await requestLocal({
      method: 'POST',
      reqPath: '/api/cms/media',
      headers: {
        Origin: EXPECTED_ORIGIN,
        Cookie: auth.cookiePair,
        'X-CSRF-Token': auth.csrfToken,
        'Content-Type': mpTrav.contentType,
      },
      body: mpTrav.body,
    });
    assert.equal(travRes.status, 400);

    // Unknown multipart field
    const mpExtra = buildMultipartPayload([
      { name: 'id', data: 'client-forged-id' },
      { name: 'file', filename: 'ok.png', contentType: 'image/png', data: makeValidPng() },
    ]);
    const extraRes = await requestLocal({
      method: 'POST',
      reqPath: '/api/cms/media',
      headers: {
        Origin: EXPECTED_ORIGIN,
        Cookie: auth.cookiePair,
        'X-CSRF-Token': auth.csrfToken,
        'Content-Type': mpExtra.contentType,
      },
      body: mpExtra.body,
    });
    assert.equal(extraRes.status, 400);

    // Empty file
    const mpEmpty = buildMultipartPayload([
      { name: 'file', filename: 'empty.png', contentType: 'image/png', data: Buffer.alloc(0) },
    ]);
    const emptyRes = await requestLocal({
      method: 'POST',
      reqPath: '/api/cms/media',
      headers: {
        Origin: EXPECTED_ORIGIN,
        Cookie: auth.cookiePair,
        'X-CSRF-Token': auth.csrfToken,
        'Content-Type': mpEmpty.contentType,
      },
      body: mpEmpty.body,
    });
    assert.equal(emptyRes.status, 400);
    assert.equal((await fs.promises.readdir(uploadTmpDir)).length, 0);
  });

  it('enforces bounded streaming limits (413), cleans up aborted uploads, and rolls back simulated upload failures', async () => {
    // 1. Content-Length exceeding limit -> 413
    const oversizeBin = Buffer.alloc(MAX_MEDIA_FILE_SIZE_BYTES + 1024, 0x41);
    const overClRes = await requestLocal({
      method: 'POST',
      reqPath: '/api/cms/media',
      headers: {
        Origin: EXPECTED_ORIGIN,
        Cookie: auth.cookiePair,
        'X-CSRF-Token': auth.csrfToken,
        'Content-Type': 'image/png',
      },
      body: oversizeBin,
    });
    assert.equal(overClRes.status, 413);
    assert.equal((await fs.promises.readdir(uploadTmpDir)).length, 0);

    // 2. Chunked stream (no Content-Length) exceeding MAX_MEDIA_MULTIPART_BODY -> 413
    const mpOver = buildMultipartPayload([
      {
        name: 'file',
        filename: 'huge.png',
        contentType: 'image/png',
        data: Buffer.alloc(MAX_MEDIA_MULTIPART_BODY + 2048, 0x42),
      },
    ]);
    const chunkedRes = await new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: HOST,
          port: PORT,
          method: 'POST',
          path: '/api/cms/media',
          headers: {
            Host: EXPECTED_HOST,
            Origin: EXPECTED_ORIGIN,
            Cookie: auth.cookiePair,
            'X-CSRF-Token': auth.csrfToken,
            'Content-Type': mpOver.contentType,
            'Transfer-Encoding': 'chunked',
          },
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
        }
      );
      let settled = false;
      req.on('error', (err) => {
        if (!settled) {
          settled = true;
          if (err.code === 'ECONNRESET' || err.code === 'EPIPE') {
            resolve({ status: 413, text: '' });
          } else {
            reject(err);
          }
        }
      });
      // Stream in 256 KB slices so server aborts cleanly on limit
      (async () => {
        try {
          for (let i = 0; i < mpOver.body.length; i += 256 * 1024) {
            if (req.destroyed || req.writableEnded) break;
            req.write(mpOver.body.subarray(i, i + 256 * 1024));
            await new Promise((r) => setTimeout(r, 2));
          }
          if (!req.destroyed && !req.writableEnded) req.end();
        } catch {}
      })();
    });
    assert.equal(chunkedRes.status, 413);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal((await fs.promises.readdir(uploadTmpDir)).length, 0);

    // 3. Mid-stream socket abort -> cleans up temp file
    await new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: HOST, port: PORT }, () => {
        const boundary = '----AbortBoundary12345';
        const head =
          `POST /api/cms/media HTTP/1.1\r\n` +
          `Host: ${EXPECTED_HOST}\r\n` +
          `Origin: ${EXPECTED_ORIGIN}\r\n` +
          `Cookie: ${auth.cookiePair}\r\n` +
          `X-CSRF-Token: ${auth.csrfToken}\r\n` +
          `Content-Type: multipart/form-data; boundary=${boundary}\r\n` +
          `Content-Length: 50000\r\n\r\n` +
          `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="file"; filename="aborted.png"\r\n` +
          `Content-Type: image/png\r\n\r\n` +
          `partial-bytes-here`;
        socket.write(head, () => {
          setTimeout(() => {
            socket.destroy();
            resolve();
          }, 40);
        });
      });
      socket.on('error', reject);
    });
    await new Promise((r) => setTimeout(r, 80));
    assert.equal((await fs.promises.readdir(uploadTmpDir)).length, 0);

    // 4. Simulated upload transaction failure -> rolls back both media.json and binary file + cleans temp file
    const beforeList = await requestLocal({
      method: 'GET',
      reqPath: '/api/cms/media',
      headers: { Cookie: auth.cookiePair },
    });
    const beforeCount = beforeList.json.total;
    const beforeFiles = new Set(await fs.promises.readdir(path.join(tmpRoot, 'public', 'images', 'media')));

    const simFailRes = await requestLocal({
      method: 'POST',
      reqPath: '/api/cms/media',
      headers: {
        Origin: EXPECTED_ORIGIN,
        Cookie: auth.cookiePair,
        'X-CSRF-Token': auth.csrfToken,
        'Content-Type': 'image/png',
        'X-Media-Filename': 'rollback-upload.png',
        'x-test-simulate-failure-at-index': '1',
      },
      body: makeValidPng(50, 50),
    });
    assert.equal(simFailRes.status, 500);
    assertNoPathLeak(simFailRes.text, tmpRoot);

    const afterList = await requestLocal({
      method: 'GET',
      reqPath: '/api/cms/media',
      headers: { Cookie: auth.cookiePair },
    });
    assert.equal(afterList.json.total, beforeCount);
    const afterFiles = new Set(await fs.promises.readdir(path.join(tmpRoot, 'public', 'images', 'media')));
    assert.deepEqual([...afterFiles].sort(), [...beforeFiles].sort());
    assert.equal((await fs.promises.readdir(uploadTmpDir)).length, 0);
  });

  it('supports GET list/single, PATCH with strong If-Match & immutable field protection, DELETE rollback, and verified /images/media/:filename serving', async () => {
    const png = makeValidPng(200, 150);
    const upRes = await requestLocal({
      method: 'POST',
      reqPath: '/api/cms/media',
      headers: {
        Origin: EXPECTED_ORIGIN,
        Cookie: auth.cookiePair,
        'X-CSRF-Token': auth.csrfToken,
        'Content-Type': 'image/png',
        'X-Media-Filename': 'lifecycle.png',
        'X-Media-Alt': 'Initial alt',
      },
      body: png,
    });
    assert.equal(upRes.status, 201);
    const created = upRes.json.media;
    const etag1 = upRes.headers.etag;

    // GET list & single
    const listRes = await requestLocal({
      method: 'GET',
      reqPath: '/api/cms/media',
      headers: { Cookie: auth.cookiePair },
    });
    assert.equal(listRes.status, 200);
    assert.ok(listRes.json.media.some((m) => m.id === created.id));
    assertNoPathLeak(listRes.text, tmpRoot);

    const badQuery = await requestLocal({
      method: 'GET',
      reqPath: '/api/cms/media?limit=10',
      headers: { Cookie: auth.cookiePair },
    });
    assert.equal(badQuery.status, 400);

    const getOne = await requestLocal({
      method: 'GET',
      reqPath: `/api/cms/media/${created.id}`,
      headers: { Cookie: auth.cookiePair },
    });
    assert.equal(getOne.status, 200);
    assert.equal(getOne.headers.etag, etag1);

    const missingGet = await requestLocal({
      method: 'GET',
      reqPath: `/api/cms/media/${crypto.randomUUID()}`,
      headers: { Cookie: auth.cookiePair },
    });
    assert.equal(missingGet.status, 404);

    const traversalGet = await requestLocal({
      method: 'GET',
      reqPath: '/api/cms/media/%2e%2e%2fsecrets',
      headers: { Cookie: auth.cookiePair },
    });
    assert.equal(traversalGet.status, 400);

    // Public serving GET & HEAD + security checks
    const serveGet = await requestLocal({ method: 'GET', reqPath: created.url });
    assert.equal(serveGet.status, 200);
    assert.equal(serveGet.headers['content-type'], 'image/png');
    assert.equal(serveGet.headers['x-content-type-options'], 'nosniff');
    assert.equal(serveGet.raw.equals(png), true);

    const serveHead = await requestLocal({ method: 'HEAD', reqPath: created.url });
    assert.equal(serveHead.status, 200);
    assert.equal(serveHead.raw.length, 0);

    const servePost = await requestLocal({ method: 'POST', reqPath: created.url });
    assert.equal(servePost.status, 405);

    const serveTraversal = await requestLocal({ method: 'GET', reqPath: '/images/media/%2e%2e%2fetc%2fpasswd' });
    assert.equal(serveTraversal.status, 400);

    // Unregistered rogue file must not be served (404)
    const rogueName = 'media-ffffffffffffffffffffffffffffffff.png';
    await fs.promises.writeFile(path.join(tmpRoot, 'public', 'images', 'media', rogueName), png);
    const rogueRes = await requestLocal({ method: 'GET', reqPath: `/images/media/${rogueName}` });
    assert.equal(rogueRes.status, 404);
    await fs.promises.unlink(path.join(tmpRoot, 'public', 'images', 'media', rogueName));

    // Symlink target in media dir -> 403
    const origPath = path.join(tmpRoot, 'public', 'images', 'media', created.filename);
    const outsideTarget = path.join(tmpRoot, 'outside.png');
    await fs.promises.copyFile(origPath, outsideTarget);
    await fs.promises.unlink(origPath);
    await fs.promises.symlink(outsideTarget, origPath);
    const symlinkServe = await requestLocal({ method: 'GET', reqPath: created.url });
    assert.equal(symlinkServe.status, 403);
    await fs.promises.unlink(origPath);
    await fs.promises.copyFile(outsideTarget, origPath);
    await fs.promises.unlink(outsideTarget);

    // PATCH precondition & immutable field checks
    const patchNoIfMatch = await requestLocal({
      method: 'PATCH',
      reqPath: `/api/cms/media/${created.id}`,
      headers: { Origin: EXPECTED_ORIGIN, Cookie: auth.cookiePair, 'X-CSRF-Token': auth.csrfToken },
      body: { alt: 'Updated alt' },
    });
    assert.equal(patchNoIfMatch.status, 428);

    const patchWeak = await requestLocal({
      method: 'PATCH',
      reqPath: `/api/cms/media/${created.id}`,
      headers: {
        Origin: EXPECTED_ORIGIN,
        Cookie: auth.cookiePair,
        'X-CSRF-Token': auth.csrfToken,
        'If-Match': `W/${etag1}`,
      },
      body: { alt: 'Updated alt' },
    });
    assert.equal(patchWeak.status, 400);

    const patchStale = await requestLocal({
      method: 'PATCH',
      reqPath: `/api/cms/media/${created.id}`,
      headers: {
        Origin: EXPECTED_ORIGIN,
        Cookie: auth.cookiePair,
        'X-CSRF-Token': auth.csrfToken,
        'If-Match': `"${'0'.repeat(64)}"`,
      },
      body: { alt: 'Updated alt' },
    });
    assert.equal(patchStale.status, 412);

    for (const badBody of [
      { alt: 'Ok', unknownField: 1 },
      { filename: 'media-11111111111111111111111111111111.png' },
      { url: '/images/media/media-11111111111111111111111111111111.png' },
      { mimeType: 'image/jpeg' },
      { size: 999 },
      { checksum: 'b'.repeat(64) },
      { width: 999 },
      { height: 999 },
      { createdAt: '2020-01-01T00:00:00.000Z' },
      { originalName: 'hacked.png' },
      JSON.parse('{"alt":"x","__proto__":{"a":1}}'),
    ]) {
      const badPatch = await requestLocal({
        method: 'PATCH',
        reqPath: `/api/cms/media/${created.id}`,
        headers: {
          Origin: EXPECTED_ORIGIN,
          Cookie: auth.cookiePair,
          'X-CSRF-Token': auth.csrfToken,
          'If-Match': etag1,
        },
        body: badBody,
      });
      assert.equal(badPatch.status, 400, `Expected 400 for PATCH body ${JSON.stringify(badBody)}, got ${badPatch.status}`);
    }

    // Valid PATCH { alt }
    const patchOk1 = await requestLocal({
      method: 'PATCH',
      reqPath: `/api/cms/media/${created.id}`,
      headers: {
        Origin: EXPECTED_ORIGIN,
        Cookie: auth.cookiePair,
        'X-CSRF-Token': auth.csrfToken,
        'If-Match': etag1,
      },
      body: { alt: 'Updated hero alt' },
    });
    assert.equal(patchOk1.status, 200, `PATCH failed: ${patchOk1.text}`);
    const etag2 = patchOk1.headers.etag;
    assert.notEqual(etag2, etag1);
    assert.equal(patchOk1.json.media.alt, 'Updated hero alt');
    assert.equal(patchOk1.json.media.id, created.id);
    assert.equal(patchOk1.json.media.filename, created.filename);
    assert.equal(patchOk1.json.media.checksum, created.checksum);
    assert.equal(patchOk1.json.media.createdAt, created.createdAt);
    assert.ok(Date.parse(patchOk1.json.media.updatedAt) >= Date.parse(created.updatedAt));

    // Valid PATCH { media: { alt } }
    const patchOk2 = await requestLocal({
      method: 'PATCH',
      reqPath: `/api/cms/media/${created.id}`,
      headers: {
        Origin: EXPECTED_ORIGIN,
        Cookie: auth.cookiePair,
        'X-CSRF-Token': auth.csrfToken,
        'If-Match': etag2,
      },
      body: { media: { alt: 'Wrapped alt update' } },
    });
    assert.equal(patchOk2.status, 200);
    const etag3 = patchOk2.headers.etag;
    assert.equal(patchOk2.json.media.alt, 'Wrapped alt update');

    // DELETE preconditions & rollback verification
    const delMissing = await requestLocal({
      method: 'DELETE',
      reqPath: `/api/cms/media/${crypto.randomUUID()}`,
      headers: {
        Origin: EXPECTED_ORIGIN,
        Cookie: auth.cookiePair,
        'X-CSRF-Token': auth.csrfToken,
        'If-Match': etag3,
      },
    });
    assert.equal(delMissing.status, 404);

    const delStale = await requestLocal({
      method: 'DELETE',
      reqPath: `/api/cms/media/${created.id}`,
      headers: {
        Origin: EXPECTED_ORIGIN,
        Cookie: auth.cookiePair,
        'X-CSRF-Token': auth.csrfToken,
        'If-Match': etag1,
      },
    });
    assert.equal(delStale.status, 412);

    // Simulated delete failure at index 1 -> restores BOTH file and metadata
    const delSimFail = await requestLocal({
      method: 'DELETE',
      reqPath: `/api/cms/media/${created.id}`,
      headers: {
        Origin: EXPECTED_ORIGIN,
        Cookie: auth.cookiePair,
        'X-CSRF-Token': auth.csrfToken,
        'If-Match': etag3,
        'x-test-simulate-failure-at-index': '1',
      },
    });
    assert.equal(delSimFail.status, 500);
    assertNoPathLeak(delSimFail.text, tmpRoot);
    assert.equal((await fs.promises.readFile(origPath)).equals(png), true);
    const checkStillThere = await requestLocal({
      method: 'GET',
      reqPath: `/api/cms/media/${created.id}`,
      headers: { Cookie: auth.cookiePair },
    });
    assert.equal(checkStillThere.status, 200);

    // Final valid DELETE
    const delOk = await requestLocal({
      method: 'DELETE',
      reqPath: `/api/cms/media/${created.id}`,
      headers: {
        Origin: EXPECTED_ORIGIN,
        Cookie: auth.cookiePair,
        'X-CSRF-Token': auth.csrfToken,
        'If-Match': etag3,
      },
    });
    assert.equal(delOk.status, 200);
    assert.equal(fs.existsSync(origPath), false);
    assertNoPathLeak(delOk.text, tmpRoot);

    const getDeleted = await requestLocal({
      method: 'GET',
      reqPath: `/api/cms/media/${created.id}`,
      headers: { Cookie: auth.cookiePair },
    });
    assert.equal(getDeleted.status, 404);
  });
});
