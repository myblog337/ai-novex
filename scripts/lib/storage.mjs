import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  MAX_MEDIA_FILE_SIZE_BYTES,
  isValidArticleSlug,
  isValidCategorySlug,
  isValidMediaFilename,
  validateArticles,
  validateTools,
  validateCategories,
  validateSettings,
  validateAds,
  validateSeoConfig,
  validatePages,
  validateMediaLibrary,
} from './validators.mjs';

// ----------------------------------------------------------------------------
// Configuration and Constants
// ----------------------------------------------------------------------------

/**
 * Strict file allowlist for CMS JSON content stores.
 * Only these 8 files located directly in the /content directory may be accessed or updated.
 */
export const ALLOWED_JSON_FILES = Object.freeze([
  'articles.json',
  'tools.json',
  'categories.json',
  'settings.json',
  'ads.json',
  'seo.json',
  'pages.json',
  'media.json',
]);

const ALLOWED_JSON_SET = new Set(ALLOWED_JSON_FILES);

export const MAX_BACKUPS_PER_FILE = 20;
export const BACKUP_DIR_NAME = '.backups';
export const MAX_TRANSACTION_OPERATIONS = 50;

/**
 * Registry mapping allowed JSON store filenames to their corresponding schema validators.
 */
const SCHEMA_VALIDATORS = Object.freeze({
  'articles.json': validateArticles,
  'tools.json': validateTools,
  'categories.json': validateCategories,
  'settings.json': validateSettings,
  'ads.json': validateAds,
  'seo.json': validateSeoConfig,
  'pages.json': validatePages,
  'media.json': validateMediaLibrary,
});

/**
 * Custom error class for standard transaction failures where changes
 * were either prevented or safely rolled back.
 */
export class TransactionError extends Error {
  constructor(message, options = {}) {
    super(sanitizeErrorMessage(message));
    this.name = 'TransactionError';
    this.code = options.code || 'TRANSACTION_ERROR';
    this.rolledBack = Boolean(options.rolledBack);
    if (typeof options.executedOperationsCount === 'number') {
      this.executedOperationsCount = options.executedOperationsCount;
    }
    if (options.originalError) {
      this.originalError = options.originalError;
    }
  }
}

/**
 * Distinct error class thrown when rollback itself fails.
 * Signals that automatic rollback encountered an unrecoverable condition,
 * all recoverable backups are preserved, and manual/admin recovery is required.
 * Never reports an ordinary successful rollback.
 */
export class TransactionRecoveryRequiredError extends Error {
  constructor(message, details = {}) {
    super(sanitizeErrorMessage(message));
    this.name = 'TransactionRecoveryRequiredError';
    this.code = 'TRANSACTION_RECOVERY_REQUIRED';
    this.isRecoveryRequired = true;
    this.mutationError = details.mutationError ? sanitizeErrorMessage(details.mutationError) : null;
    this.rollbackFailures = Array.isArray(details.rollbackFailures) ? details.rollbackFailures : [];
    this.recoveryBackups = Array.isArray(details.recoveryBackups) ? details.recoveryBackups : [];
  }
}

// Derive project root from this module's location: scripts/lib/storage.mjs -> root is ../..
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_PROJECT_ROOT = path.resolve(__dirname, '../..');

// ----------------------------------------------------------------------------
// Path Security and Boundary Validation
// ----------------------------------------------------------------------------

/**
 * Strict directory boundary check.
 * Verifies that targetPath is a child inside baseDir and does not escape via
 * relative traversal, prefix matching tricks, or separator anomalies.
 */
export function isInsideAuthorizedDirectory(baseDir, targetPath) {
  if (!baseDir || !targetPath) return false;
  const normalizedBase = path.resolve(baseDir);
  const normalizedTarget = path.resolve(targetPath);

  const relative = path.relative(normalizedBase, normalizedTarget);
  const isDescendant = !relative.startsWith('..') && !path.isAbsolute(relative) && relative !== '';
  const separatorPrefix = normalizedBase.endsWith(path.sep)
    ? normalizedBase
    : normalizedBase + path.sep;
  const hasSeparatorBoundary = normalizedTarget.startsWith(separatorPrefix);

  return isDescendant && hasSeparatorBoundary;
}

/**
 * Validates a JSON filename against the strict CMS allowlist.
 * Rejects null bytes, directory separators, path traversal sequences, and unlisted files.
 */
export function validateJsonFileName(fileName) {
  if (typeof fileName !== 'string' || !fileName.trim()) {
    throw new Error('Filename must be a non-empty string');
  }
  if (fileName.includes('\0')) {
    throw new Error('Filename contains forbidden null bytes');
  }
  if (fileName.includes('/') || fileName.includes('\\') || fileName.includes('..')) {
    throw new Error('Directory separators and path traversal sequences are forbidden');
  }
  if (path.basename(fileName) !== fileName) {
    throw new Error('Arbitrary paths are forbidden; only bare filenames from allowlist are accepted');
  }
  if (!ALLOWED_JSON_SET.has(fileName)) {
    throw new Error(
      `Disallowed JSON file: "${fileName}". Allowed files: ${ALLOWED_JSON_FILES.join(', ')}`
    );
  }
  return fileName;
}

/**
 * Validates an article slug for Markdown content according to the unified policy:
 * - String only
 * - Length: 3 to 80 characters
 * - Lowercase letters a-z and digits 0-9
 * - Single hyphens allowed between alphanumeric segments
 * - No uppercase letters, underscores, consecutive hyphens, or leading/trailing hyphens
 * - Reject whitespace, slashes, backslashes, null bytes, dots, and all other characters
 */
export function validateArticleSlug(slug) {
  if (typeof slug !== 'string' || !slug.trim()) {
    throw new Error('Article slug is missing or empty');
  }
  if (slug.trim() !== slug) {
    throw new Error('Article slug contains leading or trailing whitespace');
  }
  if (slug.includes('\0')) {
    throw new Error('Article slug contains forbidden null bytes');
  }
  if (slug.includes('/') || slug.includes('\\') || slug.includes('..')) {
    throw new Error('Article slug contains directory separators or path traversal sequences');
  }
  if (slug.toLowerCase().endsWith('.md')) {
    throw new Error('Pass the article slug identifier without the .md extension');
  }
  if (slug.length < 3 || slug.length > 80) {
    throw new Error('Article slug length must be between 3 and 80 characters');
  }
  if (!isValidArticleSlug(slug)) {
    throw new Error(
      'Article slug contains invalid characters or formatting (must be 3-80 lowercase alphanumeric characters with single hyphens, no underscores or consecutive hyphens)'
    );
  }
  return slug;
}

/**
 * Resolves and validates the canonical target path for an allowed JSON file.
 * Verifies realpath, boundary containment, and prevents symlink escape.
 */
export function resolveSecureJsonPath(fileName, projectRoot = DEFAULT_PROJECT_ROOT) {
  validateJsonFileName(fileName);

  const rootResolved = path.resolve(projectRoot);
  const contentDir = path.resolve(rootResolved, 'content');
  const canonicalContentDir = fs.existsSync(contentDir)
    ? fs.realpathSync(contentDir)
    : contentDir;

  const candidatePath = path.resolve(canonicalContentDir, fileName);

  // Boundary check
  if (!isInsideAuthorizedDirectory(canonicalContentDir, candidatePath)) {
    throw new Error('Resolved path escapes the authorized content directory');
  }
  if (
    path.dirname(candidatePath) !== canonicalContentDir ||
    path.basename(candidatePath) !== fileName
  ) {
    throw new Error('Resolved path does not match canonical content directory structure');
  }

  // Symlink escape check
  let candidateLstat = null;
  try {
    candidateLstat = fs.lstatSync(candidatePath);
  } catch {}

  if (candidateLstat) {
    if (candidateLstat.isSymbolicLink()) {
      throw new Error('Symlinks are forbidden for CMS storage');
    }
    const realTarget = fs.realpathSync(candidatePath);
    if (
      !isInsideAuthorizedDirectory(canonicalContentDir, realTarget) ||
      path.basename(realTarget) !== fileName
    ) {
      throw new Error('Canonical target escapes authorized content directory via symlink or alias');
    }
  }

  return candidatePath;
}

/**
 * Resolves and validates the canonical target path for an article Markdown file.
 * Verifies realpath, boundary containment, and prevents symlink escape.
 */
export function resolveSecureMarkdownPath(slug, projectRoot = DEFAULT_PROJECT_ROOT) {
  validateArticleSlug(slug);

  const rootResolved = path.resolve(projectRoot);
  const contentDir = path.resolve(rootResolved, 'content');
  const articlesDir = path.resolve(contentDir, 'articles');

  const canonicalContentDir = fs.existsSync(contentDir)
    ? fs.realpathSync(contentDir)
    : contentDir;

  const canonicalArticlesDir = fs.existsSync(articlesDir)
    ? fs.realpathSync(articlesDir)
    : articlesDir;

  // Verify articles directory is itself inside content directory
  if (
    fs.existsSync(articlesDir) &&
    !isInsideAuthorizedDirectory(canonicalContentDir, canonicalArticlesDir)
  ) {
    throw new Error('Articles directory escapes authorized content directory');
  }

  const expectedFileName = `${slug}.md`;
  const candidatePath = path.resolve(canonicalArticlesDir, expectedFileName);

  // Boundary check
  if (!isInsideAuthorizedDirectory(canonicalArticlesDir, candidatePath)) {
    throw new Error('Resolved path escapes authorized articles directory');
  }
  if (
    path.dirname(candidatePath) !== canonicalArticlesDir ||
    path.basename(candidatePath) !== expectedFileName
  ) {
    throw new Error('Resolved path does not match canonical articles directory structure');
  }

  // Symlink escape check
  let candidateLstat = null;
  try {
    candidateLstat = fs.lstatSync(candidatePath);
  } catch {}

  if (candidateLstat) {
    if (candidateLstat.isSymbolicLink()) {
      throw new Error('Symlinks are forbidden for CMS storage');
    }
    const realTarget = fs.realpathSync(candidatePath);
    if (
      !isInsideAuthorizedDirectory(canonicalArticlesDir, realTarget) ||
      path.basename(realTarget) !== expectedFileName
    ) {
      throw new Error('Canonical target escapes authorized articles directory via symlink or alias');
    }
  }

  return candidatePath;
}

/**
 * Validates a server-generated media filename for storage inside public/images/media/.
 */
export function validateMediaFileName(fileName) {
  if (typeof fileName !== 'string' || !fileName.trim()) {
    throw new Error('Media filename must be a non-empty string');
  }
  if (fileName.includes('\0')) {
    throw new Error('Media filename contains forbidden null bytes');
  }
  if (fileName.includes('/') || fileName.includes('\\') || fileName.includes('..')) {
    throw new Error('Directory separators and path traversal sequences are forbidden');
  }
  if (path.basename(fileName) !== fileName) {
    throw new Error('Arbitrary paths are forbidden for media files');
  }
  if (!isValidMediaFilename(fileName)) {
    throw new Error('Invalid generated media filename format');
  }
  return fileName;
}

/**
 * Resolves and validates the canonical target path for a stored media file inside public/images/media/.
 * Verifies directory containment and rejects symlinks along the directory hierarchy and target file.
 */
export function resolveSecureMediaPath(fileName, projectRoot = DEFAULT_PROJECT_ROOT) {
  validateMediaFileName(fileName);

  const rootResolved = path.resolve(projectRoot);
  const canonicalRoot = fs.existsSync(rootResolved) ? fs.realpathSync(rootResolved) : rootResolved;

  const publicDir = path.resolve(canonicalRoot, 'public');
  const imagesDir = path.resolve(publicDir, 'images');
  const mediaDir = path.resolve(imagesDir, 'media');

  for (const [parentDir, dirPath, label] of [
    [canonicalRoot, publicDir, 'public'],
    [publicDir, imagesDir, 'public/images'],
    [imagesDir, mediaDir, 'public/images/media'],
  ]) {
    let dirLstat = null;
    try {
      dirLstat = fs.lstatSync(dirPath);
    } catch {}
    if (dirLstat) {
      if (dirLstat.isSymbolicLink()) {
        throw new Error(`Symlinks are forbidden for CMS media directory (${label})`);
      }
      if (!dirLstat.isDirectory()) {
        throw new Error(`Media storage path is not a directory (${label})`);
      }
      const realDir = fs.realpathSync(dirPath);
      if (!isInsideAuthorizedDirectory(parentDir, realDir)) {
        throw new Error(`Media directory escapes authorized project boundary (${label})`);
      }
    }
  }

  const canonicalMediaDir = fs.existsSync(mediaDir) ? fs.realpathSync(mediaDir) : mediaDir;
  const candidatePath = path.resolve(canonicalMediaDir, fileName);

  if (!isInsideAuthorizedDirectory(canonicalMediaDir, candidatePath)) {
    throw new Error('Resolved path escapes authorized media directory');
  }
  if (
    path.dirname(candidatePath) !== canonicalMediaDir ||
    path.basename(candidatePath) !== fileName
  ) {
    throw new Error('Resolved path does not match canonical media directory structure');
  }

  let candidateLstat = null;
  try {
    candidateLstat = fs.lstatSync(candidatePath);
  } catch {}

  if (candidateLstat) {
    if (candidateLstat.isSymbolicLink()) {
      throw new Error('Symlinks are forbidden for CMS media storage');
    }
    const realTarget = fs.realpathSync(candidatePath);
    if (
      !isInsideAuthorizedDirectory(canonicalMediaDir, realTarget) ||
      path.basename(realTarget) !== fileName
    ) {
      throw new Error('Canonical target escapes authorized media directory via symlink or alias');
    }
  }

  return candidatePath;
}

/**
 * Verifies the integrity of public/, public/images/, and public/images/media/.
 * Rejects symlinks, non-directories, and paths escaping the project boundary.
 * When createIfMissing is true, safely provisions missing directories after parent checks.
 */
export function ensureSecureMediaDirectory(
  projectRoot = DEFAULT_PROJECT_ROOT,
  { createIfMissing = false } = {}
) {
  const rootResolved = path.resolve(projectRoot);
  if (!fs.existsSync(rootResolved)) {
    throw new Error('Project root does not exist for CMS media storage');
  }
  const canonicalRoot = fs.realpathSync(rootResolved);
  const publicDir = path.resolve(canonicalRoot, 'public');
  const imagesDir = path.resolve(publicDir, 'images');
  const mediaDir = path.resolve(imagesDir, 'media');

  for (const [parentDir, dirPath, label] of [
    [canonicalRoot, publicDir, 'public'],
    [publicDir, imagesDir, 'public/images'],
    [imagesDir, mediaDir, 'public/images/media'],
  ]) {
    let dirLstat = null;
    try {
      dirLstat = fs.lstatSync(dirPath);
    } catch (err) {
      if (!err || err.code !== 'ENOENT') {
        throw err;
      }
    }

    if (!dirLstat) {
      if (!createIfMissing) {
        throw new Error(`CMS media directory does not exist (${label})`);
      }
      fs.mkdirSync(dirPath, { recursive: false, mode: 0o755 });
      dirLstat = fs.lstatSync(dirPath);
    }

    if (dirLstat.isSymbolicLink()) {
      throw new Error(`Symlinks are forbidden for CMS media directory (${label})`);
    }
    if (!dirLstat.isDirectory()) {
      throw new Error(`Media storage path is not a directory (${label})`);
    }
    const realDir = fs.realpathSync(dirPath);
    if (!isInsideAuthorizedDirectory(parentDir, realDir)) {
      throw new Error(`Media directory escapes authorized project boundary (${label})`);
    }
  }

  return fs.realpathSync(mediaDir);
}

