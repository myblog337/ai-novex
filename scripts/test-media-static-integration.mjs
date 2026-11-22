import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { readSafeImageSize } from './postbuild.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function makeValidPng(width = 1200, height = 630) {
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

function makeValidJpeg(width = 800, height = 450) {
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

function makeValidWebpVp8l(width = 960, height = 540) {
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

function makeValidWebpVp8x(width = 1024, height = 512) {
  const vp8x = Buffer.alloc(10);
  vp8x.writeUIntLE(width - 1, 4, 3);
  vp8x.writeUIntLE(height - 1, 7, 3);
  const chunkHeader = Buffer.alloc(8);
  chunkHeader.write('VP8X', 0, 'ascii');
  chunkHeader.writeUInt32LE(vp8x.length, 4);
  const riffHeader = Buffer.alloc(12);
  riffHeader.write('RIFF', 0, 'ascii');
  riffHeader.writeUInt32LE(4 + 8 + vp8x.length, 4);
  riffHeader.write('WEBP', 8, 'ascii');
  return Buffer.concat([riffHeader, chunkHeader, vp8x]);
}

function makeValidGif(width = 320, height = 180) {
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

describe('Task 115-B — Static Build, Image Metadata & Netlify Header Integration', () => {
  it('readSafeImageSize() safely reads JPEG, PNG, WebP, GIF and rejects symlinks, traversal, and corrupted images', async () => {
    const tmpRoot = await fs.promises.realpath(
      await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ainovex-media-imgsize-'))
    );
    try {
      const mediaDir = path.join(tmpRoot, 'public', 'images', 'media');
      await fs.promises.mkdir(mediaDir, { recursive: true });

      await fs.promises.writeFile(path.join(mediaDir, 'sample.png'), makeValidPng(1200, 630));
      await fs.promises.writeFile(path.join(mediaDir, 'sample.jpg'), makeValidJpeg(800, 450));
      await fs.promises.writeFile(path.join(mediaDir, 'sample-l.webp'), makeValidWebpVp8l(960, 540));
      await fs.promises.writeFile(path.join(mediaDir, 'sample-x.webp'), makeValidWebpVp8x(1024, 512));
      await fs.promises.writeFile(path.join(mediaDir, 'sample.gif'), makeValidGif(320, 180));
      await fs.promises.writeFile(path.join(mediaDir, 'corrupt.jpg'), Buffer.from('not-a-jpeg'));

      assert.deepEqual(readSafeImageSize('/images/media/sample.png', tmpRoot), { width: 1200, height: 630 });
      assert.deepEqual(readSafeImageSize('/images/media/sample.jpg?v=1', tmpRoot), { width: 800, height: 450 });
      assert.deepEqual(readSafeImageSize('/images/media/sample-l.webp', tmpRoot), { width: 960, height: 540 });
      assert.deepEqual(readSafeImageSize('/images/media/sample-x.webp', tmpRoot), { width: 1024, height: 512 });
      assert.deepEqual(readSafeImageSize('/images/media/sample.gif', tmpRoot), { width: 320, height: 180 });
      assert.equal(readSafeImageSize('/images/media/corrupt.jpg', tmpRoot), null);
      assert.equal(readSafeImageSize('/images/media/../../../etc/passwd', tmpRoot), null);
      assert.equal(readSafeImageSize('https://example.com/images/media/sample.png', tmpRoot), null);

      // Symlink file rejection
      const outsideFile = path.join(tmpRoot, 'outside.png');
      await fs.promises.writeFile(outsideFile, makeValidPng(100, 100));
      await fs.promises.symlink(outsideFile, path.join(mediaDir, 'symlink.png'));
      assert.equal(readSafeImageSize('/images/media/symlink.png', tmpRoot), null);

      // Symlinked directory rejection
      const outsideDir = path.join(tmpRoot, 'outside-dir');
      await fs.promises.mkdir(outsideDir, { recursive: true });
      await fs.promises.writeFile(path.join(outsideDir, 'in-symdir.png'), makeValidPng(100, 100));
      await fs.promises.symlink(outsideDir, path.join(tmpRoot, 'public', 'images', 'symdir'));
      assert.equal(readSafeImageSize('/images/symdir/in-symdir.png', tmpRoot), null);
    } finally {
      await fs.promises.rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it('emits accurate OG/Twitter/ImageObject metadata for /images/media/* JPEG, PNG, WebP, and GIF assets during postbuild', async () => {
    const tmpDir = await fs.promises.realpath(
      await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ainovex-media-postbuild-'))
    );
    try {
      const distDir = path.join(tmpDir, 'dist');
      const contentDir = path.join(tmpDir, 'content');
      const articlesDir = path.join(contentDir, 'articles');
      const publicDir = path.join(tmpDir, 'public');
      const mediaDir = path.join(publicDir, 'images', 'media');

      await fs.promises.mkdir(distDir, { recursive: true });
      await fs.promises.mkdir(articlesDir, { recursive: true });
      await fs.promises.cp(path.join(REPO_ROOT, 'public'), publicDir, { recursive: true });
      await fs.promises.mkdir(mediaDir, { recursive: true });

      const baseTemplate = await fs.promises.readFile(path.join(REPO_ROOT, 'index.html'), 'utf8');
      await fs.promises.writeFile(path.join(distDir, 'index.html'), baseTemplate);

      for (const file of ['settings.json', 'categories.json', 'tools.json', 'articles.json', 'ads.json', 'seo.json']) {
        await fs.promises.copyFile(path.join(REPO_ROOT, 'content', file), path.join(contentDir, file));
      }
      for (const file of await fs.promises.readdir(path.join(REPO_ROOT, 'content', 'articles'))) {
        if (file.endsWith('.md')) {
          await fs.promises.copyFile(path.join(REPO_ROOT, 'content', 'articles', file), path.join(articlesDir, file));
        }
      }

      // Provision 4 format assets in public/images/media/ and copy to dist/images/media/ (mirroring Vite static copy)
      const mediaFiles = [
        { name: 'media-00000000000000000000000000000001.png', buf: makeValidPng(1200, 630) },
        { name: 'media-00000000000000000000000000000002.jpg', buf: makeValidJpeg(1080, 720) },
        { name: 'media-00000000000000000000000000000003.webp', buf: makeValidWebpVp8l(960, 540) },
        { name: 'media-00000000000000000000000000000004.gif', buf: makeValidGif(640, 360) },
      ];
      await fs.promises.mkdir(path.join(distDir, 'images', 'media'), { recursive: true });
      for (const mf of mediaFiles) {
        await fs.promises.writeFile(path.join(mediaDir, mf.name), mf.buf);
        await fs.promises.writeFile(path.join(distDir, 'images', 'media', mf.name), mf.buf);
      }

      // Wire article #1 to PNG, article #2 to JPEG, /about/ SEO to WebP, /contact/ SEO to GIF
      const articles = JSON.parse(await fs.promises.readFile(path.join(contentDir, 'articles.json'), 'utf8'));
      const slug1 = articles[0].slug;
      const slug2 = articles[1].slug;
      articles[0].featuredImage = `/images/media/${mediaFiles[0].name}`;
      articles[0].ogImage = `/images/media/${mediaFiles[0].name}`;
      articles[1].featuredImage = `/images/media/${mediaFiles[1].name}`;
      articles[1].ogImage = `/images/media/${mediaFiles[1].name}`;
      await fs.promises.writeFile(path.join(contentDir, 'articles.json'), JSON.stringify(articles, null, 2));

      const seo = JSON.parse(await fs.promises.readFile(path.join(contentDir, 'seo.json'), 'utf8'));
      seo.pages.about = {
        ...(seo.pages.about || {}),
        ogImage: `/images/media/${mediaFiles[2].name}`,
        twitterImage: `/images/media/${mediaFiles[2].name}`,
      };
      seo.pages.contact = {
        ...(seo.pages.contact || {}),
        ogImage: `/images/media/${mediaFiles[3].name}`,
        twitterImage: `/images/media/${mediaFiles[3].name}`,
      };
      await fs.promises.writeFile(path.join(contentDir, 'seo.json'), JSON.stringify(seo, null, 2));

      execFileSync(process.execPath, [path.join(REPO_ROOT, 'scripts', 'postbuild.mjs')], {
        cwd: tmpDir,
        stdio: 'pipe',
      });

      const checkRouteHtml = async (relRoute, expected) => {
        const html = await fs.promises.readFile(path.join(distDir, relRoute, 'index.html'), 'utf8');
        assert.ok(html.includes(expected.url), `Expected ${expected.url} in ${relRoute}/index.html`);
        assert.ok(html.includes(`content="${expected.width}"`), `Expected og:image:width ${expected.width} in ${relRoute}`);
        assert.ok(html.includes(`content="${expected.height}"`), `Expected og:image:height ${expected.height} in ${relRoute}`);
        assert.ok(html.includes(`content="${expected.mime}"`), `Expected og:image:type ${expected.mime} in ${relRoute}`);
      };

      await checkRouteHtml(`blog/${slug1}`, {
        url: `/images/media/${mediaFiles[0].name}`,
        width: 1200,
        height: 630,
        mime: 'image/png',
      });
      await checkRouteHtml(`blog/${slug2}`, {
        url: `/images/media/${mediaFiles[1].name}`,
        width: 1080,
        height: 720,
        mime: 'image/jpeg',
      });
      await checkRouteHtml('about', {
        url: `/images/media/${mediaFiles[2].name}`,
        width: 960,
        height: 540,
        mime: 'image/webp',
      });
      await checkRouteHtml('contact', {
        url: `/images/media/${mediaFiles[3].name}`,
        width: 640,
        height: 360,
        mime: 'image/gif',
      });
    } finally {
      await fs.promises.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('configures netlify.toml with /images/media/* caching and X-Content-Type-Options: nosniff ordered after /images/*', async () => {
    const netlifyToml = await fs.promises.readFile(path.join(REPO_ROOT, 'netlify.toml'), 'utf8');
    const imagesIdx = netlifyToml.indexOf('for = "/images/*"');
    const mediaIdx = netlifyToml.indexOf('for = "/images/media/*"');
    assert.ok(imagesIdx !== -1, 'Expected /images/* rule in netlify.toml');
    assert.ok(mediaIdx > imagesIdx, 'Expected /images/media/* rule to appear after /images/* in netlify.toml');

    const mediaSection = netlifyToml.slice(mediaIdx, mediaIdx + 300);
    assert.match(mediaSection, /Cache-Control\s*=\s*"public,\s*max-age=2592000,\s*stale-while-revalidate=86400"/);
    assert.match(mediaSection, /X-Content-Type-Options\s*=\s*"nosniff"/);
  });
});
