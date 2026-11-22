import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import {
  SecureStorageEngine,
  ensureSecureMediaDirectory,
  resolveSecureMediaPath,
  validateMediaFileName,
  getActiveMutexCount,
} from './lib/storage.mjs';
import { MAX_MEDIA_FILE_SIZE_BYTES } from './lib/validators.mjs';

function makeValidPng(width = 16, height = 16) {
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

function makeMediaRecord(filename, buf, overrides = {}) {
  const now = '2026-04-01T12:00:00.000Z';
  return {
    id: crypto.randomUUID(),
    filename,
    originalName: 'test-image.png',
    url: `/images/media/${filename}`,
    mimeType: 'image/png',
    size: buf.length,
    width: 16,
    height: 16,
    checksum: crypto.createHash('sha256').update(buf).digest('hex'),
    alt: 'Sample media asset',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('Task 115-B — Media Storage Infrastructure & Atomic Transactions', () => {
  let tmpRoot;
  let engine;

  beforeEach(async () => {
    const rawTmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ainovex-media-storage-'));
    tmpRoot = await fs.promises.realpath(rawTmp);
    await fs.promises.mkdir(path.join(tmpRoot, 'content'), { recursive: true });
    await fs.promises.writeFile(path.join(tmpRoot, 'content', 'media.json'), '[]\n', 'utf8');
    await fs.promises.mkdir(path.join(tmpRoot, 'public', 'images'), { recursive: true });
    engine = new SecureStorageEngine({ projectRoot: tmpRoot });
  });

  afterEach(async () => {
    assert.equal(getActiveMutexCount(), 0, 'Active mutex registry must drain to 0');
    if (tmpRoot && fs.existsSync(tmpRoot)) {
      await fs.promises.rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it('provisions public/images/media safely and rejects symlinks or non-directory targets', async () => {
    assert.throws(
      () => ensureSecureMediaDirectory(tmpRoot, { createIfMissing: false }),
      /does not exist/i
    );

    const mediaDir = ensureSecureMediaDirectory(tmpRoot, { createIfMissing: true });
    assert.equal(mediaDir, path.join(tmpRoot, 'public', 'images', 'media'));
    assert.equal(fs.lstatSync(mediaDir).isDirectory(), true);
    assert.equal(fs.lstatSync(mediaDir).isSymbolicLink(), false);

    // Replace public/images/media with a symlink -> must fail
    await fs.promises.rmdir(mediaDir);
    const outsideDir = path.join(tmpRoot, 'outside');
    await fs.promises.mkdir(outsideDir, { recursive: true });
    await fs.promises.symlink(outsideDir, mediaDir);
    assert.throws(
      () => ensureSecureMediaDirectory(tmpRoot, { createIfMissing: true }),
      /symlink/i
    );

    // Replace symlink with a regular file -> must fail
    await fs.promises.unlink(mediaDir);
    await fs.promises.writeFile(mediaDir, 'not-a-dir');
    assert.throws(
      () => ensureSecureMediaDirectory(tmpRoot, { createIfMissing: true }),
      /not a directory/i
    );
  });

  it('enforces strict filename validation, traversal rejection, and symlink target rejection', async () => {
    const validName = 'media-0123456789abcdef0123456789abcdef.png';
    assert.equal(validateMediaFileName(validName), validName);

    for (const bad of ['../evil.png', 'a/b.png', 'a\\b.png', 'file.svg', 'a\0b.png', '.hidden.png']) {
      assert.throws(() => validateMediaFileName(bad));
      assert.throws(() => resolveSecureMediaPath(bad, tmpRoot));
    }

    ensureSecureMediaDirectory(tmpRoot, { createIfMissing: true });
    const symlinkTarget = path.join(tmpRoot, 'outside-secret.txt');
    await fs.promises.writeFile(symlinkTarget, 'secret');
    const symlinkMediaPath = path.join(tmpRoot, 'public', 'images', 'media', validName);
    await fs.promises.symlink(symlinkTarget, symlinkMediaPath);

    assert.throws(() => resolveSecureMediaPath(validName, tmpRoot), /symlink/i);
  });

  it('commits writeMedia + media.json atomically and enforces the 5 MB limit', async () => {
    const fn = 'media-0123456789abcdef0123456789abcdef.png';
    const pngBytes = makeValidPng();
    const record = makeMediaRecord(fn, pngBytes);

    await engine.executeTransaction([
      { type: 'writeJson', fileName: 'media.json', data: [record] },
      { type: 'writeMedia', fileName: fn, data: pngBytes },
    ]);

    const storedBytes = await fs.promises.readFile(path.join(tmpRoot, 'public', 'images', 'media', fn));
    assert.equal(storedBytes.equals(pngBytes), true);
    const storedJson = await engine.readJson('media.json');
    assert.equal(storedJson.length, 1);
    assert.equal(storedJson[0].filename, fn);

    // Oversized writeMedia rejected with PAYLOAD_TOO_LARGE
    const fn2 = 'media-abcdef0123456789abcdef0123456789.png';
    const huge = Buffer.alloc(MAX_MEDIA_FILE_SIZE_BYTES + 1, 0x41);
    await assert.rejects(
      () => engine.executeTransaction([{ type: 'writeMedia', fileName: fn2, data: huge }]),
      (err) => err.code === 'PAYLOAD_TOO_LARGE'
    );
    assert.equal(fs.existsSync(path.join(tmpRoot, 'public', 'images', 'media', fn2)), false);
  });

  it('rolls back both media.json and physical media files on simulated upload and delete failures', async () => {
    const fn = 'media-11112222333344445555666677778888.png';
    const pngBytes = makeValidPng();
    const record = makeMediaRecord(fn, pngBytes);
    const mediaPath = path.join(tmpRoot, 'public', 'images', 'media', fn);

    // 1. Simulated upload failure at index 1 (after media.json write, during writeMedia)
    await assert.rejects(
      () =>
        engine.executeTransaction(
          [
            { type: 'writeJson', fileName: 'media.json', data: [record] },
            { type: 'writeMedia', fileName: fn, data: pngBytes },
          ],
          { _simulateMutationFailureAtIndex: 1 }
        ),
      /Simulated mutation failure/i
    );

    assert.deepEqual(await engine.readJson('media.json'), []);
    assert.equal(fs.existsSync(mediaPath), false);

    // 2. Commit cleanly first, then simulate failure during deleteMedia (index 1)
    await engine.executeTransaction([
      { type: 'writeJson', fileName: 'media.json', data: [record] },
      { type: 'writeMedia', fileName: fn, data: pngBytes },
    ]);

    await assert.rejects(
      () =>
        engine.executeTransaction(
          [
            { type: 'writeJson', fileName: 'media.json', data: [] },
            { type: 'deleteMedia', fileName: fn },
          ],
          { _simulateMutationFailureAtIndex: 1 }
        ),
      /Simulated mutation failure/i
    );

    // Both metadata and exact binary bytes must be restored
    const restoredJson = await engine.readJson('media.json');
    assert.equal(restoredJson.length, 1);
    assert.equal(restoredJson[0].id, record.id);
    const restoredBytes = await fs.promises.readFile(mediaPath);
    assert.equal(restoredBytes.equals(pngBytes), true);
  });

  it('re-verifies directory integrity under lock to block TOCTOU symlink replacement', async () => {
    const fn = 'media-9999aaaabbbbccccddddeeeeffff0000.png';
    const pngBytes = makeValidPng();
    const mediaDir = ensureSecureMediaDirectory(tmpRoot, { createIfMissing: true });
    await fs.promises.rmdir(mediaDir);
    const outsideDir = path.join(tmpRoot, 'outside-toctou');
    await fs.promises.mkdir(outsideDir, { recursive: true });
    await fs.promises.symlink(outsideDir, mediaDir);

    await assert.rejects(
      () => engine.executeTransaction([{ type: 'writeMedia', fileName: fn, data: pngBytes }]),
      /symlink/i
    );
  });
});