// ----------------------------------------------------------------------------
// Per-file Asynchronous Mutex
// ----------------------------------------------------------------------------

/**
 * FIFO Asynchronous Mutex implementation.
 * Ensures operations queue sequentially and run one at a time per lock key.
 */
class AsyncMutex {
  constructor() {
    this.queue = [];
    this.locked = false;
  }

  acquire() {
    return new Promise((resolve) => {
      const execute = () => {
        this.locked = true;
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          this.release();
        });
      };

      if (!this.locked) {
        execute();
      } else {
        this.queue.push(execute);
      }
    });
  }

  release() {
    if (this.queue.length > 0) {
      const next = this.queue.shift();
      next();
    } else {
      this.locked = false;
    }
  }
}

// Registry of active mutexes keyed by normalized file path
const fileMutexRegistry = new Map();

/**
 * Executes an asynchronous operation while holding an exclusive per-file mutex.
 * Guarantees FIFO execution for the same file, non-blocking execution across different files,
 * and unconditional lock release on both success and error.
 */
export async function withFileLock(filePath, operation) {
  const normalizedKey = path.resolve(filePath);

  let mutex = fileMutexRegistry.get(normalizedKey);
  if (!mutex) {
    mutex = new AsyncMutex();
    fileMutexRegistry.set(normalizedKey, mutex);
  }

  const release = await mutex.acquire();
  try {
    return await operation();
  } finally {
    release();
    if (!mutex.locked && mutex.queue.length === 0) {
      fileMutexRegistry.delete(normalizedKey);
    }
  }
}

/**
 * Returns current count of registered mutexes (useful for diagnostic tests).
 */
export function getActiveMutexCount() {
  return fileMutexRegistry.size;
}

// ----------------------------------------------------------------------------
// Atomic File Write
// ----------------------------------------------------------------------------

/**
 * Writes data atomically to the destination file.
 * 1. Creates a unique temporary file in the destination's directory.
 * 2. Writes full content and syncs to disk (fsync).
 * 3. Closes handle.
 * 4. Atomically replaces target file using fs.rename.
 * 5. Cleans up temporary file on any error, keeping original file intact.
 */
export async function atomicWriteFile(targetPath, content) {
  const dir = path.dirname(targetPath);
  await fs.promises.mkdir(dir, { recursive: true });

  const randomSuffix = crypto.randomBytes(8).toString('hex');
  const tempFileName = `.${path.basename(targetPath)}.${Date.now()}.${randomSuffix}.tmp`;
  const tempFilePath = path.join(dir, tempFileName);

  let handle = null;
  try {
    handle = await fs.promises.open(tempFilePath, 'w', 0o644);
    if (Buffer.isBuffer(content)) {
      await handle.writeFile(content);
    } else {
      await handle.writeFile(content, 'utf8');
    }
    await handle.sync(); // Force flush data to physical disk
    await handle.close();
    handle = null;

    // Atomic filesystem rename replaces target in a single operation
    await fs.promises.rename(tempFilePath, targetPath);
  } catch (err) {
    if (handle) {
      try {
        await handle.close();
      } catch {}
      handle = null;
    }
    try {
      await fs.promises.unlink(tempFilePath);
    } catch {}
    throw err;
  }
}

// ----------------------------------------------------------------------------
// Pre-write Backup and Rotation
// ----------------------------------------------------------------------------

/**
 * Creates a collision-safe pre-write backup of the original file if it exists,
 * and automatically rotates backups so that at most maxBackups are retained per file.
 */
export async function createPreWriteBackup(
  targetPath,
  backupKey,
  backupDir = path.resolve(DEFAULT_PROJECT_ROOT, BACKUP_DIR_NAME),
  maxBackups = MAX_BACKUPS_PER_FILE
) {
  let stat;
  try {
    stat = await fs.promises.stat(targetPath);
  } catch {
    // Original file does not exist yet; no pre-write backup needed
    return null;
  }

  // Ensure backup directory exists
  await fs.promises.mkdir(backupDir, { recursive: true });

  // Collision-safe filename: <backupKey>.<isoTimestamp>.<entropy>.bak
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const entropy = crypto.randomBytes(6).toString('hex');
  const backupFileName = `${backupKey}.${timestamp}.${entropy}.bak`;
  const backupFilePath = path.join(backupDir, backupFileName);

  // Copy existing original file to backup
  await fs.promises.copyFile(targetPath, backupFilePath);

  // Verify backup integrity
  const backupStat = await fs.promises.stat(backupFilePath);
  if (backupStat.size !== stat.size) {
    try {
      await fs.promises.unlink(backupFilePath);
    } catch {}
    throw new Error(`Backup copy integrity verification failed for ${backupKey}`);
  }

  // Enforce rotation: retain at most maxBackups for this backupKey
  await rotateBackups(backupKey, backupDir, maxBackups);

  return {
    backupFileName,
    backupFilePath,
    backupSize: backupStat.size,
  };
}

/**
 * Prunes backups for a given backupKey exceeding maxBackups, removing the oldest first.
 */
export async function rotateBackups(
  backupKey,
  backupDir = path.resolve(DEFAULT_PROJECT_ROOT, BACKUP_DIR_NAME),
  maxBackups = MAX_BACKUPS_PER_FILE
) {
  let entries;
  try {
    entries = await fs.promises.readdir(backupDir);
  } catch {
    return;
  }

  const prefix = `${backupKey}.`;
  const suffix = '.bak';
  const matching = entries.filter((f) => f.startsWith(prefix) && f.endsWith(suffix));

  if (matching.length <= maxBackups) {
    return;
  }

  // Collect metadata for sorting
  const withStats = await Promise.all(
    matching.map(async (name) => {
      const full = path.join(backupDir, name);
      try {
        const s = await fs.promises.stat(full);
        return { name, path: full, mtime: s.mtimeMs };
      } catch {
        return { name, path: full, mtime: 0 };
      }
    })
  );

  // Sort descending: newest first. Ties broken by chronological ISO timestamp in filename.
  withStats.sort((a, b) => b.mtime - a.mtime || b.name.localeCompare(a.name));

  const toRemove = withStats.slice(maxBackups);
  await Promise.all(
    toRemove.map(async (item) => {
      try {
        await fs.promises.unlink(item.path);
      } catch {}
    })
  );
}

// ----------------------------------------------------------------------------
// JSON Serialization Safety
// ----------------------------------------------------------------------------

/**
 * Serializes payload using JSON.stringify(data, null, 2) and verifies that the output
 * parses back to valid JSON before writing to disk.
 */
export function serializeAndVerifyJson(data) {
  if (data === undefined) {
    throw new TypeError('Invalid JSON data: payload cannot be undefined');
  }
  if (typeof data !== 'object' || data === null) {
    throw new TypeError('Invalid JSON data: payload must be a JSON object or array');
  }

  let serialized;
  try {
    serialized = JSON.stringify(data, null, 2);
  } catch (err) {
    throw new Error(`JSON serialization failed: ${err.message}`);
  }

  if (typeof serialized !== 'string' || !serialized.trim()) {
    throw new Error('JSON serialization produced empty or non-string output');
  }

  // Re-parse verification
  try {
    JSON.parse(serialized);
  } catch (err) {
    throw new Error(`Serialized JSON failed re-parse verification: ${err.message}`);
  }

  return serialized + '\n';
}

// ----------------------------------------------------------------------------
// Narrowly Scoped Transaction Snapshot Accessor
// ----------------------------------------------------------------------------

/**
 * Safe, narrowly scoped snapshot accessor passed to the transaction precondition callback.
 * Exposes only original file snapshots belonging to the current transaction.
 * Always returns copied bytes, preventing external mutation of internal snapshot buffers.
 * Does not expose arbitrary filesystem access or internal project paths.
 */
export class TransactionSnapshotAccessor {
  #snapshots;
  #targetMap;

  constructor(normalizedOps, snapshots) {
    this.#snapshots = snapshots;
    this.#targetMap = new Map();
    for (const op of normalizedOps) {
      if (op.sanitizedTarget) {
        this.#targetMap.set(op.sanitizedTarget, op.targetPath);
      }
      if (op.fileName) {
        this.#targetMap.set(op.fileName, op.targetPath);
      }
      if (op.slug) {
        this.#targetMap.set(op.slug, op.targetPath);
        this.#targetMap.set(`${op.slug}.md`, op.targetPath);
      }
      if (op.mediaFileName) {
        this.#targetMap.set(op.mediaFileName, op.targetPath);
        this.#targetMap.set(`images/media/${op.mediaFileName}`, op.targetPath);
      }
    }
  }

