import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import {
  MAX_MEDIA_FILE_SIZE_BYTES,
  MAX_MEDIA_IMAGE_DIMENSION,
  MAX_MEDIA_ALT_LENGTH,
  MAX_MEDIA_ORIGINAL_NAME_LENGTH,
  ALLOWED_MEDIA_MIME_TYPES,
  ALLOWED_MEDIA_FIELDS,
  isValidMediaId,
  isValidMediaFilename,
  isValidMediaPublicUrl,
  sanitizeMediaOriginalFilename,
  validateMediaAltText,
  inspectImageBuffer,
  validateMediaRecord,
  validateMediaLibrary,
} from './lib/validators.mjs';

function makeValidPng(width = 120, height = 80) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = 2; // RGB
  ihdrData[10] = 0;
  ihdrData[11] = 0;
  ihdrData[12] = 0;
  const makeChunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, 'ascii');
    const crc = Buffer.alloc(4);
    return Buffer.concat([len, typeBuf, data, crc]);
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
    0xff, 0xda, 0x00, 0x0c, 0x03, 0x01, 0x00, 0x02, 0x11, 0x03, 0x11, 0x00, 0x3f, 0x00,
    0xaa, 0xff, 0x00, 0xbb,
  ]);
  const eoi = Buffer.from([0xff, 0xd9]);
  return Buffer.concat([soi, app0, sof0, sos, eoi]);
}