  #resolvePath(identifier) {
    if (typeof identifier !== 'string') return null;
    const trimmed = identifier.trim();
    return this.#targetMap.get(trimmed) || null;
  }

  has(identifier) {
    return this.#resolvePath(identifier) !== null;
  }

  hasSnapshot(identifier) {
    return this.has(identifier);
  }

  get(identifier) {
    const targetPath = this.#resolvePath(identifier);
    if (!targetPath) return null;
    const internal = this.#snapshots.get(targetPath);
    if (!internal) return null;

    // Return fresh copied bytes, never a mutable reference to internal snapshot buffer
    const bytesCopy = internal.originalBytes ? Buffer.from(internal.originalBytes) : null;

    return Object.freeze({
      target: internal.sanitizedTarget,
      sanitizedTarget: internal.sanitizedTarget,
      existed: internal.existed,
      size: internal.size,
      mode: internal.mode,
      bytes: bytesCopy,
      getText: () => (internal.originalBytes ? internal.originalBytes.toString('utf8') : null),
      getJson: () => {
        if (!internal.originalBytes) return null;
        try {
          return JSON.parse(internal.originalBytes.toString('utf8'));
        } catch (err) {
          throw new TransactionError(
            `Failed to parse snapshot JSON for "${internal.sanitizedTarget}": ${err.message}`,
            { code: 'INVALID_ORIGINAL_JSON' }
          );
        }
      },
    });
  }

  getSnapshot(identifier) {
    return this.get(identifier);
  }

  getBytes(identifier) {
    const snap = this.get(identifier);
    return snap && snap.bytes ? Buffer.from(snap.bytes) : null;
  }

  getSnapshotBytes(identifier) {
    return this.getBytes(identifier);
  }

  getText(identifier) {
    const snap = this.get(identifier);
    return snap ? snap.getText() : null;
  }

  getSnapshotText(identifier) {
    return this.getText(identifier);
  }

  getJson(identifier) {
    const snap = this.get(identifier);
    return snap ? snap.getJson() : null;
  }

  getSnapshotJson(identifier) {
    return this.getJson(identifier);
  }

  listTargets() {
    return Array.from(new Set(this.#targetMap.keys())).sort();
  }
}

// ----------------------------------------------------------------------------
// High-Level Secure Storage Engine Class & Factory
// ----------------------------------------------------------------------------

export class SecureStorageEngine {
  constructor(options = {}) {
    this.projectRoot = path.resolve(options.projectRoot || DEFAULT_PROJECT_ROOT);
    this.backupDir = path.resolve(this.projectRoot, options.backupDirName || BACKUP_DIR_NAME);
    this.maxBackups = options.maxBackups || MAX_BACKUPS_PER_FILE;
  }

  /**
   * Loads trusted category data from authorized project content store.
   * Fails closed by returning null if category store is missing, empty, malformed, or unavailable.
   */
  async loadTrustedCategories(pendingCategories = null) {
    let categories = pendingCategories;

    if (!categories) {
      try {
        const categoriesPath = resolveSecureJsonPath('categories.json', this.projectRoot);
        let stat = null;
        try {
          stat = await fs.promises.lstat(categoriesPath);
        } catch {
          return null;
        }
        if (!stat || stat.isSymbolicLink() || !stat.isFile()) {
          return null;
        }
        const raw = await fs.promises.readFile(categoriesPath, 'utf8');
        categories = JSON.parse(raw);
      } catch {
        return null;
      }
    }

    if (!Array.isArray(categories) || categories.length === 0) {
      return null;
    }

    const validSlugs = new Set();
    for (const item of categories) {
      if (typeof item === 'string' && isValidCategorySlug(item)) {
        validSlugs.add(item);
      } else if (
        item &&
        typeof item === 'object' &&
        typeof item.slug === 'string' &&
        isValidCategorySlug(item.slug)
      ) {
        validSlugs.add(item.slug);
      }
    }

    if (validSlugs.size === 0) {
      return null;
    }

    return categories;
  }

  /**
   * Safely reads and parses an allowlisted JSON content file.
   * For pages.json, enforces complete store schema validation on read (fail-closed).
   */
  async readJson(fileName) {
    const targetPath = resolveSecureJsonPath(fileName, this.projectRoot);
    const raw = await fs.promises.readFile(targetPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (fileName === 'pages.json') {
      const valResult = validatePages(parsed, { projectRoot: this.projectRoot });
      if (!valResult.isValid) {
        const detail = (valResult.errors || [])
          .map((e) => `${e.field}: ${e.message}`)
          .join(', ');
        throw new TransactionError(`Schema validation failed for pages.json: ${detail}`, {
          code: 'SCHEMA_VALIDATION_FAILED',
        });
      }
    }
    if (fileName === 'media.json') {
      const valResult = validateMediaLibrary(parsed, { projectRoot: this.projectRoot });
      if (!valResult.isValid) {
        const detail = (valResult.errors || [])
          .map((e) => `${e.field}: ${e.message}`)
          .join(', ');
        throw new TransactionError(`Schema validation failed for media.json: ${detail}`, {
          code: 'SCHEMA_VALIDATION_FAILED',
        });
      }
    }
    return parsed;
  }

  /**
   * Safely writes data to an allowlisted JSON content file.
   * Enforces:
   * 1. Allowlist verification
   * 2. Canonical path safety
   * 3. Mandatory JSON schema validation (cannot be bypassed)
   * 4. JSON serialization and re-parse validation
   * 5. Per-file FIFO asynchronous mutex
   * 6. Pre-write backup with rotation (max 20)
   * 7. Atomic write with fsync and cleanup on failure
   */
  async writeJson(fileName, data, options = {}) {
    validateJsonFileName(fileName);

    if (options !== undefined && options !== null) {
      if (typeof options !== 'object' || Array.isArray(options)) {
        throw new TransactionError('Write options must be an object', {
          code: 'INVALID_OPTIONS',
        });
      }
      if (options.validateSchema !== undefined && typeof options.validateSchema !== 'boolean') {
        throw new TransactionError('Invalid validateSchema option: must be a boolean', {
          code: 'INVALID_OPTIONS',
        });
      }
      if (options.isCmsInput !== undefined && typeof options.isCmsInput !== 'boolean') {
        throw new TransactionError('Invalid isCmsInput option: must be a boolean', {
          code: 'INVALID_OPTIONS',
        });
      }
      if (options.categories !== undefined && !Array.isArray(options.categories)) {
        throw new TransactionError('Invalid categories option: must be an array', {
          code: 'INVALID_OPTIONS',
        });
      }
      if (options.projectRoot !== undefined && typeof options.projectRoot !== 'string') {
        throw new TransactionError('Invalid projectRoot option: must be a string', {
          code: 'INVALID_OPTIONS',
        });
      }
      if (options.precondition !== undefined && typeof options.precondition !== 'function') {
        throw new TransactionError('Invalid precondition option: must be a function', {
          code: 'INVALID_OPTIONS',
        });
      }
    }

    if (typeof data === 'function' || (options && options.precondition !== undefined)) {
      const txRes = await this.executeTransaction([{ type: 'writeJson', fileName, data }], options);
      const r = txRes.results[0];
      return {
        success: true,
        fileName,
        filePath: resolveSecureJsonPath(fileName, this.projectRoot),
        bytesWritten: r.bytesWritten,
        backupCreated: r.backupCreated,
        backupFileName: r.backupFileName,
      };
    }

    const targetPath = resolveSecureJsonPath(fileName, this.projectRoot);

    let parsedData = data;
    if (typeof data === 'string') {
      try {
        parsedData = JSON.parse(data);
      } catch (err) {
        throw new TransactionError(`Invalid JSON data for ${fileName}: ${err.message}`, {
          code: 'INVALID_JSON',
        });
      }
    }

    // Mandatory schema validation for every JSON write
    const validator = SCHEMA_VALIDATORS[fileName];
    if (!validator) {
      throw new TransactionError(`No schema validator found for JSON file: ${fileName}`, {
        code: 'NO_VALIDATOR',
      });
    }

    // Category referential integrity must be established for articles and tools
    let trustedCategories = null;
    if (fileName === 'articles.json' || fileName === 'tools.json') {
      trustedCategories = await this.loadTrustedCategories();
      if (!trustedCategories) {
        throw new TransactionError(
          'Category referential integrity cannot be established: category store is empty, missing, malformed, or unavailable',
          { code: 'CATEGORY_INTEGRITY_UNAVAILABLE' }
        );
      }
    }

    // Define one immutable, trusted validation context (never merge arbitrary caller options)
    const trustedValidationContext = Object.freeze({
      projectRoot: this.projectRoot,
      categories: trustedCategories,
      isCmsInput: false,
    });

    // Enforce stored article invariants strictly before any mutation
    if (fileName === 'articles.json') {
      if (!Array.isArray(parsedData)) {
        throw new TransactionError('Articles payload must be a JSON array', {
          code: 'SCHEMA_VALIDATION_FAILED',
        });
      }
      for (let i = 0; i < parsedData.length; i++) {
        const article = parsedData[i];
        if (!article || typeof article !== 'object') continue;
        const expectedContentPath = `content/articles/${article.slug}.md`;
        if (!article.contentPath || article.contentPath !== expectedContentPath) {
          throw new TransactionError(
            `Stored article "${article.slug || i}" must contain server-generated contentPath "${expectedContentPath}"`,
            { code: 'SCHEMA_VALIDATION_FAILED' }
          );
        }
      }
    }

    const valResult = validator(parsedData, trustedValidationContext);
    if (!valResult.isValid) {
      const detail = (valResult.errors || [])
        .map((e) => `${e.field}: ${e.message}`)
        .join(', ');
      throw new TransactionError(
        `Schema validation failed for ${fileName}: ${detail}`,
        { code: 'SCHEMA_VALIDATION_FAILED' }
      );
    }

    const serialized = serializeAndVerifyJson(parsedData);

    return await withFileLock(targetPath, async () => {
      const backupResult = await createPreWriteBackup(
        targetPath,
        fileName,
        this.backupDir,
        this.maxBackups
      );

      await atomicWriteFile(targetPath, serialized);

      return {
        success: true,
        fileName,
        filePath: targetPath,
        bytesWritten: Buffer.byteLength(serialized, 'utf8'),
        backupCreated: Boolean(backupResult),
        backupFileName: backupResult?.backupFileName || null,
      };
    });
  }

  /**
   * JSON store deletion is permanently disabled.
   * Calling this throws a TransactionError.
   */
  async deleteJson() {
    throw new TransactionError(
      'JSON store deletion is completely disabled; JSON content stores cannot be deleted',
      { code: 'FORBIDDEN_OPERATION' }
    );
  }

  /**
   * Safely reads an article Markdown file by validated slug.
   */
  async readArticleMarkdown(slug) {
    const targetPath = resolveSecureMarkdownPath(slug, this.projectRoot);
    return await fs.promises.readFile(targetPath, 'utf8');
  }

  /**
   * Safely writes an article Markdown file by validated slug.
   * Enforces:
   * 1. Slug validation (strict alphanumeric, hyphens, underscores, no traversal)
   * 2. Canonical path safety inside content/articles/
   * 3. String content validation
   * 4. Per-file FIFO asynchronous mutex
   * 5. Pre-write backup with rotation (max 20)
   * 6. Atomic write with fsync and cleanup on failure
   */
  async writeArticleMarkdown(slug, markdownContent) {
    if (typeof markdownContent !== 'string') {
      throw new TypeError('Markdown content must be a string');
    }

    const targetPath = resolveSecureMarkdownPath(slug, this.projectRoot);
    const backupKey = `article_${slug}.md`;

    return await withFileLock(targetPath, async () => {
      const backupResult = await createPreWriteBackup(
        targetPath,
        backupKey,
        this.backupDir,
        this.maxBackups
      );

      await atomicWriteFile(targetPath, markdownContent);

      return {
        success: true,
        slug,
        filePath: targetPath,
        bytesWritten: Buffer.byteLength(markdownContent, 'utf8'),
        backupCreated: Boolean(backupResult),
        backupFileName: backupResult?.backupFileName || null,
      };
    });
  }

  /**
   * Safely deletes an article Markdown file by validated slug.
   * Enforces:
   * 1. Slug validation via canonical isValidArticleSlug
   * 2. Canonical path resolution exclusively under content/articles/${slug}.md
   * 3. Path-jail, symlink, and regular-file verification (rejects symlinks, directories, non-regular files)
   * 4. Per-file FIFO asynchronous mutex
   * 5. Structured not-found result if target file does not exist (no file or directory creation)
   * 6. Recoverable backup creation and verification before deletion
   * 7. Original file preservation if backup creation or verification fails
   * 8. Safe file unlinking with zero absolute path exposure in results or errors
   *
   * @param {string} slug - The article slug to delete.
   * @returns {Promise<object>} Structured result object.
   */
  async deleteArticleMarkdown(slug) {
    const targetPath = resolveSecureMarkdownPath(slug, this.projectRoot);
    const backupKey = `article_${slug}.md`;

    return await withFileLock(targetPath, async () => {
      let stat;
      try {
        stat = await fs.promises.lstat(targetPath);
      } catch (err) {
        if (err && err.code === 'ENOENT') {
          return {
            success: false,
            notFound: true,
            deleted: false,
            slug,
            message: `Article markdown file not found for slug: ${slug}`,
          };
        }
        throw new Error(
          sanitizeErrorMessage(`Failed to inspect file for slug "${slug}": ${err?.code || 'UNKNOWN'}`)
        );
      }

      if (stat.isSymbolicLink()) {
        throw new Error('Symlinks are forbidden for CMS storage');
      }
      if (stat.isDirectory()) {
        throw new Error('Cannot delete: target is a directory, not a regular file');
      }
      if (!stat.isFile()) {
        throw new Error('Cannot delete: target is not a regular file');
      }

      // Create and verify a recoverable backup using the existing backup mechanism
      let backupResult;
      try {
        backupResult = await createPreWriteBackup(
          targetPath,
          backupKey,
          this.backupDir,
          this.maxBackups
        );
      } catch (err) {
        throw new Error(
          sanitizeErrorMessage(`Backup creation failed for article "${slug}": ${err?.message || 'unknown error'}`)
        );
      }

      if (!backupResult || !backupResult.backupFilePath || !backupResult.backupFileName) {
        throw new Error(`Backup creation failed for article "${slug}"`);
      }

      let backupStat;
      try {
        backupStat = await fs.promises.stat(backupResult.backupFilePath);
      } catch {
        throw new Error(
          sanitizeErrorMessage(`Backup verification failed: cannot access backup file for article "${slug}"`)
        );
      }

      if (!backupStat.isFile() || backupStat.size !== stat.size) {
        throw new Error(`Backup verification failed: size mismatch for article "${slug}"`);
      }

      try {
        const [origBuf, backupBuf] = await Promise.all([
          fs.promises.readFile(targetPath),
          fs.promises.readFile(backupResult.backupFilePath),
        ]);
        if (!origBuf.equals(backupBuf)) {
          throw new Error(`Backup verification failed: content mismatch for article "${slug}"`);
        }
      } catch (err) {
        if (err.message?.startsWith('Backup verification failed')) {
          throw err;
        }
        throw new Error(
          sanitizeErrorMessage(`Backup verification failed for article "${slug}": ${err?.message || 'read error'}`)
        );
      }

      // Delete only the verified target Markdown file
      try {
        await fs.promises.unlink(targetPath);
      } catch (err) {
        throw new Error(
          sanitizeErrorMessage(`Failed to delete article markdown file for slug "${slug}": ${err?.code || 'UNKNOWN'}`)
        );
      }

      return {
        success: true,
        deleted: true,
        slug,
        backupCreated: true,
        backupFileName: backupResult.backupFileName,
        backupReference: backupResult.backupFileName,
      };
    });
  }

  /**
   * Safely lists all existing article slugs in content/articles/.
   * Only returns files whose slugs pass validation.
   */
  async listArticles() {
    const contentDir = path.resolve(this.projectRoot, 'content');
    const articlesDir = path.resolve(contentDir, 'articles');
    if (!fs.existsSync(articlesDir)) {
      return [];
    }

    const entries = await fs.promises.readdir(articlesDir, { withFileTypes: true });
    const slugs = [];

    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.md') && !entry.name.startsWith('.')) {
        const slug = entry.name.slice(0, -3);
        try {
          validateArticleSlug(slug);
          slugs.push(slug);
        } catch {
          // Ignore invalid files
        }
      }
    }

    return slugs.sort();
  }

  /**
   * Lists existing backups for an allowed JSON file or article slug.
   */
  async listBackups(fileKey) {
    if (!fs.existsSync(this.backupDir)) {
      return [];
    }

    const entries = await fs.promises.readdir(this.backupDir);
    const prefix = `${fileKey}.`;
    const suffix = '.bak';

    const matching = entries.filter((f) => f.startsWith(prefix) && f.endsWith(suffix));
    const results = await Promise.all(
      matching.map(async (name) => {
        const full = path.join(this.backupDir, name);
        try {
          const s = await fs.promises.stat(full);
          return {
            name,
            path: full,
            size: s.size,
            createdAt: new Date(s.mtimeMs).toISOString(),
          };
        } catch {
          return null;
        }
      })
    );

    return results.filter(Boolean).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /**
   * Executes a safe multi-file transaction across allowlisted CMS files with automatic rollback.
   *
   * Design & Architectural Guarantees:
   * 1. Path Safety & Strict Allowlist:
   *    Accepts only bounded operations targeting strictly allowlisted CMS files (ALLOWED_JSON_FILES
   *    in /content or canonical article markdown in /content/articles/<slug>.md).
   *    Arbitrary filesystem paths, symlinks, directory traversal, and non-regular files are rejected.
   * 2. Validation Policy:
   *    - Storage-layer protections (path validation, boundary check, symlink rejection, JSON
   *      serializability, and regular-file checks) are unconditionally enforced.
   *    - Content schema validation (via validators.mjs) can be invoked by setting `validateSchema: true`
   *      in options or on individual operations. By default, the engine accepts pre-validated data objects.
   * 3. Deterministic Deadlock-Free Locking:
   *    Acquires exclusive per-file AsyncMutex locks for all target files in a globally deterministic,
   *    lexicographically sorted order of canonical path keys.
   *    Every acquired lock is guaranteed to be released in reverse order in all scenarios (success,
   *    validation error, backup failure, mutation exception, or rollback).
   * 4. Pre-write Snapshot & Backup Verification:
   *    Under the exclusive locks, snapshots exact byte contents and metadata of all target files.
   *    Creates and byte-for-byte verifies pre-write backups of all existing target files before
   *    applying ANY mutation. If backup creation or verification fails, the transaction aborts
   *    immediately with zero mutations applied.
   * 5. Atomic Operations:
   *    Writes use atomicWriteFile (temp file + fsync + atomic rename).
   *    Deletions use safe allowlisted target unlinking under lock.
   * 6. Comprehensive Rollback & Recovery:
   *    If any mutation fails, automatic rollback is executed for all targets:
   *    - Existing files are restored to their exact pre-transaction byte contents.
   *    - Files created during the transaction are unlinked.
   *    - Symlinks and non-regular files are never overwritten during rollback.
   *    - If rollback itself fails, all backups are preserved and a distinct
   *      TransactionRecoveryRequiredError is thrown (never reporting an ordinary successful rollback).
   * 7. Path Sanitization:
   *    Zero absolute filesystem paths are exposed in results or error messages.
   *
   * @param {Array<object>} operations - List of file operations to execute in transaction.
   * @param {object} [options] - Optional transaction options.
   * @param {number} [options.maxOperations=MAX_TRANSACTION_OPERATIONS] - Maximum allowed operations.
   * @param {boolean} [options.validateSchema=false] - Whether to validate JSON against validators.mjs.
   * @param {boolean} [options._simulateBackupFailure=false] - Test hook: simulate backup creation failure.
   * @param {number} [options._simulateMutationFailureAtIndex=-1] - Test hook: simulate mutation failure at index.
   * @param {boolean} [options._simulateRollbackFailure=false] - Test hook: simulate rollback failure.
   * @param {Array<string>} [options._lockAcquisitionOrder] - Diagnostic hook to record lock acquisition order.
   * @param {Array<string>} [options._lockReleaseOrder] - Diagnostic hook to record lock release order.
   * @returns {Promise<object>} Structured result object.
   */
  async executeTransaction(operations, options = {}) {
    if (!Array.isArray(operations) || operations.length === 0) {
      throw new TransactionError('Transaction operations list must be a non-empty array', {
        code: 'EMPTY_OPERATIONS',
      });
    }

    let effectiveMax = MAX_TRANSACTION_OPERATIONS;

    if (options !== undefined && options !== null) {
      if (typeof options !== 'object' || Array.isArray(options)) {
        throw new TransactionError('Transaction options must be an object', {
          code: 'INVALID_OPTIONS',
        });
      }

      if (options.maxOperations !== undefined) {
        if (
          typeof options.maxOperations !== 'number' ||
          !Number.isFinite(options.maxOperations) ||
          !Number.isSafeInteger(options.maxOperations) ||
          options.maxOperations <= 0
        ) {
          throw new TransactionError(
            'Invalid maxOperations option: must be a positive safe integer',
            { code: 'INVALID_OPTIONS' }
          );
        }
        effectiveMax = Math.min(MAX_TRANSACTION_OPERATIONS, options.maxOperations);
      }

      if (options.validateSchema !== undefined && typeof options.validateSchema !== 'boolean') {
        throw new TransactionError('Invalid validateSchema option: must be a boolean', {
          code: 'INVALID_OPTIONS',
        });
      }
      if (options.isCmsInput !== undefined && typeof options.isCmsInput !== 'boolean') {
        throw new TransactionError('Invalid isCmsInput option: must be a boolean', {
          code: 'INVALID_OPTIONS',
        });
      }
      if (options.categories !== undefined && !Array.isArray(options.categories)) {
        throw new TransactionError('Invalid categories option: must be an array', {
          code: 'INVALID_OPTIONS',
        });
      }
      if (options.projectRoot !== undefined && typeof options.projectRoot !== 'string') {
        throw new TransactionError('Invalid projectRoot option: must be a string', {
          code: 'INVALID_OPTIONS',
        });
      }
      if (options.precondition !== undefined && typeof options.precondition !== 'function') {
        throw new TransactionError('Invalid precondition option: must be a function', {
          code: 'INVALID_OPTIONS',
        });
      }
    }

    if (operations.length > effectiveMax) {
      throw new TransactionError(
        `Transaction operations list exceeds maximum allowed limit of ${effectiveMax} operations (received ${operations.length})`,
        { code: 'MAX_OPERATIONS_EXCEEDED' }
      );
    }

    // Check operation-level options and reject conflicting options
    for (let i = 0; i < operations.length; i++) {
      const op = operations[i];
      if (!op || typeof op !== 'object' || Array.isArray(op)) {
        throw new TransactionError('Transaction operation must be a non-null object', {
          code: 'INVALID_OPERATION',
        });
      }

      if (op.validateSchema !== undefined && typeof op.validateSchema !== 'boolean') {
        throw new TransactionError('Invalid validateSchema option: must be a boolean', {
          code: 'INVALID_OPTIONS',
        });
      }
      if (op.isCmsInput !== undefined && typeof op.isCmsInput !== 'boolean') {
        throw new TransactionError('Invalid isCmsInput option: must be a boolean', {
          code: 'INVALID_OPTIONS',
        });
      }
      if (op.categories !== undefined && !Array.isArray(op.categories)) {
        throw new TransactionError('Invalid categories option: must be an array', {
          code: 'INVALID_OPTIONS',
        });
      }
      if (op.projectRoot !== undefined && typeof op.projectRoot !== 'string') {
        throw new TransactionError('Invalid projectRoot option: must be a string', {
          code: 'INVALID_OPTIONS',
        });
      }

      // Check conflicting options between transaction and operation
      if (
        options &&
        options.validateSchema !== undefined &&
        op.validateSchema !== undefined &&
        options.validateSchema !== op.validateSchema
      ) {
        throw new TransactionError(
          'Conflicting validateSchema options between transaction and operation',
          { code: 'INVALID_OPTIONS' }
        );
      }
      if (
        options &&
        options.isCmsInput !== undefined &&
        op.isCmsInput !== undefined &&
        options.isCmsInput !== op.isCmsInput
      ) {
        throw new TransactionError(
          'Conflicting isCmsInput options between transaction and operation',
          { code: 'INVALID_OPTIONS' }
        );
      }
      if (
        options &&
        options.projectRoot !== undefined &&
        op.projectRoot !== undefined &&
        options.projectRoot !== op.projectRoot
      ) {
        throw new TransactionError(
          'Conflicting projectRoot options between transaction and operation',
          { code: 'INVALID_OPTIONS' }
        );
      }
      if (
        options &&
        options.categories !== undefined &&
        op.categories !== undefined &&
        options.categories !== op.categories
      ) {
        throw new TransactionError(
          'Conflicting categories options between transaction and operation',
          { code: 'INVALID_OPTIONS' }
        );
      }
    }

    // Inspect if transaction reads or writes categories.json, or writes articles.json / tools.json
    let pendingCategoriesData = null;
    let hasDynamicCategories = false;
    let hasReadCategories = false;
    let hasWriteCategories = false;
    let hasWriteArticlesOrTools = false;
    for (const op of operations) {
      const rawType = String(op.type || op.action || '').trim().toLowerCase();
      const target = op.fileName || op.file || op.target;
      const isCategories = target === 'categories.json';
      const isRead =
        rawType === 'readjson' ||
        rawType === 'read_json' ||
        (rawType === 'read' && isCategories);
      const isWrite =
        rawType === 'writejson' ||
        rawType === 'write_json' ||
        (rawType === 'write' && isCategories);

      if (
        (rawType === 'writejson' || rawType === 'write_json' || rawType === 'write') &&
        (target === 'articles.json' || target === 'tools.json')
      ) {
        hasWriteArticlesOrTools = true;
      }

      if (isRead && isCategories) {
        hasReadCategories = true;
      } else if (isWrite && isCategories) {
        hasWriteCategories = true;
        const rawData = op.data !== undefined ? op.data : op.content;
        if (typeof rawData === 'function') {
          hasDynamicCategories = true;
        } else {
          let parsed = rawData;
          if (typeof rawData === 'string') {
            try {
              parsed = JSON.parse(rawData);
            } catch (err) {
              throw new TransactionError(`Invalid JSON data for categories.json: ${err.message}`, {
                code: 'INVALID_JSON',
              });
            }
          }
          const valRes = validateCategories(parsed, { projectRoot: this.projectRoot });
          if (!valRes.isValid) {
            const detail = (valRes.errors || []).map((e) => `${e.field}: ${e.message}`).join(', ');
            throw new TransactionError(`Schema validation failed for categories.json: ${detail}`, {
              code: 'SCHEMA_VALIDATION_FAILED',
            });
          }
          pendingCategoriesData = parsed;
        }
      }
    }

    const deferCategoryValidation = hasReadCategories || hasDynamicCategories;

    // When categories.json is locked in this transaction (via readJson or dynamic writeJson),
    // never read categories.json from disk pre-lock; resolve trustedCategories from the locked
    // snapshot / dynamic result under lock instead.
    let trustedCategories = deferCategoryValidation
      ? null
      : await this.loadTrustedCategories(hasWriteCategories ? pendingCategoriesData : null);

    if (hasWriteArticlesOrTools && !trustedCategories && !deferCategoryValidation) {
      throw new TransactionError(
        'Category referential integrity cannot be established: category store is empty, missing, malformed, or unavailable',
        { code: 'CATEGORY_INTEGRITY_UNAVAILABLE' }
      );
    }

    // Define one immutable, trusted validation context
    const trustedValidationContext = Object.freeze({
      projectRoot: this.projectRoot,
      categories: trustedCategories,
      isCmsInput: false,
    });

    // 1. Normalize and validate all operations against allowlist and path boundary
    const normalizedOps = operations.map((op) =>
      normalizeTransactionOperation(op, this.projectRoot, trustedValidationContext, options, {
        deferCategoryValidation,
      })
    );

    const writesArticlesOrTools = normalizedOps.some(
      (op) =>
        op.action === 'write' &&
        (op.sanitizedTarget === 'articles.json' || op.sanitizedTarget === 'tools.json')
    );

    if (writesArticlesOrTools && !trustedCategories && !deferCategoryValidation) {
      throw new TransactionError(
        'Category referential integrity cannot be established: category store is empty, missing, malformed, or unavailable',
        { code: 'CATEGORY_INTEGRITY_UNAVAILABLE' }
      );
    }

    // 2. Reject duplicate target files in the same transaction
    const seenTargets = new Map();
    for (let i = 0; i < normalizedOps.length; i++) {
      const normKey = path.resolve(normalizedOps[i].targetPath);
      if (seenTargets.has(normKey)) {
        const prevIdx = seenTargets.get(normKey);
        throw new TransactionError(
          `Duplicate target file in transaction: "${normalizedOps[i].sanitizedTarget}" (operations [${prevIdx}] and [${i}])`,
          { code: 'DUPLICATE_TARGET' }
        );
      }
      seenTargets.set(normKey, i);
    }

    // 3. Acquire locks in globally deterministic, sorted order to prevent deadlocks
    const sortedLockKeys = Array.from(seenTargets.keys()).sort((a, b) => a.localeCompare(b));
    const acquiredLocks = [];

    try {
      for (const lockKey of sortedLockKeys) {
        let mutex = fileMutexRegistry.get(lockKey);
        if (!mutex) {
          mutex = new AsyncMutex();
          fileMutexRegistry.set(lockKey, mutex);
        }
        if (options._lockAcquisitionOrder) {
          options._lockAcquisitionOrder.push(lockKey);
        }
        const releaseFn = await mutex.acquire();
        acquiredLocks.push({
          lockKey,
          mutex,
          release: () => {
            if (options._lockReleaseOrder) {
              options._lockReleaseOrder.push(lockKey);
            }
            releaseFn();
            if (!mutex.locked && mutex.queue.length === 0) {
              fileMutexRegistry.delete(lockKey);
            }
          },
        });
      }

      // 4. Snapshot state under lock: exact bytes, metadata, or record non-existence
      const snapshots = new Map();
      for (const op of normalizedOps) {
        if (op.kind === 'media') {
          try {
            if (op.action === 'write') {
              ensureSecureMediaDirectory(this.projectRoot, { createIfMissing: true });
            }
            const verifiedPath = resolveSecureMediaPath(op.mediaFileName, this.projectRoot);
            if (verifiedPath !== op.targetPath) {
              throw new Error(`Resolved path mismatch for "${op.sanitizedTarget}"`);
            }
          } catch (err) {
            const isSymlink = err?.message && err.message.toLowerCase().includes('symlink');
            throw new TransactionError(sanitizeErrorMessage(err?.message || 'Media path check failed'), {
              code: isSymlink ? 'FORBIDDEN_SYMLINK' : 'PATH_VALIDATION_FAILED',
            });
          }
        }
        let stat = null;
        try {
          stat = await fs.promises.lstat(op.targetPath);
        } catch (err) {
          if (err && err.code === 'ENOENT') {
            stat = null;
          } else {
            throw new TransactionError(
              sanitizeErrorMessage(
                `Failed to inspect target "${op.sanitizedTarget}": ${err?.message || 'unknown error'}`
              ),
              { code: 'INSPECT_FAILED' }
            );
          }
        }

        if (stat === null) {
          snapshots.set(op.targetPath, {
            targetPath: op.targetPath,
            sanitizedTarget: op.sanitizedTarget,
            backupKey: op.backupKey,
            existed: false,
            originalBytes: null,
            mode: null,
            size: 0,
          });
        } else {
          if (stat.isSymbolicLink()) {
            throw new TransactionError(
              `Symlinks are forbidden for CMS storage: "${op.sanitizedTarget}"`,
              { code: 'FORBIDDEN_SYMLINK' }
            );
          }
          if (stat.isDirectory()) {
            throw new TransactionError(
              `Target is a directory, not a regular file: "${op.sanitizedTarget}"`,
              { code: 'TARGET_IS_DIRECTORY' }
            );
          }
          if (!stat.isFile()) {
            throw new TransactionError(
              `Target is not a regular file: "${op.sanitizedTarget}"`,
              { code: 'NOT_REGULAR_FILE' }
            );
          }

          const originalBytes = await fs.promises.readFile(op.targetPath);
          snapshots.set(op.targetPath, {
            targetPath: op.targetPath,
            sanitizedTarget: op.sanitizedTarget,
            backupKey: op.backupKey,
            existed: true,
            originalBytes,
            mode: stat.mode,
            size: stat.size,
          });
        }
      }

      // 4. Validate locked pages.json read snapshots fail-closed before precondition/consumers
      for (const op of normalizedOps) {
        if (op.action === 'read' && op.fileName === 'pages.json') {
          const snap = snapshots.get(op.targetPath);
          if (!snap || !snap.existed || !snap.originalBytes) {
            throw new TransactionError('Custom pages store (pages.json) is missing or unavailable', {
              code: 'STORE_INTEGRITY_UNAVAILABLE',
            });
          }
          let parsedPages;
          try {
            parsedPages = JSON.parse(snap.originalBytes.toString('utf8'));
          } catch (parseErr) {
            throw new TransactionError(
              `Custom pages store contains malformed JSON: ${parseErr.message}`,
              { code: 'INVALID_ORIGINAL_JSON' }
            );
          }
          const pagesVal = validatePages(parsedPages, { projectRoot: this.projectRoot });
          if (!pagesVal.isValid) {
            const detail = (pagesVal.errors || [])
              .map((e) => `${e.field}: ${e.message}`)
              .join(', ');
            throw new TransactionError(`Schema validation failed for pages.json: ${detail}`, {
              code: 'SCHEMA_VALIDATION_FAILED',
            });
          }
        }
        if (op.action === 'read' && op.fileName === 'media.json') {
          const snap = snapshots.get(op.targetPath);
          if (!snap || !snap.existed || !snap.originalBytes) {
            throw new TransactionError('Media library store (media.json) is missing or unavailable', {
              code: 'STORE_INTEGRITY_UNAVAILABLE',
            });
          }
          let parsedMedia;
          try {
            parsedMedia = JSON.parse(snap.originalBytes.toString('utf8'));
          } catch (parseErr) {
            throw new TransactionError(
              `Media library store contains malformed JSON: ${parseErr.message}`,
              { code: 'INVALID_ORIGINAL_JSON' }
            );
          }
          const mediaVal = validateMediaLibrary(parsedMedia, { projectRoot: this.projectRoot });
          if (!mediaVal.isValid) {
            const detail = (mediaVal.errors || [])
              .map((e) => `${e.field}: ${e.message}`)
              .join(', ');
            throw new TransactionError(`Schema validation failed for media.json: ${detail}`, {
              code: 'SCHEMA_VALIDATION_FAILED',
            });
          }
        }
      }

      // 5. Run optional precondition hook under locks with snapshot accessor
      if (options.precondition !== undefined) {
        const snapshotAccessor = new TransactionSnapshotAccessor(normalizedOps, snapshots);
        try {
          await options.precondition(snapshotAccessor);
        } catch (err) {
          if (err instanceof TransactionError || err instanceof TransactionRecoveryRequiredError) {
            throw err;
          }
          const sanitizedMsg = sanitizeErrorMessage(err?.message || 'Precondition check failed');
          throw new TransactionError(`Transaction precondition failed: ${sanitizedMsg}`, {
            code: err?.code || 'PRECONDITION_FAILED',
            originalError: err,
          });
        }
      }

      // 5. Resolve dynamic JSON updates from snapshots collected under lock
      for (const op of normalizedOps) {
        if (!op.isDynamic) continue;

        const snapshot = snapshots.get(op.targetPath);
        if (!snapshot || !snapshot.existed || !snapshot.originalBytes) {
          throw new TransactionError(
            `Cannot apply dynamic JSON update: target file "${op.sanitizedTarget}" does not exist`,
            { code: 'TARGET_NOT_FOUND' }
          );
        }

        let existingData;
        try {
          existingData = JSON.parse(snapshot.originalBytes.toString('utf8'));
        } catch (parseErr) {
          throw new TransactionError(
            `Cannot apply dynamic JSON update: target file "${op.sanitizedTarget}" contains malformed JSON: ${parseErr.message}`,
            { code: 'INVALID_ORIGINAL_JSON' }
          );
        }

        if (typeof existingData !== 'object' || existingData === null) {
          throw new TransactionError(
            `Cannot apply dynamic JSON update: target file "${op.sanitizedTarget}" contains invalid JSON root data`,
            { code: 'INVALID_ORIGINAL_JSON' }
          );
        }

        let updatedData;
        try {
          const clonedInput = structuredClone(existingData);
          updatedData = await op.dataProducer(clonedInput);
        } catch (err) {
          if (err instanceof TransactionError || err instanceof TransactionRecoveryRequiredError) {
            throw err;
          }
          const sanitizedMsg = sanitizeErrorMessage(err?.message || 'Dynamic data generation failed');
          throw new TransactionError(
            `Dynamic data generation failed for "${op.sanitizedTarget}": ${sanitizedMsg}`,
            { code: err?.code || 'DYNAMIC_DATA_ERROR', originalError: err }
          );
        }

        if (updatedData === undefined) {
          throw new TransactionError(
            `Dynamic data function for "${op.sanitizedTarget}" returned undefined`,
            { code: 'INVALID_DATA' }
          );
        }

        let parsedUpdatedData = updatedData;
        if (typeof updatedData === 'string') {
          try {
            parsedUpdatedData = JSON.parse(updatedData);
          } catch (err) {
            throw new TransactionError(
              `Invalid JSON data returned for ${op.sanitizedTarget}: ${err.message}`,
              { code: 'INVALID_JSON' }
            );
          }
        }

        op.resolvedData = parsedUpdatedData;
      }

      // 6. Mandatory schema and trusted-context validation under lock
      //    (for dynamic JSON updates and category-dependent writes)
      let dynamicCategoriesUpdated = false;
      const dynamicCatOp = normalizedOps.find(
        (op) => op.action === 'write' && op.isDynamic && op.sanitizedTarget === 'categories.json'
      );
      const readCatOp = normalizedOps.find(
        (op) => op.action === 'read' && op.sanitizedTarget === 'categories.json'
      );

      if (dynamicCatOp) {
        const valRes = validateCategories(dynamicCatOp.resolvedData, { projectRoot: this.projectRoot });
        if (!valRes.isValid) {
          const detail = (valRes.errors || []).map((e) => `${e.field}: ${e.message}`).join(', ');
          throw new TransactionError(`Schema validation failed for categories.json: ${detail}`, {
            code: 'SCHEMA_VALIDATION_FAILED',
          });
        }
        pendingCategoriesData = dynamicCatOp.resolvedData;
        trustedCategories = await this.loadTrustedCategories(pendingCategoriesData);
        dynamicCategoriesUpdated = true;
      } else if (readCatOp) {
        // Resolve trusted category context strictly from the locked snapshot (never re-reading unlocked disk)
        const catSnapshot = snapshots.get(readCatOp.targetPath);
        let snapshotCategoriesData = null;
        if (catSnapshot && catSnapshot.existed && catSnapshot.originalBytes) {
          try {
            snapshotCategoriesData = JSON.parse(catSnapshot.originalBytes.toString('utf8'));
          } catch {
            snapshotCategoriesData = null;
          }
        }
        if (Array.isArray(snapshotCategoriesData) && snapshotCategoriesData.length > 0) {
          trustedCategories = await this.loadTrustedCategories(snapshotCategoriesData);
        } else {
          trustedCategories = null;
        }
      }

      if (writesArticlesOrTools && !trustedCategories) {
        throw new TransactionError(
          'Category referential integrity cannot be established: category store is empty, missing, malformed, or unavailable',
          { code: 'CATEGORY_INTEGRITY_UNAVAILABLE' }
        );
      }

      const postResolutionValidationContext = Object.freeze({
        projectRoot: this.projectRoot,
        categories: trustedCategories,
        isCmsInput: false,
      });

      const needsStaticCategoryValidation = Boolean(dynamicCategoriesUpdated || readCatOp);

      for (const op of normalizedOps) {
        if (op.action !== 'write') {
          continue;
        }

        if (!op.isDynamic) {
          if (
            needsStaticCategoryValidation &&
            (op.sanitizedTarget === 'articles.json' || op.sanitizedTarget === 'tools.json')
          ) {
            const validator = SCHEMA_VALIDATORS[op.fileName];
            const dataToValidate = op.resolvedData !== null ? op.resolvedData : JSON.parse(op.content);
            const valResult = validator(dataToValidate, postResolutionValidationContext);
            if (!valResult.isValid) {
              const detail = (valResult.errors || [])
                .map((e) => `${e.field}: ${e.message}`)
                .join(', ');
              throw new TransactionError(`Schema validation failed for ${op.fileName}: ${detail}`, {
                code: 'SCHEMA_VALIDATION_FAILED',
              });
            }
          }
          continue;
        }

        const parsedData = op.resolvedData;
        const fileName = op.fileName;

        if (fileName === 'articles.json') {
          if (!Array.isArray(parsedData)) {
            throw new TransactionError('Articles payload must be a JSON array', {
              code: 'SCHEMA_VALIDATION_FAILED',
            });
          }
          for (let i = 0; i < parsedData.length; i++) {
            const article = parsedData[i];
            if (!article || typeof article !== 'object') continue;
            const expectedContentPath = `content/articles/${article.slug}.md`;
            if (!article.contentPath || article.contentPath !== expectedContentPath) {
              throw new TransactionError(
                `Stored article "${article.slug || i}" must contain server-generated contentPath "${expectedContentPath}"`,
                { code: 'SCHEMA_VALIDATION_FAILED' }
              );
            }
          }
        }

        const validator = SCHEMA_VALIDATORS[fileName];
        if (!validator) {
          throw new TransactionError(`No schema validator found for JSON file: ${fileName}`, {
            code: 'NO_VALIDATOR',
          });
        }

        const valResult = validator(parsedData, postResolutionValidationContext);
        if (!valResult.isValid) {
          const detail = (valResult.errors || [])
            .map((e) => `${e.field}: ${e.message}`)
            .join(', ');
          throw new TransactionError(`Schema validation failed for ${fileName}: ${detail}`, {
            code: 'SCHEMA_VALIDATION_FAILED',
          });
        }

        try {
          op.content = serializeAndVerifyJson(parsedData);
        } catch (err) {
          throw new TransactionError(sanitizeErrorMessage(err.message), {
            code: 'SERIALIZATION_FAILED',
          });
        }
      }

      // 7. Create and verify recoverable backups of all existing mutating files before ANY mutation
      const backupsCreated = [];
      for (const op of normalizedOps) {
        if (op.action === 'read') {
          continue;
        }
        const snapshot = snapshots.get(op.targetPath);
        if (!snapshot || !snapshot.existed) {
          continue;
        }

        if (options._simulateBackupFailure) {
          throw new TransactionError(
            `Simulated backup failure for target: "${op.sanitizedTarget}"`,
            { code: 'BACKUP_FAILED' }
          );
        }

        let backupResult;
        try {
          backupResult = await createPreWriteBackup(
            op.targetPath,
            op.backupKey,
            this.backupDir,
            this.maxBackups
          );
        } catch (err) {
          throw new TransactionError(
            sanitizeErrorMessage(
              `Backup creation failed for "${op.sanitizedTarget}": ${err?.message || 'unknown error'}`
            ),
            { code: 'BACKUP_FAILED' }
          );
        }

        if (!backupResult || !backupResult.backupFilePath || !backupResult.backupFileName) {
          throw new TransactionError(
            `Backup creation failed for "${op.sanitizedTarget}": invalid backup result`,
            { code: 'BACKUP_FAILED' }
          );
        }

        let backupStat;
        try {
          backupStat = await fs.promises.stat(backupResult.backupFilePath);
        } catch {
          throw new TransactionError(
            `Backup verification failed: cannot access backup file for "${op.sanitizedTarget}"`,
            { code: 'BACKUP_VERIFICATION_FAILED' }
          );
        }

        if (!backupStat.isFile() || backupStat.size !== snapshot.size) {
          throw new TransactionError(
            `Backup verification failed: size mismatch for "${op.sanitizedTarget}"`,
            { code: 'BACKUP_VERIFICATION_FAILED' }
          );
        }

        const backupBytes = await fs.promises.readFile(backupResult.backupFilePath);
        if (!backupBytes.equals(snapshot.originalBytes)) {
          throw new TransactionError(
            `Backup verification failed: byte mismatch for "${op.sanitizedTarget}"`,
            { code: 'BACKUP_VERIFICATION_FAILED' }
          );
        }

        op.backupResult = backupResult;
        backupsCreated.push({
          targetPath: op.targetPath,
          sanitizedTarget: op.sanitizedTarget,
          backupFileName: backupResult.backupFileName,
          backupFilePath: backupResult.backupFilePath,
        });
      }

      // 6. Apply mutations sequentially using atomic writes where possible
      const executedOps = [];
      let mutationError = null;
      let mutationIndex = 0;

      try {
        for (let i = 0; i < normalizedOps.length; i++) {
          const op = normalizedOps[i];
          if (op.action === 'read') {
            continue;
          }

          if (options._simulateMutationFailureAtIndex === mutationIndex) {
            throw new Error(
              `Simulated mutation failure during operation index ${mutationIndex} (${op.type})`
            );
          }
          mutationIndex++;

          if (op.action === 'write') {
            await atomicWriteFile(op.targetPath, op.content);
          } else if (op.action === 'delete') {
            if (op.kind === 'json') {
              throw new TransactionError(
                'JSON store deletion is completely disabled; JSON content stores cannot be deleted',
                { code: 'FORBIDDEN_OPERATION' }
              );
            }
            const snapshot = snapshots.get(op.targetPath);
            if (snapshot && snapshot.existed) {
              await fs.promises.unlink(op.targetPath);
            }
          }
          executedOps.push(op);
        }
      } catch (err) {
        mutationError = err;
      }

      // 7. If any mutation failed, execute rollback of every mutating target to its pre-transaction state
      if (mutationError) {
        const rollbackFailures = [];

        for (const op of normalizedOps) {
          if (op.action === 'read') {
            continue;
          }
          const snapshot = snapshots.get(op.targetPath);
          if (!snapshot) continue;

          try {
            if (options._simulateRollbackFailure) {
              throw new Error(`Simulated rollback failure for target: "${op.sanitizedTarget}"`);
            }

            if (snapshot.existed) {
              // Existing file: verify target is not non-regular/symlink, then restore exact original bytes
              let currentStat = null;
              try {
                currentStat = await fs.promises.lstat(op.targetPath);
              } catch (e) {
                if (!e || e.code !== 'ENOENT') throw e;
              }

              if (currentStat) {
                if (currentStat.isSymbolicLink()) {
                  throw new Error(`Cannot rollback: destination is a symlink: "${op.sanitizedTarget}"`);
                }
                if (currentStat.isDirectory()) {
                  throw new Error(`Cannot rollback: destination is a directory: "${op.sanitizedTarget}"`);
                }
                if (!currentStat.isFile()) {
                  throw new Error(
                    `Cannot rollback: destination is not a regular file: "${op.sanitizedTarget}"`
                  );
                }
              }

              await atomicWriteFile(op.targetPath, snapshot.originalBytes);

              // Verify byte-level restoration
              const restoredBytes = await fs.promises.readFile(op.targetPath);
              if (!restoredBytes.equals(snapshot.originalBytes)) {
                throw new Error(
                  `Rollback verification failed: restored content does not match original bytes for "${op.sanitizedTarget}"`
                );
              }
            } else {
              // Target did not exist before transaction: remove if created
              let currentStat = null;
              try {
                currentStat = await fs.promises.lstat(op.targetPath);
              } catch (e) {
                if (!e || e.code !== 'ENOENT') throw e;
              }

              if (currentStat) {
                if (
                  currentStat.isSymbolicLink() ||
                  currentStat.isDirectory() ||
                  !currentStat.isFile()
                ) {
                  throw new Error(
                    `Cannot rollback created file: target is non-regular or symlink: "${op.sanitizedTarget}"`
                  );
                }
                await fs.promises.unlink(op.targetPath);
                try {
                  await fs.promises.lstat(op.targetPath);
                  throw new Error(
                    `Rollback verification failed: file still exists for "${op.sanitizedTarget}"`
                  );
                } catch (e) {
                  if (!e || e.code !== 'ENOENT') throw e;
                }
              }
            }
          } catch (rbErr) {
            rollbackFailures.push({
              target: op.sanitizedTarget,
              error: sanitizeErrorMessage(rbErr?.message || 'Rollback error'),
            });
          }
        }

        // 8. If rollback itself fails, preserve all backups and throw distinct recovery-required error
        if (rollbackFailures.length > 0) {
          const recoveryBackups = backupsCreated.map((b) => ({
            target: b.sanitizedTarget,
            backupFileName: b.backupFileName,
          }));

          const sanitizedMutationErr = sanitizeErrorMessage(
            mutationError?.message || 'Mutation failed'
          );
          const sanitizedFailuresStr = rollbackFailures
            .map((f) => `${f.target}: ${f.error}`)
            .join('; ');

          throw new TransactionRecoveryRequiredError(
            `Transaction rollback failed! System recovery required. Mutation error: ${sanitizedMutationErr}. Rollback errors: ${sanitizedFailuresStr}`,
            {
              mutationError: sanitizedMutationErr,
              rollbackFailures,
              recoveryBackups,
            }
          );
        }

        // Rollback succeeded completely
        const sanitizedMutationErr = sanitizeErrorMessage(
          mutationError?.message || 'Mutation failed'
        );
        throw new TransactionError(
          `Transaction failed: ${sanitizedMutationErr}. All changes were successfully rolled back to original state.`,
          {
            rolledBack: true,
            executedOperationsCount: executedOps.length,
            code: 'TRANSACTION_ROLLED_BACK',
            originalError: mutationError,
          }
        );
      }

      // 9. Return structured result with zero absolute paths
      return {
        success: true,
        operationsCount: normalizedOps.length,
        results: normalizedOps.map((op) => ({
          type: op.type,
          target: op.sanitizedTarget,
          fileName: op.fileName || null,
          slug: op.slug || null,
          mediaFileName: op.mediaFileName || null,
          action: op.action,
          backupCreated: Boolean(op.backupResult),
          backupFileName: op.backupResult?.backupFileName || null,
          bytesWritten:
            op.action === 'write'
              ? Buffer.isBuffer(op.content)
                ? op.content.length
                : Buffer.byteLength(op.content, 'utf8')
              : null,
          deleted: op.action === 'delete',
        })),
      };
    } finally {
      // 10. Unconditionally release every acquired lock in reverse order
      while (acquiredLocks.length > 0) {
        const lock = acquiredLocks.pop();
        try {
          lock.release();
        } catch {}
      }
    }
  }

  /**
   * Alias for executeTransaction.
   */
  async transaction(operations, options = {}) {
    return await this.executeTransaction(operations, options);
  }
}

/**
 * Normalizes and validates a single operation descriptor for multi-file transactions.
 * Enforces allowlist validation, directory containment, and target path resolution.
 */
function normalizeTransactionOperation(
  op,
  projectRoot,
  trustedValidationContext,
  options = {},
  internalFlags = {}
) {
  if (!op || typeof op !== 'object' || Array.isArray(op)) {
    throw new TransactionError('Transaction operation must be a non-null object', {
      code: 'INVALID_OPERATION',
    });
  }

  // Validate operation options
  if (op.validateSchema !== undefined && typeof op.validateSchema !== 'boolean') {
    throw new TransactionError('Invalid validateSchema option: must be a boolean', {
      code: 'INVALID_OPTIONS',
    });
  }
  if (op.isCmsInput !== undefined && typeof op.isCmsInput !== 'boolean') {
    throw new TransactionError('Invalid isCmsInput option: must be a boolean', {
      code: 'INVALID_OPTIONS',
    });
  }
  if (op.categories !== undefined && !Array.isArray(op.categories)) {
    throw new TransactionError('Invalid categories option: must be an array', {
      code: 'INVALID_OPTIONS',
    });
  }
  if (op.projectRoot !== undefined && typeof op.projectRoot !== 'string') {
    throw new TransactionError('Invalid projectRoot option: must be a string', {
      code: 'INVALID_OPTIONS',
    });
  }

  // Reject conflicting validation options between transaction options and operation options
  if (
    options &&
    options.validateSchema !== undefined &&
    op.validateSchema !== undefined &&
    options.validateSchema !== op.validateSchema
  ) {
    throw new TransactionError(
      'Conflicting validateSchema options between transaction and operation',
      { code: 'INVALID_OPTIONS' }
    );
  }
  if (
    options &&
    options.isCmsInput !== undefined &&
    op.isCmsInput !== undefined &&
    options.isCmsInput !== op.isCmsInput
  ) {
    throw new TransactionError(
      'Conflicting isCmsInput options between transaction and operation',
      { code: 'INVALID_OPTIONS' }
    );
  }
  if (
    options &&
    options.projectRoot !== undefined &&
    op.projectRoot !== undefined &&
    options.projectRoot !== op.projectRoot
  ) {
    throw new TransactionError(
      'Conflicting projectRoot options between transaction and operation',
      { code: 'INVALID_OPTIONS' }
    );
  }
  if (
    options &&
    options.categories !== undefined &&
    op.categories !== undefined &&
    options.categories !== op.categories
  ) {
    throw new TransactionError(
      'Conflicting categories options between transaction and operation',
      { code: 'INVALID_OPTIONS' }
    );
  }

  const rawType = String(op.type || op.action || '').trim();
  const lowerType = rawType.toLowerCase();

  // Fix 3: Reject deleteJson and delete_json immediately
  if (lowerType === 'deletejson' || lowerType === 'delete_json') {
    throw new TransactionError(
      'JSON store deletion is completely disabled; JSON content stores cannot be deleted',
      { code: 'FORBIDDEN_OPERATION' }
    );
  }

  // Fix 3: Check if generic delete targets a JSON file or JSON kind
  if (lowerType === 'delete') {
    const targetCandidate = op.fileName || op.file || op.target;
    if (
      op.kind === 'json' ||
      (typeof targetCandidate === 'string' &&
        (ALLOWED_JSON_SET.has(targetCandidate) || targetCandidate.toLowerCase().endsWith('.json')))
    ) {
      throw new TransactionError(
        'JSON store deletion is completely disabled; JSON content stores cannot be deleted',
        { code: 'FORBIDDEN_OPERATION' }
      );
    }
  }

  let kind = null; // 'json' | 'markdown' | 'media'
  let action = null; // 'read' | 'write' | 'delete'
  let fileName = null;
  let slug = null;
  let mediaFileName = null;
  let content = null;
  let targetPath = null;
  let backupKey = null;
  let sanitizedTarget = null;
  let parsedData = null;

  if (lowerType === 'readjson' || lowerType === 'read_json') {
    kind = 'json';
    action = 'read';
    fileName = op.fileName || op.file || op.target;
  } else if (lowerType === 'readmedia' || lowerType === 'read_media') {
    kind = 'media';
    action = 'read';
    mediaFileName = op.fileName || op.filename || op.file || op.target;
  } else if (lowerType === 'writemedia' || lowerType === 'write_media') {
    kind = 'media';
    action = 'write';
    mediaFileName = op.fileName || op.filename || op.file || op.target;
  } else if (lowerType === 'deletemedia' || lowerType === 'delete_media') {
    kind = 'media';
    action = 'delete';
    mediaFileName = op.fileName || op.filename || op.file || op.target;
  } else if (
    lowerType === 'readmarkdown' ||
    lowerType === 'read_markdown' ||
    lowerType === 'readarticlemarkdown' ||
    lowerType === 'read_article_markdown'
  ) {
    kind = 'markdown';
    action = 'read';
    slug =
      op.slug ||
      (op.fileName && op.fileName.endsWith('.md')
        ? op.fileName.slice(0, -3)
        : op.fileName);
  } else if (lowerType === 'read') {
    action = 'read';
    const targetCandidate = op.fileName || op.file || op.target;
    if (
      typeof targetCandidate === 'string' &&
      (ALLOWED_JSON_SET.has(targetCandidate) || targetCandidate.toLowerCase().endsWith('.json'))
    ) {
      kind = 'json';
      fileName = targetCandidate;
    } else if (op.slug) {
      kind = 'markdown';
      slug = op.slug;
    } else if (typeof targetCandidate === 'string' && targetCandidate.toLowerCase().endsWith('.md')) {
      kind = 'markdown';
      slug = targetCandidate.slice(0, -3);
    } else {
      throw new TransactionError(
        `Cannot determine target kind for read operation: ${JSON.stringify(op.fileName || op.slug || op.file || op.target)}`,
        { code: 'UNSUPPORTED_OPERATION' }
      );
    }
  } else if (lowerType === 'writejson' || lowerType === 'write_json') {
    kind = 'json';
    action = 'write';
    fileName = op.fileName || op.file || op.target;
  } else if (
    lowerType === 'writemarkdown' ||
    lowerType === 'write_markdown' ||
    lowerType === 'writearticlemarkdown' ||
    lowerType === 'write_article_markdown'
  ) {
    kind = 'markdown';
    action = 'write';
    slug =
      op.slug ||
      (op.fileName && op.fileName.endsWith('.md')
        ? op.fileName.slice(0, -3)
        : op.fileName);
  } else if (
    lowerType === 'deletemarkdown' ||
    lowerType === 'delete_markdown' ||
    lowerType === 'deletearticlemarkdown' ||
    lowerType === 'delete_article_markdown'
  ) {
    kind = 'markdown';
    action = 'delete';
    slug =
      op.slug ||
      (op.fileName && op.fileName.endsWith('.md')
        ? op.fileName.slice(0, -3)
        : op.fileName);
  } else if (lowerType === 'write') {
    action = 'write';
    if (op.fileName && (ALLOWED_JSON_SET.has(op.fileName) || op.fileName.endsWith('.json'))) {
      kind = 'json';
      fileName = op.fileName;
    } else if (op.slug) {
      kind = 'markdown';
      slug = op.slug;
    } else if (op.fileName && op.fileName.endsWith('.md')) {
      kind = 'markdown';
      slug = op.fileName.slice(0, -3);
    } else if (op.file && ALLOWED_JSON_SET.has(op.file)) {
      kind = 'json';
      fileName = op.file;
    } else {
      throw new TransactionError(
        `Cannot determine target kind for write operation: ${JSON.stringify(op.fileName || op.slug || op.file)}`,
        { code: 'UNSUPPORTED_OPERATION' }
      );
    }
  } else if (lowerType === 'delete') {
    action = 'delete';
    if (op.slug) {
      kind = 'markdown';
      slug = op.slug;
    } else if (op.fileName && op.fileName.endsWith('.md')) {
      kind = 'markdown';
      slug = op.fileName.slice(0, -3);
    } else {
      throw new TransactionError(
        `Cannot determine target kind for delete operation: ${JSON.stringify(op.fileName || op.slug || op.file)}`,
        { code: 'UNSUPPORTED_OPERATION' }
      );
    }
  } else {
    throw new TransactionError(`Unsupported transaction operation type: "${rawType}"`, {
      code: 'UNSUPPORTED_OPERATION',
    });
  }

  // Disallow dynamic data functions for unsupported operation types
  if (kind !== 'json' || action !== 'write') {
    if (
      typeof op.data === 'function' ||
      typeof op.content === 'function' ||
      typeof op.markdownContent === 'function'
    ) {
      throw new TransactionError(
        'Dynamic data functions are only supported for writeJson operations',
        { code: 'INVALID_OPERATION' }
      );
    }
  }

  // Safety invariant: JSON stores can never be deleted
  if (kind === 'json' && action === 'delete') {
    throw new TransactionError(
      'JSON store deletion is completely disabled; JSON content stores cannot be deleted',
      { code: 'FORBIDDEN_OPERATION' }
    );
  }

  if (kind === 'json') {
    if (!fileName || typeof fileName !== 'string') {
      throw new TransactionError('JSON transaction operation requires string "fileName"', {
        code: 'INVALID_OPERATION',
      });
    }
    try {
      validateJsonFileName(fileName);
      targetPath = resolveSecureJsonPath(fileName, projectRoot);
    } catch (err) {
      const isSymlink = err?.message && err.message.toLowerCase().includes('symlink');
      throw new TransactionError(sanitizeErrorMessage(err.message), {
        code: isSymlink ? 'FORBIDDEN_SYMLINK' : 'PATH_VALIDATION_FAILED',
      });
    }
    backupKey = fileName;
    sanitizedTarget = fileName;

    if (action === 'write') {
      const rawData = op.data !== undefined ? op.data : op.content;
      if (rawData === undefined) {
        throw new TransactionError(`JSON write operation requires "data" for ${fileName}`, {
          code: 'INVALID_OPERATION',
        });
      }

      if (typeof rawData === 'function') {
        return {
          rawOp: op,
          id: op.id || null,
          type: 'writeJson',
          kind: 'json',
          action: 'write',
          fileName,
          slug: null,
          content: null,
          targetPath,
          backupKey,
          sanitizedTarget,
          isDynamic: true,
          dataProducer: rawData,
          resolvedData: null,
        };
      }

      parsedData = rawData;
      if (typeof rawData === 'string') {
        try {
          parsedData = JSON.parse(rawData);
        } catch (err) {
          throw new TransactionError(`Invalid JSON data for ${fileName}: ${err.message}`, {
            code: 'INVALID_JSON',
          });
        }
      }

      // Mandatory schema validation for every JSON write in transactions
      const validator = SCHEMA_VALIDATORS[fileName];
      if (!validator) {
        throw new TransactionError(`No schema validator found for JSON file: ${fileName}`, {
          code: 'NO_VALIDATOR',
        });
      }

      const valContext =
        trustedValidationContext ||
        Object.freeze({
          projectRoot,
          categories: null,
          isCmsInput: false,
        });

      // Enforce stored article invariants strictly before any mutation
      if (fileName === 'articles.json') {
        if (!Array.isArray(parsedData)) {
          throw new TransactionError('Articles payload must be a JSON array', {
            code: 'SCHEMA_VALIDATION_FAILED',
          });
        }
        for (let i = 0; i < parsedData.length; i++) {
          const article = parsedData[i];
          if (!article || typeof article !== 'object') continue;
          const expectedContentPath = `content/articles/${article.slug}.md`;
          if (!article.contentPath || article.contentPath !== expectedContentPath) {
            throw new TransactionError(
              `Stored article "${article.slug || i}" must contain server-generated contentPath "${expectedContentPath}"`,
              { code: 'SCHEMA_VALIDATION_FAILED' }
            );
          }
        }
      }

      const shouldDeferCategoryValidation =
        Boolean(internalFlags?.deferCategoryValidation) &&
        (fileName === 'articles.json' || fileName === 'tools.json');

      if (!shouldDeferCategoryValidation) {
        const valResult = validator(parsedData, valContext);
        if (!valResult.isValid) {
          const detail = (valResult.errors || [])
            .map((e) => `${e.field}: ${e.message}`)
            .join(', ');
          throw new TransactionError(`Schema validation failed for ${fileName}: ${detail}`, {
            code: 'SCHEMA_VALIDATION_FAILED',
          });
        }
      }

      try {
        content = serializeAndVerifyJson(parsedData);
      } catch (err) {
        throw new TransactionError(sanitizeErrorMessage(err.message), {
          code: 'SERIALIZATION_FAILED',
        });
      }
    }
  } else if (kind === 'markdown') {
    let rawSlug =
      slug ||
      (op.fileName && op.fileName.endsWith('.md') ? op.fileName.slice(0, -3) : op.fileName);
    if (typeof rawSlug === 'string' && rawSlug.toLowerCase().endsWith('.md')) {
      rawSlug = rawSlug.slice(0, -3);
    }
    slug = rawSlug;

    if (!slug || typeof slug !== 'string') {
      throw new TransactionError('Markdown transaction operation requires string "slug"', {
        code: 'INVALID_OPERATION',
      });
    }
    try {
      validateArticleSlug(slug);
      targetPath = resolveSecureMarkdownPath(slug, projectRoot);
    } catch (err) {
      const isSymlink = err?.message && err.message.toLowerCase().includes('symlink');
      throw new TransactionError(sanitizeErrorMessage(err.message), {
        code: isSymlink ? 'FORBIDDEN_SYMLINK' : 'PATH_VALIDATION_FAILED',
      });
    }
    backupKey = `article_${slug}.md`;
    sanitizedTarget = `${slug}.md`;

    if (action === 'write') {
      const rawContent =
        op.content !== undefined
          ? op.content
          : op.markdownContent !== undefined
            ? op.markdownContent
            : op.data;
      if (typeof rawContent === 'function') {
        throw new TransactionError(
          'Dynamic data functions are only supported for writeJson operations',
          { code: 'INVALID_OPERATION' }
        );
      }
      if (typeof rawContent !== 'string') {
        throw new TransactionError(
          `Markdown write operation requires string content for slug: ${slug}`,
          {
            code: 'INVALID_OPERATION',
          }
        );
      }
      content = rawContent;
    }
  } else if (kind === 'media') {
    if (!mediaFileName || typeof mediaFileName !== 'string') {
      throw new TransactionError('Media transaction operation requires string "fileName"', {
        code: 'INVALID_OPERATION',
      });
    }
    try {
      validateMediaFileName(mediaFileName);
      targetPath = resolveSecureMediaPath(mediaFileName, projectRoot);
    } catch (err) {
      const isSymlink = err?.message && err.message.toLowerCase().includes('symlink');
      throw new TransactionError(sanitizeErrorMessage(err.message), {
        code: isSymlink ? 'FORBIDDEN_SYMLINK' : 'PATH_VALIDATION_FAILED',
      });
    }
    backupKey = `media_${mediaFileName}`;
    sanitizedTarget = `images/media/${mediaFileName}`;

    if (action === 'write') {
      const rawBytes = op.data !== undefined ? op.data : op.content;
      if (!Buffer.isBuffer(rawBytes) || rawBytes.length === 0) {
        throw new TransactionError(
          `Media write operation requires non-empty Buffer data for ${mediaFileName}`,
          { code: 'INVALID_OPERATION' }
        );
      }
      if (rawBytes.length > MAX_MEDIA_FILE_SIZE_BYTES) {
        throw new TransactionError(
          `Media write operation exceeds maximum allowed size of ${MAX_MEDIA_FILE_SIZE_BYTES} bytes for ${mediaFileName}`,
          { code: 'PAYLOAD_TOO_LARGE' }
        );
      }
      content = Buffer.from(rawBytes);
    }
  }

  const normalizedType =
    kind === 'json'
      ? `${action}Json`
      : kind === 'media'
        ? `${action}Media`
        : `${action}Markdown`;

  return {
    rawOp: op,
    id: op.id || null,
    type: normalizedType,
    kind,
    action,
    fileName,
    slug,
    mediaFileName,
    content,
    targetPath,
    backupKey,
    sanitizedTarget,
    isDynamic: false,
    dataProducer: null,
    resolvedData: kind === 'json' ? parsedData : null,
  };
}

/**
 * Strips absolute filesystem paths from an error message to prevent path leakage.
 */
export function sanitizeErrorMessage(message) {
  if (typeof message !== 'string') return 'Unknown error';
  return message
    .replace(/(?:\/[a-zA-Z0-9._-]+)+/g, (p) => path.basename(p))
    .replace(/(?:[a-zA-Z]:\\[a-zA-Z0-9._\\-]+)/g, (p) => path.basename(p));
}

// ----------------------------------------------------------------------------
// Default Engine Singleton and Direct Method Exports
// ----------------------------------------------------------------------------

export const defaultStorageEngine = new SecureStorageEngine();

export const readJson = (fileName) => defaultStorageEngine.readJson(fileName);
export const writeJson = (fileName, data, options) =>
  defaultStorageEngine.writeJson(fileName, data, options);
export const deleteJson = () => defaultStorageEngine.deleteJson();
export const readArticleMarkdown = (slug) => defaultStorageEngine.readArticleMarkdown(slug);
export const writeArticleMarkdown = (slug, content) =>
  defaultStorageEngine.writeArticleMarkdown(slug, content);
export const deleteArticleMarkdown = (slug) =>
  defaultStorageEngine.deleteArticleMarkdown(slug);
export const listArticles = () => defaultStorageEngine.listArticles();
export const listBackups = (fileKey) => defaultStorageEngine.listBackups(fileKey);
export const executeTransaction = (operations, options) =>
  defaultStorageEngine.executeTransaction(operations, options);
export const transaction = (operations, options) =>
  defaultStorageEngine.transaction(operations, options);

// ----------------------------------------------------------------------------
// Automated Test Suite (Task 42 — Storage Read-Lock Infrastructure)
// ----------------------------------------------------------------------------

async function runStorageTests() {
  let passCount = 0;
  let failCount = 0;
  let totalCount = 0;

  function testAssert(condition, name, detail = '') {
    totalCount++;
    if (condition) {
      passCount++;
      console.log(`  ✓ [PASS] ${name}`);
    } else {
      failCount++;
      console.error(`  ✗ [FAIL] ${name}${detail ? ` — ${detail}` : ''}`);
    }
  }

  console.log('\n================================================================');
  console.log(' [Storage Test Suite] Task 42 — Read-Lock Transaction Infrastructure');
  console.log('================================================================');

  const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ainovex-storage-test-'));

  const makeCategories = (extra = []) => [
    {
      id: 'cat-business',
      slug: 'business',
      name: 'Business',
      description: 'AI tools for business workflows',
      icon: 'TrendingUp',
    },
    ...extra,
  ];

  const makeArticle = (slug, category = 'business', title = 'Test Article Title') => ({
    id: `id-${slug}`,
    slug,
    title,
    excerpt: 'Valid article excerpt for isolated storage transaction testing.',
    contentPath: `content/articles/${slug}.md`,
    category,
    categoryName: 'Business',
    author: 'Test Author',
    publishedAt: '2026-10-01',
    updatedAt: '2026-10-05',
    isPublished: true,
    featuredImage: '/images/articles/test-hero.webp',
    imageAlt: 'Test hero alt text',
    readingTime: '4 min read',
    tags: ['AI', 'Testing'],
    metaTitle: 'Test Meta Title for SEO',
    metaDescription: 'Valid test meta description for isolated storage testing.',
  });

  const makeSettings = (siteTitle = 'AINOVEX Test') => ({
    siteTitle,
    siteTagline: 'AI Tools Directory',
    siteDescription: 'Curated AI tools and practical guides.',
    authorName: 'Test Author',
    contactEmail: 'test@example.com',
    productionUrl: 'https://example.com',
    defaultOgImage: '/images/og-default.png',
    monetizationNotice: 'Affiliate disclosure notice.',
    footerCopyright: '© 2026 AINOVEX',
  });

  async function setupFixtureRoot(subName) {
    const root = path.join(tmpRoot, subName);
    const contentDir = path.join(root, 'content');
    const articlesDir = path.join(contentDir, 'articles');
    await fs.promises.mkdir(articlesDir, { recursive: true });

    const categories = makeCategories();
    const articles = [makeArticle('alpha-guide', 'business', 'Alpha Guide')];
    const settings = makeSettings();

    await fs.promises.writeFile(
      path.join(contentDir, 'categories.json'),
      JSON.stringify(categories, null, 2) + '\n',
      'utf8'
    );
    await fs.promises.writeFile(
      path.join(contentDir, 'articles.json'),
      JSON.stringify(articles, null, 2) + '\n',
      'utf8'
    );
    await fs.promises.writeFile(
      path.join(contentDir, 'settings.json'),
      JSON.stringify(settings, null, 2) + '\n',
      'utf8'
    );
    await fs.promises.writeFile(
      path.join(articlesDir, 'alpha-guide.md'),
      '# Alpha Guide\n\nOriginal markdown body.\n',
      'utf8'
    );

    return { root, contentDir, articlesDir, engine: new SecureStorageEngine({ projectRoot: root }) };
  }

  try {
    // 1. readJson snapshot succeeds
    console.log('\n--- 1. Read-Only Snapshot & Public Accessor Methods ---');
    {
      const { engine, contentDir } = await setupFixtureRoot('t1-read-json');
      let seenCategories = null;
      const res = await engine.executeTransaction(
        [{ type: 'readJson', fileName: 'categories.json' }],
        {
          precondition: (snap) => {
            seenCategories = snap.getJson('categories.json');
          },
        }
      );
      testAssert(
        res.success === true &&
          res.operationsCount === 1 &&
          res.results[0].type === 'readJson' &&
          res.results[0].action === 'read' &&
          res.results[0].backupCreated === false &&
          res.results[0].bytesWritten === null &&
          res.results[0].deleted === false &&
          Array.isArray(seenCategories) &&
          seenCategories[0].slug === 'business',
        '1. readJson snapshot succeeds with valid result and parsed JSON'
      );
      testAssert(
        !fs.existsSync(path.join(contentDir, '..', BACKUP_DIR_NAME)),
        '1b. readJson-only transaction creates no backup directory'
      );
    }

    // 2. readMarkdown snapshot succeeds (existing + non-existing)
    {
      const { engine } = await setupFixtureRoot('t2-read-md');
      let existingMd = null;
      let missingSnap = null;
      const res = await engine.executeTransaction(
        [
          { type: 'readMarkdown', slug: 'alpha-guide' },
          { type: 'readMarkdown', slug: 'non-existent-slug' },
        ],
        {
          precondition: (snap) => {
            existingMd = snap.getText('alpha-guide');
            missingSnap = snap.get('non-existent-slug');
          },
        }
      );
      testAssert(
        res.success === true &&
          res.results[0].type === 'readMarkdown' &&
          res.results[0].action === 'read' &&
          res.results[0].slug === 'alpha-guide' &&
          existingMd === '# Alpha Guide\n\nOriginal markdown body.\n' &&
          missingSnap !== null &&
          missingSnap.existed === false &&
          missingSnap.getText() === null,
        '2. readMarkdown snapshot succeeds for existing and non-existent targets'
      );
    }

    // 3. Snapshot accessor public methods + immutability
    {
      const { engine } = await setupFixtureRoot('t3-accessor');
      let allMethodsOk = false;
      let immutableOk = false;
      await engine.executeTransaction(
        [
          { type: 'readJson', fileName: 'articles.json' },
          { type: 'readMarkdown', slug: 'alpha-guide' },
        ],
        {
          precondition: (snap) => {
            const targets = snap.listTargets();
            const hasJson = snap.has('articles.json');
            const hasMdSlug = snap.has('alpha-guide');
            const hasMdFile = snap.has('alpha-guide.md');
            const snapObj = snap.get('articles.json');
            const json1 = snap.getJson('articles.json');
            const text1 = snap.getText('alpha-guide');
            const bytes1 = snap.getBytes('alpha-guide');

            allMethodsOk =
              targets.includes('articles.json') &&
              targets.includes('alpha-guide') &&
              targets.includes('alpha-guide.md') &&
              hasJson &&
              hasMdSlug &&
              hasMdFile &&
              Boolean(snapObj) &&
              Array.isArray(json1) &&
              typeof text1 === 'string' &&
              Buffer.isBuffer(bytes1);

            // Mutate returned bytes & JSON and verify internal snapshot remains intact
            json1[0].title = 'MUTATED_BY_CALLER';
            json1.push({ hacked: true });
            bytes1.fill(0x41);
            snapObj.bytes.fill(0x42);

            const json2 = snap.getJson('articles.json');
            const text2 = snap.getText('alpha-guide');
            const snapObjText = snapObj.getText();
            const snapObjJson = snapObj.getJson();
            immutableOk =
              json2.length === 1 &&
              json2[0].title === 'Alpha Guide' &&
              text2 === '# Alpha Guide\n\nOriginal markdown body.\n' &&
              snapObjJson.length === 1 &&
              snapObjJson[0].title === 'Alpha Guide' &&
              snapObjText.includes('Alpha Guide');
          },
        }
      );
      testAssert(
        allMethodsOk && immutableOk,
        '3. Snapshot accessor public read methods work and internal snapshot is immutable'
      );
    }

    // 4, 5, 6. Exact bytes, mtime/inode unchanged, zero backup for read-only file
    console.log('\n--- 2. Zero-Mutation, mtime/inode, & Zero-Backup Guarantees ---');
    {
      const { root, contentDir, articlesDir, engine } = await setupFixtureRoot('t4-5-6-zero-mut');
      const catPath = path.join(contentDir, 'categories.json');
      const mdPath = path.join(articlesDir, 'alpha-guide.md');
      const settingsPath = path.join(contentDir, 'settings.json');

      const catBytesBefore = await fs.promises.readFile(catPath);
      const mdBytesBefore = await fs.promises.readFile(mdPath);
      const catStatBefore = await fs.promises.stat(catPath);
      const mdStatBefore = await fs.promises.stat(mdPath);

      await new Promise((r) => setTimeout(r, 25));

      await engine.executeTransaction([
        { type: 'readJson', fileName: 'categories.json' },
        { type: 'readMarkdown', slug: 'alpha-guide' },
        { type: 'writeJson', fileName: 'settings.json', data: makeSettings('Updated Site') },
      ]);

      const catBytesAfter = await fs.promises.readFile(catPath);
      const mdBytesAfter = await fs.promises.readFile(mdPath);
      const catStatAfter = await fs.promises.stat(catPath);
      const mdStatAfter = await fs.promises.stat(mdPath);
      const settingsAfter = JSON.parse(await fs.promises.readFile(settingsPath, 'utf8'));

      const backups = await fs.promises.readdir(path.join(root, BACKUP_DIR_NAME));
      const hasCatBackup = backups.some((b) => b.startsWith('categories.json.'));
      const hasMdBackup = backups.some((b) => b.startsWith('article_alpha-guide.md.'));
      const hasSettingsBackup = backups.some((b) => b.startsWith('settings.json.'));

      testAssert(
        catBytesBefore.equals(catBytesAfter) && mdBytesBefore.equals(mdBytesAfter),
        '4. Read-only JSON & Markdown files retain exact byte contents'
      );
      testAssert(
        catStatBefore.mtimeMs === catStatAfter.mtimeMs &&
          catStatBefore.ino === catStatAfter.ino &&
          mdStatBefore.mtimeMs === mdStatAfter.mtimeMs &&
          mdStatBefore.ino === mdStatAfter.ino,
        '5. Read-only files retain exact mtime and inode'
      );
      testAssert(
        !hasCatBackup && !hasMdBackup && hasSettingsBackup && settingsAfter.siteTitle === 'Updated Site',
        '6. Zero backups created for read-only targets while write target creates backup'
      );
    }

    // 7. Concurrent writer waits until read lock is released
    console.log('\n--- 3. Concurrency, Sorted Lock Order & Reverse Release ---');
    {
      const { engine } = await setupFixtureRoot('t7-concurrency');
      const timeline = [];
      let releaseReaderGate;
      const readerEntered = new Promise((resolve) => {
        releaseReaderGate = resolve;
      });

      const readerPromise = engine.executeTransaction(
        [{ type: 'readJson', fileName: 'settings.json' }],
        {
          precondition: async (snap) => {
            timeline.push(`read-start:${snap.getJson('settings.json').siteTitle}`);
            releaseReaderGate();
            await new Promise((r) => setTimeout(r, 60));
            timeline.push('read-end');
          },
        }
      );

      await readerEntered;

      const writerPromise = engine.executeTransaction([
        {
          type: 'writeJson',
          fileName: 'settings.json',
          data: (curr) => {
            timeline.push(`write-exec:${curr.siteTitle}`);
            return { ...curr, siteTitle: 'Writer Updated' };
          },
        },
      ]);

      await Promise.all([readerPromise, writerPromise]);
      testAssert(
        timeline.join('|') ===
          'read-start:AINOVEX Test|read-end|write-exec:AINOVEX Test',
        '7. Concurrent writer waits until read lock is released',
        `Timeline was: ${timeline.join('|')}`
      );
      testAssert(getActiveMutexCount() === 0, '7b. Active mutex count is 0 after concurrent read+write');
    }

    // 8 & 9. Sorted lock acquisition order & reverse release order
    {
      const { engine } = await setupFixtureRoot('t8-9-lock-order');
      const acq = [];
      const rel = [];
      await engine.executeTransaction(
        [
          { type: 'writeJson', fileName: 'settings.json', data: makeSettings('Sorted') },
          { type: 'readMarkdown', slug: 'alpha-guide' },
          { type: 'readJson', fileName: 'categories.json' },
          { type: 'readJson', fileName: 'articles.json' },
        ],
        {
          _lockAcquisitionOrder: acq,
          _lockReleaseOrder: rel,
        }
      );
      const expectedSorted = [...acq].sort((a, b) => a.localeCompare(b));
      const expectedReversed = [...acq].reverse();
      testAssert(
        acq.length === 4 && JSON.stringify(acq) === JSON.stringify(expectedSorted),
        '8. Multiple read/write targets acquire locks in deterministic sorted order'
      );
      testAssert(
        rel.length === 4 && JSON.stringify(rel) === JSON.stringify(expectedReversed),
        '9. Locks release in exact reverse order'
      );
    }

    // 10 & 11. Duplicate read target & read/write conflict rejection
    console.log('\n--- 4. Duplicate Target & Conflict Rejections ---');
    {
      const { engine } = await setupFixtureRoot('t10-11-conflicts');
      let dupJsonErr = null;
      try {
        await engine.executeTransaction([
          { type: 'readJson', fileName: 'articles.json' },
          { type: 'readJson', fileName: 'articles.json' },
        ]);
      } catch (err) {
        dupJsonErr = err;
      }

      let dupMdErr = null;
      try {
        await engine.executeTransaction([
          { type: 'readMarkdown', slug: 'alpha-guide' },
          { type: 'read', fileName: 'alpha-guide.md' },
        ]);
      } catch (err) {
        dupMdErr = err;
      }

      let rwJsonErr = null;
      try {
        await engine.executeTransaction([
          { type: 'readJson', fileName: 'settings.json' },
          { type: 'writeJson', fileName: 'settings.json', data: makeSettings('Conflict') },
        ]);
      } catch (err) {
        rwJsonErr = err;
      }

      let rwMdErr = null;
      try {
        await engine.executeTransaction([
          { type: 'readMarkdown', slug: 'alpha-guide' },
          { type: 'deleteMarkdown', slug: 'alpha-guide' },
        ]);
      } catch (err) {
        rwMdErr = err;
      }

      testAssert(
        dupJsonErr?.code === 'DUPLICATE_TARGET' && dupMdErr?.code === 'DUPLICATE_TARGET',
        '10. Duplicate readJson and readMarkdown targets rejected with DUPLICATE_TARGET'
      );
      testAssert(
        rwJsonErr?.code === 'DUPLICATE_TARGET' && rwMdErr?.code === 'DUPLICATE_TARGET',
        '11. Same-target read+write and read+delete rejected with DUPLICATE_TARGET'
      );
    }

    // 12, 13, 14, 15, 16. Failure paths, rollback isolation, & active mutex count === 0
    console.log('\n--- 5. Failure Paths, Rollback Isolation & Mutex Cleanup ---');
    {
      const { root, contentDir, articlesDir, engine } = await setupFixtureRoot('t12-16-failures');
      const catPath = path.join(contentDir, 'categories.json');
      const mdPath = path.join(articlesDir, 'alpha-guide.md');
      const settingsPath = path.join(contentDir, 'settings.json');

      const settingsBefore = await fs.promises.readFile(settingsPath);
      const catBefore = await fs.promises.readFile(catPath);
      const mdBefore = await fs.promises.readFile(mdPath);
      const catStatBefore = await fs.promises.stat(catPath);

      // 12. Precondition failure
      let precondErr = null;
      const preRel = [];
      try {
        await engine.executeTransaction(
          [
            { type: 'readJson', fileName: 'categories.json' },
            { type: 'writeJson', fileName: 'settings.json', data: makeSettings('Should Not Write') },
          ],
          {
            _lockReleaseOrder: preRel,
            precondition: () => {
              const e = new Error('Precondition aborted');
              e.code = 'ABORT_PRECOND';
              throw e;
            },
          }
        );
      } catch (err) {
        precondErr = err;
      }
      testAssert(
        precondErr?.code === 'ABORT_PRECOND' &&
          (await fs.promises.readFile(settingsPath)).equals(settingsBefore) &&
          !fs.existsSync(path.join(root, BACKUP_DIR_NAME)) &&
          preRel.length === 2 &&
          getActiveMutexCount() === 0,
        '12. Precondition failure performs zero mutations, zero backups, and releases locks'
      );

      // 13. Dynamic producer failure
      let dynErr = null;
      const dynRel = [];
      try {
        await engine.executeTransaction(
          [
            { type: 'readJson', fileName: 'categories.json' },
            {
              type: 'writeJson',
              fileName: 'settings.json',
              data: () => {
                throw new Error('Dynamic producer crashed');
              },
            },
          ],
          { _lockReleaseOrder: dynRel }
        );
      } catch (err) {
        dynErr = err;
      }
      testAssert(
        dynErr?.code === 'DYNAMIC_DATA_ERROR' &&
          dynRel.length === 2 &&
          !fs.existsSync(path.join(root, BACKUP_DIR_NAME)) &&
          getActiveMutexCount() === 0,
        '13. Dynamic producer failure releases all locks with zero backups'
      );

      // 14. Backup failure
      let backupErr = null;
      const bkpRel = [];
      try {
        await engine.executeTransaction(
          [
            { type: 'readJson', fileName: 'categories.json' },
            { type: 'writeJson', fileName: 'settings.json', data: makeSettings('Backup Fail') },
          ],
          { _simulateBackupFailure: true, _lockReleaseOrder: bkpRel }
        );
      } catch (err) {
        backupErr = err;
      }
      testAssert(
        backupErr?.code === 'BACKUP_FAILED' &&
          bkpRel.length === 2 &&
          (await fs.promises.readFile(settingsPath)).equals(settingsBefore) &&
          getActiveMutexCount() === 0,
        '14. Backup failure releases all locks and preserves original files'
      );

      // 15. Simulated mutation failure & rollback with readJson at index 0
      await new Promise((r) => setTimeout(r, 25));
      let mutErr = null;
      const mutRel = [];
      try {
        await engine.executeTransaction(
          [
            { type: 'readJson', fileName: 'categories.json' },
            { type: 'writeJson', fileName: 'settings.json', data: makeSettings('Will Rollback') },
            { type: 'writeMarkdown', slug: 'alpha-guide', content: '# Mutated\n' },
          ],
          {
            _simulateMutationFailureAtIndex: 1, // 2nd mutation (writeMarkdown), NOT index 1 (settings.json)
            _lockReleaseOrder: mutRel,
          }
        );
      } catch (err) {
        mutErr = err;
      }

      const catAfterMut = await fs.promises.readFile(catPath);
      const catStatAfterMut = await fs.promises.stat(catPath);
      const settingsAfterMut = await fs.promises.readFile(settingsPath);
      const mdAfterMut = await fs.promises.readFile(mdPath);
      const backupsAfterMut = await fs.promises.readdir(path.join(root, BACKUP_DIR_NAME));

      testAssert(
        mutErr?.code === 'TRANSACTION_ROLLED_BACK' &&
          mutErr?.rolledBack === true &&
          mutErr?.executedOperationsCount === 1 &&
          catAfterMut.equals(catBefore) &&
          catStatAfterMut.mtimeMs === catStatBefore.mtimeMs &&
          catStatAfterMut.ino === catStatBefore.ino &&
          !backupsAfterMut.some((b) => b.startsWith('categories.json.')) &&
          settingsAfterMut.equals(settingsBefore) &&
          mdAfterMut.equals(mdBefore) &&
          mutRel.length === 3,
        '15. Simulated mutation failure (index excluding reads) rolls back writes while leaving read-only file untouched'
      );

      // Verify _simulateMutationFailureAtIndex: 0 hits first mutation (settings.json), not readJson
      let mut0Err = null;
      try {
        await engine.executeTransaction(
          [
            { type: 'readJson', fileName: 'categories.json' },
            { type: 'writeJson', fileName: 'settings.json', data: makeSettings('Fail At Mut 0') },
          ],
          { _simulateMutationFailureAtIndex: 0 }
        );
      } catch (err) {
        mut0Err = err;
      }
      testAssert(
        mut0Err?.code === 'TRANSACTION_ROLLED_BACK' &&
          mut0Err?.executedOperationsCount === 0 &&
          mut0Err?.originalError?.message?.includes('writeJson'),
        '15b. _simulateMutationFailureAtIndex=0 targets first mutating op even when readJson precedes it'
      );

      // 16. Symlink error + rollback failure error still yield active mutex count === 0
      let rbFailErr = null;
      try {
        await engine.executeTransaction(
          [
            { type: 'readJson', fileName: 'categories.json' },
            { type: 'writeJson', fileName: 'settings.json', data: makeSettings('Rollback Fail') },
          ],
          { _simulateMutationFailureAtIndex: 0, _simulateRollbackFailure: true }
        );
      } catch (err) {
        rbFailErr = err;
      }
      testAssert(
        rbFailErr instanceof TransactionRecoveryRequiredError && getActiveMutexCount() === 0,
        '16. Active mutex count is 0 across success and all failure paths including rollback failure'
      );
    }

    // 17. Trusted Category Snapshot & Existing Transaction Regressions
    console.log('\n--- 6. Trusted Category Snapshot & Regression Tests ---');
    {
      const { contentDir, engine } = await setupFixtureRoot('t17-trusted-cat');

      // Concurrent category update + readJson('categories.json') + writeJson('articles.json')
      let releaseCatUpdate;
      const catWriteEntered = new Promise((resolve) => {
        releaseCatUpdate = resolve;
      });

      const catUpdateTx = engine.executeTransaction(
        [
          {
            type: 'writeJson',
            fileName: 'categories.json',
            data: (cats) => [
              ...cats,
              {
                id: 'cat-coding',
                slug: 'coding',
                name: 'Coding',
                description: 'AI coding assistants',
                icon: 'Code',
              },
            ],
          },
        ],
        {
          precondition: async () => {
            releaseCatUpdate();
            await new Promise((r) => setTimeout(r, 40));
          },
        }
      );

      await catWriteEntered;

      // Static writeJson('articles.json') referencing the newly added 'coding' category,
      // paired with readJson('categories.json') — must validate against the locked snapshot!
      const articleTx = engine.executeTransaction([
        { type: 'readJson', fileName: 'categories.json' },
        {
          type: 'writeJson',
          fileName: 'articles.json',
          data: [
            makeArticle('alpha-guide', 'business', 'Alpha Guide'),
            makeArticle('beta-coding', 'coding', 'Beta Coding Guide'),
          ],
        },
        {
          type: 'writeMarkdown',
          slug: 'beta-coding',
          content: '# Beta Coding\n\nContent.\n',
        },
      ]);

      const [catRes, artRes] = await Promise.all([catUpdateTx, articleTx]);
      const savedArticles = JSON.parse(
        await fs.promises.readFile(path.join(contentDir, 'articles.json'), 'utf8')
      );
      testAssert(
        catRes.success &&
          artRes.success &&
          savedArticles.length === 2 &&
          savedArticles[1].category === 'coding',
        '17a. Locked readJson(categories.json) snapshot provides trusted category context after concurrent category update'
      );

      // Read-only articles.json succeeds even when categories.json is missing/deleted
      await fs.promises.unlink(path.join(contentDir, 'categories.json'));
      let readOnlyArtOk = false;
      await engine.executeTransaction(
        [{ type: 'readJson', fileName: 'articles.json' }],
        {
          precondition: (snap) => {
            readOnlyArtOk = Array.isArray(snap.getJson('articles.json'));
          },
        }
      );
      testAssert(
        readOnlyArtOk,
        '17b. readJson(articles.json) does not require categories.json write integrity check'
      );

      // Write articles.json with readJson(categories.json) when categories.json is missing fails closed under lock
      let missingCatErr = null;
      try {
        await engine.executeTransaction([
          { type: 'readJson', fileName: 'categories.json' },
          {
            type: 'writeJson',
            fileName: 'articles.json',
            data: [makeArticle('alpha-guide', 'business', 'Alpha Guide')],
          },
        ]);
      } catch (err) {
        missingCatErr = err;
      }
      testAssert(
        missingCatErr?.code === 'CATEGORY_INTEGRITY_UNAVAILABLE' && getActiveMutexCount() === 0,
        '17c. Write articles.json + readJson(categories.json) fails closed when category snapshot is missing'
      );

      // Path traversal / disallowed JSON / symlink / MAX_TRANSACTION_OPERATIONS rejections
      let traversalErr = null;
      try {
        await engine.executeTransaction([{ type: 'readJson', fileName: '../package.json' }]);
      } catch (err) {
        traversalErr = err;
      }
      let disallowedErr = null;
      try {
        await engine.executeTransaction([{ type: 'readJson', fileName: 'secrets.json' }]);
      } catch (err) {
        disallowedErr = err;
      }
      let badSlugErr = null;
      try {
        await engine.executeTransaction([{ type: 'readMarkdown', slug: 'Invalid_Slug!' }]);
      } catch (err) {
        badSlugErr = err;
      }
      let maxOpsErr = null;
      try {
        const tooMany = Array.from({ length: MAX_TRANSACTION_OPERATIONS + 1 }, () => ({
          type: 'readJson',
          fileName: 'articles.json',
        }));
        await engine.executeTransaction(tooMany);
      } catch (err) {
        maxOpsErr = err;
      }
      testAssert(
        traversalErr?.code === 'PATH_VALIDATION_FAILED' &&
          disallowedErr?.code === 'PATH_VALIDATION_FAILED' &&
          badSlugErr?.code === 'PATH_VALIDATION_FAILED' &&
          maxOpsErr?.code === 'MAX_OPERATIONS_EXCEEDED' &&
          getActiveMutexCount() === 0,
        '17d. Path traversal, allowlist, slug policy, and MAX_TRANSACTION_OPERATIONS enforced for read ops'
      );
    }
  } finally {
    await fs.promises.rm(tmpRoot, { recursive: true, force: true });
  }

  console.log('\n================================================================');
  console.log(
    ` [Storage Test Suite Summary] Total: ${totalCount} | Passed: ${passCount} | Failed: ${failCount}`
  );
  console.log('================================================================\n');

  return { totalCount, passCount, failCount, success: failCount === 0 };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(__filename) &&
  process.argv.includes('--test')
) {
  runStorageTests()
    .then((result) => {
      process.exit(result.success ? 0 : 1);
    })
    .catch((err) => {
      console.error('[Storage Test Runner] Fatal error:', err);
      process.exit(1);
    });
}