function makeValidWebp(width = 400, height = 300) {
  const payload = Buffer.alloc(12);
  payload[0] = 0x2f; // VP8L signature
  const packed = ((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14);
  payload.writeUInt32LE(packed >>> 0, 1);

  const chunkHeader = Buffer.alloc(8);
  chunkHeader.write('VP8L', 0, 'ascii');
  chunkHeader.writeUInt32LE(payload.length, 4);

  const riffBodySize = 4 + chunkHeader.length + payload.length;
  const riffHeader = Buffer.alloc(12);
  riffHeader.write('RIFF', 0, 'ascii');
  riffHeader.writeUInt32LE(riffBodySize, 4);
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
  const imgData = Buffer.from([0x02, 0x02, 0x4c, 0x01, 0x00, 0x3b]);
  return Buffer.concat([header, lsd, imgDesc, imgData]);
}

function makeValidMediaRecord(overrides = {}) {
  const now = '2026-04-01T12:00:00.000Z';
  const filename = 'media-0123456789abcdef0123456789abcdef.png';
  return {
    id: 'a1b2c3d4-e5f6-4789-abcd-0123456789ab',
    filename,
    originalName: 'hero-banner.png',
    url: `/images/media/${filename}`,
    mimeType: 'image/png',
    size: 1024,
    width: 120,
    height: 80,
    checksum: 'a'.repeat(64),
    alt: 'Hero banner illustration',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('Task 115-B — Media Validators & Binary Inspection', () => {
  it('accepts valid JPEG, PNG, WebP, and GIF buffers with exact dimensions and SHA-256 checksum', () => {
    const cases = [
      { buf: makeValidJpeg(320, 240), mime: 'image/jpeg', ext: 'jpg', w: 320, h: 240 },
      { buf: makeValidPng(120, 80), mime: 'image/png', ext: 'png', w: 120, h: 80 },
      { buf: makeValidWebp(400, 300), mime: 'image/webp', ext: 'webp', w: 400, h: 300 },
      { buf: makeValidGif(64, 48), mime: 'image/gif', ext: 'gif', w: 64, h: 48 },
    ];

    for (const c of cases) {
      const res = inspectImageBuffer(c.buf, { declaredMimeType: c.mime });
      assert.equal(res.ok, true, `Expected ${c.mime} to succeed: ${res.error}`);
      assert.equal(res.mimeType, c.mime);
      assert.equal(res.extension, c.ext);
      assert.equal(res.size, c.buf.length);
      assert.equal(res.width, c.w);
      assert.equal(res.height, c.h);
      assert.equal(res.checksum, crypto.createHash('sha256').update(c.buf).digest('hex'));
    }
  });

  it('rejects SVG, XML, HTML, scripts, PDF, executables, and ZIP payloads even if declared as image/*', () => {
    const activePayloads = [
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', 'utf8'),
      Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>', 'utf8'),
      Buffer.from('  <!DOCTYPE html><html><script>alert(1)</script></html>', 'utf8'),
      Buffer.from('<?php system($_GET["c"]); ?>', 'utf8'),
      Buffer.from('%PDF-1.7\n1 0 obj', 'utf8'),
      Buffer.from('#!/bin/sh\necho hi', 'utf8'),
      Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00]), // MZ/PE
      Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01]), // ELF
      Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]), // ZIP
    ];

    for (const payload of activePayloads) {
      for (const mime of ALLOWED_MEDIA_MIME_TYPES) {
        const res = inspectImageBuffer(payload, { declaredMimeType: mime });
        assert.equal(res.ok, false);
        assert.equal(res.code, 'DISALLOWED_CONTENT');
      }
    }
  });

  it('rejects MIME spoofing, truncated/corrupt images, empty buffers, oversized payloads, and extreme dimensions', () => {
    const pngBuf = makeValidPng(100, 100);
    const spoofed = inspectImageBuffer(pngBuf, { declaredMimeType: 'image/jpeg' });
    assert.equal(spoofed.ok, false);
    assert.equal(spoofed.code, 'MIME_SPOOFING');

    const svgMime = inspectImageBuffer(pngBuf, { declaredMimeType: 'image/svg+xml' });
    assert.equal(svgMime.ok, false);
    assert.equal(svgMime.code, 'UNSUPPORTED_MIME_TYPE');

    assert.equal(inspectImageBuffer(Buffer.alloc(0)).code, 'EMPTY_FILE');
    assert.equal(inspectImageBuffer(pngBuf.subarray(0, 20)).code, 'MALFORMED_IMAGE');

    const trailingPng = Buffer.concat([pngBuf, Buffer.from([0x01, 0x02])]);
    assert.equal(inspectImageBuffer(trailingPng).code, 'MALFORMED_IMAGE');

    const zeroDimPng = makeValidPng(0, 50);
    assert.equal(inspectImageBuffer(zeroDimPng).code, 'INVALID_DIMENSIONS');

    const hugeDimPng = makeValidPng(MAX_MEDIA_IMAGE_DIMENSION + 1, 50);
    assert.equal(inspectImageBuffer(hugeDimPng).code, 'INVALID_DIMENSIONS');

    const oversized = Buffer.alloc(MAX_MEDIA_FILE_SIZE_BYTES + 1);
    assert.equal(inspectImageBuffer(oversized).code, 'FILE_TOO_LARGE');
  });

  it('sanitizes valid client filenames as metadata and rejects traversal/extension spoofing', () => {
    const okClean = sanitizeMediaOriginalFilename('Hero <script>Banner (v2)!!.png', 'image/png');
    assert.equal(okClean.ok, true);
    assert.ok(!okClean.originalName.includes('<'));
    assert.ok(!okClean.originalName.includes('>'));
    assert.ok(okClean.originalName.endsWith('.png'));

    const longName = `${'a'.repeat(200)}.webp`;
    const okBounded = sanitizeMediaOriginalFilename(longName, 'image/webp');
    assert.equal(okBounded.ok, true);
    assert.ok(okBounded.originalName.length <= MAX_MEDIA_ORIGINAL_NAME_LENGTH);
    assert.ok(okBounded.originalName.endsWith('.webp'));

    const hiddenSanitized = sanitizeMediaOriginalFilename('.hidden.png', 'image/png');
    assert.equal(hiddenSanitized.ok, true);
    assert.equal(hiddenSanitized.originalName, 'hidden.png');

    const badNames = [
      '../evil.png',
      'sub/dir.png',
      'sub\\dir.png',
      'bad\0name.png',
      'encoded%2e%2e.png',
      '.png',
      'vector.svg',
      'page.html',
      'mismatch.jpg', // expected image/png
    ];
    for (const bad of badNames) {
      const res = sanitizeMediaOriginalFilename(bad, 'image/png');
      assert.equal(res.ok, false, `Expected "${bad}" to be rejected`);
    }
  });

  it('validates alt text and enforces the exact 12-field media schema allowlist', () => {
    assert.deepEqual(validateMediaAltText(undefined), { ok: true, alt: '' });
    assert.deepEqual(validateMediaAltText('  Clean diagram  '), { ok: true, alt: 'Clean diagram' });
    assert.equal(validateMediaAltText('<script>alert(1)</script>').ok, false);
    assert.equal(validateMediaAltText('javascript:alert(1)').ok, false);
    assert.equal(validateMediaAltText('a'.repeat(MAX_MEDIA_ALT_LENGTH + 1)).ok, false);

    assert.equal(ALLOWED_MEDIA_FIELDS.length, 12);

    const valid = makeValidMediaRecord();
    assert.equal(validateMediaRecord(valid).isValid, true);

    const withExtra = makeValidMediaRecord({ extraField: 'nope' });
    const extraRes = validateMediaRecord(withExtra);
    assert.equal(extraRes.isValid, false);
    assert.ok(extraRes.errors.some((e) => e.code === 'UNKNOWN_FIELD'));

    const withProto = JSON.parse('{"__proto__":{"polluted":true}}');
    assert.equal(validateMediaRecord(withProto).isValid, false);

    const urlMismatch = makeValidMediaRecord({ url: '/images/media/media-ffffffffffffffffffffffffffffffff.png' });
    assert.equal(validateMediaRecord(urlMismatch).isValid, false);

    const extMismatch = makeValidMediaRecord({
      filename: 'media-0123456789abcdef0123456789abcdef.jpg',
      url: '/images/media/media-0123456789abcdef0123456789abcdef.jpg',
      mimeType: 'image/png',
    });
    assert.equal(validateMediaRecord(extMismatch).isValid, false);
  });

  it('validates media IDs, filenames, public URLs, and rejects duplicates in validateMediaLibrary()', () => {
    assert.equal(isValidMediaId('a1b2c3d4-e5f6-4789-abcd-0123456789ab'), true);
    assert.equal(isValidMediaId('../etc'), false);
    assert.equal(isValidMediaId('__proto__'), false);

    assert.equal(isValidMediaFilename('media-0123456789abcdef0123456789abcdef.webp'), true);
    assert.equal(isValidMediaFilename('logo.svg'), false);
    assert.equal(isValidMediaFilename('../media-0123456789abcdef0123456789abcdef.png'), false);

    assert.equal(isValidMediaPublicUrl('/images/media/media-0123456789abcdef0123456789abcdef.jpg'), true);
    assert.equal(isValidMediaPublicUrl('/images/og-default.png'), false);

    const rec1 = makeValidMediaRecord();
    const rec2 = makeValidMediaRecord({
      id: 'b1b2c3d4-e5f6-4789-abcd-0123456789ab',
      filename: 'media-fedcba9876543210fedcba9876543210.jpg',
      url: '/images/media/media-fedcba9876543210fedcba9876543210.jpg',
      mimeType: 'image/jpeg',
    });
    assert.equal(validateMediaLibrary([rec1, rec2]).isValid, true);

    const dupId = validateMediaLibrary([rec1, { ...rec2, id: rec1.id }]);
    assert.equal(dupId.isValid, false);
    assert.ok(dupId.errors.some((e) => e.code === 'DUPLICATE_ID'));

    const dupFile = validateMediaLibrary([
      rec1,
      { ...rec2, filename: rec1.filename, mimeType: rec1.mimeType },
    ]);
    assert.equal(dupFile.isValid, false);
    assert.ok(dupFile.errors.some((e) => e.code === 'DUPLICATE_FILENAME'));
  });
});
