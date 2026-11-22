import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

// ----------------------------------------------------------------------------
// Configuration and Path Constants
// ----------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_PROJECT_ROOT = path.resolve(__dirname, '../..');

/**
 * Valid pricing models allowed for Tools.
 */
export const ALLOWED_PRICING_MODELS = Object.freeze(['Free', 'Freemium', 'Paid']);

/**
 * Maximum allowed character length for Tool.longDescription.
 * Sized to prevent modal layout/viewport overflow in ToolModal (max-w-lg)
 * while comfortably accommodating detailed multi-paragraph tool summaries.
 */
export const MAX_TOOL_LONG_DESCRIPTION_LENGTH = 2000;

/**
 * Valid slot formats allowed for Ads.
 */
export const ALLOWED_AD_FORMATS = Object.freeze([
  'horizontal',
  'rectangle',
  'vertical',
  'responsive',
]);

/**
 * Valid icon identifiers supported by CategoryGrid and CategoriesView.
 */
export const ALLOWED_CATEGORY_ICONS = Object.freeze([
  'PenTool',
  'Image',
  'Video',
  'Zap',
  'Palette',
  'Code',
  'TrendingUp',
  'GraduationCap',
  'LayoutGrid',
]);

// ----------------------------------------------------------------------------
// Common Helper Functions
// ----------------------------------------------------------------------------

/**
 * Creates a standard validation result object.
 */
function createResult(errors = []) {
  return {
    isValid: errors.length === 0,
    success: errors.length === 0,
    errors,
  };
}

/**
 * Adds an error entry to the errors list.
 */
function pushError(errors, field, message, code = 'INVALID_FIELD', extra = {}) {
  errors.push({
    field,
    message,
    code,
    ...extra,
  });
}

/**
 * Checks whether an object is a non-null plain object.
 */
function isPlainObject(val) {
  return typeof val === 'object' && val !== null && !Array.isArray(val);
}

/**
 * Validates a strict article slug:
 * - lowercase a-z, 0-9, single hyphen
 * - length 3 to 80
 * - no leading or trailing hyphen
 * - no consecutive hyphens
 */
export function isValidArticleSlug(slug) {
  if (typeof slug !== 'string') return false;
  if (slug.length < 3 || slug.length > 80) return false;
  return /^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug);
}

/**
 * Validates a category or general slug:
 * - lowercase a-z, 0-9, single hyphen
 * - length 2 to 60
 * - no leading or trailing hyphen
 * - no consecutive hyphens
 */
export function isValidCategorySlug(slug) {
  if (typeof slug !== 'string') return false;
  if (slug.length < 2 || slug.length > 60) return false;
  return /^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug);
}

/**
 * Validates a tool slug or ID:
 * - lowercase a-z, 0-9, single hyphen
 * - length 2 to 60
 */
export function isValidToolSlug(slug) {
  if (typeof slug !== 'string') return false;
  if (slug.length < 2 || slug.length > 60) return false;
  return /^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug);
}

/**
 * Validates an ISO 8601 calendar date formatted as YYYY-MM-DD.
 * Strictly verifies leap years and month boundaries (e.g., rejects 2026-02-31).
 */
export function isValidCalendarDate(dateStr) {
  if (typeof dateStr !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return false;
  }
  const [yearStr, monthStr, dayStr] = dateStr.split('-');
  const y = Number(yearStr);
  const m = Number(monthStr);
  const d = Number(dayStr);

  if (m < 1 || m > 12 || d < 1 || d > 31) {
    return false;
  }

  const date = new Date(Date.UTC(y, m - 1, d));
  return (
    date.getUTCFullYear() === y &&
    date.getUTCMonth() + 1 === m &&
    date.getUTCDate() === d
  );
}

/**
 * Validates an absolute HTTP or HTTPS URL.
 * Enforces explicit "://" authority syntax without leading extra slashes or backslashes,
 * rejects raw whitespace (ASCII and Unicode) and ASCII control characters (U+0000–U+001F, U+007F),
 * rejects malformed percent-encoding (every '%' must be followed by two hex characters),
 * rejects URLs containing userinfo (non-empty username/password or '@' in the raw authority),
 * validates raw authority ports strictly (1–65535, rejecting empty/0/leading-zero/non-numeric),
 * rejects shorthand/hex/octal/integer/leading-zero/trailing-dot IPv4 while accepting dotted-quad IPv4,
 * preserves valid bracketed IPv6 literals, and enforces DNS label rules after Punycode IDN normalization.
 */
export function isValidHttpUrl(urlStr) {
  if (typeof urlStr !== 'string' || urlStr.length === 0) return false;
  if (/[\u0000-\u001F\u007F\s\p{White_Space}]/u.test(urlStr)) return false;
  if (urlStr.includes('\\')) return false;
  if (!/^https?:\/\/[^/]/i.test(urlStr)) return false;
  if (/%(?![0-9A-Fa-f]{2})/.test(urlStr)) return false;
  try {
    const parsed = new URL(urlStr);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return false;
    }
    if (parsed.username !== '' || parsed.password !== '') {
      return false;
    }

    // Also inspect the raw authority before path/query/fragment delimiters so
    // normalized empty userinfo forms ("https://@example.com"), default/leading-zero ports
    // (":80", ":443", ":080", ":00443"), shorthand/hex/octal IPv4, trailing dots, and
    // percent-encoded hostnames are evaluated before WHATWG normalization masks them.
    const schemeSepIdx = urlStr.indexOf('://');
    if (schemeSepIdx === -1) return false;
    const afterScheme = urlStr.slice(schemeSepIdx + 3);
    const authorityEndIdx = afterScheme.search(/[/?#]/);
    const rawAuthority =
      authorityEndIdx === -1 ? afterScheme : afterScheme.slice(0, authorityEndIdx);

    if (rawAuthority.length === 0 || rawAuthority.includes('@')) {
      return false;
    }

    let rawHost = '';
    let hasPort = false;
    let rawPort = '';

    if (rawAuthority.startsWith('[')) {
      const closeBracketIdx = rawAuthority.indexOf(']');
      if (closeBracketIdx === -1) {
        return false;
      }
      rawHost = rawAuthority.slice(0, closeBracketIdx + 1);
      const remainder = rawAuthority.slice(closeBracketIdx + 1);
      if (remainder.length > 0) {
        if (!remainder.startsWith(':')) {
          return false;
        }
        hasPort = true;
        rawPort = remainder.slice(1);
      }
    } else {
      if (rawAuthority.includes('[') || rawAuthority.includes(']')) {
        return false;
      }
      const colonIdx = rawAuthority.indexOf(':');
      if (colonIdx !== -1) {
        rawHost = rawAuthority.slice(0, colonIdx);
        hasPort = true;
        rawPort = rawAuthority.slice(colonIdx + 1);
      } else {
        rawHost = rawAuthority;
      }
    }

    if (rawHost.length === 0 || rawHost.includes('%')) {
      return false;
    }

    if (hasPort) {
      if (!/^[1-9]\d{0,4}$/.test(rawPort)) {
        return false;
      }
      const portNum = Number(rawPort);
      if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
        return false;
      }
    }

    const parsedHost = parsed.hostname;
    if (!parsedHost) {
      return false;
    }

    // IPv6 literal: WHATWG URL parser validates syntax; ensure brackets match cleanly
    if (rawHost.startsWith('[') || parsedHost.startsWith('[')) {
      return (
        rawHost.startsWith('[') &&
        rawHost.endsWith(']') &&
        parsedHost.startsWith('[') &&
        parsedHost.endsWith(']')
      );
    }

    // IPv4 literal: reject shorthand, hex, octal, integer, leading-zero octets, and trailing dots
    if (/^\d+\.\d+\.\d+\.\d+$/.test(parsedHost)) {
      const strictIpv4Regex = /^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/;
      if (!strictIpv4Regex.test(rawHost) || rawHost !== parsedHost) {
        return false;
      }
      const octets = rawHost.split('.');
      for (const octet of octets) {
        const val = Number(octet);
        if (!Number.isInteger(val) || val < 0 || val > 255) {
          return false;
        }
      }
      return true;
    }

    // DNS hostname: validate dot structure & label hyphens on rawHost and DNS label rules on Punycode-normalized hostname
    if (rawHost.startsWith('.') || rawHost.endsWith('.') || rawHost.includes('..')) {
      return false;
    }
    for (const rawLabel of rawHost.split('.')) {
      if (rawLabel.length === 0 || rawLabel.startsWith('-') || rawLabel.endsWith('-')) {
        return false;
      }
    }
    if (parsedHost.length === 0 || parsedHost.length > 253) {
      return false;
    }
    if (parsedHost.startsWith('.') || parsedHost.endsWith('.') || parsedHost.includes('..')) {
      return false;
    }

    const labels = parsedHost.split('.');
    const dnsLabelRegex = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
    for (const label of labels) {
      if (label.length === 0 || label.length > 63 || !dnsLabelRegex.test(label)) {
        return false;
      }
    }

    return true;
  } catch {
    return false;
  }
}

/**
 * Validates an origin-only absolute HTTP or HTTPS URL (scheme + authority, optional single trailing slash).
 * Reuses isValidHttpUrl() for Task 73–80 security guarantees and additionally rejects paths,
 * multiple trailing slashes, query delimiters ('?'), and fragment delimiters ('#'), while
 * ensuring parsed origin consistency with raw authority and preserving IPv6 brackets and ports.
 */
export function isValidHttpOriginUrl(urlStr) {
  if (!isValidHttpUrl(urlStr)) return false;

  // Reject any query or fragment delimiter, even when empty (e.g. "https://example.com?", "https://example.com#")
  if (urlStr.includes('?') || urlStr.includes('#')) {
    return false;
  }

  const schemeSepIdx = urlStr.indexOf('://');
  if (schemeSepIdx === -1) return false;

  const afterScheme = urlStr.slice(schemeSepIdx + 3);
  const slashIdx = afterScheme.indexOf('/');
  const rawAuthority = slashIdx === -1 ? afterScheme : afterScheme.slice(0, slashIdx);
  const rawPath = slashIdx === -1 ? '' : afterScheme.slice(slashIdx);

  // Origin-only policy: allow either no pathname ("") or a single root slash ("/")
  if (rawPath !== '' && rawPath !== '/') {
    return false;
  }

  try {
    const parsed = new URL(urlStr);
    if (
      (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
      parsed.pathname !== '/' ||
      parsed.search !== '' ||
      parsed.hash !== ''
    ) {
      return false;
    }

    if (!parsed.origin || parsed.origin === 'null') {
      return false;
    }
    if (parsed.origin !== `${parsed.protocol}//${parsed.host}`) {
      return false;
    }
    if (parsed.href !== `${parsed.origin}/`) {
      return false;
    }

    // Verify rawAuthority matches parsed host/port semantics and preserves IPv6 brackets and ports
    let rawHost = '';
    let rawPort = '';
    if (rawAuthority.startsWith('[')) {
      const closeBracketIdx = rawAuthority.indexOf(']');
      if (closeBracketIdx === -1) return false;
      rawHost = rawAuthority.slice(0, closeBracketIdx + 1);
      const remainder = rawAuthority.slice(closeBracketIdx + 1);
      if (remainder.length > 0) {
        if (!remainder.startsWith(':')) return false;
        rawPort = remainder.slice(1);
      }
      if (!parsed.hostname.startsWith('[') || !parsed.hostname.endsWith(']')) {
        return false;
      }
    } else {
      const colonIdx = rawAuthority.indexOf(':');
      if (colonIdx !== -1) {
        rawHost = rawAuthority.slice(0, colonIdx);
        rawPort = rawAuthority.slice(colonIdx + 1);
      } else {
        rawHost = rawAuthority;
      }
    }

    if (!rawHost) return false;

    const isDefaultPort =
      (parsed.protocol === 'https:' && rawPort === '443') ||
      (parsed.protocol === 'http:' && rawPort === '80');

    if (rawPort === '' || isDefaultPort) {
      if (parsed.port !== '' || parsed.host !== parsed.hostname) {
        return false;
      }
    } else {
      if (parsed.port !== rawPort || parsed.host !== `${parsed.hostname}:${rawPort}`) {
        return false;
      }
    }

    const hostCheck = new URL(`${parsed.protocol}//${rawHost}`);
    if (hostCheck.hostname !== parsed.hostname) {
      return false;
    }

    return true;
  } catch {
    return false;
  }
}

/**
 * Validates a local site asset path (e.g. "/images/articles/hero.webp") or absolute URL.
 * Rejects protocol-relative URLs (e.g. "//evil.com/asset.svg", "///evil.com/asset.svg", "/\evil.com/asset.svg").
 */
export function isValidAssetPathOrUrl(pathStr) {
  if (typeof pathStr !== 'string' || !pathStr.trim()) return false;
  if (
    pathStr.startsWith('/') &&
    !pathStr.startsWith('//') &&
    !pathStr.startsWith('/\\') &&
    !pathStr.includes('..') &&
    !pathStr.includes('\0')
  ) {
    return true;
  }
  return isValidHttpUrl(pathStr);
}

/**
 * Validates standard email address format.
 */
export function isValidEmail(emailStr) {
  if (typeof emailStr !== 'string') return false;
  const clean = emailStr.trim();
  if (clean.length < 5 || clean.length > 254) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean);
}

const ALLOWED_CONTENT_FILES = Object.freeze(
  new Set([
    'articles.json',
    'tools.json',
    'categories.json',
    'settings.json',
    'ads.json',
    'seo.json',
    'pages.json',
    'media.json',
  ])
);

/**
 * Lazily loads a content JSON file from disk if not supplied in validator options.
 * Enforces strict allowlist, authorized content directory boundary, symlink rejection,
 * and fail-safe handling to prevent arbitrary filesystem traversal.
 */
function loadFallbackContent(fileName, projectRoot = DEFAULT_PROJECT_ROOT) {
  try {
    if (typeof fileName !== 'string' || !ALLOWED_CONTENT_FILES.has(fileName)) {
      return null;
    }
    const normalizedRoot = path.resolve(projectRoot || DEFAULT_PROJECT_ROOT);
    const contentDir = path.resolve(normalizedRoot, 'content');
    const fullPath = path.resolve(contentDir, fileName);

    const relative = path.relative(contentDir, fullPath);
    if (relative.startsWith('..') || path.isAbsolute(relative) || relative === '') {
      return null;
    }
    const prefix = contentDir.endsWith(path.sep) ? contentDir : contentDir + path.sep;
    if (!fullPath.startsWith(prefix)) {
      return null;
    }
    if (path.dirname(fullPath) !== contentDir || path.basename(fullPath) !== fileName) {
      return null;
    }

    let stat = null;
    try {
      stat = fs.lstatSync(fullPath);
    } catch {
      return null;
    }
    if (!stat || stat.isSymbolicLink() || !stat.isFile()) {
      return null;
    }

    const raw = fs.readFileSync(fullPath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Extracts a Set of category slug strings from array of category objects or string slugs.
 */
function extractCategorySlugs(categoriesOption, projectRoot = DEFAULT_PROJECT_ROOT) {
  let list = categoriesOption;
  if (!list) {
    list = loadFallbackContent('categories.json', projectRoot);
  }
  if (!Array.isArray(list) || list.length === 0) return new Set();

  const slugs = new Set();
  for (const item of list) {
    if (typeof item === 'string' && isValidCategorySlug(item)) {
      slugs.add(item);
    } else if (item && typeof item === 'object' && typeof item.slug === 'string' && isValidCategorySlug(item.slug)) {
      slugs.add(item.slug);
    }
  }
  return slugs;
}

/**
 * Extracts a Map of categorySlug -> exact categoryName (or null when name is unavailable)
 * from an array of category objects or string slugs.
 */
function extractCategoryMap(categoriesOption, projectRoot = DEFAULT_PROJECT_ROOT) {
  let list = categoriesOption;
  if (!list) {
    list = loadFallbackContent('categories.json', projectRoot);
  }
  if (!Array.isArray(list) || list.length === 0) return new Map();

  const map = new Map();
  for (const item of list) {
    if (typeof item === 'string' && isValidCategorySlug(item)) {
      if (!map.has(item)) {
        map.set(item, null);
      }
    } else if (
      item &&
      typeof item === 'object' &&
      typeof item.slug === 'string' &&
      isValidCategorySlug(item.slug)
    ) {
      const catName =
        typeof item.name === 'string' && item.name.trim() ? item.name : null;
      map.set(item.slug, catName);
    }
  }
  return map;
}

// ----------------------------------------------------------------------------
// 1. Article Validation
// ----------------------------------------------------------------------------

/**
 * Validates a single article object against the actual content schema.
 *
 * @param {object} article - The article object to validate.
 * @param {object} [options] - Optional settings:
 * @param {boolean} [options.isCmsInput=false] - When true, rejects client-supplied contentPath.
 * @param {Array} [options.categories] - List of valid categories or slugs.
 * @param {string} [options.projectRoot] - Path to project root.
 * @param {number|string} [options.prefix=''] - Error field prefix (e.g. "articles[0].").
 * @returns {object} Validation result { isValid, success, errors }.
 */
export function validateArticle(article, options = {}) {
  const errors = [];
  const prefix = options.prefix || '';
  const isCmsInput = Boolean(options.isCmsInput);
  const allowedCategories = extractCategorySlugs(options.categories, options.projectRoot);

  if (!isPlainObject(article)) {
    pushError(errors, `${prefix}article`, 'Article must be a valid JSON object', 'INVALID_TYPE');
    return createResult(errors);
  }

  // 1. ID
  if (typeof article.id !== 'string' || !article.id.trim()) {
    pushError(errors, `${prefix}id`, 'Article id must be a non-empty string', 'REQUIRED');
  } else if (article.id.length > 128) {
    pushError(errors, `${prefix}id`, 'Article id cannot exceed 128 characters', 'LENGTH_EXCEEDED');
  }

  // 2. Slug
  if (typeof article.slug !== 'string' || !article.slug.trim()) {
    pushError(errors, `${prefix}slug`, 'Article slug is required', 'REQUIRED');
  } else if (!isValidArticleSlug(article.slug)) {
    pushError(
      errors,
      `${prefix}slug`,
      'Article slug must be 3-80 characters, lowercase letters, numbers, and single hyphens (no leading, trailing, or consecutive hyphens)',
      'INVALID_SLUG'
    );
  }

  // 3. contentPath (Server-generated path policy enforcement)
  if (isCmsInput) {
    if ('contentPath' in article && article.contentPath !== undefined) {
      pushError(
        errors,
        `${prefix}contentPath`,
        'contentPath is server-generated and cannot be provided in CMS input',
        'FORBIDDEN_FIELD'
      );
    }
  } else {
    if (!('contentPath' in article) || article.contentPath === undefined || article.contentPath === null) {
      pushError(
        errors,
        `${prefix}contentPath`,
        'contentPath is required for stored article records',
        'REQUIRED'
      );
    } else if (typeof article.contentPath !== 'string' || !article.contentPath.trim()) {
      pushError(
        errors,
        `${prefix}contentPath`,
        'contentPath must be a non-empty string when provided',
        'INVALID_TYPE'
      );
    } else {
      const expectedPath = `content/articles/${article.slug}.md`;
      if (article.contentPath !== expectedPath) {
        pushError(
          errors,
          `${prefix}contentPath`,
          `contentPath must strictly follow server-generated path policy: "${expectedPath}"`,
          'INVALID_POLICY_PATH'
        );
      }
    }
  }

  // 4. Title
  if (typeof article.title !== 'string' || !article.title.trim()) {
    pushError(errors, `${prefix}title`, 'Article title is required', 'REQUIRED');
  } else if (article.title.trim().length < 3 || article.title.trim().length > 250) {
    pushError(
      errors,
      `${prefix}title`,
      'Article title must be between 3 and 250 characters',
      'INVALID_LENGTH'
    );
  }

  // 5. Excerpt
  if (typeof article.excerpt !== 'string' || !article.excerpt.trim()) {
    pushError(errors, `${prefix}excerpt`, 'Article excerpt is required', 'REQUIRED');
  } else if (article.excerpt.trim().length < 5 || article.excerpt.trim().length > 600) {
    pushError(
      errors,
      `${prefix}excerpt`,
      'Article excerpt must be between 5 and 600 characters',
      'INVALID_LENGTH'
    );
  }

  // 6. Category
  if (typeof article.category !== 'string' || !article.category.trim()) {
    pushError(errors, `${prefix}category`, 'Article category is required', 'REQUIRED');
  } else if (allowedCategories.size === 0) {
    pushError(
      errors,
      `${prefix}category`,
      'Category referential integrity cannot be established: category store is empty or unavailable',
      'UNAVAILABLE_CATEGORIES'
    );
  } else if (!allowedCategories.has(article.category)) {
    pushError(
      errors,
      `${prefix}category`,
      `Category "${article.category}" does not exist in categories.json`,
      'INVALID_CATEGORY'
    );
  }

  // 7. categoryName (optional string)
  if ('categoryName' in article && article.categoryName !== undefined) {
    if (typeof article.categoryName !== 'string' || !article.categoryName.trim()) {
      pushError(
        errors,
        `${prefix}categoryName`,
        'categoryName must be a non-empty string when provided',
        'INVALID_TYPE'
      );
    }
  }

  // 8. Author
  if (typeof article.author !== 'string' || !article.author.trim()) {
    pushError(errors, `${prefix}author`, 'Article author is required', 'REQUIRED');
  }

  // 9. publishedAt
  if (typeof article.publishedAt !== 'string' || !article.publishedAt.trim()) {
    pushError(errors, `${prefix}publishedAt`, 'publishedAt is required', 'REQUIRED');
  } else if (!isValidCalendarDate(article.publishedAt)) {
    pushError(
      errors,
      `${prefix}publishedAt`,
      'publishedAt must be a valid calendar date in YYYY-MM-DD format',
      'INVALID_DATE'
    );
  }

  // 10. updatedAt
  if (typeof article.updatedAt !== 'string' || !article.updatedAt.trim()) {
    pushError(errors, `${prefix}updatedAt`, 'updatedAt is required', 'REQUIRED');
  } else if (!isValidCalendarDate(article.updatedAt)) {
    pushError(
      errors,
      `${prefix}updatedAt`,
      'updatedAt must be a valid calendar date in YYYY-MM-DD format',
      'INVALID_DATE'
    );
  } else if (
    isValidCalendarDate(article.publishedAt) &&
    article.updatedAt < article.publishedAt
  ) {
    pushError(
      errors,
      `${prefix}updatedAt`,
      'updatedAt cannot be earlier than publishedAt',
      'DATE_OUT_OF_ORDER'
    );
  }

  // 11. isPublished
  if (typeof article.isPublished !== 'boolean') {
    pushError(
      errors,
      `${prefix}isPublished`,
      'isPublished must be a boolean (true or false)',
      'INVALID_TYPE'
    );
  }

  // 12. featuredImage
  if (typeof article.featuredImage !== 'string' || !article.featuredImage.trim()) {
    pushError(errors, `${prefix}featuredImage`, 'featuredImage is required', 'REQUIRED');
  } else if (!isValidAssetPathOrUrl(article.featuredImage)) {
    pushError(
      errors,
      `${prefix}featuredImage`,
      'featuredImage must be a valid path starting with "/" or an absolute URL',
      'INVALID_URL'
    );
  }

  // 13. ogImage (optional)
  if ('ogImage' in article && article.ogImage !== undefined && article.ogImage !== '') {
    if (!isValidAssetPathOrUrl(article.ogImage)) {
      pushError(
        errors,
        `${prefix}ogImage`,
        'ogImage must be a valid path starting with "/" or an absolute URL',
        'INVALID_URL'
      );
    }
  }

  // 14. imageAlt
  if (typeof article.imageAlt !== 'string' || !article.imageAlt.trim()) {
    pushError(errors, `${prefix}imageAlt`, 'imageAlt is required for accessibility', 'REQUIRED');
  }

  // 15. readingTime
  if (typeof article.readingTime !== 'string' || !article.readingTime.trim()) {
    pushError(errors, `${prefix}readingTime`, 'readingTime is required', 'REQUIRED');
  }

  // 16. tags
  if (!Array.isArray(article.tags)) {
    pushError(errors, `${prefix}tags`, 'tags must be an array of strings', 'INVALID_TYPE');
  } else {
    for (let i = 0; i < article.tags.length; i++) {
      const tag = article.tags[i];
      if (typeof tag !== 'string' || !tag.trim()) {
        pushError(
          errors,
          `${prefix}tags[${i}]`,
          'Each tag must be a non-empty string',
          'INVALID_TAG'
        );
      }
    }
  }

  // 17. SEO fields: metaTitle & metaDescription
  if (typeof article.metaTitle !== 'string' || !article.metaTitle.trim()) {
    pushError(errors, `${prefix}metaTitle`, 'metaTitle is required for SEO', 'REQUIRED');
  } else if (article.metaTitle.trim().length < 5 || article.metaTitle.trim().length > 120) {
    pushError(
      errors,
      `${prefix}metaTitle`,
      'metaTitle must be between 5 and 120 characters',
      'INVALID_LENGTH'
    );
  }

  if (typeof article.metaDescription !== 'string' || !article.metaDescription.trim()) {
    pushError(errors, `${prefix}metaDescription`, 'metaDescription is required for SEO', 'REQUIRED');
  } else if (
    article.metaDescription.trim().length < 10 ||
    article.metaDescription.trim().length > 300
  ) {
    pushError(
      errors,
      `${prefix}metaDescription`,
      'metaDescription must be between 10 and 300 characters',
      'INVALID_LENGTH'
    );
  }

  // Optional SEO fields: primaryKeyword, secondaryKeywords, canonicalUrl
  if ('primaryKeyword' in article && article.primaryKeyword !== undefined) {
    if (typeof article.primaryKeyword !== 'string') {
      pushError(
        errors,
        `${prefix}primaryKeyword`,
        'primaryKeyword must be a string',
        'INVALID_TYPE'
      );
    }
  }

  if ('secondaryKeywords' in article && article.secondaryKeywords !== undefined) {
    if (!Array.isArray(article.secondaryKeywords)) {
      pushError(
        errors,
        `${prefix}secondaryKeywords`,
        'secondaryKeywords must be an array of strings',
        'INVALID_TYPE'
      );
    }
  }

  if ('canonicalUrl' in article && article.canonicalUrl !== undefined && article.canonicalUrl !== '') {
    if (!isValidHttpUrl(article.canonicalUrl)) {
      pushError(
        errors,
        `${prefix}canonicalUrl`,
        'canonicalUrl must be a valid absolute HTTP/HTTPS URL',
        'INVALID_URL'
      );
    }
  }

  return createResult(errors);
}

/**
 * Validates the full array of articles (articles.json structure).
 * Enforces uniqueness of slugs and IDs, individual schema validity,
 * and the build requirement that at least one published article exists.
 *
 * @param {Array} articles - Array of article objects.
 * @param {object} [options] - Validation options.
 * @returns {object} Validation result { isValid, success, errors }.
 */
export function validateArticles(articles, options = {}) {
  const errors = [];

  if (!Array.isArray(articles)) {
    pushError(errors, 'articles', 'Articles payload must be a JSON array', 'INVALID_TYPE');
    return createResult(errors);
  }

  const seenSlugs = new Map();
  const seenIds = new Map();
  let publishedCount = 0;

  for (let i = 0; i < articles.length; i++) {
    const article = articles[i];
    const prefix = `articles[${i}].`;

    // Validate single article
    const itemResult = validateArticle(article, { ...options, prefix });
    if (!itemResult.isValid) {
      errors.push(...itemResult.errors);
    }

    if (article && typeof article === 'object') {
      // Check duplicate slug
      if (typeof article.slug === 'string' && article.slug.trim()) {
        const normSlug = article.slug.trim();
        if (seenSlugs.has(normSlug)) {
          pushError(
            errors,
            `${prefix}slug`,
            `Duplicate article slug "${normSlug}" (first seen at index ${seenSlugs.get(normSlug)})`,
            'DUPLICATE_SLUG'
          );
        } else {
          seenSlugs.set(normSlug, i);
        }
      }

      // Check duplicate id
      if (typeof article.id === 'string' && article.id.trim()) {
        const normId = article.id.trim();
        if (seenIds.has(normId)) {
          pushError(
            errors,
            `${prefix}id`,
            `Duplicate article id "${normId}" (first seen at index ${seenIds.get(normId)})`,
            'DUPLICATE_ID'
          );
        } else {
          seenIds.set(normId, i);
        }
      }

      // Track published status
      if (article.isPublished === true) {
        publishedCount++;
      }
    }
  }

  // Real build requirement: scripts/postbuild.mjs line 67 requires >= 1 published article
  if (publishedCount === 0) {
    pushError(
      errors,
      'articles',
      'At least one published article is required to maintain public site build and sitemap generation',
      'NO_PUBLISHED_ARTICLES'
    );
  }

  return createResult(errors);
}

/**
 * Validates unpublishing an article to ensure at least one published article remains.
 */
export function validateArticleUnpublish(articleSlug, options = {}) {
  const errors = [];
  let articles = options.articles;
  if (!Array.isArray(articles)) {
    articles = loadFallbackContent('articles.json', options.projectRoot) || [];
  }

  const published = articles.filter((a) => a && a.isPublished === true);
  const target = published.find((a) => a && a.slug === articleSlug);

  if (target && published.length <= 1) {
    pushError(
      errors,
      'isPublished',
      `Cannot unpublish article "${articleSlug}": at least one published article must remain to satisfy build and sitemap requirements`,
      'LAST_PUBLISHED_ARTICLE'
    );
  }

  return createResult(errors);
}

/**
 * Validates deleting an article to ensure at least one published article remains.
 */
export function validateArticleDeletion(articleSlug, options = {}) {
  const errors = [];
  let articles = options.articles;
  if (!Array.isArray(articles)) {
    articles = loadFallbackContent('articles.json', options.projectRoot) || [];
  }

  const published = articles.filter((a) => a && a.isPublished === true);
  const target = articles.find((a) => a && a.slug === articleSlug);

  if (target && target.isPublished === true && published.length <= 1) {
    pushError(
      errors,
      'article',
      `Cannot delete article "${articleSlug}": it is the only published article and build requires at least one published article`,
      'LAST_PUBLISHED_ARTICLE'
    );
  }

  return createResult(errors);
}

// ----------------------------------------------------------------------------
// 2. Category Validation & Referential Integrity
// ----------------------------------------------------------------------------

/**
 * Validates a single category item.
 */
export function validateCategory(category, options = {}) {
  const errors = [];
  const prefix = options.prefix || '';

  if (!isPlainObject(category)) {
    pushError(errors, `${prefix}category`, 'Category must be a valid JSON object', 'INVALID_TYPE');
    return createResult(errors);
  }

  // id
  if (typeof category.id !== 'string' || !category.id.trim()) {
    pushError(errors, `${prefix}id`, 'Category id is required', 'REQUIRED');
  }

  // name
  if (typeof category.name !== 'string' || !category.name.trim()) {
    pushError(errors, `${prefix}name`, 'Category name is required', 'REQUIRED');
  } else if (category.name.trim().length < 2 || category.name.trim().length > 100) {
    pushError(
      errors,
      `${prefix}name`,
      'Category name must be between 2 and 100 characters',
      'INVALID_LENGTH'
    );
  }

  // slug
  if (typeof category.slug !== 'string' || !category.slug.trim()) {
    pushError(errors, `${prefix}slug`, 'Category slug is required', 'REQUIRED');
  } else if (!isValidCategorySlug(category.slug)) {
    pushError(
      errors,
      `${prefix}slug`,
      'Category slug must be 2-60 characters, lowercase letters, numbers, and single hyphens',
      'INVALID_SLUG'
    );
  }

  // description
  if (typeof category.description !== 'string' || !category.description.trim()) {
    pushError(errors, `${prefix}description`, 'Category description is required', 'REQUIRED');
  } else if (category.description.trim().length < 5 || category.description.trim().length > 300) {
    pushError(
      errors,
      `${prefix}description`,
      'Category description must be between 5 and 300 characters',
      'INVALID_LENGTH'
    );
  }

  // icon
  if (typeof category.icon !== 'string' || !category.icon.trim()) {
    pushError(errors, `${prefix}icon`, 'Category icon identifier is required', 'REQUIRED');
  } else if (!ALLOWED_CATEGORY_ICONS.includes(category.icon)) {
    pushError(
      errors,
      `${prefix}icon`,
      `Category icon must be one of: ${ALLOWED_CATEGORY_ICONS.join(', ')}`,
      'INVALID_ICON'
    );
  }

  // color (optional)
  if ('color' in category && category.color !== undefined) {
    if (typeof category.color !== 'string' || !category.color.trim()) {
      pushError(
        errors,
        `${prefix}color`,
        'Category color must be a non-empty string when provided',
        'INVALID_TYPE'
      );
    }
  }

  return createResult(errors);
}

/**
 * Validates the full array of categories (categories.json).
 */
export function validateCategories(categories, options = {}) {
  const errors = [];

  if (!Array.isArray(categories)) {
    pushError(errors, 'categories', 'Categories payload must be an array', 'INVALID_TYPE');
    return createResult(errors);
  }

  if (categories.length === 0) {
    pushError(errors, 'categories', 'Categories array cannot be empty', 'EMPTY_ARRAY');
    return createResult(errors);
  }

  const seenSlugs = new Map();
  const seenIds = new Map();
  const seenNames = new Map();

  for (let i = 0; i < categories.length; i++) {
    const category = categories[i];
    const prefix = `categories[${i}].`;

    const itemResult = validateCategory(category, { ...options, prefix });
    if (!itemResult.isValid) {
      errors.push(...itemResult.errors);
    }

    if (category && typeof category === 'object') {
      if (typeof category.slug === 'string' && category.slug.trim()) {
        const normSlug = category.slug.trim();
        if (seenSlugs.has(normSlug)) {
          pushError(
            errors,
            `${prefix}slug`,
            `Duplicate category slug "${normSlug}" (first seen at index ${seenSlugs.get(normSlug)})`,
            'DUPLICATE_SLUG'
          );
        } else {
          seenSlugs.set(normSlug, i);
        }
      }

      if (typeof category.id === 'string' && category.id.trim()) {
        const normId = category.id.trim();
        if (seenIds.has(normId)) {
          pushError(
            errors,
            `${prefix}id`,
            `Duplicate category id "${normId}" (first seen at index ${seenIds.get(normId)})`,
            'DUPLICATE_ID'
          );
        } else {
          seenIds.set(normId, i);
        }
      }

      if (typeof category.name === 'string' && category.name.trim()) {
        const trimmedName = category.name.trim();
        const normName = trimmedName.toLowerCase();
        if (seenNames.has(normName)) {
          pushError(
            errors,
            `${prefix}name`,
            `Duplicate category name "${trimmedName}" (first seen at index ${seenNames.get(normName)})`,
            'DUPLICATE_NAME'
          );
        } else {
          seenNames.set(normName, i);
        }
      }
    }
  }

  return createResult(errors);
}

/**
 * Helper to check category usage across articles and tools.
 * Returns referential usage details.
 */
export function checkCategoryUsage(categorySlug, options = {}) {
  let articles = options.articles;
  if (!Array.isArray(articles)) {
    articles = loadFallbackContent('articles.json', options.projectRoot) || [];
  }

  let tools = options.tools;
  if (!Array.isArray(tools)) {
    tools = loadFallbackContent('tools.json', options.projectRoot) || [];
  }

  const matchedArticles = articles
    .filter((a) => a && a.category === categorySlug)
    .map((a) => a.slug || a.id);

  const matchedTools = tools
    .filter((t) => t && t.category === categorySlug)
    .map((t) => t.slug || t.id);

  const isInUse = matchedArticles.length > 0 || matchedTools.length > 0;

  return {
    isInUse,
    articlesCount: matchedArticles.length,
    toolsCount: matchedTools.length,
    matchedArticles,
    matchedTools,
  };
}

/**
 * Validates whether a category can safely be deleted without breaking referential integrity.
 * If any article or tool references this category, deletion is rejected with details.
 */
export function validateCategoryDeletion(categorySlug, options = {}) {
  const errors = [];

  if (typeof categorySlug !== 'string' || !categorySlug.trim()) {
    pushError(errors, 'categorySlug', 'Category slug is required for deletion check', 'REQUIRED');
    return createResult(errors);
  }

  const usage = checkCategoryUsage(categorySlug.trim(), options);

  if (usage.isInUse) {
    const reasons = [];
    if (usage.articlesCount > 0) {
      reasons.push(`${usage.articlesCount} article(s) [${usage.matchedArticles.slice(0, 3).join(', ')}${usage.articlesCount > 3 ? '...' : ''}]`);
    }
    if (usage.toolsCount > 0) {
      reasons.push(`${usage.toolsCount} tool(s) [${usage.matchedTools.slice(0, 3).join(', ')}${usage.toolsCount > 3 ? '...' : ''}]`);
    }

    pushError(
      errors,
      'category',
      `Cannot delete category "${categorySlug}": referential integrity violation. Currently referenced by ${reasons.join(' and ')}.`,
      'CATEGORY_IN_USE',
      {
        references: {
          articles: usage.matchedArticles,
          tools: usage.matchedTools,
        },
      }
    );
  }

  return createResult(errors);
}

/**
 * Validates whether a category can safely be renamed without breaking existing references.
 */
export function validateCategoryRename(oldSlug, newSlug, options = {}) {
  const errors = [];

  if (!isValidCategorySlug(newSlug)) {
    pushError(
      errors,
      'newSlug',
      'New category slug must be 2-60 characters, lowercase letters, numbers, and single hyphens',
      'INVALID_SLUG'
    );
    return createResult(errors);
  }

  if (oldSlug !== newSlug) {
    const usage = checkCategoryUsage(oldSlug, options);
    if (usage.isInUse) {
      pushError(
        errors,
        'category',
        `Renaming category "${oldSlug}" to "${newSlug}" would break referential integrity for ${usage.articlesCount} article(s) and ${usage.toolsCount} tool(s). Associated items must be migrated simultaneously.`,
        'CATEGORY_RENAME_INTEGRITY_VIOLATION',
        {
          references: {
            articles: usage.matchedArticles,
            tools: usage.matchedTools,
          },
        }
      );
    }
  }

  return createResult(errors);
}

// ----------------------------------------------------------------------------
// 3. Tools Validation
// ----------------------------------------------------------------------------

/**
 * Validates a single tool object against tools.json schema.
 */
export function validateTool(tool, options = {}) {
  const errors = [];
  const prefix = options.prefix || '';
  const categoryMap =
    options._categoryMap instanceof Map
      ? options._categoryMap
      : extractCategoryMap(options.categories, options.projectRoot);

  if (!isPlainObject(tool)) {
    pushError(errors, `${prefix}tool`, 'Tool must be a valid JSON object', 'INVALID_TYPE');
    return createResult(errors);
  }

  // id
  if (typeof tool.id !== 'string' || !tool.id.trim()) {
    pushError(errors, `${prefix}id`, 'Tool id is required', 'REQUIRED');
  }

  // name
  if (typeof tool.name !== 'string' || !tool.name.trim()) {
    pushError(errors, `${prefix}name`, 'Tool name is required', 'REQUIRED');
  } else if (tool.name.trim().length < 2 || tool.name.trim().length > 100) {
    pushError(
      errors,
      `${prefix}name`,
      'Tool name must be between 2 and 100 characters',
      'INVALID_LENGTH'
    );
  }

  // slug
  if (typeof tool.slug !== 'string' || !tool.slug.trim()) {
    pushError(errors, `${prefix}slug`, 'Tool slug is required', 'REQUIRED');
  } else if (!isValidToolSlug(tool.slug)) {
    pushError(
      errors,
      `${prefix}slug`,
      'Tool slug must be 2-60 characters, lowercase letters, numbers, and single hyphens',
      'INVALID_SLUG'
    );
  }

  // url
  if (typeof tool.url !== 'string' || !tool.url.trim()) {
    pushError(errors, `${prefix}url`, 'Tool url is required', 'REQUIRED');
  } else if (!isValidHttpUrl(tool.url)) {
    pushError(
      errors,
      `${prefix}url`,
      'Tool url must be a valid absolute HTTP or HTTPS URL',
      'INVALID_URL'
    );
  }

  // description
  if (typeof tool.description !== 'string' || !tool.description.trim()) {
    pushError(errors, `${prefix}description`, 'Tool description is required', 'REQUIRED');
  } else if (tool.description.trim().length < 5 || tool.description.trim().length > 300) {
    pushError(
      errors,
      `${prefix}description`,
      'Tool description must be between 5 and 300 characters',
      'INVALID_LENGTH'
    );
  }

  // longDescription (optional, max MAX_TOOL_LONG_DESCRIPTION_LENGTH chars)
  if ('longDescription' in tool && tool.longDescription !== undefined) {
    if (typeof tool.longDescription !== 'string') {
      pushError(
        errors,
        `${prefix}longDescription`,
        'longDescription must be a string',
        'INVALID_TYPE'
      );
    } else if (tool.longDescription.length > 0 && !tool.longDescription.trim()) {
      pushError(
        errors,
        `${prefix}longDescription`,
        'longDescription cannot be whitespace-only when provided',
        'INVALID_LENGTH'
      );
    } else if (tool.longDescription.length > MAX_TOOL_LONG_DESCRIPTION_LENGTH) {
      pushError(
        errors,
        `${prefix}longDescription`,
        `longDescription cannot exceed ${MAX_TOOL_LONG_DESCRIPTION_LENGTH} characters`,
        'INVALID_LENGTH'
      );
    }
  }

  // category
  const hasValidCategorySlug =
    typeof tool.category === 'string' &&
    Boolean(tool.category.trim()) &&
    categoryMap.size > 0 &&
    categoryMap.has(tool.category);

  if (typeof tool.category !== 'string' || !tool.category.trim()) {
    pushError(errors, `${prefix}category`, 'Tool category is required', 'REQUIRED');
  } else if (categoryMap.size === 0) {
    pushError(
      errors,
      `${prefix}category`,
      'Category referential integrity cannot be established: category store is empty or unavailable',
      'UNAVAILABLE_CATEGORIES'
    );
  } else if (!categoryMap.has(tool.category)) {
    pushError(
      errors,
      `${prefix}category`,
      `Category "${tool.category}" does not exist in categories.json`,
      'INVALID_CATEGORY'
    );
  }

  // categoryName (required by Tool interface and must match trusted category.name)
  if (typeof tool.categoryName !== 'string' || !tool.categoryName.trim()) {
    pushError(errors, `${prefix}categoryName`, 'Tool categoryName is required', 'REQUIRED');
  } else if (hasValidCategorySlug) {
    const expectedCategoryName = categoryMap.get(tool.category);
    if (typeof expectedCategoryName !== 'string' || !expectedCategoryName.trim()) {
      pushError(
        errors,
        `${prefix}categoryName`,
        `Trusted category name for "${tool.category}" is unavailable`,
        'UNAVAILABLE_CATEGORIES'
      );
    } else if (tool.categoryName !== expectedCategoryName) {
      pushError(
        errors,
        `${prefix}categoryName`,
        `Tool categoryName "${tool.categoryName}" does not match category "${tool.category}" name "${expectedCategoryName}"`,
        'INVALID_CATEGORY_NAME'
      );
    }
  }

  // tags
  if (!Array.isArray(tool.tags)) {
    pushError(errors, `${prefix}tags`, 'tags must be an array of strings', 'INVALID_TYPE');
  } else {
    for (let i = 0; i < tool.tags.length; i++) {
      const tag = tool.tags[i];
      if (typeof tag !== 'string' || !tag.trim()) {
        pushError(
          errors,
          `${prefix}tags[${i}]`,
          'Each tag must be a non-empty string',
          'INVALID_TAG'
        );
      }
    }
  }

  // pricing ('Free' | 'Freemium' | 'Paid')
  if (typeof tool.pricing !== 'string' || !tool.pricing.trim()) {
    pushError(errors, `${prefix}pricing`, 'pricing is required', 'REQUIRED');
  } else if (!ALLOWED_PRICING_MODELS.includes(tool.pricing)) {
    pushError(
      errors,
      `${prefix}pricing`,
      `pricing must be one of: ${ALLOWED_PRICING_MODELS.join(', ')}`,
      'INVALID_PRICING'
    );
  }

  // isFeatured
  if (typeof tool.isFeatured !== 'boolean') {
    pushError(errors, `${prefix}isFeatured`, 'isFeatured must be a boolean', 'INVALID_TYPE');
  }

  // icon
  if (typeof tool.icon !== 'string' || !tool.icon.trim()) {
    pushError(errors, `${prefix}icon`, 'Tool icon path is required', 'REQUIRED');
  } else if (!isValidAssetPathOrUrl(tool.icon)) {
    pushError(
      errors,
      `${prefix}icon`,
      'icon must be a valid path starting with "/" or an absolute URL',
      'INVALID_URL'
    );
  }

  // iconBg (optional)
  if ('iconBg' in tool && tool.iconBg !== undefined) {
    if (typeof tool.iconBg !== 'string') {
      pushError(errors, `${prefix}iconBg`, 'iconBg must be a string', 'INVALID_TYPE');
    }
  }

  // brandInitial (optional)
  if ('brandInitial' in tool && tool.brandInitial !== undefined) {
    if (typeof tool.brandInitial !== 'string') {
      pushError(
        errors,
        `${prefix}brandInitial`,
        'brandInitial must be a string',
        'INVALID_TYPE'
      );
    }
  }

  // rating (optional finite number between 0 and 5)
  if ('rating' in tool && tool.rating !== undefined) {
    if (typeof tool.rating !== 'number' || !Number.isFinite(tool.rating)) {
      pushError(errors, `${prefix}rating`, 'rating must be a finite number', 'INVALID_TYPE');
    } else if (tool.rating < 0 || tool.rating > 5) {
      pushError(
        errors,
        `${prefix}rating`,
        'rating must be between 0 and 5',
        'INVALID_RATING_RANGE'
      );
    }
  }

  return createResult(errors);
}

/**
 * Validates the full array of tools (tools.json).
 * Resolves the trusted category context once and shares it across every tool item.
 */
export function validateTools(tools, options = {}) {
  const errors = [];

  if (!Array.isArray(tools)) {
    pushError(errors, 'tools', 'Tools payload must be a JSON array', 'INVALID_TYPE');
    return createResult(errors);
  }

  // Resolve trusted category map once for the entire array to guarantee snapshot consistency
  const categoryMap =
    options._categoryMap instanceof Map
      ? options._categoryMap
      : extractCategoryMap(options.categories, options.projectRoot);

  const seenSlugs = new Map();
  const seenIds = new Map();

  for (let i = 0; i < tools.length; i++) {
    const tool = tools[i];
    const prefix = `tools[${i}].`;

    const itemResult = validateTool(tool, { ...options, _categoryMap: categoryMap, prefix });
    if (!itemResult.isValid) {
      errors.push(...itemResult.errors);
    }

    if (tool && typeof tool === 'object') {
      if (typeof tool.slug === 'string' && tool.slug.trim()) {
        const normSlug = tool.slug.trim();
        if (seenSlugs.has(normSlug)) {
          pushError(
            errors,
            `${prefix}slug`,
            `Duplicate tool slug "${normSlug}" (first seen at index ${seenSlugs.get(normSlug)})`,
            'DUPLICATE_SLUG'
          );
        } else {
          seenSlugs.set(normSlug, i);
        }
      }

      if (typeof tool.id === 'string' && tool.id.trim()) {
        const normId = tool.id.trim();
        if (seenIds.has(normId)) {
          pushError(
            errors,
            `${prefix}id`,
            `Duplicate tool id "${normId}" (first seen at index ${seenIds.get(normId)})`,
            'DUPLICATE_ID'
          );
        } else {
          seenIds.set(normId, i);
        }
      }
    }
  }

  return createResult(errors);
}

// ----------------------------------------------------------------------------
// 4. Settings Validation
// ----------------------------------------------------------------------------

/**
 * Validates settings.json object structure.
 * Preserves custom/unknown fields without removing them.
 */
export function validateSettings(settings) {
  const errors = [];

  if (!isPlainObject(settings)) {
    pushError(errors, 'settings', 'Settings must be a valid JSON object', 'INVALID_TYPE');
    return createResult(errors);
  }

  // siteTitle
  if (typeof settings.siteTitle !== 'string' || !settings.siteTitle.trim()) {
    pushError(errors, 'siteTitle', 'siteTitle is required', 'REQUIRED');
  }

  // siteTagline
  if (typeof settings.siteTagline !== 'string') {
    pushError(errors, 'siteTagline', 'siteTagline must be a string', 'INVALID_TYPE');
  }

  // siteDescription
  if (typeof settings.siteDescription !== 'string' || !settings.siteDescription.trim()) {
    pushError(errors, 'siteDescription', 'siteDescription is required', 'REQUIRED');
  }

  // authorName
  if (typeof settings.authorName !== 'string' || !settings.authorName.trim()) {
    pushError(errors, 'authorName', 'authorName is required', 'REQUIRED');
  }

  // contactEmail
  if (typeof settings.contactEmail !== 'string' || !settings.contactEmail.trim()) {
    pushError(errors, 'contactEmail', 'contactEmail is required', 'REQUIRED');
  } else if (!isValidEmail(settings.contactEmail)) {
    pushError(
      errors,
      'contactEmail',
      'contactEmail must be a valid email address',
      'INVALID_EMAIL'
    );
  }

  // productionUrl (Required by postbuild.mjs line 56-59)
  if (typeof settings.productionUrl !== 'string' || !settings.productionUrl.trim()) {
    pushError(errors, 'productionUrl', 'productionUrl is required', 'REQUIRED');
  } else if (!isValidHttpOriginUrl(settings.productionUrl)) {
    pushError(
      errors,
      'productionUrl',
      'productionUrl must be a valid HTTP or HTTPS origin URL without a path, query, or fragment (e.g., https://example.com)',
      'INVALID_URL'
    );
  }

  // githubRepo (optional string)
  if ('githubRepo' in settings && settings.githubRepo !== undefined) {
    if (typeof settings.githubRepo !== 'string') {
      pushError(errors, 'githubRepo', 'githubRepo must be a string', 'INVALID_TYPE');
    }
  }

  // githubBranch (optional string)
  if ('githubBranch' in settings && settings.githubBranch !== undefined) {
    if (typeof settings.githubBranch !== 'string') {
      pushError(errors, 'githubBranch', 'githubBranch must be a string', 'INVALID_TYPE');
    }
  }

  // socialLinks (object)
  if ('socialLinks' in settings && settings.socialLinks !== undefined) {
    if (!isPlainObject(settings.socialLinks)) {
      pushError(errors, 'socialLinks', 'socialLinks must be an object', 'INVALID_TYPE');
    } else {
      for (const [key, val] of Object.entries(settings.socialLinks)) {
        if (typeof val !== 'string') {
          pushError(
            errors,
            `socialLinks.${key}`,
            `socialLinks.${key} must be a string`,
            'INVALID_TYPE'
          );
        } else if (val.trim()) {
          if (key === 'rss') {
            if (!isValidAssetPathOrUrl(val)) {
              pushError(
                errors,
                'socialLinks.rss',
                'RSS link must be a valid path (e.g. /rss.xml) or absolute URL',
                'INVALID_URL'
              );
            }
          } else if (!isValidHttpUrl(val)) {
            pushError(
              errors,
              `socialLinks.${key}`,
              `socialLinks.${key} must be a valid absolute URL`,
              'INVALID_URL'
            );
          }
        }
      }
    }
  }

  // defaultOgImage
  if (typeof settings.defaultOgImage !== 'string' || !settings.defaultOgImage.trim()) {
    pushError(errors, 'defaultOgImage', 'defaultOgImage is required', 'REQUIRED');
  } else if (!isValidAssetPathOrUrl(settings.defaultOgImage)) {
    pushError(
      errors,
      'defaultOgImage',
      'defaultOgImage must be a valid path starting with "/" or an absolute URL',
      'INVALID_URL'
    );
  }

  // googleAnalyticsId
  if ('googleAnalyticsId' in settings && settings.googleAnalyticsId !== undefined) {
    if (typeof settings.googleAnalyticsId !== 'string') {
      pushError(
        errors,
        'googleAnalyticsId',
        'googleAnalyticsId must be a string',
        'INVALID_TYPE'
      );
    }
  }

  // monetizationNotice
  if (typeof settings.monetizationNotice !== 'string') {
    pushError(
      errors,
      'monetizationNotice',
      'monetizationNotice must be a string',
      'INVALID_TYPE'
    );
  }

  // footerCopyright
  if (typeof settings.footerCopyright !== 'string') {
    pushError(
      errors,
      'footerCopyright',
      'footerCopyright must be a string',
      'INVALID_TYPE'
    );
  }

  return createResult(errors);
}

// ----------------------------------------------------------------------------
// 5. Ads Validation
// ----------------------------------------------------------------------------

/**
 * Validates ads.json object structure.
 * Preserves custom/unknown fields without removing them.
 */
export function validateAds(ads) {
  const errors = [];

  if (!isPlainObject(ads)) {
    pushError(errors, 'ads', 'Ads configuration must be a valid JSON object', 'INVALID_TYPE');
    return createResult(errors);
  }

  // enabled
  if (typeof ads.enabled !== 'boolean') {
    pushError(errors, 'enabled', 'enabled must be a boolean', 'INVALID_TYPE');
  }

  // publisherId
  if (typeof ads.publisherId !== 'string') {
    pushError(errors, 'publisherId', 'publisherId must be a string', 'INVALID_TYPE');
  }

  // autoAds
  if (typeof ads.autoAds !== 'boolean') {
    pushError(errors, 'autoAds', 'autoAds must be a boolean', 'INVALID_TYPE');
  }

  // testMode
  if (typeof ads.testMode !== 'boolean') {
    pushError(errors, 'testMode', 'testMode must be a boolean', 'INVALID_TYPE');
  }

  // adsTxtContent
  if (typeof ads.adsTxtContent !== 'string') {
    pushError(errors, 'adsTxtContent', 'adsTxtContent must be a string', 'INVALID_TYPE');
  }

  // slots
  if ('slots' in ads && ads.slots !== undefined) {
    if (!isPlainObject(ads.slots)) {
      pushError(errors, 'slots', 'slots must be an object', 'INVALID_TYPE');
    } else {
      for (const [slotKey, slot] of Object.entries(ads.slots)) {
        const prefix = `slots.${slotKey}.`;
        if (!isPlainObject(slot)) {
          pushError(
            errors,
            `slots.${slotKey}`,
            `Slot "${slotKey}" must be a valid object`,
            'INVALID_TYPE'
          );
          continue;
        }

        // id
        if (typeof slot.id !== 'string' || !slot.id.trim()) {
          pushError(errors, `${prefix}id`, 'Slot id is required', 'REQUIRED');
        }

        // name
        if (typeof slot.name !== 'string' || !slot.name.trim()) {
          pushError(errors, `${prefix}name`, 'Slot name is required', 'REQUIRED');
        }

        // description
        if (typeof slot.description !== 'string') {
          pushError(
            errors,
            `${prefix}description`,
            'Slot description must be a string',
            'INVALID_TYPE'
          );
        }

        // enabled
        if (typeof slot.enabled !== 'boolean') {
          pushError(
            errors,
            `${prefix}enabled`,
            'Slot enabled must be a boolean',
            'INVALID_TYPE'
          );
        }

        // slotId
        if (typeof slot.slotId !== 'string') {
          pushError(
            errors,
            `${prefix}slotId`,
            'Slot slotId must be a string',
            'INVALID_TYPE'
          );
        }

        // format
        if (typeof slot.format !== 'string' || !slot.format.trim()) {
          pushError(errors, `${prefix}format`, 'Slot format is required', 'REQUIRED');
        } else if (!ALLOWED_AD_FORMATS.includes(slot.format)) {
          pushError(
            errors,
            `${prefix}format`,
            `Slot format must be one of: ${ALLOWED_AD_FORMATS.join(', ')}`,
            'INVALID_FORMAT'
          );
        }

        // customCode
        if (typeof slot.customCode !== 'string') {
          pushError(
            errors,
            `${prefix}customCode`,
            'Slot customCode must be a string',
            'INVALID_TYPE'
          );
        }

        // label
        if (typeof slot.label !== 'boolean') {
          pushError(
            errors,
            `${prefix}label`,
            'Slot label must be a boolean',
            'INVALID_TYPE'
          );
        }
      }
    }
  }

  return createResult(errors);
}

// ----------------------------------------------------------------------------
// 6. Global & Page-Level SEO Validation (Task 113)
// ----------------------------------------------------------------------------

export const ALLOWED_SEO_PAGE_TYPES = Object.freeze([
  'home',
  'article',
  'category',
  'tool',
  'author',
  'about',
  'contact',
  'privacy',
  'terms',
  'static',
]);

export const ALLOWED_SEO_SCHEMA_TYPES = Object.freeze([
  'WebPage',
  'WebSite',
  'Article',
  'BlogPosting',
  'NewsArticle',
  'CollectionPage',
  'ItemList',
  'ProfilePage',
  'AboutPage',
  'ContactPage',
  'FAQPage',
  'SoftwareApplication',
  'Product',
  'Review',
  'Custom',
]);

export const ALLOWED_SEO_OG_TYPES = Object.freeze([
  'website',
  'article',
  'profile',
]);

export const ALLOWED_SEO_TWITTER_CARDS = Object.freeze([
  'summary',
  'summary_large_image',
]);

export const ALLOWED_SEO_MAX_IMAGE_PREVIEW = Object.freeze([
  'none',
  'standard',
  'large',
]);

export const MAX_SEO_PAGES = 5000;
export const MAX_SEO_SECONDARY_KEYWORDS = 25;
export const MAX_SEO_BREADCRUMB_ITEMS = 10;
export const MAX_SEO_CUSTOM_IMAGE_ALTS = 20;
export const MAX_SEO_STRUCTURED_DATA_DEPTH = 6;
export const MAX_SEO_STRUCTURED_DATA_BYTES = 16384;

const SEO_PROTO_POLLUTION_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const SEO_SINGLE_LINE_CONTROL_REGEX = /[\u0000-\u001F\u007F-\u009F]/;
const SEO_DANGEROUS_MARKUP_REGEX = /<\/script|<!--|-->/i;
const SEO_DANGEROUS_SCHEME_REGEX = /^\s*(?:javascript|data|vbscript):/i;
const SEO_PAGE_ID_REGEX = /^[a-z0-9][a-z0-9:_-]{0,127}$/;
const SEO_PAGE_SLUG_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SEO_PAGE_PATH_REGEX =
  /^\/(?:[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?(?:\/[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?)*\/?)?$/;
const SEO_SCHEMA_TYPE_VALUE_REGEX = /^[A-Za-z][A-Za-z0-9_:-]{0,63}$/;
const SEO_IMAGE_KEY_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/;

export const ALLOWED_SEO_DEFAULTS_FIELDS = Object.freeze([
  'siteName',
  'titleTemplate',
  'defaultSeoTitle',
  'defaultMetaDescription',
  'defaultFocusKeyword',
  'defaultSecondaryKeywords',
  'defaultIndex',
  'defaultFollow',
  'defaultMaxImagePreview',
  'defaultMaxSnippet',
  'defaultMaxVideoPreview',
  'defaultOgTitle',
  'defaultOgDescription',
  'defaultOgImage',
  'defaultOgType',
  'defaultTwitterTitle',
  'defaultTwitterDescription',
  'defaultTwitterImage',
  'defaultTwitterCard',
  'defaultTwitterSite',
  'defaultSchemaType',
  'defaultBreadcrumbEnabled',
  'defaultImageAlt',
  'updatedAt',
]);

export const ALLOWED_SEO_PAGE_FIELDS = Object.freeze([
  'pageId',
  'pageType',
  'path',
  'slug',
  'seoTitle',
  'metaDescription',
  'focusKeyword',
  'secondaryKeywords',
  'canonicalUrl',
  'index',
  'follow',
  'maxImagePreview',
  'maxSnippet',
  'maxVideoPreview',
  'ogTitle',
  'ogDescription',
  'ogImage',
  'ogType',
  'twitterTitle',
  'twitterDescription',
  'twitterImage',
  'twitterCard',
  'schemaType',
  'customStructuredData',
  'breadcrumb',
  'imageAlt',
  'ogImageAlt',
  'twitterImageAlt',
  'customImageAlts',
  'createdAt',
  'updatedAt',
]);

const ALLOWED_SEO_DEFAULTS_SET = new Set(ALLOWED_SEO_DEFAULTS_FIELDS);
const ALLOWED_SEO_PAGE_SET = new Set(ALLOWED_SEO_PAGE_FIELDS);
const ALLOWED_SEO_BREADCRUMB_SET = new Set(['enabled', 'label', 'items']);
const ALLOWED_SEO_BREADCRUMB_ITEM_SET = new Set(['name', 'path']);

function isStrictPlainObject(val) {
  if (!val || typeof val !== 'object' || Array.isArray(val)) return false;
  const proto = Object.getPrototypeOf(val);
  return proto === Object.prototype || proto === null;
}

function findSeoProtoPollutionKey(root, maxDepth = 10) {
  const stack = [{ node: root, depth: 0 }];
  const seen = new WeakSet();
  while (stack.length > 0) {
    const { node, depth } = stack.pop();
    if (node === null || typeof node !== 'object') continue;
    if (depth > maxDepth) {
      return { ok: false, reason: 'excessive_depth', key: null };
    }
    if (seen.has(node)) continue;
    seen.add(node);

    if (Array.isArray(node)) {
      for (const item of node) {
        if (item !== null && typeof item === 'object') {
          if (depth + 1 > maxDepth) {
            return { ok: false, reason: 'excessive_depth', key: null };
          }
          stack.push({ node: item, depth: depth + 1 });
        }
      }
      continue;
    }

    for (const key of Object.getOwnPropertyNames(node)) {
      if (SEO_PROTO_POLLUTION_KEYS.has(key)) {
        return { ok: false, reason: 'prototype_pollution', key };
      }
      const val = node[key];
      if (val !== null && typeof val === 'object') {
        if (depth + 1 > maxDepth) {
          return { ok: false, reason: 'excessive_depth', key: null };
        }
        stack.push({ node: val, depth: depth + 1 });
      }
    }
  }
  return { ok: true, reason: null, key: null };
}

/**
 * Validates a stable SEO page ID (1-128 chars, lowercase alphanumeric, :, _, -).
 */
export function isValidSeoPageId(pageId) {
  if (typeof pageId !== 'string') return false;
  if (SEO_PROTO_POLLUTION_KEYS.has(pageId)) return false;
  return SEO_PAGE_ID_REGEX.test(pageId);
}

/**
 * Validates a page slug based on pageType.
 * Homepage allows '' or 'home'; all other page types require 1-120 char lowercase slug.
 */
export function isValidSeoPageSlug(slug, pageType = 'static') {
  if (typeof slug !== 'string') return false;
  if (pageType === 'home') {
    return slug === '' || slug === 'home';
  }
  if (slug.length < 1 || slug.length > 120) return false;
  return SEO_PAGE_SLUG_REGEX.test(slug);
}

/**
 * Validates a clean internal website route path (e.g. "/", "/about/", "/blog/my-post/", "/future/page").
 * Rejects traversal, protocol-relative URLs, query/hash, percent encoding, backslashes, whitespace, and uppercase.
 */
export function isValidSeoPagePath(rawPath) {
  if (typeof rawPath !== 'string' || rawPath.length < 1 || rawPath.length > 256) {
    return false;
  }
  if (SEO_SINGLE_LINE_CONTROL_REGEX.test(rawPath) || /\s/.test(rawPath)) {
    return false;
  }
  if (
    rawPath.includes('\\') ||
    rawPath.includes('..') ||
    rawPath.includes('//') ||
    rawPath.includes('?') ||
    rawPath.includes('#') ||
    rawPath.includes('%')
  ) {
    return false;
  }
  return SEO_PAGE_PATH_REGEX.test(rawPath);
}

/**
 * Normalizes a valid SEO page path to canonical trailing-slash form ("/" stays "/").
 * Returns null if rawPath fails strict path validation.
 */
export function normalizeSeoPagePath(rawPath) {
  if (!isValidSeoPagePath(rawPath)) return null;
  if (rawPath === '/') return '/';
  return rawPath.endsWith('/') ? rawPath : `${rawPath}/`;
}

/**
 * Validates an ISO 8601 UTC timestamp string (YYYY-MM-DDTHH:mm:ss(.sss)?Z).
 */
export function isValidIsoTimestamp(ts) {
  if (typeof ts !== 'string') return false;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(ts)) {
    return false;
  }
  const parsedMs = Date.parse(ts);
  if (!Number.isFinite(parsedMs)) return false;
  const roundTrip = new Date(parsedMs).toISOString();
  if (ts.includes('.')) {
    return roundTrip === ts;
  }
  return roundTrip.slice(0, 19) + 'Z' === ts;
}

/**
 * Iteratively validates custom structured-data JSON-LD configuration objects
 * for depth, size, prototype pollution, control characters, script breakouts, and dangerous URI schemes.
 */
export function inspectSeoStructuredDataSafety(
  value,
  maxDepth = MAX_SEO_STRUCTURED_DATA_DEPTH,
  maxBytes = MAX_SEO_STRUCTURED_DATA_BYTES
) {
  if (!isStrictPlainObject(value)) {
    return { ok: false, error: 'customStructuredData must be a plain JSON object or null' };
  }

  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return { ok: false, error: 'customStructuredData must be JSON-serializable' };
  }

  if (typeof serialized !== 'string' || Buffer.byteLength(serialized, 'utf8') > maxBytes) {
    return {
      ok: false,
      error: `customStructuredData cannot exceed ${maxBytes} bytes`,
    };
  }

  const stack = [{ node: value, depth: 0 }];
  const seen = new WeakSet();

  while (stack.length > 0) {
    const { node, depth } = stack.pop();
    if (depth > maxDepth) {
      return {
        ok: false,
        error: `customStructuredData exceeds maximum nesting depth of ${maxDepth}`,
      };
    }

    if (typeof node === 'string') {
      if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/.test(node)) {
        return {
          ok: false,
          error: 'customStructuredData contains disallowed control characters',
        };
      }
      if (SEO_DANGEROUS_MARKUP_REGEX.test(node)) {
        return {
          ok: false,
          error: 'customStructuredData cannot contain HTML script breakout or comment sequences',
        };
      }
      if (SEO_DANGEROUS_SCHEME_REGEX.test(node)) {
        return {
          ok: false,
          error: 'customStructuredData cannot contain javascript:, data:, or vbscript: URIs',
        };
      }
      continue;
    }

    if (node === null || typeof node === 'boolean') {
      continue;
    }

    if (typeof node === 'number') {
      if (!Number.isFinite(node)) {
        return { ok: false, error: 'customStructuredData cannot contain non-finite numbers' };
      }
      continue;
    }

    if (typeof node !== 'object') {
      return { ok: false, error: 'customStructuredData contains unsupported value types' };
    }

    if (seen.has(node)) {
      return { ok: false, error: 'customStructuredData cannot contain circular references' };
    }
    seen.add(node);

    if (Array.isArray(node)) {
      for (const item of node) {
        if (item !== null && typeof item === 'object' && depth + 1 > maxDepth) {
          return {
            ok: false,
            error: `customStructuredData exceeds maximum nesting depth of ${maxDepth}`,
          };
        }
        stack.push({ node: item, depth: depth + 1 });
      }
      continue;
    }

    if (!isStrictPlainObject(node)) {
      return { ok: false, error: 'customStructuredData must contain only plain JSON objects' };
    }

    for (const key of Object.getOwnPropertyNames(node)) {
      if (SEO_PROTO_POLLUTION_KEYS.has(key)) {
        return { ok: false, error: `Forbidden prototype pollution key: "${key}"` };
      }
      if (SEO_SINGLE_LINE_CONTROL_REGEX.test(key)) {
        return { ok: false, error: 'customStructuredData key contains disallowed control characters' };
      }
      const val = node[key];
      if (val !== null && typeof val === 'object' && depth + 1 > maxDepth) {
        return {
          ok: false,
          error: `customStructuredData exceeds maximum nesting depth of ${maxDepth}`,
        };
      }
      stack.push({ node: val, depth: depth + 1 });
    }
  }

  if (Object.prototype.hasOwnProperty.call(value, '@context') && value['@context'] !== undefined) {
    const ctx = value['@context'];
    if (
      typeof ctx !== 'string' ||
      (!['https://schema.org', 'http://schema.org', 'https://schema.org/', 'http://schema.org/'].includes(ctx) &&
        !isValidHttpUrl(ctx))
    ) {
      return {
        ok: false,
        error: 'customStructuredData.@context must be https://schema.org or a valid HTTP/HTTPS URL',
      };
    }
  }

  if (Object.prototype.hasOwnProperty.call(value, '@type') && value['@type'] !== undefined) {
    const t = value['@type'];
    const validSingleType = (v) => typeof v === 'string' && SEO_SCHEMA_TYPE_VALUE_REGEX.test(v);
    if (Array.isArray(t)) {
      if (t.length === 0 || !t.every(validSingleType)) {
        return {
          ok: false,
          error: 'customStructuredData.@type array must contain valid Schema.org type names',
        };
      }
    } else if (!validSingleType(t)) {
      return {
        ok: false,
        error: 'customStructuredData.@type must be a valid Schema.org type name',
      };
    }
  }

  return { ok: true, error: null };
}

function validateSeoStringField(
  errors,
  fieldPath,
  value,
  { required = false, nullable = true, minLen = 1, maxLen = 300, allowEmpty = false } = {}
) {
  if (value === undefined) {
    if (required) {
      pushError(errors, fieldPath, `${fieldPath} is required`, 'REQUIRED');
    }
    return;
  }
  if (value === null) {
    if (!nullable || required) {
      pushError(errors, fieldPath, `${fieldPath} cannot be null`, 'INVALID_TYPE');
    }
    return;
  }
  if (typeof value !== 'string') {
    pushError(errors, fieldPath, `${fieldPath} must be a string`, 'INVALID_TYPE');
    return;
  }
  if (SEO_SINGLE_LINE_CONTROL_REGEX.test(value)) {
    pushError(
      errors,
      fieldPath,
      `${fieldPath} contains disallowed control characters`,
      'INVALID_CHARACTERS'
    );
    return;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    if (allowEmpty && value.length === 0 && !required) {
      return;
    }
    pushError(
      errors,
      fieldPath,
      `${fieldPath} cannot be empty or whitespace-only`,
      required ? 'REQUIRED' : 'INVALID_LENGTH'
    );
    return;
  }
  if (trimmed.length < minLen || trimmed.length > maxLen) {
    pushError(
      errors,
      fieldPath,
      `${fieldPath} must be between ${minLen} and ${maxLen} characters`,
      'INVALID_LENGTH'
    );
  }
}

function validateSeoKeywordsArray(errors, fieldPath, value, { nullable = true } = {}) {
  if (value === undefined) return;
  if (value === null) {
    if (!nullable) {
      pushError(errors, fieldPath, `${fieldPath} cannot be null`, 'INVALID_TYPE');
    }
    return;
  }
  if (!Array.isArray(value)) {
    pushError(errors, fieldPath, `${fieldPath} must be an array of strings`, 'INVALID_TYPE');
    return;
  }
  if (value.length > MAX_SEO_SECONDARY_KEYWORDS) {
    pushError(
      errors,
      fieldPath,
      `${fieldPath} cannot exceed ${MAX_SEO_SECONDARY_KEYWORDS} keywords`,
      'LENGTH_EXCEEDED'
    );
    return;
  }
  const seen = new Set();
  for (let i = 0; i < value.length; i++) {
    const kw = value[i];
    if (typeof kw !== 'string') {
      pushError(errors, `${fieldPath}[${i}]`, 'Each keyword must be a string', 'INVALID_TYPE');
      continue;
    }
    if (SEO_SINGLE_LINE_CONTROL_REGEX.test(kw)) {
      pushError(
        errors,
        `${fieldPath}[${i}]`,
        'Keyword contains disallowed control characters',
        'INVALID_CHARACTERS'
      );
      continue;
    }
    const trimmed = kw.trim();
    if (!trimmed || trimmed.length > 100) {
      pushError(
        errors,
        `${fieldPath}[${i}]`,
        'Each keyword must be between 1 and 100 characters',
        'INVALID_LENGTH'
      );
      continue;
    }
    const lower = trimmed.toLowerCase();
    if (seen.has(lower)) {
      pushError(
        errors,
        `${fieldPath}[${i}]`,
        `Duplicate keyword "${trimmed}"`,
        'DUPLICATE_KEYWORD'
      );
    } else {
      seen.add(lower);
    }
  }
}

function validateSeoSnippetLimit(errors, fieldPath, value, { nullable = true } = {}) {
  if (value === undefined) return;
  if (value === null) {
    if (!nullable) {
      pushError(errors, fieldPath, `${fieldPath} cannot be null`, 'INVALID_TYPE');
    }
    return;
  }
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < -1 || value > 1000) {
    pushError(
      errors,
      fieldPath,
      `${fieldPath} must be an integer between -1 and 1000`,
      'INVALID_VALUE'
    );
  }
}

/**
 * Validates the global default SEO settings object (seo.defaults).
 */
export function validateSeoDefaults(defaults, options = {}) {
  const errors = [];
  const prefix = options.prefix || '';
  const isCmsInput = Boolean(options.isCmsInput);

  const safety = findSeoProtoPollutionKey(defaults, 6);
  if (!safety.ok) {
    pushError(
      errors,
      `${prefix}defaults`,
      safety.reason === 'prototype_pollution'
        ? `Forbidden prototype pollution key: "${safety.key}"`
        : 'SEO defaults exceed maximum allowed nesting depth',
      'INVALID_PAYLOAD'
    );
    return createResult(errors);
  }

  if (!isStrictPlainObject(defaults)) {
    pushError(errors, `${prefix}defaults`, 'SEO defaults must be a plain JSON object', 'INVALID_TYPE');
    return createResult(errors);
  }

  for (const key of Object.getOwnPropertyNames(defaults)) {
    if (SEO_PROTO_POLLUTION_KEYS.has(key)) {
      pushError(
        errors,
        `${prefix}${key}`,
        `Forbidden prototype pollution key: "${key}"`,
        'FORBIDDEN_FIELD'
      );
    } else if (!ALLOWED_SEO_DEFAULTS_SET.has(key)) {
      pushError(errors, `${prefix}${key}`, `Unknown SEO defaults field: "${key}"`, 'UNKNOWN_FIELD');
    }
  }

  if (isCmsInput) {
    if ('updatedAt' in defaults && defaults.updatedAt !== undefined) {
      pushError(
        errors,
        `${prefix}updatedAt`,
        'updatedAt is server-managed and cannot be provided in CMS input',
        'FORBIDDEN_FIELD'
      );
    }
  } else {
    if (typeof defaults.updatedAt !== 'string' || !isValidIsoTimestamp(defaults.updatedAt)) {
      pushError(
        errors,
        `${prefix}updatedAt`,
        'updatedAt must be a valid UTC ISO 8601 timestamp',
        'INVALID_TIMESTAMP'
      );
    }
  }

  validateSeoStringField(errors, `${prefix}siteName`, defaults.siteName, {
    required: true,
    nullable: false,
    minLen: 1,
    maxLen: 100,
  });

  validateSeoStringField(errors, `${prefix}titleTemplate`, defaults.titleTemplate, {
    required: true,
    nullable: false,
    minLen: 2,
    maxLen: 120,
  });
  if (typeof defaults.titleTemplate === 'string' && !defaults.titleTemplate.includes('%s')) {
    pushError(
      errors,
      `${prefix}titleTemplate`,
      'titleTemplate must include "%s" placeholder',
      'INVALID_FORMAT'
    );
  }

  validateSeoStringField(errors, `${prefix}defaultSeoTitle`, defaults.defaultSeoTitle, {
    required: true,
    nullable: false,
    minLen: 3,
    maxLen: 160,
  });

  validateSeoStringField(errors, `${prefix}defaultMetaDescription`, defaults.defaultMetaDescription, {
    required: true,
    nullable: false,
    minLen: 10,
    maxLen: 320,
  });

  validateSeoStringField(errors, `${prefix}defaultFocusKeyword`, defaults.defaultFocusKeyword, {
    required: false,
    nullable: true,
    minLen: 1,
    maxLen: 120,
    allowEmpty: true,
  });

  validateSeoKeywordsArray(
    errors,
    `${prefix}defaultSecondaryKeywords`,
    defaults.defaultSecondaryKeywords,
    { nullable: true }
  );

  if (typeof defaults.defaultIndex !== 'boolean') {
    pushError(errors, `${prefix}defaultIndex`, 'defaultIndex must be a boolean', 'INVALID_TYPE');
  }

  if (typeof defaults.defaultFollow !== 'boolean') {
    pushError(errors, `${prefix}defaultFollow`, 'defaultFollow must be a boolean', 'INVALID_TYPE');
  }

  if (
    'defaultMaxImagePreview' in defaults &&
    defaults.defaultMaxImagePreview !== undefined &&
    defaults.defaultMaxImagePreview !== null
  ) {
    if (
      typeof defaults.defaultMaxImagePreview !== 'string' ||
      !ALLOWED_SEO_MAX_IMAGE_PREVIEW.includes(defaults.defaultMaxImagePreview)
    ) {
      pushError(
        errors,
        `${prefix}defaultMaxImagePreview`,
        `defaultMaxImagePreview must be one of: ${ALLOWED_SEO_MAX_IMAGE_PREVIEW.join(', ')}`,
        'INVALID_VALUE'
      );
    }
  }

  validateSeoSnippetLimit(errors, `${prefix}defaultMaxSnippet`, defaults.defaultMaxSnippet);
  validateSeoSnippetLimit(
    errors,
    `${prefix}defaultMaxVideoPreview`,
    defaults.defaultMaxVideoPreview
  );

  validateSeoStringField(errors, `${prefix}defaultOgTitle`, defaults.defaultOgTitle, {
    required: false,
    nullable: true,
    minLen: 1,
    maxLen: 160,
  });

  validateSeoStringField(errors, `${prefix}defaultOgDescription`, defaults.defaultOgDescription, {
    required: false,
    nullable: true,
    minLen: 1,
    maxLen: 320,
  });

  if (typeof defaults.defaultOgImage !== 'string' || !defaults.defaultOgImage.trim()) {
    pushError(errors, `${prefix}defaultOgImage`, 'defaultOgImage is required', 'REQUIRED');
  } else if (
    SEO_SINGLE_LINE_CONTROL_REGEX.test(defaults.defaultOgImage) ||
    !isValidAssetPathOrUrl(defaults.defaultOgImage)
  ) {
    pushError(
      errors,
      `${prefix}defaultOgImage`,
      'defaultOgImage must be a valid path starting with "/" or an absolute HTTP/HTTPS URL',
      'INVALID_URL'
    );
  }

  if (
    'defaultOgType' in defaults &&
    defaults.defaultOgType !== undefined &&
    defaults.defaultOgType !== null
  ) {
    if (
      typeof defaults.defaultOgType !== 'string' ||
      !ALLOWED_SEO_OG_TYPES.includes(defaults.defaultOgType)
    ) {
      pushError(
        errors,
        `${prefix}defaultOgType`,
        `defaultOgType must be one of: ${ALLOWED_SEO_OG_TYPES.join(', ')}`,
        'INVALID_VALUE'
      );
    }
  }

  validateSeoStringField(errors, `${prefix}defaultTwitterTitle`, defaults.defaultTwitterTitle, {
    required: false,
    nullable: true,
    minLen: 1,
    maxLen: 160,
  });

  validateSeoStringField(
    errors,
    `${prefix}defaultTwitterDescription`,
    defaults.defaultTwitterDescription,
    {
      required: false,
      nullable: true,
      minLen: 1,
      maxLen: 320,
    }
  );

  if (
    'defaultTwitterImage' in defaults &&
    defaults.defaultTwitterImage !== undefined &&
    defaults.defaultTwitterImage !== null &&
    defaults.defaultTwitterImage !== ''
  ) {
    if (
      typeof defaults.defaultTwitterImage !== 'string' ||
      SEO_SINGLE_LINE_CONTROL_REGEX.test(defaults.defaultTwitterImage) ||
      !isValidAssetPathOrUrl(defaults.defaultTwitterImage)
    ) {
      pushError(
        errors,
        `${prefix}defaultTwitterImage`,
        'defaultTwitterImage must be a valid path starting with "/" or an absolute HTTP/HTTPS URL',
        'INVALID_URL'
      );
    }
  }

  if (
    'defaultTwitterCard' in defaults &&
    defaults.defaultTwitterCard !== undefined &&
    defaults.defaultTwitterCard !== null
  ) {
    if (
      typeof defaults.defaultTwitterCard !== 'string' ||
      !ALLOWED_SEO_TWITTER_CARDS.includes(defaults.defaultTwitterCard)
    ) {
      pushError(
        errors,
        `${prefix}defaultTwitterCard`,
        `defaultTwitterCard must be one of: ${ALLOWED_SEO_TWITTER_CARDS.join(', ')}`,
        'INVALID_VALUE'
      );
    }
  }

  if (
    'defaultTwitterSite' in defaults &&
    defaults.defaultTwitterSite !== undefined &&
    defaults.defaultTwitterSite !== null &&
    defaults.defaultTwitterSite !== ''
  ) {
    if (
      typeof defaults.defaultTwitterSite !== 'string' ||
      SEO_SINGLE_LINE_CONTROL_REGEX.test(defaults.defaultTwitterSite) ||
      !/^@[a-zA-Z0-9_]{1,30}$/.test(defaults.defaultTwitterSite.trim())
    ) {
      pushError(
        errors,
        `${prefix}defaultTwitterSite`,
        'defaultTwitterSite must be a valid Twitter/X handle starting with "@"',
        'INVALID_FORMAT'
      );
    }
  }

  if (
    'defaultSchemaType' in defaults &&
    defaults.defaultSchemaType !== undefined &&
    defaults.defaultSchemaType !== null
  ) {
    if (
      typeof defaults.defaultSchemaType !== 'string' ||
      !ALLOWED_SEO_SCHEMA_TYPES.includes(defaults.defaultSchemaType)
    ) {
      pushError(
        errors,
        `${prefix}defaultSchemaType`,
        `defaultSchemaType must be one of: ${ALLOWED_SEO_SCHEMA_TYPES.join(', ')}`,
        'INVALID_VALUE'
      );
    }
  }

  if (typeof defaults.defaultBreadcrumbEnabled !== 'boolean') {
    pushError(
      errors,
      `${prefix}defaultBreadcrumbEnabled`,
      'defaultBreadcrumbEnabled must be a boolean',
      'INVALID_TYPE'
    );
  }

  validateSeoStringField(errors, `${prefix}defaultImageAlt`, defaults.defaultImageAlt, {
    required: false,
    nullable: true,
    minLen: 1,
    maxLen: 300,
    allowEmpty: true,
  });

  return createResult(errors);
}

/**
 * Validates a single page-level SEO record.
 */
export function validateSeoPageRecord(page, options = {}) {
  const errors = [];
  const prefix = options.prefix || '';
  const isCmsInput = Boolean(options.isCmsInput);

  const safety = findSeoProtoPollutionKey(page, 10);
  if (!safety.ok) {
    pushError(
      errors,
      `${prefix}page`,
      safety.reason === 'prototype_pollution'
        ? `Forbidden prototype pollution key: "${safety.key}"`
        : 'Page SEO record exceeds maximum allowed nesting depth',
      'INVALID_PAYLOAD'
    );
    return createResult(errors);
  }

  if (!isStrictPlainObject(page)) {
    pushError(errors, `${prefix}page`, 'Page SEO record must be a plain JSON object', 'INVALID_TYPE');
    return createResult(errors);
  }

  for (const key of Object.getOwnPropertyNames(page)) {
    if (SEO_PROTO_POLLUTION_KEYS.has(key)) {
      pushError(
        errors,
        `${prefix}${key}`,
        `Forbidden prototype pollution key: "${key}"`,
        'FORBIDDEN_FIELD'
      );
    } else if (!ALLOWED_SEO_PAGE_SET.has(key)) {
      pushError(errors, `${prefix}${key}`, `Unknown page SEO field: "${key}"`, 'UNKNOWN_FIELD');
    }
  }

  // pageId
  if (typeof page.pageId !== 'string' || !page.pageId.trim()) {
    pushError(errors, `${prefix}pageId`, 'pageId is required', 'REQUIRED');
  } else if (!isValidSeoPageId(page.pageId)) {
    pushError(
      errors,
      `${prefix}pageId`,
      'pageId must be 1-128 lowercase alphanumeric characters, colons, underscores, or hyphens starting with alphanumeric',
      'INVALID_PAGE_ID'
    );
  }

  // pageType
  if (typeof page.pageType !== 'string' || !page.pageType.trim()) {
    pushError(errors, `${prefix}pageType`, 'pageType is required', 'REQUIRED');
  } else if (!ALLOWED_SEO_PAGE_TYPES.includes(page.pageType)) {
    pushError(
      errors,
      `${prefix}pageType`,
      `pageType must be one of: ${ALLOWED_SEO_PAGE_TYPES.join(', ')}`,
      'INVALID_PAGE_TYPE'
    );
  }

  // path
  if (typeof page.path !== 'string' || !page.path) {
    pushError(errors, `${prefix}path`, 'path is required', 'REQUIRED');
  } else if (!isValidSeoPagePath(page.path)) {
    pushError(
      errors,
      `${prefix}path`,
      'path must be a clean normalized site path starting with "/" (lowercase alphanumeric, hyphens, underscores; no traversal, query, hash, or percent encoding)',
      'INVALID_PATH'
    );
  } else {
    const normalizedPath = normalizeSeoPagePath(page.path);
    if (!isCmsInput && page.path !== normalizedPath) {
      pushError(
        errors,
        `${prefix}path`,
        `Stored path must be in canonical trailing-slash form ("${normalizedPath}")`,
        'NON_CANONICAL_PATH'
      );
    }
    if (page.pageType === 'home' && normalizedPath !== '/') {
      pushError(
        errors,
        `${prefix}path`,
        'Homepage (pageType="home") must use path "/"',
        'PATH_PAGE_TYPE_MISMATCH'
      );
    }
    if (
      typeof page.pageType === 'string' &&
      ALLOWED_SEO_PAGE_TYPES.includes(page.pageType) &&
      page.pageType !== 'home' &&
      normalizedPath === '/'
    ) {
      pushError(
        errors,
        `${prefix}path`,
        `Only pageType="home" may use root path "/" (received pageType="${page.pageType}")`,
        'PATH_PAGE_TYPE_MISMATCH'
      );
    }
  }

  // slug
  if (typeof page.slug !== 'string') {
    pushError(errors, `${prefix}slug`, 'slug must be a string', 'REQUIRED');
  } else if (!isValidSeoPageSlug(page.slug, page.pageType)) {
    pushError(
      errors,
      `${prefix}slug`,
      page.pageType === 'home'
        ? 'Homepage slug must be "" or "home"'
        : 'slug must be 1-120 lowercase alphanumeric characters with single hyphens',
      'INVALID_SLUG'
    );
  }

  // Timestamps (server-managed)
  if (isCmsInput) {
    if ('createdAt' in page && page.createdAt !== undefined) {
      pushError(
        errors,
        `${prefix}createdAt`,
        'createdAt is server-generated and cannot be provided in CMS input',
        'FORBIDDEN_FIELD'
      );
    }
    if ('updatedAt' in page && page.updatedAt !== undefined) {
      pushError(
        errors,
        `${prefix}updatedAt`,
        'updatedAt is server-generated and cannot be provided in CMS input',
        'FORBIDDEN_FIELD'
      );
    }
  } else {
    if (typeof page.createdAt !== 'string' || !isValidIsoTimestamp(page.createdAt)) {
      pushError(
        errors,
        `${prefix}createdAt`,
        'createdAt must be a valid UTC ISO 8601 timestamp',
        'INVALID_TIMESTAMP'
      );
    }
    if (typeof page.updatedAt !== 'string' || !isValidIsoTimestamp(page.updatedAt)) {
      pushError(
        errors,
        `${prefix}updatedAt`,
        'updatedAt must be a valid UTC ISO 8601 timestamp',
        'INVALID_TIMESTAMP'
      );
    }
    if (
      typeof page.createdAt === 'string' &&
      typeof page.updatedAt === 'string' &&
      isValidIsoTimestamp(page.createdAt) &&
      isValidIsoTimestamp(page.updatedAt) &&
      Date.parse(page.updatedAt) < Date.parse(page.createdAt)
    ) {
      pushError(
        errors,
        `${prefix}updatedAt`,
        'updatedAt cannot be earlier than createdAt',
        'TIMESTAMP_OUT_OF_ORDER'
      );
    }
  }

  // Optional SEO override fields
  validateSeoStringField(errors, `${prefix}seoTitle`, page.seoTitle, {
    required: false,
    nullable: true,
    minLen: 3,
    maxLen: 160,
  });

  validateSeoStringField(errors, `${prefix}metaDescription`, page.metaDescription, {
    required: false,
    nullable: true,
    minLen: 10,
    maxLen: 320,
  });

  validateSeoStringField(errors, `${prefix}focusKeyword`, page.focusKeyword, {
    required: false,
    nullable: true,
    minLen: 1,
    maxLen: 120,
  });

  validateSeoKeywordsArray(errors, `${prefix}secondaryKeywords`, page.secondaryKeywords, {
    nullable: true,
  });

  if ('canonicalUrl' in page && page.canonicalUrl !== undefined && page.canonicalUrl !== null) {
    if (typeof page.canonicalUrl !== 'string' || !isValidHttpUrl(page.canonicalUrl)) {
      pushError(
        errors,
        `${prefix}canonicalUrl`,
        'canonicalUrl must be a valid absolute HTTP or HTTPS URL (or null)',
        'INVALID_URL'
      );
    }
  }

  if ('index' in page && page.index !== undefined && page.index !== null) {
    if (typeof page.index !== 'boolean') {
      pushError(errors, `${prefix}index`, 'index must be a boolean or null', 'INVALID_TYPE');
    }
  }

  if ('follow' in page && page.follow !== undefined && page.follow !== null) {
    if (typeof page.follow !== 'boolean') {
      pushError(errors, `${prefix}follow`, 'follow must be a boolean or null', 'INVALID_TYPE');
    }
  }

  if (
    'maxImagePreview' in page &&
    page.maxImagePreview !== undefined &&
    page.maxImagePreview !== null
  ) {
    if (
      typeof page.maxImagePreview !== 'string' ||
      !ALLOWED_SEO_MAX_IMAGE_PREVIEW.includes(page.maxImagePreview)
    ) {
      pushError(
        errors,
        `${prefix}maxImagePreview`,
        `maxImagePreview must be one of: ${ALLOWED_SEO_MAX_IMAGE_PREVIEW.join(', ')}`,
        'INVALID_VALUE'
      );
    }
  }

  validateSeoSnippetLimit(errors, `${prefix}maxSnippet`, page.maxSnippet, { nullable: true });
  validateSeoSnippetLimit(errors, `${prefix}maxVideoPreview`, page.maxVideoPreview, {
    nullable: true,
  });

  // Open Graph overrides
  validateSeoStringField(errors, `${prefix}ogTitle`, page.ogTitle, {
    required: false,
    nullable: true,
    minLen: 1,
    maxLen: 160,
  });

  validateSeoStringField(errors, `${prefix}ogDescription`, page.ogDescription, {
    required: false,
    nullable: true,
    minLen: 1,
    maxLen: 320,
  });

  if ('ogImage' in page && page.ogImage !== undefined && page.ogImage !== null) {
    if (
      typeof page.ogImage !== 'string' ||
      SEO_SINGLE_LINE_CONTROL_REGEX.test(page.ogImage) ||
      !isValidAssetPathOrUrl(page.ogImage)
    ) {
      pushError(
        errors,
        `${prefix}ogImage`,
        'ogImage must be a valid path starting with "/" or an absolute HTTP/HTTPS URL (or null)',
        'INVALID_URL'
      );
    }
  }

  if ('ogType' in page && page.ogType !== undefined && page.ogType !== null) {
    if (typeof page.ogType !== 'string' || !ALLOWED_SEO_OG_TYPES.includes(page.ogType)) {
      pushError(
        errors,
        `${prefix}ogType`,
        `ogType must be one of: ${ALLOWED_SEO_OG_TYPES.join(', ')}`,
        'INVALID_VALUE'
      );
    }
  }

  // Twitter overrides
  validateSeoStringField(errors, `${prefix}twitterTitle`, page.twitterTitle, {
    required: false,
    nullable: true,
    minLen: 1,
    maxLen: 160,
  });

  validateSeoStringField(errors, `${prefix}twitterDescription`, page.twitterDescription, {
    required: false,
    nullable: true,
    minLen: 1,
    maxLen: 320,
  });

  if ('twitterImage' in page && page.twitterImage !== undefined && page.twitterImage !== null) {
    if (
      typeof page.twitterImage !== 'string' ||
      SEO_SINGLE_LINE_CONTROL_REGEX.test(page.twitterImage) ||
      !isValidAssetPathOrUrl(page.twitterImage)
    ) {
      pushError(
        errors,
        `${prefix}twitterImage`,
        'twitterImage must be a valid path starting with "/" or an absolute HTTP/HTTPS URL (or null)',
        'INVALID_URL'
      );
    }
  }

  if ('twitterCard' in page && page.twitterCard !== undefined && page.twitterCard !== null) {
    if (
      typeof page.twitterCard !== 'string' ||
      !ALLOWED_SEO_TWITTER_CARDS.includes(page.twitterCard)
    ) {
      pushError(
        errors,
        `${prefix}twitterCard`,
        `twitterCard must be one of: ${ALLOWED_SEO_TWITTER_CARDS.join(', ')}`,
        'INVALID_VALUE'
      );
    }
  }

  // Schema type & custom structured data
  if ('schemaType' in page && page.schemaType !== undefined && page.schemaType !== null) {
    if (
      typeof page.schemaType !== 'string' ||
      !ALLOWED_SEO_SCHEMA_TYPES.includes(page.schemaType)
    ) {
      pushError(
        errors,
        `${prefix}schemaType`,
        `schemaType must be one of: ${ALLOWED_SEO_SCHEMA_TYPES.join(', ')}`,
        'INVALID_VALUE'
      );
    }
  }

  if (
    'customStructuredData' in page &&
    page.customStructuredData !== undefined &&
    page.customStructuredData !== null
  ) {
    const sdCheck = inspectSeoStructuredDataSafety(page.customStructuredData);
    if (!sdCheck.ok) {
      pushError(
        errors,
        `${prefix}customStructuredData`,
        sdCheck.error || 'Invalid customStructuredData',
        'INVALID_STRUCTURED_DATA'
      );
    }
  }

  // Breadcrumb configuration
  if ('breadcrumb' in page && page.breadcrumb !== undefined && page.breadcrumb !== null) {
    if (!isStrictPlainObject(page.breadcrumb)) {
      pushError(
        errors,
        `${prefix}breadcrumb`,
        'breadcrumb must be a plain JSON object or null',
        'INVALID_TYPE'
      );
    } else {
      for (const bKey of Object.getOwnPropertyNames(page.breadcrumb)) {
        if (SEO_PROTO_POLLUTION_KEYS.has(bKey)) {
          pushError(
            errors,
            `${prefix}breadcrumb.${bKey}`,
            `Forbidden prototype pollution key: "${bKey}"`,
            'FORBIDDEN_FIELD'
          );
        } else if (!ALLOWED_SEO_BREADCRUMB_SET.has(bKey)) {
          pushError(
            errors,
            `${prefix}breadcrumb.${bKey}`,
            `Unknown breadcrumb field: "${bKey}"`,
            'UNKNOWN_FIELD'
          );
        }
      }

      if (
        'enabled' in page.breadcrumb &&
        page.breadcrumb.enabled !== undefined &&
        typeof page.breadcrumb.enabled !== 'boolean'
      ) {
        pushError(
          errors,
          `${prefix}breadcrumb.enabled`,
          'breadcrumb.enabled must be a boolean',
          'INVALID_TYPE'
        );
      }

      validateSeoStringField(errors, `${prefix}breadcrumb.label`, page.breadcrumb.label, {
        required: false,
        nullable: true,
        minLen: 1,
        maxLen: 100,
      });

      if (
        'items' in page.breadcrumb &&
        page.breadcrumb.items !== undefined &&
        page.breadcrumb.items !== null
      ) {
        if (!Array.isArray(page.breadcrumb.items)) {
          pushError(
            errors,
            `${prefix}breadcrumb.items`,
            'breadcrumb.items must be an array or null',
            'INVALID_TYPE'
          );
        } else if (page.breadcrumb.items.length > MAX_SEO_BREADCRUMB_ITEMS) {
          pushError(
            errors,
            `${prefix}breadcrumb.items`,
            `breadcrumb.items cannot exceed ${MAX_SEO_BREADCRUMB_ITEMS} items`,
            'LENGTH_EXCEEDED'
          );
        } else {
          for (let i = 0; i < page.breadcrumb.items.length; i++) {
            const item = page.breadcrumb.items[i];
            const itemPrefix = `${prefix}breadcrumb.items[${i}].`;
            if (!isStrictPlainObject(item)) {
              pushError(
                errors,
                `${prefix}breadcrumb.items[${i}]`,
                'Each breadcrumb item must be an object',
                'INVALID_TYPE'
              );
              continue;
            }
            for (const iKey of Object.getOwnPropertyNames(item)) {
              if (!ALLOWED_SEO_BREADCRUMB_ITEM_SET.has(iKey)) {
                pushError(
                  errors,
                  `${itemPrefix}${iKey}`,
                  `Unknown breadcrumb item field: "${iKey}"`,
                  'UNKNOWN_FIELD'
                );
              }
            }
            validateSeoStringField(errors, `${itemPrefix}name`, item.name, {
              required: true,
              nullable: false,
              minLen: 1,
              maxLen: 100,
            });
            if (typeof item.path !== 'string' || !isValidSeoPagePath(item.path)) {
              pushError(
                errors,
                `${itemPrefix}path`,
                'Breadcrumb item path must be a valid site path starting with "/"',
                'INVALID_PATH'
              );
            }
          }
        }
      }
    }
  }

  // Image alt-text metadata
  validateSeoStringField(errors, `${prefix}imageAlt`, page.imageAlt, {
    required: false,
    nullable: true,
    minLen: 1,
    maxLen: 300,
  });

  validateSeoStringField(errors, `${prefix}ogImageAlt`, page.ogImageAlt, {
    required: false,
    nullable: true,
    minLen: 1,
    maxLen: 300,
  });

  validateSeoStringField(errors, `${prefix}twitterImageAlt`, page.twitterImageAlt, {
    required: false,
    nullable: true,
    minLen: 1,
    maxLen: 300,
  });

  if (
    'customImageAlts' in page &&
    page.customImageAlts !== undefined &&
    page.customImageAlts !== null
  ) {
    if (!isStrictPlainObject(page.customImageAlts)) {
      pushError(
        errors,
        `${prefix}customImageAlts`,
        'customImageAlts must be a plain object mapping image keys to alt text strings',
        'INVALID_TYPE'
      );
    } else {
      const entries = Object.getOwnPropertyNames(page.customImageAlts);
      if (entries.length > MAX_SEO_CUSTOM_IMAGE_ALTS) {
        pushError(
          errors,
          `${prefix}customImageAlts`,
          `customImageAlts cannot exceed ${MAX_SEO_CUSTOM_IMAGE_ALTS} entries`,
          'LENGTH_EXCEEDED'
        );
      } else {
        for (const imgKey of entries) {
          if (SEO_PROTO_POLLUTION_KEYS.has(imgKey) || !SEO_IMAGE_KEY_REGEX.test(imgKey)) {
            pushError(
              errors,
              `${prefix}customImageAlts.${imgKey}`,
              `Invalid image key "${imgKey}" in customImageAlts`,
              'INVALID_KEY'
            );
            continue;
          }
          validateSeoStringField(
            errors,
            `${prefix}customImageAlts.${imgKey}`,
            page.customImageAlts[imgKey],
            {
              required: true,
              nullable: false,
              minLen: 1,
              maxLen: 300,
            }
          );
        }
      }
    }
  }

  return createResult(errors);
}

/**
 * Validates the complete content/seo.json store structure.
 * Enforces unique pageIds (key === record.pageId), unique normalized paths across all pages,
 * valid global defaults, and valid timestamps.
 */
export function validateSeoConfig(seoConfig, options = {}) {
  const errors = [];

  const safety = findSeoProtoPollutionKey(seoConfig, 12);
  if (!safety.ok) {
    pushError(
      errors,
      'seo',
      safety.reason === 'prototype_pollution'
        ? `Forbidden prototype pollution key: "${safety.key}"`
        : 'SEO configuration exceeds maximum allowed nesting depth',
      'INVALID_PAYLOAD'
    );
    return createResult(errors);
  }

  if (!isStrictPlainObject(seoConfig)) {
    pushError(errors, 'seo', 'SEO configuration must be a plain JSON object', 'INVALID_TYPE');
    return createResult(errors);
  }

  const ALLOWED_ROOT_KEYS = new Set(['version', 'updatedAt', 'defaults', 'pages']);
  for (const key of Object.getOwnPropertyNames(seoConfig)) {
    if (!ALLOWED_ROOT_KEYS.has(key)) {
      pushError(errors, key, `Unknown SEO configuration field: "${key}"`, 'UNKNOWN_FIELD');
    }
  }

  if (
    typeof seoConfig.version !== 'number' ||
    !Number.isSafeInteger(seoConfig.version) ||
    seoConfig.version < 1
  ) {
    pushError(errors, 'version', 'SEO configuration version must be an integer >= 1', 'INVALID_VALUE');
  }

  if (typeof seoConfig.updatedAt !== 'string' || !isValidIsoTimestamp(seoConfig.updatedAt)) {
    pushError(
      errors,
      'updatedAt',
      'SEO configuration updatedAt must be a valid UTC ISO 8601 timestamp',
      'INVALID_TIMESTAMP'
    );
  }

  if (!('defaults' in seoConfig) || !isStrictPlainObject(seoConfig.defaults)) {
    pushError(errors, 'defaults', 'SEO defaults object is required', 'REQUIRED');
  } else {
    const defRes = validateSeoDefaults(seoConfig.defaults, {
      isCmsInput: Boolean(options.isCmsInput),
      prefix: 'defaults.',
    });
    if (!defRes.isValid) {
      errors.push(...defRes.errors);
    }
  }

  if (!('pages' in seoConfig) || !isStrictPlainObject(seoConfig.pages)) {
    pushError(errors, 'pages', 'SEO pages map must be a plain JSON object', 'REQUIRED');
  } else {
    const pageKeys = Object.getOwnPropertyNames(seoConfig.pages);
    if (pageKeys.length > MAX_SEO_PAGES) {
      pushError(
        errors,
        'pages',
        `SEO pages map cannot exceed ${MAX_SEO_PAGES} entries`,
        'LENGTH_EXCEEDED'
      );
    } else {
      const seenPaths = new Map();
      for (const pageKey of pageKeys) {
        if (!isValidSeoPageId(pageKey)) {
          pushError(
            errors,
            `pages.${pageKey}`,
            `Invalid page key "${pageKey}" in SEO pages map`,
            'INVALID_PAGE_ID'
          );
          continue;
        }
        const record = seoConfig.pages[pageKey];
        const pageRes = validateSeoPageRecord(record, {
          isCmsInput: false,
          prefix: `pages.${pageKey}.`,
        });
        if (!pageRes.isValid) {
          errors.push(...pageRes.errors);
        }
        if (isStrictPlainObject(record)) {
          if (record.pageId !== pageKey) {
            pushError(
              errors,
              `pages.${pageKey}.pageId`,
              `Page key "${pageKey}" must match record.pageId ("${record.pageId}")`,
              'PAGE_ID_MISMATCH'
            );
          }
          const normPath = normalizeSeoPagePath(record.path);
          if (normPath) {
            if (seenPaths.has(normPath)) {
              pushError(
                errors,
                `pages.${pageKey}.path`,
                `Duplicate SEO page path "${normPath}" (already assigned to pageId "${seenPaths.get(normPath)}")`,
                'DUPLICATE_PATH'
              );
            } else {
              seenPaths.set(normPath, pageKey);
            }
          }
        }
      }
    }
  }

  return createResult(errors);
}

/**
 * Resolves effective SEO metadata by merging global defaults with an optional page-level override record.
 * Never mutates either input object.
 */
export function resolveEffectiveSeo(pageRecord, defaults, fallbackPath = '/') {
  const safeDefaults = isStrictPlainObject(defaults) ? defaults : {};
  const safePage = isStrictPlainObject(pageRecord) ? pageRecord : null;
  const resolvedPath = safePage?.path
    ? normalizeSeoPagePath(safePage.path) || fallbackPath
    : normalizeSeoPagePath(fallbackPath) || '/';

  const seoTitle =
    safePage && typeof safePage.seoTitle === 'string' && safePage.seoTitle.trim()
      ? safePage.seoTitle
      : safeDefaults.defaultSeoTitle || '';

  const metaDescription =
    safePage && typeof safePage.metaDescription === 'string' && safePage.metaDescription.trim()
      ? safePage.metaDescription
      : safeDefaults.defaultMetaDescription || '';

  const ogTitle =
    safePage && typeof safePage.ogTitle === 'string' && safePage.ogTitle.trim()
      ? safePage.ogTitle
      : safePage && typeof safePage.seoTitle === 'string' && safePage.seoTitle.trim()
        ? safePage.seoTitle
        : safeDefaults.defaultOgTitle || safeDefaults.defaultSeoTitle || '';

  const ogDescription =
    safePage && typeof safePage.ogDescription === 'string' && safePage.ogDescription.trim()
      ? safePage.ogDescription
      : safePage && typeof safePage.metaDescription === 'string' && safePage.metaDescription.trim()
        ? safePage.metaDescription
        : safeDefaults.defaultOgDescription || safeDefaults.defaultMetaDescription || '';

  const ogImage =
    safePage && typeof safePage.ogImage === 'string' && safePage.ogImage.trim()
      ? safePage.ogImage
      : safeDefaults.defaultOgImage || '';

  const twitterTitle =
    safePage && typeof safePage.twitterTitle === 'string' && safePage.twitterTitle.trim()
      ? safePage.twitterTitle
      : ogTitle;

  const twitterDescription =
    safePage && typeof safePage.twitterDescription === 'string' && safePage.twitterDescription.trim()
      ? safePage.twitterDescription
      : ogDescription;

  const twitterImage =
    safePage && typeof safePage.twitterImage === 'string' && safePage.twitterImage.trim()
      ? safePage.twitterImage
      : safePage && typeof safePage.ogImage === 'string' && safePage.ogImage.trim()
        ? safePage.ogImage
        : safeDefaults.defaultTwitterImage || safeDefaults.defaultOgImage || '';

  const imageAlt =
    safePage && typeof safePage.imageAlt === 'string' && safePage.imageAlt.trim()
      ? safePage.imageAlt
      : safeDefaults.defaultImageAlt || '';

  const ogImageAlt =
    safePage && typeof safePage.ogImageAlt === 'string' && safePage.ogImageAlt.trim()
      ? safePage.ogImageAlt
      : imageAlt;

  const twitterImageAlt =
    safePage && typeof safePage.twitterImageAlt === 'string' && safePage.twitterImageAlt.trim()
      ? safePage.twitterImageAlt
      : imageAlt;

  const breadcrumbEnabled =
    safePage?.breadcrumb && typeof safePage.breadcrumb.enabled === 'boolean'
      ? safePage.breadcrumb.enabled
      : typeof safeDefaults.defaultBreadcrumbEnabled === 'boolean'
        ? safeDefaults.defaultBreadcrumbEnabled
        : true;

  return {
    pageId: safePage?.pageId ?? null,
    pageType: safePage?.pageType ?? (resolvedPath === '/' ? 'home' : 'static'),
    path: resolvedPath,
    slug: safePage?.slug ?? (resolvedPath === '/' ? 'home' : ''),
    seoTitle,
    metaDescription,
    focusKeyword:
      safePage && typeof safePage.focusKeyword === 'string'
        ? safePage.focusKeyword
        : safeDefaults.defaultFocusKeyword || '',
    secondaryKeywords: Array.isArray(safePage?.secondaryKeywords)
      ? [...safePage.secondaryKeywords]
      : Array.isArray(safeDefaults.defaultSecondaryKeywords)
        ? [...safeDefaults.defaultSecondaryKeywords]
        : [],
    canonicalUrl: safePage?.canonicalUrl ?? null,
    index:
      safePage && typeof safePage.index === 'boolean'
        ? safePage.index
        : Boolean(safeDefaults.defaultIndex ?? true),
    follow:
      safePage && typeof safePage.follow === 'boolean'
        ? safePage.follow
        : Boolean(safeDefaults.defaultFollow ?? true),
    maxImagePreview:
      safePage?.maxImagePreview ?? safeDefaults.defaultMaxImagePreview ?? 'large',
    maxSnippet:
      typeof safePage?.maxSnippet === 'number'
        ? safePage.maxSnippet
        : typeof safeDefaults.defaultMaxSnippet === 'number'
          ? safeDefaults.defaultMaxSnippet
          : -1,
    maxVideoPreview:
      typeof safePage?.maxVideoPreview === 'number'
        ? safePage.maxVideoPreview
        : typeof safeDefaults.defaultMaxVideoPreview === 'number'
          ? safeDefaults.defaultMaxVideoPreview
          : -1,
    ogTitle,
    ogDescription,
    ogImage,
    ogType: safePage?.ogType ?? safeDefaults.defaultOgType ?? 'website',
    twitterTitle,
    twitterDescription,
    twitterImage,
    twitterCard:
      safePage?.twitterCard ?? safeDefaults.defaultTwitterCard ?? 'summary_large_image',
    twitterSite: safeDefaults.defaultTwitterSite || '',
    schemaType: safePage?.schemaType ?? safeDefaults.defaultSchemaType ?? 'WebPage',
    customStructuredData: safePage?.customStructuredData
      ? JSON.parse(JSON.stringify(safePage.customStructuredData))
      : null,
    breadcrumb: {
      enabled: breadcrumbEnabled,
      label: safePage?.breadcrumb?.label ?? null,
      items: Array.isArray(safePage?.breadcrumb?.items)
        ? safePage.breadcrumb.items.map((item) => ({ name: item.name, path: item.path }))
        : null,
    },
    imageAlt,
    ogImageAlt,
    twitterImageAlt,
    customImageAlts: isStrictPlainObject(safePage?.customImageAlts)
      ? { ...safePage.customImageAlts }
      : {},
    hasPageOverride: Boolean(safePage),
    updatedAt: safePage?.updatedAt ?? safeDefaults.updatedAt ?? null,
  };
}

// ----------------------------------------------------------------------------
// 6b. Custom Static Pages Validation (Task 114-H0)
// ----------------------------------------------------------------------------

export const MAX_CUSTOM_PAGES = 500;
export const MAX_CUSTOM_PAGE_CONTENT_LENGTH = 500000;

export const ALLOWED_CUSTOM_PAGE_FIELDS = Object.freeze([
  'id',
  'slug',
  'title',
  'content',
  'isPublished',
  'createdAt',
  'updatedAt',
]);

const ALLOWED_CUSTOM_PAGE_SET = new Set(ALLOWED_CUSTOM_PAGE_FIELDS);

export const FORBIDDEN_CUSTOM_PAGE_SEO_FIELDS = Object.freeze([
  ...ALLOWED_SEO_PAGE_FIELDS.filter((f) => !ALLOWED_CUSTOM_PAGE_SET.has(f)),
  'seo',
  'meta',
  'metaTitle',
  'primaryKeyword',
  'robots',
  'keywords',
]);

const FORBIDDEN_CUSTOM_PAGE_SEO_SET = new Set(FORBIDDEN_CUSTOM_PAGE_SEO_FIELDS);

/**
 * Reserved routes and route prefixes that custom static pages must never shadow.
 * Derived from src/App.tsx routes, netlify.toml redirects/headers, public/ static assets,
 * and backend API/CMS endpoints.
 */
export const RESERVED_PAGE_SLUGS = Object.freeze([
  'tools',
  'blog',
  'categories',
  'category',
  'author',
  'authors',
  'about',
  'contact',
  'privacy',
  'terms',
  'editorial-policy',
  'affiliate-disclosure',
  '404',
  'api',
  'assets',
  'images',
  'cms',
  'admin',
  'auth',
  'home',
  'index',
  'search',
  'rss',
  'sitemap',
  'robots',
  'ads',
  'llms',
  'favicon',
  'not-found',
  'best-ai-tools-bulk-product-catalog-enrichment',
  'rss.xml',
  'sitemap.xml',
  'robots.txt',
  'ads.txt',
  'llms.txt',
  'index.html',
  '404.html',
  'favicon.ico',
  'favicon.svg',
  'apple-touch-icon.png',
  'logo-512.png',
  'c49a629b37c0411eb31a896d8e20791d.txt',
]);

const RESERVED_PAGE_SLUG_SET = new Set(RESERVED_PAGE_SLUGS);

export const RESERVED_PAGE_ROUTES = Object.freeze([
  '/',
  '/tools',
  '/blog',
  '/categories',
  '/category',
  '/author',
  '/about',
  '/contact',
  '/privacy',
  '/terms',
  '/editorial-policy',
  '/affiliate-disclosure',
  '/404',
  '/api',
  '/assets',
  '/images',
  '/best-ai-tools-bulk-product-catalog-enrichment',
]);

const CUSTOM_PAGE_ID_REGEX = /^[a-z0-9][a-z0-9_-]{0,127}$/;
const CUSTOM_PAGE_SLUG_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CUSTOM_PAGE_MULTILINE_CONTROL_REGEX = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/;
const CUSTOM_PAGE_UNSAFE_HTML_TAG_REGEX =
  /<\/?\s*(?:script|iframe|object|embed|applet|base|meta)\b/i;
const CUSTOM_PAGE_UNSAFE_EVENT_ATTR_REGEX = /<[a-z][^>]*\bon[a-z]+\s*=/i;
const CUSTOM_PAGE_UNSAFE_URI_REGEX = /(?:javascript|vbscript):|data\s*:\s*text\/html/i;

/**
 * Checks whether a slug or route path collides with a reserved site route or prefix.
 */
export function isReservedPageSlug(slugOrPath) {
  if (typeof slugOrPath !== 'string') return true;
  if (SEO_SINGLE_LINE_CONTROL_REGEX.test(slugOrPath) || /\s/.test(slugOrPath)) {
    return true;
  }
  const normalized = slugOrPath.trim().replace(/^\/+|\/+$/g, '').toLowerCase();
  if (!normalized) {
    return true;
  }
  if (RESERVED_PAGE_SLUG_SET.has(normalized)) {
    return true;
  }
  const firstSegment = normalized.split('/')[0];
  return RESERVED_PAGE_SLUG_SET.has(firstSegment);
}

/**
 * Validates a custom page ID:
 * - string, 1..128 chars
 * - lowercase alphanumeric start, then [a-z0-9_-]
 * - never prototype pollution key
 */
export function isValidCustomPageId(id) {
  if (typeof id !== 'string') return false;
  if (SEO_PROTO_POLLUTION_KEYS.has(id)) return false;
  return CUSTOM_PAGE_ID_REGEX.test(id);
}

/**
 * Validates a custom static page slug:
 * - strictly 2..80 chars lowercase [a-z0-9] with single hyphens
 * - no slashes, backslashes, dots, "..", null bytes, percent encodings, underscores, or uppercase
 * - must not collide with any reserved route or prefix
 */
export function isValidCustomPageSlug(slug) {
  if (typeof slug !== 'string') return false;
  if (slug.length < 2 || slug.length > 80) return false;
  if (!CUSTOM_PAGE_SLUG_REGEX.test(slug)) return false;
  if (isReservedPageSlug(slug)) return false;
  return true;
}

/**
 * Validates Markdown content for custom static pages:
 * - non-empty string up to MAX_CUSTOM_PAGE_CONTENT_LENGTH chars
 * - rejects null bytes and disallowed control characters
 * - rejects raw unsafe HTML execution vectors (<script>, <iframe>, event attributes, javascript: URIs)
 */
export function inspectCustomPageContentSafety(content) {
  if (typeof content !== 'string') {
    return { ok: false, code: 'INVALID_TYPE', error: 'content must be a Markdown string' };
  }
  if (CUSTOM_PAGE_MULTILINE_CONTROL_REGEX.test(content)) {
    return {
      ok: false,
      code: 'INVALID_CHARACTERS',
      error: 'content contains disallowed control characters',
    };
  }
  if (!content.trim()) {
    return {
      ok: false,
      code: 'REQUIRED',
      error: 'content cannot be empty or whitespace-only',
    };
  }
  if (content.length > MAX_CUSTOM_PAGE_CONTENT_LENGTH) {
    return {
      ok: false,
      code: 'INVALID_LENGTH',
      error: `content cannot exceed ${MAX_CUSTOM_PAGE_CONTENT_LENGTH} characters`,
    };
  }
  if (
    CUSTOM_PAGE_UNSAFE_HTML_TAG_REGEX.test(content) ||
    CUSTOM_PAGE_UNSAFE_EVENT_ATTR_REGEX.test(content) ||
    CUSTOM_PAGE_UNSAFE_URI_REGEX.test(content)
  ) {
    return {
      ok: false,
      code: 'UNSAFE_CONTENT',
      error: 'content contains disallowed active HTML tags, event handlers, or unsafe URI schemes',
    };
  }
  return { ok: true, code: null, error: null };
}

/**
 * Validates a single custom static page record against content/pages.json schema.
 */
export function validateCustomPage(page, options = {}) {
  const errors = [];
  const prefix = options.prefix || '';
  const isCmsInput = Boolean(options.isCmsInput);
  const isCreate = Boolean(options.isCreate);

  const safety = findSeoProtoPollutionKey(page, 4);
  if (!safety.ok) {
    pushError(
      errors,
      `${prefix}page`,
      safety.reason === 'prototype_pollution'
        ? `Forbidden prototype pollution key: "${safety.key}"`
        : 'Custom page payload exceeds maximum allowed nesting depth',
      'INVALID_PAYLOAD'
    );
    return createResult(errors);
  }

  if (!isStrictPlainObject(page)) {
    pushError(errors, `${prefix}page`, 'Custom page must be a plain JSON object', 'INVALID_TYPE');
    return createResult(errors);
  }

  for (const key of Object.getOwnPropertyNames(page)) {
    if (SEO_PROTO_POLLUTION_KEYS.has(key)) {
      pushError(
        errors,
        `${prefix}${key}`,
        `Forbidden prototype pollution key: "${key}"`,
        'FORBIDDEN_FIELD'
      );
    } else if (FORBIDDEN_CUSTOM_PAGE_SEO_SET.has(key)) {
      pushError(
        errors,
        `${prefix}${key}`,
        `SEO field "${key}" is not allowed on custom page records; SEO is managed in content/seo.json`,
        'FORBIDDEN_SEO_FIELD'
      );
    } else if (!ALLOWED_CUSTOM_PAGE_SET.has(key)) {
      pushError(
        errors,
        `${prefix}${key}`,
        `Unknown custom page field: "${key}"`,
        'UNKNOWN_FIELD'
      );
    }
  }

  // id
  if (isCmsInput && isCreate) {
    if ('id' in page && page.id !== undefined) {
      pushError(
        errors,
        `${prefix}id`,
        'Client-supplied "id" is forbidden; id is server-generated',
        'FORBIDDEN_FIELD'
      );
    }
  } else {
    if (typeof page.id !== 'string' || !page.id.trim()) {
      pushError(errors, `${prefix}id`, 'Page id is required', 'REQUIRED');
    } else if (!isValidCustomPageId(page.id)) {
      pushError(
        errors,
        `${prefix}id`,
        'Page id must be 1-128 lowercase alphanumeric characters, hyphens, or underscores starting with alphanumeric',
        'INVALID_ID'
      );
    }
  }

  // slug
  if (typeof page.slug !== 'string' || !page.slug) {
    pushError(errors, `${prefix}slug`, 'Page slug is required', 'REQUIRED');
  } else if (!CUSTOM_PAGE_SLUG_REGEX.test(page.slug) || page.slug.length < 2 || page.slug.length > 80) {
    pushError(
      errors,
      `${prefix}slug`,
      'Page slug must be 2-80 lowercase alphanumeric characters with single hyphens',
      'INVALID_SLUG'
    );
  } else if (isReservedPageSlug(page.slug)) {
    pushError(
      errors,
      `${prefix}slug`,
      `Slug "${page.slug}" is reserved and cannot shadow an existing application route`,
      'RESERVED_SLUG'
    );
  }

  // title
  if (typeof page.title !== 'string') {
    pushError(errors, `${prefix}title`, 'Page title is required', 'REQUIRED');
  } else if (SEO_SINGLE_LINE_CONTROL_REGEX.test(page.title)) {
    pushError(
      errors,
      `${prefix}title`,
      'Page title contains disallowed control characters',
      'INVALID_CHARACTERS'
    );
  } else if (
    CUSTOM_PAGE_UNSAFE_HTML_TAG_REGEX.test(page.title) ||
    CUSTOM_PAGE_UNSAFE_EVENT_ATTR_REGEX.test(page.title)
  ) {
    pushError(
      errors,
      `${prefix}title`,
      'Page title contains disallowed active HTML tags or event handlers',
      'UNSAFE_CONTENT'
    );
  } else {
    const trimmedTitle = page.title.trim();
    if (!trimmedTitle) {
      pushError(errors, `${prefix}title`, 'Page title cannot be empty or whitespace-only', 'REQUIRED');
    } else if (trimmedTitle.length < 2 || trimmedTitle.length > 200) {
      pushError(
        errors,
        `${prefix}title`,
        'Page title must be between 2 and 200 characters',
        'INVALID_LENGTH'
      );
    }
  }

  // content
  const contentCheck = inspectCustomPageContentSafety(page.content);
  if (!contentCheck.ok) {
    pushError(errors, `${prefix}content`, contentCheck.error, contentCheck.code);
  }

  // isPublished
  if (isCmsInput && isCreate) {
    if ('isPublished' in page && page.isPublished !== undefined) {
      if (typeof page.isPublished !== 'boolean') {
        pushError(errors, `${prefix}isPublished`, 'isPublished must be a boolean', 'INVALID_TYPE');
      } else if (page.isPublished !== false) {
        pushError(
          errors,
          `${prefix}isPublished`,
          'New custom pages must default to unpublished (isPublished: false)',
          'INVALID_PUBLISH_STATE'
        );
      }
    }
  } else if (typeof page.isPublished !== 'boolean') {
    pushError(errors, `${prefix}isPublished`, 'isPublished must be a boolean', 'INVALID_TYPE');
  }

  // Timestamps (createdAt, updatedAt)
  if (isCmsInput) {
    if ('createdAt' in page && page.createdAt !== undefined) {
      pushError(
        errors,
        `${prefix}createdAt`,
        'createdAt is server-generated and cannot be provided in CMS input',
        'FORBIDDEN_FIELD'
      );
    }
    if ('updatedAt' in page && page.updatedAt !== undefined) {
      pushError(
        errors,
        `${prefix}updatedAt`,
        'updatedAt is server-generated and cannot be provided in CMS input',
        'FORBIDDEN_FIELD'
      );
    }
  } else {
    const hasValidCreated = typeof page.createdAt === 'string' && isValidIsoTimestamp(page.createdAt);
    const hasValidUpdated = typeof page.updatedAt === 'string' && isValidIsoTimestamp(page.updatedAt);

    if (!hasValidCreated) {
      pushError(
        errors,
        `${prefix}createdAt`,
        'createdAt must be a valid UTC ISO 8601 timestamp',
        'INVALID_TIMESTAMP'
      );
    }
    if (!hasValidUpdated) {
      pushError(
        errors,
        `${prefix}updatedAt`,
        'updatedAt must be a valid UTC ISO 8601 timestamp',
        'INVALID_TIMESTAMP'
      );
    }
    if (hasValidCreated && hasValidUpdated && Date.parse(page.updatedAt) < Date.parse(page.createdAt)) {
      pushError(
        errors,
        `${prefix}updatedAt`,
        'updatedAt cannot be earlier than createdAt',
        'INVALID_TIMESTAMP_ORDER'
      );
    }
  }

  return createResult(errors);
}

/**
 * Validates the complete content/pages.json store array.
 */
export function validatePages(pages, options = {}) {
  const errors = [];

  if (!Array.isArray(pages)) {
    pushError(errors, 'pages', 'Pages store must be a JSON array', 'INVALID_TYPE');
    return createResult(errors);
  }

  if (pages.length > MAX_CUSTOM_PAGES) {
    pushError(
      errors,
      'pages',
      `Pages store cannot exceed ${MAX_CUSTOM_PAGES} custom pages`,
      'LENGTH_EXCEEDED'
    );
  }

  const seenIds = new Map();
  const seenSlugs = new Map();

  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    const prefix = `pages[${i}].`;

    const itemRes = validateCustomPage(page, { ...options, isCmsInput: false, isCreate: false, prefix });
    if (!itemRes.isValid) {
      errors.push(...itemRes.errors);
    }

    if (page && typeof page === 'object' && !Array.isArray(page)) {
      if (typeof page.id === 'string' && page.id) {
        if (seenIds.has(page.id)) {
          pushError(
            errors,
            `${prefix}id`,
            `Duplicate page id "${page.id}" (first seen at index ${seenIds.get(page.id)})`,
            'DUPLICATE_ID'
          );
        } else {
          seenIds.set(page.id, i);
        }
      }
      if (typeof page.slug === 'string' && page.slug) {
        if (seenSlugs.has(page.slug)) {
          pushError(
            errors,
            `${prefix}slug`,
            `Duplicate page slug "${page.slug}" (first seen at index ${seenSlugs.get(page.slug)})`,
            'DUPLICATE_SLUG'
          );
        } else {
          seenSlugs.set(page.slug, i);
        }
      }
    }
  }

  return createResult(errors);
}

// ----------------------------------------------------------------------------
// 6b. Secure Media Library Validation & Binary Image Inspection (Task 115)
// ----------------------------------------------------------------------------

export const MAX_MEDIA_FILE_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB
export const MAX_MEDIA_IMAGE_DIMENSION = 16384;
export const MAX_MEDIA_ITEMS = 5000;
export const MAX_MEDIA_ALT_LENGTH = 300;
export const MAX_MEDIA_ORIGINAL_NAME_LENGTH = 140;
export const MEDIA_PUBLIC_URL_PREFIX = '/images/media/';

export const ALLOWED_MEDIA_MIME_TYPES = Object.freeze([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
]);

const ALLOWED_MEDIA_MIME_SET = new Set(ALLOWED_MEDIA_MIME_TYPES);

export const MEDIA_MIME_TO_EXT = Object.freeze({
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
});

export const MEDIA_EXT_TO_MIME = Object.freeze({
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
});

export const ALLOWED_MEDIA_FIELDS = Object.freeze([
  'id',
  'filename',
  'originalName',
  'url',
  'mimeType',
  'size',
  'width',
  'height',
  'checksum',
  'alt',
  'createdAt',
  'updatedAt',
]);

const ALLOWED_MEDIA_FIELD_SET = new Set(ALLOWED_MEDIA_FIELDS);
const MEDIA_ID_REGEX = /^[a-z0-9][a-z0-9_-]{0,127}$/;
const MEDIA_FILENAME_REGEX = /^[a-z0-9][a-z0-9_-]{7,127}\.(?:jpg|png|webp|gif)$/;
const MEDIA_CHECKSUM_REGEX = /^[0-9a-f]{64}$/;
const MEDIA_ALT_UNSAFE_HTML_REGEX = /<\/?\s*(?:script|iframe|object|embed|applet|svg|style)\b|<!--|-->/i;

export function isValidMediaId(id) {
  if (typeof id !== 'string') return false;
  if (SEO_PROTO_POLLUTION_KEYS.has(id)) return false;
  return MEDIA_ID_REGEX.test(id);
}

export function isValidMediaFilename(filename) {
  if (typeof filename !== 'string') return false;
  if (
    filename.includes('..') ||
    filename.includes('/') ||
    filename.includes('\\') ||
    filename.includes('\0')
  ) {
    return false;
  }
  return MEDIA_FILENAME_REGEX.test(filename);
}

export function isValidMediaPublicUrl(urlStr) {
  if (typeof urlStr !== 'string') return false;
  if (!urlStr.startsWith(MEDIA_PUBLIC_URL_PREFIX)) return false;
  const filename = urlStr.slice(MEDIA_PUBLIC_URL_PREFIX.length);
  return isValidMediaFilename(filename);
}

/**
 * Validates and sanitizes a client-provided original filename.
 * Rejects path traversal, directory separators, null bytes, control characters,
 * and mismatched/dangerous file extensions.
 */
export function sanitizeMediaOriginalFilename(rawName, expectedMimeType = null) {
  if (typeof rawName !== 'string') {
    return { ok: false, code: 'INVALID_FILENAME', error: 'Original filename must be a string' };
  }
  if (
    rawName.includes('\0') ||
    SEO_SINGLE_LINE_CONTROL_REGEX.test(rawName) ||
    rawName.includes('/') ||
    rawName.includes('\\') ||
    rawName.includes('..') ||
    /%2e/i.test(rawName) ||
    /%2f/i.test(rawName) ||
    /%5c/i.test(rawName) ||
    /%00/i.test(rawName)
  ) {
    return {
      ok: false,
      code: 'PATH_TRAVERSAL',
      error: 'Filename contains disallowed path separators, traversal sequences, or control characters',
    };
  }

  const trimmed = rawName.trim();
  if (!trimmed) {
    return { ok: false, code: 'INVALID_FILENAME', error: 'Original filename cannot be empty' };
  }

  const lastDot = trimmed.lastIndexOf('.');
  let rawStem = trimmed;
  let rawExt = '';
  if (lastDot !== -1) {
    if (lastDot === 0) {
      return { ok: false, code: 'INVALID_FILENAME', error: 'Hidden filenames without a base name are not allowed' };
    }
    rawStem = trimmed.slice(0, lastDot);
    rawExt = trimmed.slice(lastDot).toLowerCase();
  }

  if (rawExt) {
    const extMime = MEDIA_EXT_TO_MIME[rawExt] || null;
    if (!extMime) {
      return {
        ok: false,
        code: 'UNSUPPORTED_EXTENSION',
        error: `Unsupported or disallowed file extension "${rawExt}"`,
      };
    }
    if (expectedMimeType && extMime !== expectedMimeType) {
      return {
        ok: false,
        code: 'MIME_SPOOFING',
        error: `File extension "${rawExt}" does not match declared or detected media type`,
      };
    }
  }

  // Strip HTML-like tags, quotes, angle brackets, and collapse unsafe punctuation
  const strippedStem = rawStem
    .replace(/<[^>]*>/g, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/\.{2,}/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[._-]+|[._-]+$/g, '');

  const safeStem = strippedStem || 'media';
  const finalExt = rawExt || (expectedMimeType && MEDIA_MIME_TO_EXT[expectedMimeType] ? `.${MEDIA_MIME_TO_EXT[expectedMimeType]}` : '');
  const maxStemLen = Math.max(1, MAX_MEDIA_ORIGINAL_NAME_LENGTH - finalExt.length);
  const boundedStem = safeStem.slice(0, maxStemLen).replace(/[._-]+$/g, '') || 'media';
  const originalName = `${boundedStem}${finalExt}`;

  if (originalName.length > MAX_MEDIA_ORIGINAL_NAME_LENGTH) {
    return {
      ok: false,
      code: 'INVALID_FILENAME',
      error: `Sanitized filename exceeds ${MAX_MEDIA_ORIGINAL_NAME_LENGTH} characters`,
    };
  }

  return { ok: true, originalName, extension: finalExt };
}

/**
 * Validates descriptive alt text for a media record.
 */
export function validateMediaAltText(alt) {
  if (alt === undefined) {
    return { ok: true, alt: '' };
  }
  if (typeof alt !== 'string') {
    return { ok: false, error: 'alt must be a string' };
  }
  if (SEO_SINGLE_LINE_CONTROL_REGEX.test(alt)) {
    return { ok: false, error: 'alt contains disallowed control characters' };
  }
  if (MEDIA_ALT_UNSAFE_HTML_REGEX.test(alt) || SEO_DANGEROUS_SCHEME_REGEX.test(alt)) {
    return { ok: false, error: 'alt contains disallowed HTML or unsafe URI sequences' };
  }
  const trimmed = alt.trim();
  if (trimmed.length > MAX_MEDIA_ALT_LENGTH) {
    return { ok: false, error: `alt cannot exceed ${MAX_MEDIA_ALT_LENGTH} characters` };
  }
  return { ok: true, alt: trimmed };
}

function parsePngDimensionsStrict(buf) {
  if (buf.length < 33) {
    return { ok: false, error: 'PNG file is truncated' };
  }
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < sig.length; i++) {
    if (buf[i] !== sig[i]) {
      return { ok: false, error: 'Invalid PNG signature' };
    }
  }

  let offset = 8;
  let width = 0;
  let height = 0;
  let sawIHDR = false;
  let sawIDAT = false;
  let sawIEND = false;

  while (offset < buf.length) {
    if (offset + 12 > buf.length) {
      return { ok: false, error: 'Malformed or truncated PNG chunk header' };
    }
    const chunkLen = buf.readUInt32BE(offset);
    const chunkType = buf.toString('ascii', offset + 4, offset + 8);
    if (!/^[A-Za-z]{4}$/.test(chunkType)) {
      return { ok: false, error: 'Invalid PNG chunk type' };
    }
    if (chunkLen > buf.length - (offset + 12)) {
      return { ok: false, error: 'PNG chunk length exceeds buffer bounds' };
    }
    const dataOffset = offset + 8;

    if (!sawIHDR) {
      if (chunkType !== 'IHDR' || chunkLen !== 13) {
        return { ok: false, error: 'PNG must begin with a valid 13-byte IHDR chunk' };
      }
      width = buf.readUInt32BE(dataOffset);
      height = buf.readUInt32BE(dataOffset + 4);
      const bitDepth = buf[dataOffset + 8];
      const colorType = buf[dataOffset + 9];
      const compression = buf[dataOffset + 10];
      const filter = buf[dataOffset + 11];
      const interlace = buf[dataOffset + 12];
      if (
        ![1, 2, 4, 8, 16].includes(bitDepth) ||
        ![0, 2, 3, 4, 6].includes(colorType) ||
        compression !== 0 ||
        filter !== 0 ||
        (interlace !== 0 && interlace !== 1)
      ) {
        return { ok: false, error: 'Invalid PNG IHDR metadata' };
      }
      sawIHDR = true;
    } else if (chunkType === 'IDAT') {
      sawIDAT = true;
    } else if (chunkType === 'IEND') {
      if (chunkLen !== 0) {
        return { ok: false, error: 'PNG IEND chunk must have zero length' };
      }
      sawIEND = true;
      offset = dataOffset + chunkLen + 4;
      break;
    }

    offset = dataOffset + chunkLen + 4;
  }

  if (!sawIHDR || !sawIDAT || !sawIEND || offset !== buf.length) {
    return { ok: false, error: 'Incomplete PNG stream or trailing data after IEND' };
  }

  return { ok: true, width, height };
}

function parseWebpDimensionsStrict(buf) {
  if (buf.length < 20) {
    return { ok: false, error: 'WebP file is truncated' };
  }
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WEBP') {
    return { ok: false, error: 'Invalid WebP RIFF container header' };
  }
  const riffSize = buf.readUInt32LE(4);
  if (riffSize < 12) {
    return { ok: false, error: 'Invalid WebP RIFF size' };
  }
  const paddedTotal = 8 + riffSize + (riffSize % 2);
  if (8 + riffSize !== buf.length && paddedTotal !== buf.length) {
    return { ok: false, error: 'WebP RIFF size does not match actual buffer length' };
  }

  let offset = 12;
  let width = 0;
  let height = 0;
  let foundDimensions = false;

  while (offset < buf.length) {
    if (offset + 8 > buf.length) {
      return { ok: false, error: 'Truncated WebP chunk header' };
    }
    const fourcc = buf.toString('ascii', offset, offset + 4);
    const chunkSize = buf.readUInt32LE(offset + 4);
    const dataOffset = offset + 8;
    const paddedChunkSize = chunkSize + (chunkSize & 1);
    if (chunkSize > buf.length - dataOffset || paddedChunkSize > buf.length - dataOffset) {
      return { ok: false, error: 'WebP chunk extends past end of file' };
    }

    if (!foundDimensions) {
      if (fourcc === 'VP8 ') {
        if (chunkSize < 10) {
          return { ok: false, error: 'Truncated WebP VP8 chunk' };
        }
        if (
          buf[dataOffset + 3] !== 0x9d ||
          buf[dataOffset + 4] !== 0x01 ||
          buf[dataOffset + 5] !== 0x2a
        ) {
          return { ok: false, error: 'Invalid WebP VP8 keyframe sync code' };
        }
        width = buf.readUInt16LE(dataOffset + 6) & 0x3fff;
        height = buf.readUInt16LE(dataOffset + 8) & 0x3fff;
        foundDimensions = true;
      } else if (fourcc === 'VP8L') {
        if (chunkSize < 5 || buf[dataOffset] !== 0x2f) {
          return { ok: false, error: 'Invalid WebP VP8L header' };
        }
        const b = buf.readUInt32LE(dataOffset + 1);
        width = (b & 0x3fff) + 1;
        height = ((b >> 14) & 0x3fff) + 1;
        foundDimensions = true;
      } else if (fourcc === 'VP8X') {
        if (chunkSize < 10) {
          return { ok: false, error: 'Invalid WebP VP8X header' };
        }
        width = 1 + buf.readUIntLE(dataOffset + 4, 3);
        height = 1 + buf.readUIntLE(dataOffset + 7, 3);
        foundDimensions = true;
      } else {
        return { ok: false, error: 'Unsupported or missing WebP primary image chunk' };
      }
    }

    offset = dataOffset + paddedChunkSize;
  }

  if (!foundDimensions || offset !== buf.length) {
    return { ok: false, error: 'Malformed WebP chunk structure' };
  }

  return { ok: true, width, height };
}

function parseJpegDimensionsStrict(buf) {
  if (buf.length < 16) {
    return { ok: false, error: 'JPEG file is truncated' };
  }
  if (buf[0] !== 0xff || buf[1] !== 0xd8 || buf[2] !== 0xff) {
    return { ok: false, error: 'Invalid JPEG SOI header' };
  }

  let pos = 2;
  let width = 0;
  let height = 0;
  let sawSOF = false;
  let sawSOS = false;
  let sawEOI = false;

  while (pos < buf.length) {
    if (buf[pos] !== 0xff) {
      return { ok: false, error: 'Invalid JPEG marker alignment' };
    }
    while (pos < buf.length && buf[pos] === 0xff) {
      pos++;
    }
    if (pos >= buf.length) {
      return { ok: false, error: 'Unexpected end of JPEG marker stream' };
    }
    const marker = buf[pos++];

    if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      continue;
    }

    if (marker === 0xd9) {
      sawEOI = true;
      break;
    }

    if (pos + 2 > buf.length) {
      return { ok: false, error: 'Truncated JPEG marker segment length' };
    }
    const segLen = buf.readUInt16BE(pos);
    if (segLen < 2 || pos + segLen > buf.length) {
      return { ok: false, error: 'Invalid JPEG segment length' };
    }

    const isSof =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf);

    if (isSof) {
      if (segLen < 8) {
        return { ok: false, error: 'Truncated JPEG SOF frame header' };
      }
      const precision = buf[pos + 2];
      const sofHeight = buf.readUInt16BE(pos + 3);
      const sofWidth = buf.readUInt16BE(pos + 5);
      const components = buf[pos + 7];
      if (![8, 12, 16].includes(precision) || components < 1 || components > 4) {
        return { ok: false, error: 'Invalid JPEG SOF frame parameters' };
      }
      width = sofWidth;
      height = sofHeight;
      sawSOF = true;
      pos += segLen;
      continue;
    }

    if (marker === 0xda) {
      if (segLen < 6) {
        return { ok: false, error: 'Truncated JPEG SOS header' };
      }
      sawSOS = true;
      pos += segLen;

      // Scan entropy-coded scan payload until next unstuffed marker
      while (pos < buf.length) {
        if (buf[pos] !== 0xff) {
          pos++;
          continue;
        }
        let nextPos = pos + 1;
        while (nextPos < buf.length && buf[nextPos] === 0xff) {
          nextPos++;
        }
        if (nextPos >= buf.length) {
          return { ok: false, error: 'Truncated JPEG scan data' };
        }
        const scanMarker = buf[nextPos];
        if (scanMarker === 0x00 || (scanMarker >= 0xd0 && scanMarker <= 0xd7)) {
          pos = nextPos + 1;
          continue;
        }
        if (scanMarker === 0xd9) {
          pos = nextPos + 1;
          sawEOI = true;
          break;
        }
        // Multi-scan progressive JPEG marker encountered; resume marker parsing at buf[pos]
        pos = nextPos - 1;
        break;
      }

      if (sawEOI) {
        break;
      }
      continue;
    }

    pos += segLen;
  }

  if (!sawSOF || !sawSOS || !sawEOI) {
    return { ok: false, error: 'Incomplete JPEG image stream (missing SOF, SOS, or EOI)' };
  }

  const trailingLen = buf.length - pos;
  if (trailingLen > 16) {
    return { ok: false, error: 'Unexpected trailing data after JPEG EOI marker' };
  }
  for (let i = pos; i < buf.length; i++) {
    if (buf[i] !== 0x00 && buf[i] !== 0xff) {
      return { ok: false, error: 'Unexpected non-padding bytes after JPEG EOI marker' };
    }
  }

  return { ok: true, width, height };
}

function parseGifDimensionsStrict(buf) {
  if (buf.length < 19) {
    return { ok: false, error: 'GIF file is truncated' };
  }
  const header = buf.toString('ascii', 0, 6);
  if (header !== 'GIF87a' && header !== 'GIF89a') {
    return { ok: false, error: 'Invalid GIF header signature' };
  }
  const width = buf.readUInt16LE(6);
  const height = buf.readUInt16LE(8);
  const packed = buf[10];
  let pos = 13;

  if ((packed & 0x80) !== 0) {
    const gctSize = 3 * (1 << ((packed & 0x07) + 1));
    if (pos + gctSize > buf.length) {
      return { ok: false, error: 'Truncated GIF global color table' };
    }
    pos += gctSize;
  }

  let sawImage = false;
  let sawTrailer = false;

  const skipSubBlocks = () => {
    while (pos < buf.length) {
      const subLen = buf[pos++];
      if (subLen === 0) return true;
      if (pos + subLen > buf.length) return false;
      pos += subLen;
    }
    return false;
  };

  while (pos < buf.length) {
    const intro = buf[pos++];
    if (intro === 0x3b) {
      sawTrailer = true;
      break;
    }
    if (intro === 0x21) {
      if (pos >= buf.length) {
        return { ok: false, error: 'Truncated GIF extension block' };
      }
      pos++; // extension label
      if (!skipSubBlocks()) {
        return { ok: false, error: 'Malformed GIF extension sub-block' };
      }
      continue;
    }
    if (intro === 0x2c) {
      if (pos + 9 >= buf.length) {
        return { ok: false, error: 'Truncated GIF image descriptor' };
      }
      const imgPacked = buf[pos + 8];
      pos += 9;
      if ((imgPacked & 0x80) !== 0) {
        const lctSize = 3 * (1 << ((imgPacked & 0x07) + 1));
        if (pos + lctSize >= buf.length) {
          return { ok: false, error: 'Truncated GIF local color table' };
        }
        pos += lctSize;
      }
      if (pos >= buf.length) {
        return { ok: false, error: 'Missing GIF LZW minimum code size' };
      }
      const lzwMinCodeSize = buf[pos++];
      if (lzwMinCodeSize < 2 || lzwMinCodeSize > 8) {
        return { ok: false, error: 'Invalid GIF LZW minimum code size' };
      }
      if (!skipSubBlocks()) {
        return { ok: false, error: 'Malformed GIF image data sub-block' };
      }
      sawImage = true;
      continue;
    }
    return { ok: false, error: 'Invalid GIF block introducer byte' };
  }

  if (!sawImage || !sawTrailer || pos !== buf.length) {
    return { ok: false, error: 'Incomplete GIF image stream or trailing data after trailer' };
  }

  return { ok: true, width, height };
}

/**
 * Inspects actual binary buffer content to verify format, reject disguised/malformed/active files,
 * parse exact image dimensions, compute SHA-256 checksum, and detect MIME spoofing.
 */
export function inspectImageBuffer(buf, options = {}) {
  if (!Buffer.isBuffer(buf) || buf.length === 0) {
    return { ok: false, code: 'EMPTY_FILE', error: 'Uploaded file cannot be empty' };
  }
  const maxBytes =
    typeof options.maxBytes === 'number' && options.maxBytes > 0
      ? options.maxBytes
      : MAX_MEDIA_FILE_SIZE_BYTES;
  if (buf.length > maxBytes) {
    return {
      ok: false,
      code: 'FILE_TOO_LARGE',
      error: `Uploaded file exceeds maximum allowed size of ${maxBytes} bytes`,
    };
  }

  // Explicitly reject active/executable/markup signatures before container inspection
  const headText = buf.subarray(0, Math.min(buf.length, 512)).toString('utf8').trimStart().toLowerCase();
  if (
    headText.startsWith('<svg') ||
    headText.startsWith('<?xml') ||
    headText.startsWith('<!doctype') ||
    headText.startsWith('<html') ||
    headText.startsWith('<script') ||
    headText.startsWith('<?php') ||
    headText.startsWith('%pdf-') ||
    headText.startsWith('#!') ||
    (buf.length >= 2 && buf[0] === 0x4d && buf[1] === 0x5a) || // PE/MZ
    (buf.length >= 4 && buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46) || // ELF
    (buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04) // ZIP
  ) {
    return {
      ok: false,
      code: 'DISALLOWED_CONTENT',
      error: 'Disallowed file format: SVG, HTML, scripts, documents, and executables are forbidden',
    };
  }

  let detectedMime = null;
  let parsed = null;

  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    detectedMime = 'image/png';
    parsed = parsePngDimensionsStrict(buf);
  } else if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    detectedMime = 'image/jpeg';
    parsed = parseJpegDimensionsStrict(buf);
  } else if (
    buf.length >= 12 &&
    buf.toString('ascii', 0, 4) === 'RIFF' &&
    buf.toString('ascii', 8, 12) === 'WEBP'
  ) {
    detectedMime = 'image/webp';
    parsed = parseWebpDimensionsStrict(buf);
  } else if (
    buf.length >= 6 &&
    (buf.toString('ascii', 0, 6) === 'GIF87a' || buf.toString('ascii', 0, 6) === 'GIF89a')
  ) {
    detectedMime = 'image/gif';
    parsed = parseGifDimensionsStrict(buf);
  } else {
    return {
      ok: false,
      code: 'UNSUPPORTED_OR_INVALID_IMAGE',
      error: 'File content is not a valid supported image (JPEG, PNG, WebP, or GIF)',
    };
  }

  if (!parsed || !parsed.ok) {
    return {
      ok: false,
      code: 'MALFORMED_IMAGE',
      error: parsed?.error || 'Malformed or corrupted image payload',
    };
  }

  if (
    !Number.isSafeInteger(parsed.width) ||
    !Number.isSafeInteger(parsed.height) ||
    parsed.width < 1 ||
    parsed.height < 1 ||
    parsed.width > MAX_MEDIA_IMAGE_DIMENSION ||
    parsed.height > MAX_MEDIA_IMAGE_DIMENSION
  ) {
    return {
      ok: false,
      code: 'INVALID_DIMENSIONS',
      error: `Image dimensions must be between 1x1 and ${MAX_MEDIA_IMAGE_DIMENSION}x${MAX_MEDIA_IMAGE_DIMENSION}`,
    };
  }

  if (options.declaredMimeType) {
    const declared = String(options.declaredMimeType).split(';')[0].trim().toLowerCase();
    const normalizedDeclared = declared === 'image/jpg' ? 'image/jpeg' : declared;
    if (!ALLOWED_MEDIA_MIME_SET.has(normalizedDeclared)) {
      return {
        ok: false,
        code: 'UNSUPPORTED_MIME_TYPE',
        error: `Unsupported declared MIME type "${declared}"`,
      };
    }
    if (normalizedDeclared !== detectedMime) {
      return {
        ok: false,
        code: 'MIME_SPOOFING',
        error: `Declared MIME type "${declared}" does not match actual image content (${detectedMime})`,
      };
    }
  }

  const checksum = crypto.createHash('sha256').update(buf).digest('hex');

  return {
    ok: true,
    mimeType: detectedMime,
    extension: MEDIA_MIME_TO_EXT[detectedMime],
    size: buf.length,
    width: parsed.width,
    height: parsed.height,
    checksum,
  };
}

/**
 * Validates a single Media Library record against the content/media.json schema.
 */
export function validateMediaRecord(record, options = {}) {
  const errors = [];
  const prefix = options.prefix || '';

  const safety = findSeoProtoPollutionKey(record, 4);
  if (!safety.ok) {
    pushError(
      errors,
      `${prefix}media`,
      safety.reason === 'prototype_pollution'
        ? `Forbidden prototype pollution key: "${safety.key}"`
        : 'Media record exceeds maximum allowed nesting depth',
      'INVALID_PAYLOAD'
    );
    return createResult(errors);
  }

  if (!isStrictPlainObject(record)) {
    pushError(errors, `${prefix}media`, 'Media record must be a plain JSON object', 'INVALID_TYPE');
    return createResult(errors);
  }

  for (const key of Object.getOwnPropertyNames(record)) {
    if (SEO_PROTO_POLLUTION_KEYS.has(key)) {
      pushError(
        errors,
        `${prefix}${key}`,
        `Forbidden prototype pollution key: "${key}"`,
        'FORBIDDEN_FIELD'
      );
    } else if (!ALLOWED_MEDIA_FIELD_SET.has(key)) {
      pushError(errors, `${prefix}${key}`, `Unknown media field: "${key}"`, 'UNKNOWN_FIELD');
    }
  }

  if (typeof record.id !== 'string' || !isValidMediaId(record.id)) {
    pushError(errors, `${prefix}id`, 'Media id must be a valid server-generated identifier', 'INVALID_ID');
  }

  if (typeof record.filename !== 'string' || !isValidMediaFilename(record.filename)) {
    pushError(errors, `${prefix}filename`, 'Media filename must be a safe server-generated image filename', 'INVALID_FILENAME');
  }

  if (typeof record.originalName !== 'string' || !record.originalName.trim()) {
    pushError(errors, `${prefix}originalName`, 'originalName is required', 'REQUIRED');
  } else if (
    SEO_SINGLE_LINE_CONTROL_REGEX.test(record.originalName) ||
    record.originalName.includes('/') ||
    record.originalName.includes('\\') ||
    record.originalName.includes('..') ||
    record.originalName.length > MAX_MEDIA_ORIGINAL_NAME_LENGTH
  ) {
    pushError(errors, `${prefix}originalName`, 'originalName contains unsafe characters or exceeds max length', 'INVALID_FILENAME');
  }

  if (typeof record.mimeType !== 'string' || !ALLOWED_MEDIA_MIME_SET.has(record.mimeType)) {
    pushError(
      errors,
      `${prefix}mimeType`,
      `mimeType must be one of: ${ALLOWED_MEDIA_MIME_TYPES.join(', ')}`,
      'INVALID_MIME_TYPE'
    );
  } else if (typeof record.filename === 'string' && isValidMediaFilename(record.filename)) {
    const expectedExt = `.${MEDIA_MIME_TO_EXT[record.mimeType]}`;
    if (!record.filename.endsWith(expectedExt)) {
      pushError(
        errors,
        `${prefix}filename`,
        `filename extension must match verified mimeType (${expectedExt})`,
        'EXTENSION_MISMATCH'
      );
    }
  }

  if (typeof record.url !== 'string' || !isValidMediaPublicUrl(record.url)) {
    pushError(
      errors,
      `${prefix}url`,
      `url must start with "${MEDIA_PUBLIC_URL_PREFIX}" and reference a safe filename`,
      'INVALID_URL'
    );
  } else if (typeof record.filename === 'string' && record.url !== `${MEDIA_PUBLIC_URL_PREFIX}${record.filename}`) {
    pushError(
      errors,
      `${prefix}url`,
      'url must match canonical public path for filename',
      'URL_FILENAME_MISMATCH'
    );
  }

  if (
    typeof record.size !== 'number' ||
    !Number.isSafeInteger(record.size) ||
    record.size < 1 ||
    record.size > MAX_MEDIA_FILE_SIZE_BYTES
  ) {
    pushError(
      errors,
      `${prefix}size`,
      `size must be a positive integer <= ${MAX_MEDIA_FILE_SIZE_BYTES}`,
      'INVALID_SIZE'
    );
  }

  if (
    typeof record.width !== 'number' ||
    !Number.isSafeInteger(record.width) ||
    record.width < 1 ||
    record.width > MAX_MEDIA_IMAGE_DIMENSION
  ) {
    pushError(
      errors,
      `${prefix}width`,
      `width must be an integer between 1 and ${MAX_MEDIA_IMAGE_DIMENSION}`,
      'INVALID_DIMENSIONS'
    );
  }

  if (
    typeof record.height !== 'number' ||
    !Number.isSafeInteger(record.height) ||
    record.height < 1 ||
    record.height > MAX_MEDIA_IMAGE_DIMENSION
  ) {
    pushError(
      errors,
      `${prefix}height`,
      `height must be an integer between 1 and ${MAX_MEDIA_IMAGE_DIMENSION}`,
      'INVALID_DIMENSIONS'
    );
  }

  if (typeof record.checksum !== 'string' || !MEDIA_CHECKSUM_REGEX.test(record.checksum)) {
    pushError(errors, `${prefix}checksum`, 'checksum must be a 64-character lowercase SHA-256 hex digest', 'INVALID_CHECKSUM');
  }

  const altCheck = validateMediaAltText(record.alt);
  if (typeof record.alt !== 'string' || !altCheck.ok) {
    pushError(errors, `${prefix}alt`, altCheck.error || 'alt must be a valid string', 'INVALID_ALT');
  }

  const hasValidCreated = typeof record.createdAt === 'string' && isValidIsoTimestamp(record.createdAt);
  const hasValidUpdated = typeof record.updatedAt === 'string' && isValidIsoTimestamp(record.updatedAt);

  if (!hasValidCreated) {
    pushError(errors, `${prefix}createdAt`, 'createdAt must be a valid UTC ISO 8601 timestamp', 'INVALID_TIMESTAMP');
  }
  if (!hasValidUpdated) {
    pushError(errors, `${prefix}updatedAt`, 'updatedAt must be a valid UTC ISO 8601 timestamp', 'INVALID_TIMESTAMP');
  }
  if (hasValidCreated && hasValidUpdated && Date.parse(record.updatedAt) < Date.parse(record.createdAt)) {
    pushError(errors, `${prefix}updatedAt`, 'updatedAt cannot be earlier than createdAt', 'INVALID_TIMESTAMP_ORDER');
  }

  return createResult(errors);
}

/**
 * Validates the complete content/media.json store array.
 */
export function validateMediaLibrary(mediaList, options = {}) {
  const errors = [];

  if (!Array.isArray(mediaList)) {
    pushError(errors, 'media', 'Media store must be a JSON array', 'INVALID_TYPE');
    return createResult(errors);
  }

  if (mediaList.length > MAX_MEDIA_ITEMS) {
    pushError(
      errors,
      'media',
      `Media store cannot exceed ${MAX_MEDIA_ITEMS} records`,
      'LENGTH_EXCEEDED'
    );
  }

  const seenIds = new Map();
  const seenFilenames = new Map();
  const seenUrls = new Map();

  for (let i = 0; i < mediaList.length; i++) {
    const item = mediaList[i];
    const prefix = `media[${i}].`;

    const itemRes = validateMediaRecord(item, { ...options, prefix });
    if (!itemRes.isValid) {
      errors.push(...itemRes.errors);
    }

    if (item && typeof item === 'object' && !Array.isArray(item)) {
      if (typeof item.id === 'string' && item.id) {
        if (seenIds.has(item.id)) {
          pushError(
            errors,
            `${prefix}id`,
            `Duplicate media id "${item.id}" (first seen at index ${seenIds.get(item.id)})`,
            'DUPLICATE_ID'
          );
        } else {
          seenIds.set(item.id, i);
        }
      }
      if (typeof item.filename === 'string' && item.filename) {
        if (seenFilenames.has(item.filename)) {
          pushError(
            errors,
            `${prefix}filename`,
            `Duplicate media filename "${item.filename}" (first seen at index ${seenFilenames.get(item.filename)})`,
            'DUPLICATE_FILENAME'
          );
        } else {
          seenFilenames.set(item.filename, i);
        }
      }
      if (typeof item.url === 'string' && item.url) {
        if (seenUrls.has(item.url)) {
          pushError(
            errors,
            `${prefix}url`,
            `Duplicate media url "${item.url}" (first seen at index ${seenUrls.get(item.url)})`,
            'DUPLICATE_URL'
          );
        } else {
          seenUrls.set(item.url, i);
        }
      }
    }
  }

  return createResult(errors);
}

function escapeRegExpLiteral(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function textReferencesMediaUrl(text, targetPath, filename) {
  if (typeof text !== 'string' || !text) return false;
  if (!text.includes(filename)) return false;

  const escapedTargetPath = escapeRegExpLiteral(targetPath);
  // Matches exact path or absolute HTTP/HTTPS URL containing /images/media/<filename>
  const pathRegex = new RegExp(
    `(?:^|[\\s"'(\\[<,=])(?:https?:\\/\\/[^\\s"'>)]+)?${escapedTargetPath}(?:[?#][^"'\\s)>]*)?(?=$|[\\s"')\\]>,;])`
  );
  return pathRegex.test(text);
}

function valueReferencesMediaUrl(val, targetPath, filename, fieldPath = '', visited = new WeakSet()) {
  const hits = [];
  const stack = [{ node: val, path: fieldPath }];
  while (stack.length > 0) {
    const { node, path: curPath } = stack.pop();
    if (typeof node === 'string') {
      if (textReferencesMediaUrl(node, targetPath, filename)) {
        hits.push(curPath || 'value');
      }
      continue;
    }
    if (!node || typeof node !== 'object') continue;
    if (visited.has(node)) continue;
    visited.add(node);

    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        stack.push({ node: node[i], path: `${curPath}[${i}]` });
      }
    } else {
      for (const k of Object.getOwnPropertyNames(node)) {
        if (SEO_PROTO_POLLUTION_KEYS.has(k)) continue;
        if (textReferencesMediaUrl(k, targetPath, filename)) {
          hits.push(curPath ? `${curPath}.${k}` : k);
        }
        stack.push({ node: node[k], path: curPath ? `${curPath}.${k}` : k });
      }
    }
  }
  return hits;
}

/**
 * Inspects all content stores and markdown bodies to determine whether a media asset is referenced.
 * Returns a list of safe reference descriptors (without exposing filesystem paths).
 */
export function findMediaReferencesInContent(mediaRecord, stores = {}) {
  const refs = [];
  if (!mediaRecord || typeof mediaRecord.filename !== 'string' || typeof mediaRecord.url !== 'string') {
    return refs;
  }
  const filename = mediaRecord.filename;
  const targetPath = `${MEDIA_PUBLIC_URL_PREFIX}${filename}`;

  // 1. Articles metadata + Markdown bodies
  if (Array.isArray(stores.articles)) {
    for (const article of stores.articles) {
      if (!article || typeof article !== 'object') continue;
      const slug = article.slug || article.id || 'unknown';
      if (textReferencesMediaUrl(article.featuredImage, targetPath, filename)) {
        refs.push({ store: 'articles', target: slug, field: 'featuredImage' });
      }
      if (textReferencesMediaUrl(article.ogImage, targetPath, filename)) {
        refs.push({ store: 'articles', target: slug, field: 'ogImage' });
      }
    }
  }
  if (stores.articleMarkdowns instanceof Map) {
    for (const [slug, mdText] of stores.articleMarkdowns.entries()) {
      if (textReferencesMediaUrl(mdText, targetPath, filename)) {
        refs.push({ store: 'articleMarkdown', target: slug, field: 'content' });
      }
    }
  }

  // 2. Categories
  if (Array.isArray(stores.categories)) {
    for (const cat of stores.categories) {
      if (!cat || typeof cat !== 'object') continue;
      const slug = cat.slug || cat.id || 'unknown';
      const hits = valueReferencesMediaUrl(cat, targetPath, filename);
      for (const field of hits) {
        refs.push({ store: 'categories', target: slug, field });
      }
    }
  }

  // 3. Tools
  if (Array.isArray(stores.tools)) {
    for (const tool of stores.tools) {
      if (!tool || typeof tool !== 'object') continue;
      const slug = tool.slug || tool.id || 'unknown';
      const hits = valueReferencesMediaUrl(tool, targetPath, filename);
      for (const field of hits) {
        refs.push({ store: 'tools', target: slug, field });
      }
    }
  }

  // 4. Custom Pages
  if (Array.isArray(stores.pages)) {
    for (const page of stores.pages) {
      if (!page || typeof page !== 'object') continue;
      const target = page.slug || page.id || 'unknown';
      const hits = valueReferencesMediaUrl(page, targetPath, filename);
      for (const field of hits) {
        refs.push({ store: 'pages', target, field });
      }
    }
  }

  // 5. SEO (defaults + page-level OG/Twitter/structured data/customImageAlts)
  if (stores.seo && typeof stores.seo === 'object') {
    if (stores.seo.defaults && typeof stores.seo.defaults === 'object') {
      const hits = valueReferencesMediaUrl(stores.seo.defaults, targetPath, filename);
      for (const field of hits) {
        refs.push({ store: 'seo.defaults', target: 'defaults', field });
      }
    }
    if (stores.seo.pages && typeof stores.seo.pages === 'object') {
      for (const [pageId, pageSeo] of Object.entries(stores.seo.pages)) {
        if (!pageSeo || typeof pageSeo !== 'object') continue;
        const hits = valueReferencesMediaUrl(pageSeo, targetPath, filename);
        for (const field of hits) {
          refs.push({ store: 'seo.pages', target: pageId, field });
        }
      }
    }
  }

  // 6. Site Settings
  if (stores.settings && typeof stores.settings === 'object') {
    const hits = valueReferencesMediaUrl(stores.settings, targetPath, filename);
    for (const field of hits) {
      refs.push({ store: 'settings', target: 'settings', field });
    }
  }

  return refs;
}

// ----------------------------------------------------------------------------
// 7. Validator Self-Test Runner (--test)
// ----------------------------------------------------------------------------

export function runValidatorTests() {
  console.log('\n================================================================');
  console.log(' [Validators Test Suite] Task 40 — Category Validation Hardening');
  console.log('================================================================\n');

  let totalCount = 0;
  let passCount = 0;
  let failCount = 0;

  function testAssert(condition, name, details = '') {
    totalCount++;
    if (condition) {
      passCount++;
      console.log(`  ✓ [PASS] ${name}`);
    } else {
      failCount++;
      console.error(`  ✗ [FAIL] ${name}${details ? ` -> ${details}` : ''}`);
    }
  }

  const makeCategory = (overrides = {}) => ({
    id: 'cat-1',
    name: 'AI Writing',
    slug: 'ai-writing',
    description: 'Discover AI tools for writing and editing.',
    icon: 'PenTool',
    color: 'blue',
    ...overrides,
  });

  // 1. Duplicate exact name rejection
  console.log('--- 1. Duplicate Category Name Validation ---');
  const dupExactRes = validateCategories([
    makeCategory({ id: 'cat-1', slug: 'cat-one', name: 'AI Writing' }),
    makeCategory({ id: 'cat-2', slug: 'cat-two', name: 'AI Writing' }),
  ]);
  testAssert(
    !dupExactRes.isValid &&
      dupExactRes.errors.some((e) => e.field === 'categories[1].name' && e.code === 'DUPLICATE_NAME'),
    'Duplicate exact name: rejects identical category name with DUPLICATE_NAME'
  );

  // 2. Case-insensitive duplicate rejection
  const dupLowerRes = validateCategories([
    makeCategory({ id: 'cat-1', slug: 'cat-one', name: 'AI Writing' }),
    makeCategory({ id: 'cat-2', slug: 'cat-two', name: 'ai writing' }),
  ]);
  testAssert(
    !dupLowerRes.isValid &&
      dupLowerRes.errors.some((e) => e.field === 'categories[1].name' && e.code === 'DUPLICATE_NAME'),
    'Case-insensitive duplicate: rejects "ai writing" when "AI Writing" exists'
  );

  const dupUpperRes = validateCategories([
    makeCategory({ id: 'cat-1', slug: 'cat-one', name: 'AI Writing' }),
    makeCategory({ id: 'cat-2', slug: 'cat-two', name: 'AI WRITING' }),
    makeCategory({ id: 'cat-3', slug: 'cat-three', name: 'Ai WrItInG' }),
  ]);
  testAssert(
    !dupUpperRes.isValid &&
      dupUpperRes.errors.filter((e) => e.code === 'DUPLICATE_NAME').length === 2,
    'Case-insensitive duplicate: rejects "AI WRITING" and mixed-case variants with DUPLICATE_NAME'
  );

  // 3. Leading/trailing whitespace ignored
  const dupWhitespaceRes = validateCategories([
    makeCategory({ id: 'cat-1', slug: 'cat-one', name: '  AI Writing' }),
    makeCategory({ id: 'cat-2', slug: 'cat-two', name: 'ai writing   ' }),
  ]);
  testAssert(
    !dupWhitespaceRes.isValid &&
      dupWhitespaceRes.errors.some((e) => e.field === 'categories[1].name' && e.code === 'DUPLICATE_NAME'),
    'Whitespace normalization: ignores leading/trailing whitespace when detecting DUPLICATE_NAME'
  );

  // 4. Unique names acceptance
  const uniqueNamesRes = validateCategories([
    makeCategory({ id: 'cat-1', slug: 'ai-writing', name: 'AI Writing', icon: 'PenTool' }),
    makeCategory({ id: 'cat-2', slug: 'image-generation', name: 'Image Generation', icon: 'Image' }),
    makeCategory({ id: 'cat-3', slug: 'code-dev', name: 'Code & Dev', icon: 'Code' }),
  ]);
  testAssert(
    uniqueNamesRes.isValid && uniqueNamesRes.errors.length === 0,
    'Unique names acceptance: distinct names, slugs, ids, and supported icons pass'
  );

  // 5. Existing 9 categories acceptance
  console.log('\n--- 2. Existing Content & Supported Icons ---');
  const existingCategories = loadFallbackContent('categories.json');
  testAssert(
    Array.isArray(existingCategories) && existingCategories.length === 9,
    'Loaded existing content/categories.json with 9 categories'
  );
  const existingCatsRes = validateCategories(existingCategories);
  testAssert(
    existingCatsRes.isValid && existingCatsRes.errors.length === 0,
    'Existing 9 categories in content/categories.json pass validateCategories()',
    JSON.stringify(existingCatsRes.errors)
  );

  // 6. Existing supported icons acceptance
  for (const iconName of ALLOWED_CATEGORY_ICONS) {
    const singleIconRes = validateCategory(makeCategory({ icon: iconName }));
    testAssert(
      singleIconRes.isValid && singleIconRes.errors.length === 0,
      `Supported icon accepted: "${iconName}"`,
      JSON.stringify(singleIconRes.errors)
    );
  }

  // 7. Unknown icon rejection
  console.log('\n--- 3. Unknown Icon Rejection ---');
  const unknownIconRes = validateCategory(makeCategory({ icon: 'Rocket' }));
  testAssert(
    !unknownIconRes.isValid &&
      unknownIconRes.errors.some((e) => e.field === 'icon' && e.code === 'INVALID_ICON'),
    'Unknown icon rejected: "Rocket" fails with INVALID_ICON'
  );

  const wrongCaseIconRes = validateCategory(makeCategory({ icon: 'pentool' }));
  testAssert(
    !wrongCaseIconRes.isValid &&
      wrongCaseIconRes.errors.some((e) => e.field === 'icon' && e.code === 'INVALID_ICON'),
    'Wrong-case icon rejected: "pentool" fails with INVALID_ICON'
  );

  const paddedIconRes = validateCategory(makeCategory({ icon: ' PenTool ' }));
  testAssert(
    !paddedIconRes.isValid &&
      paddedIconRes.errors.some((e) => e.field === 'icon' && e.code === 'INVALID_ICON'),
    'Whitespace-padded icon rejected: " PenTool " fails with INVALID_ICON'
  );

  const emptyIconRes = validateCategory(makeCategory({ icon: '   ' }));
  testAssert(
    !emptyIconRes.isValid &&
      emptyIconRes.errors.some((e) => e.field === 'icon' && e.code === 'REQUIRED'),
    'Empty/whitespace icon rejected with REQUIRED'
  );

  const unknownIconInListRes = validateCategories([
    makeCategory({ id: 'cat-1', slug: 'cat-one', name: 'Valid Cat', icon: 'PenTool' }),
    makeCategory({ id: 'cat-2', slug: 'cat-two', name: 'Invalid Icon Cat', icon: 'NonExistentIcon' }),
  ]);
  testAssert(
    !unknownIconInListRes.isValid &&
      unknownIconInListRes.errors.some(
        (e) => e.field === 'categories[1].icon' && e.code === 'INVALID_ICON'
      ),
    'Unknown icon in validateCategories array rejected at categories[1].icon with INVALID_ICON'
  );

  // 8. Existing article/tool validation regression
  console.log('\n--- 4. Article & Tool Validation Regression ---');
  const existingArticles = loadFallbackContent('articles.json');
  const articlesRegRes = validateArticles(existingArticles, { categories: existingCategories });
  testAssert(
    articlesRegRes.isValid && articlesRegRes.errors.length === 0,
    'Existing content/articles.json passes validateArticles() with category FK integrity',
    JSON.stringify(articlesRegRes.errors)
  );

  const existingTools = loadFallbackContent('tools.json');
  const toolsRegRes = validateTools(existingTools, { categories: existingCategories });
  testAssert(
    toolsRegRes.isValid && toolsRegRes.errors.length === 0,
    'Existing content/tools.json passes validateTools() with category FK integrity',
    JSON.stringify(toolsRegRes.errors)
  );

  const invalidArticleFk = validateArticle(
    { ...existingArticles[0], category: 'non-existent-cat' },
    { categories: existingCategories }
  );
  testAssert(
    !invalidArticleFk.isValid &&
      invalidArticleFk.errors.some((e) => e.field === 'category' && e.code === 'INVALID_CATEGORY'),
    'Article foreign-key check still rejects unknown category with INVALID_CATEGORY'
  );

  const invalidToolFk = validateTool(
    { ...existingTools[0], category: 'non-existent-cat' },
    { categories: existingCategories }
  );
  testAssert(
    !invalidToolFk.isValid &&
      invalidToolFk.errors.some((e) => e.field === 'category' && e.code === 'INVALID_CATEGORY'),
    'Tool foreign-key check still rejects unknown category with INVALID_CATEGORY'
  );

  const catInUseDel = validateCategoryDeletion('business', {
    articles: existingArticles,
    tools: existingTools,
  });
  testAssert(
    !catInUseDel.isValid && catInUseDel.errors.some((e) => e.code === 'CATEGORY_IN_USE'),
    'validateCategoryDeletion still rejects in-use category with CATEGORY_IN_USE'
  );

  const catRenameInUse = validateCategoryRename('business', 'business-new', {
    articles: existingArticles,
    tools: existingTools,
  });
  testAssert(
    !catRenameInUse.isValid &&
      catRenameInUse.errors.some((e) => e.code === 'CATEGORY_RENAME_INTEGRITY_VIOLATION'),
    'validateCategoryRename still rejects renaming in-use category'
  );

  // 9. Task 54 — Tool Validator Consistency & Hardening Tests
  console.log('\n--- 5. Task 54: Tool Validator Consistency & Hardening ---');

  const makeTool = (overrides = {}) => ({
    id: 'sample-tool',
    name: 'Sample Tool',
    slug: 'sample-tool',
    url: 'https://example.com/sample-tool',
    description: 'A sample AI tool description for validator testing.',
    longDescription: 'Extended description for Sample Tool.',
    category: 'ai-writing',
    categoryName: 'AI Writing',
    tags: ['Writing'],
    pricing: 'Freemium',
    isFeatured: true,
    icon: '/images/chatgpt.svg',
    iconBg: 'bg-slate-900 text-white',
    brandInitial: 'Sample',
    rating: 4.5,
    ...overrides,
  });

  // 9.1 All 8 tools in content/tools.json pass
  testAssert(
    Array.isArray(existingTools) && existingTools.length === 8 && toolsRegRes.isValid,
    'Task 54 (Existing tools.json): All 8 production tools pass validateTools()'
  );

  // 9.2 categoryName missing / undefined / empty / whitespace / non-string -> reject REQUIRED
  const { categoryName: _omittedCatName, ...toolMissingCatName } = makeTool();
  const missingCatNameRes = validateTool(toolMissingCatName, { categories: existingCategories });
  const undefinedCatNameRes = validateTool(makeTool({ categoryName: undefined }), {
    categories: existingCategories,
  });
  const emptyCatNameRes = validateTool(makeTool({ categoryName: '' }), {
    categories: existingCategories,
  });
  const whitespaceCatNameRes = validateTool(makeTool({ categoryName: '   ' }), {
    categories: existingCategories,
  });
  const nonStringCatNameRes = validateTool(makeTool({ categoryName: 123 }), {
    categories: existingCategories,
  });
  testAssert(
    [
      missingCatNameRes,
      undefinedCatNameRes,
      emptyCatNameRes,
      whitespaceCatNameRes,
      nonStringCatNameRes,
    ].every(
      (r) => !r.isValid && r.errors.some((e) => e.field === 'categoryName' && e.code === 'REQUIRED')
    ),
    'Task 54 (categoryName required): Rejects missing, undefined, empty, whitespace, and non-string categoryName'
  );

  // 9.3 categoryName wrong / mismatched case / padded / wrong category's name -> reject INVALID_CATEGORY_NAME
  const wrongCatNameRes = validateTool(makeTool({ categoryName: 'Code & Dev' }), {
    categories: existingCategories,
  });
  const wrongCaseCatNameRes = validateTool(makeTool({ categoryName: 'ai writing' }), {
    categories: existingCategories,
  });
  const paddedCatNameRes = validateTool(makeTool({ categoryName: ' AI Writing ' }), {
    categories: existingCategories,
  });
  testAssert(
    [wrongCatNameRes, wrongCaseCatNameRes, paddedCatNameRes].every(
      (r) =>
        !r.isValid &&
        r.errors.some((e) => e.field === 'categoryName' && e.code === 'INVALID_CATEGORY_NAME')
    ),
    'Task 54 (categoryName exact match): Rejects wrong, wrong-case, and whitespace-padded categoryName with INVALID_CATEGORY_NAME'
  );

  // 9.4 categoryName exact match -> accept
  const exactCatNameRes = validateTool(
    makeTool({ category: 'code-dev', categoryName: 'Code & Dev' }),
    { categories: existingCategories }
  );
  testAssert(
    exactCatNameRes.isValid && exactCatNameRes.errors.length === 0,
    'Task 54 (categoryName valid): Accepts exact matching categoryName from trusted categories'
  );

  // 9.5 category slug missing / empty / whitespace -> reject REQUIRED
  const { category: _omittedCatSlug, ...toolMissingCatSlug } = makeTool();
  const missingCatSlugRes = validateTool(toolMissingCatSlug, { categories: existingCategories });
  const emptyCatSlugRes = validateTool(makeTool({ category: '' }), {
    categories: existingCategories,
  });
  const whitespaceCatSlugRes = validateTool(makeTool({ category: '   ' }), {
    categories: existingCategories,
  });
  testAssert(
    [missingCatSlugRes, emptyCatSlugRes, whitespaceCatSlugRes].every(
      (r) => !r.isValid && r.errors.some((e) => e.field === 'category' && e.code === 'REQUIRED')
    ),
    'Task 54 (category slug required): Rejects missing, empty, and whitespace category slug'
  );

  // 9.6 rating: NaN, Infinity, -Infinity, non-number -> reject INVALID_TYPE
  const nanRatingRes = validateTool(makeTool({ rating: Number.NaN }), {
    categories: existingCategories,
  });
  const infRatingRes = validateTool(makeTool({ rating: Number.POSITIVE_INFINITY }), {
    categories: existingCategories,
  });
  const negInfRatingRes = validateTool(makeTool({ rating: Number.NEGATIVE_INFINITY }), {
    categories: existingCategories,
  });
  const strRatingRes = validateTool(makeTool({ rating: '4.5' }), {
    categories: existingCategories,
  });
  testAssert(
    [nanRatingRes, infRatingRes, negInfRatingRes, strRatingRes].every(
      (r) => !r.isValid && r.errors.some((e) => e.field === 'rating' && e.code === 'INVALID_TYPE')
    ),
    'Task 54 (rating finite number): Rejects NaN, Infinity, -Infinity, and non-number rating with INVALID_TYPE'
  );

  // 9.7 rating: -1, 5.1 -> reject INVALID_RATING_RANGE; 0, 5, undefined -> accept
  const negRatingRes = validateTool(makeTool({ rating: -1 }), {
    categories: existingCategories,
  });
  const overRatingRes = validateTool(makeTool({ rating: 5.1 }), {
    categories: existingCategories,
  });
  testAssert(
    [negRatingRes, overRatingRes].every(
      (r) =>
        !r.isValid &&
        r.errors.some((e) => e.field === 'rating' && e.code === 'INVALID_RATING_RANGE')
    ),
    'Task 54 (rating range): Rejects -1 and 5.1 with INVALID_RATING_RANGE'
  );

  const zeroRatingRes = validateTool(makeTool({ rating: 0 }), {
    categories: existingCategories,
  });
  const fiveRatingRes = validateTool(makeTool({ rating: 5 }), {
    categories: existingCategories,
  });
  const { rating: _omittedRating, ...toolNoRating } = makeTool();
  const noRatingRes = validateTool(toolNoRating, { categories: existingCategories });
  testAssert(
    zeroRatingRes.isValid && fiveRatingRes.isValid && noRatingRes.isValid,
    'Task 54 (rating boundaries): Accepts 0, 5, and omitted optional rating'
  );

  // 9.8 longDescription boundary tests
  const { longDescription: _omittedLongDesc, ...toolNoLongDesc } = makeTool();
  const noLongDescRes = validateTool(toolNoLongDesc, { categories: existingCategories });
  const emptyLongDescRes = validateTool(makeTool({ longDescription: '' }), {
    categories: existingCategories,
  });
  const maxBoundaryLongDescRes = validateTool(
    makeTool({ longDescription: 'a'.repeat(MAX_TOOL_LONG_DESCRIPTION_LENGTH) }),
    { categories: existingCategories }
  );
  const overMaxLongDescRes = validateTool(
    makeTool({ longDescription: 'a'.repeat(MAX_TOOL_LONG_DESCRIPTION_LENGTH + 1) }),
    { categories: existingCategories }
  );
  const whitespaceLongDescRes = validateTool(makeTool({ longDescription: '   ' }), {
    categories: existingCategories,
  });
  const nonStrLongDescRes = validateTool(makeTool({ longDescription: 12345 }), {
    categories: existingCategories,
  });
  testAssert(
    noLongDescRes.isValid &&
      emptyLongDescRes.isValid &&
      maxBoundaryLongDescRes.isValid &&
      !overMaxLongDescRes.isValid &&
      overMaxLongDescRes.errors.some(
        (e) => e.field === 'longDescription' && e.code === 'INVALID_LENGTH'
      ) &&
      !whitespaceLongDescRes.isValid &&
      whitespaceLongDescRes.errors.some(
        (e) => e.field === 'longDescription' && e.code === 'INVALID_LENGTH'
      ) &&
      !nonStrLongDescRes.isValid &&
      nonStrLongDescRes.errors.some(
        (e) => e.field === 'longDescription' && e.code === 'INVALID_TYPE'
      ),
    `Task 54 (longDescription boundaries): Accepts omitted, empty, and ${MAX_TOOL_LONG_DESCRIPTION_LENGTH} chars; rejects ${MAX_TOOL_LONG_DESCRIPTION_LENGTH + 1} chars, whitespace-only, and non-string`
  );

  // 9.9 validateTools() shared trusted category context consistency
  const customCategories = [
    makeCategory({ id: 'custom-ai', slug: 'custom-ai', name: 'Custom AI' }),
  ];
  let getCategoriesCalls = 0;
  const proxyCategories = new Proxy(customCategories, {
    get(target, prop, receiver) {
      if (prop === '0') getCategoriesCalls++;
      return Reflect.get(target, prop, receiver);
    },
  });
  const sharedCtxToolsValid = validateTools(
    [
      makeTool({ id: 't-1', slug: 'tool-one', category: 'custom-ai', categoryName: 'Custom AI' }),
      makeTool({ id: 't-2', slug: 'tool-two', category: 'custom-ai', categoryName: 'Custom AI' }),
      makeTool({ id: 't-3', slug: 'tool-three', category: 'custom-ai', categoryName: 'Custom AI' }),
    ],
    { categories: proxyCategories }
  );
  const sharedCtxToolsMismatch = validateTools(
    [
      makeTool({ id: 't-1', slug: 'tool-one', category: 'custom-ai', categoryName: 'Custom AI' }),
      makeTool({ id: 't-2', slug: 'tool-two', category: 'custom-ai', categoryName: 'AI Writing' }),
    ],
    { categories: customCategories }
  );
  testAssert(
    sharedCtxToolsValid.isValid &&
      getCategoriesCalls === 1 &&
      !sharedCtxToolsMismatch.isValid &&
      sharedCtxToolsMismatch.errors.some(
        (e) => e.field === 'tools[1].categoryName' && e.code === 'INVALID_CATEGORY_NAME'
      ),
    'Task 54 (validateTools shared context): Resolves trusted categories once across all tools and enforces categoryName match per item'
  );

  // 10. Task 73 — Reject Protocol-Relative Asset URLs
  console.log('\n--- 6. Task 73: isValidAssetPathOrUrl() Protocol-Relative URL Rejection ---');

  const protocolRelativeRejectCases = [
    '//evil.com/asset.svg',
    '//cdn.example.com/image.webp',
    '///evil.com/asset.svg',
    '//127.0.0.1/asset.svg',
    '/\\evil.com/asset.svg',
  ];
  for (const badAsset of protocolRelativeRejectCases) {
    testAssert(
      isValidAssetPathOrUrl(badAsset) === false,
      `Task 73 (Reject protocol-relative): Rejects "${badAsset}"`
    );
  }

  const validRootRelativeCases = [
    '/assets/image.webp',
    '/images/articles/best-free-ai-tools-2026.webp',
    '/images/chatgpt.svg',
    '/rss.xml',
  ];
  for (const validPath of validRootRelativeCases) {
    testAssert(
      isValidAssetPathOrUrl(validPath) === true,
      `Task 73 (Preserve root-relative): Accepts "${validPath}"`
    );
  }

  const relativePathCases = ['assets/image.webp', './assets/image.webp'];
  for (const relPath of relativePathCases) {
    testAssert(
      isValidAssetPathOrUrl(relPath) === false,
      `Task 73 (Preserve non-root relative behavior): Unchanged false for "${relPath}"`
    );
  }

  const validHttpAssetCases = [
    'https://example.com/image.webp',
    'http://example.com/image.webp',
  ];
  for (const validHttpUrl of validHttpAssetCases) {
    testAssert(
      isValidAssetPathOrUrl(validHttpUrl) === true,
      `Task 73 (Preserve HTTP/HTTPS): Accepts "${validHttpUrl}"`
    );
  }

  // Integration check across article, tool, and settings validators
  const existingSettings = loadFallbackContent('settings.json');
  const settingsRegRes = validateSettings(existingSettings);
  testAssert(
    settingsRegRes.isValid && settingsRegRes.errors.length === 0,
    'Task 73 (Existing settings.json): Passes validateSettings()',
    JSON.stringify(settingsRegRes.errors)
  );

  const protoRelArticleImgRes = validateArticle(
    { ...existingArticles[0], featuredImage: '//evil.com/asset.svg', ogImage: '//cdn.example.com/image.webp' },
    { categories: existingCategories }
  );
  testAssert(
    !protoRelArticleImgRes.isValid &&
      protoRelArticleImgRes.errors.some((e) => e.field === 'featuredImage' && e.code === 'INVALID_URL') &&
      protoRelArticleImgRes.errors.some((e) => e.field === 'ogImage' && e.code === 'INVALID_URL'),
    'Task 73 (validateArticle): Rejects protocol-relative featuredImage and ogImage with INVALID_URL'
  );

  const protoRelToolIconRes = validateTool(
    makeTool({ icon: '//127.0.0.1/asset.svg' }),
    { categories: existingCategories }
  );
  testAssert(
    !protoRelToolIconRes.isValid &&
      protoRelToolIconRes.errors.some((e) => e.field === 'icon' && e.code === 'INVALID_URL'),
    'Task 73 (validateTool): Rejects protocol-relative icon with INVALID_URL'
  );

  const protoRelSettingsRes = validateSettings({
    ...existingSettings,
    defaultOgImage: '///evil.com/asset.svg',
    socialLinks: {
      ...existingSettings.socialLinks,
      rss: '//evil.com/rss.xml',
    },
  });
  testAssert(
    !protoRelSettingsRes.isValid &&
      protoRelSettingsRes.errors.some((e) => e.field === 'defaultOgImage' && e.code === 'INVALID_URL') &&
      protoRelSettingsRes.errors.some((e) => e.field === 'socialLinks.rss' && e.code === 'INVALID_URL'),
    'Task 73 (validateSettings): Rejects protocol-relative defaultOgImage and socialLinks.rss with INVALID_URL'
  );

  // 11. Task 75 — Reject HTTP(S) URLs Containing Userinfo
  console.log('\n--- 7. Task 75: isValidHttpUrl() Userinfo Rejection ---');

  const userinfoRejectCases = [
    'https://user:pass@example.com',
    'https://user@example.com',
    'https://:pass@example.com',
    'https://@example.com',
    'https://:@example.com',
    'http://user:pass@example.com',
    'https://openai.com@evil.com',
  ];
  for (const badUrl of userinfoRejectCases) {
    testAssert(
      isValidHttpUrl(badUrl) === false,
      `Task 75 (Reject userinfo): Rejects "${badUrl}"`
    );
  }

  const validHttpUrlCases = [
    'https://example.com',
    'http://example.com/path',
    'https://example.com/path/@profile',
    'https://example.com/?redirect=@example.com',
    'https://example.com/#@profile',
  ];
  for (const validUrl of validHttpUrlCases) {
    testAssert(
      isValidHttpUrl(validUrl) === true,
      `Task 75 (Preserve valid HTTP/HTTPS): Accepts "${validUrl}"`
    );
  }

  const nonHttpProtocolCases = [
    'ftp://example.com',
    'javascript:alert(1)',
    'mailto:user@example.com',
  ];
  for (const badProtoUrl of nonHttpProtocolCases) {
    testAssert(
      isValidHttpUrl(badProtoUrl) === false,
      `Task 75 (Reject non-HTTP(S) protocol): Rejects "${badProtoUrl}"`
    );
  }

  // Integration check across article, tool, and settings validators
  const userinfoArticleCanonicalRes = validateArticle(
    { ...existingArticles[0], canonicalUrl: 'https://@example.com/article' },
    { categories: existingCategories }
  );
  testAssert(
    !userinfoArticleCanonicalRes.isValid &&
      userinfoArticleCanonicalRes.errors.some(
        (e) => e.field === 'canonicalUrl' && e.code === 'INVALID_URL'
      ),
    'Task 75 (validateArticle): Rejects userinfo canonicalUrl with INVALID_URL'
  );

  const userinfoToolUrlRes = validateTool(
    makeTool({ url: 'https://openai.com@evil.com' }),
    { categories: existingCategories }
  );
  testAssert(
    !userinfoToolUrlRes.isValid &&
      userinfoToolUrlRes.errors.some((e) => e.field === 'url' && e.code === 'INVALID_URL'),
    'Task 75 (validateTool): Rejects userinfo tool.url with INVALID_URL'
  );

  const userinfoSettingsRes = validateSettings({
    ...existingSettings,
    productionUrl: 'https://:@example.com',
    socialLinks: {
      ...existingSettings.socialLinks,
      twitter: 'https://user:pass@example.com/profile',
    },
  });
  testAssert(
    !userinfoSettingsRes.isValid &&
      userinfoSettingsRes.errors.some(
        (e) => e.field === 'productionUrl' && e.code === 'INVALID_URL'
      ) &&
      userinfoSettingsRes.errors.some(
        (e) => e.field === 'socialLinks.twitter' && e.code === 'INVALID_URL'
      ),
    'Task 75 (validateSettings): Rejects userinfo productionUrl and socialLinks.twitter with INVALID_URL'
  );

  // 12. Task 76 — Reject Raw Whitespace and ASCII Control Characters in HTTP URLs
  console.log('\n--- 8. Task 76: isValidHttpUrl() Raw Whitespace & Control Character Rejection ---');

  const whitespaceControlRejectCases = [
    { url: ' https://example.com', label: 'leading space' },
    { url: 'https://example.com ', label: 'trailing space' },
    { url: 'https://exa mple.com', label: 'space in hostname' },
    { url: 'https://example.com/path with space', label: 'space in path' },
    { url: 'https://example.com/\tpath', label: 'embedded tab in path' },
    { url: 'https://example.com/\npath', label: 'embedded LF in path' },
    { url: 'https://example.com/\rpath', label: 'embedded CR in path' },
    { url: '\thttps://example.com', label: 'leading tab' },
    { url: 'https://example.com\n', label: 'trailing LF' },
    { url: 'https://example.com/\u0000path', label: 'NUL U+0000 control char' },
    { url: 'https://example.com/\u001Fpath', label: 'US U+001F control char' },
    { url: 'https://example.com/\u007Fpath', label: 'DEL U+007F control char' },
    { url: 'https://example.com/\u00A0path', label: 'Unicode NBSP U+00A0' },
    { url: 'https://example.com/\u0085path', label: 'Unicode NEL U+0085' },
    { url: 'https://example.com/\u3000path', label: 'Unicode ideographic space U+3000' },
  ];
  for (const { url, label } of whitespaceControlRejectCases) {
    testAssert(
      isValidHttpUrl(url) === false,
      `Task 76 (Reject ${label}): Rejects ${JSON.stringify(url)}`
    );
  }

  const whitespaceControlValidCases = [
    'https://example.com',
    'http://example.com/path',
    'https://example.com/%20image.webp',
    'https://example.com/path/@profile',
    'https://example.com/?q=hello',
    'https://example.com/#section',
  ];
  for (const validUrl of whitespaceControlValidCases) {
    testAssert(
      isValidHttpUrl(validUrl) === true,
      `Task 76 (Accept valid URL): Accepts "${validUrl}"`
    );
  }

  // Integration check across article, tool, and settings validators
  const wsArticleCanonicalRes = validateArticle(
    { ...existingArticles[0], canonicalUrl: ' https://example.com/article' },
    { categories: existingCategories }
  );
  testAssert(
    !wsArticleCanonicalRes.isValid &&
      wsArticleCanonicalRes.errors.some(
        (e) => e.field === 'canonicalUrl' && e.code === 'INVALID_URL'
      ),
    'Task 76 (validateArticle): Rejects canonicalUrl with leading whitespace'
  );

  const wsToolUrlRes = validateTool(
    makeTool({ url: 'https://example.com/path\twith-tab' }),
    { categories: existingCategories }
  );
  testAssert(
    !wsToolUrlRes.isValid &&
      wsToolUrlRes.errors.some((e) => e.field === 'url' && e.code === 'INVALID_URL'),
    'Task 76 (validateTool): Rejects tool.url with embedded tab'
  );

  const wsSettingsRes = validateSettings({
    ...existingSettings,
    productionUrl: 'https://example.com\n',
    socialLinks: {
      ...existingSettings.socialLinks,
      twitter: 'https://example.com/\u00A0profile',
    },
  });
  testAssert(
    !wsSettingsRes.isValid &&
      wsSettingsRes.errors.some(
        (e) => e.field === 'productionUrl' && e.code === 'INVALID_URL'
      ) &&
      wsSettingsRes.errors.some(
        (e) => e.field === 'socialLinks.twitter' && e.code === 'INVALID_URL'
      ),
    'Task 76 (validateSettings): Rejects productionUrl with trailing LF and socialLinks.twitter with Unicode NBSP'
  );

  // 13. Task 77 — Reject Non-Canonical HTTP(S) URL Syntax and Backslashes
  console.log('\n--- 9. Task 77: isValidHttpUrl() Non-Canonical Syntax & Backslash Rejection ---');

  const nonCanonicalRejectCases = [
    { url: 'https:example.com', label: 'missing slashes after https:' },
    { url: 'http:example.com/path', label: 'missing slashes after http:' },
    { url: 'https:/example.com', label: 'single slash after https:' },
    { url: 'http:/example.com', label: 'single slash after http:' },
    { url: 'https:///example.com', label: 'triple slash after https:' },
    { url: 'http:///example.com', label: 'triple slash after http:' },
    { url: 'https:\\example.com', label: 'single backslash after https:' },
    { url: 'https://example.com\\path', label: 'backslash before path' },
    { url: 'https://example.com/path\\image.webp', label: 'backslash inside path' },
    { url: 'http:\\example.com\\path', label: 'backslashes after http: and in path' },
    { url: 'https://example.com/?q=a\\b', label: 'backslash in query' },
    { url: 'https://example.com/#a\\b', label: 'backslash in fragment' },
  ];
  for (const { url, label } of nonCanonicalRejectCases) {
    testAssert(
      isValidHttpUrl(url) === false,
      `Task 77 (Reject ${label}): Rejects ${JSON.stringify(url)}`
    );
  }

  const canonicalValidCases = [
    'https://example.com',
    'http://example.com/path',
    'https://example.com/path/image.webp',
    'https://example.com/path/@profile',
    'https://example.com/?q=hello',
    'https://example.com/#section',
    'https://example.com/%20image.webp',
  ];
  for (const validUrl of canonicalValidCases) {
    testAssert(
      isValidHttpUrl(validUrl) === true,
      `Task 77 (Accept canonical URL): Accepts "${validUrl}"`
    );
  }

  // Integration check across article, tool, and settings validators
  const nonCanonArticleRes = validateArticle(
    {
      ...existingArticles[0],
      featuredImage: 'https:\\example.com\\hero.webp',
      canonicalUrl: 'https:example.com/article',
    },
    { categories: existingCategories }
  );
  testAssert(
    !nonCanonArticleRes.isValid &&
      nonCanonArticleRes.errors.some(
        (e) => e.field === 'featuredImage' && e.code === 'INVALID_URL'
      ) &&
      nonCanonArticleRes.errors.some(
        (e) => e.field === 'canonicalUrl' && e.code === 'INVALID_URL'
      ),
    'Task 77 (validateArticle): Rejects backslash featuredImage and non-canonical canonicalUrl with INVALID_URL'
  );

  const nonCanonToolUrlRes = validateTool(
    makeTool({ url: 'https://example.com/path\\tool' }),
    { categories: existingCategories }
  );
  testAssert(
    !nonCanonToolUrlRes.isValid &&
      nonCanonToolUrlRes.errors.some((e) => e.field === 'url' && e.code === 'INVALID_URL'),
    'Task 77 (validateTool): Rejects tool.url containing backslash with INVALID_URL'
  );

  const nonCanonSettingsRes = validateSettings({
    ...existingSettings,
    productionUrl: 'https:/example.com',
    socialLinks: {
      ...existingSettings.socialLinks,
      twitter: 'https://example.com\\profile',
    },
  });
  testAssert(
    !nonCanonSettingsRes.isValid &&
      nonCanonSettingsRes.errors.some(
        (e) => e.field === 'productionUrl' && e.code === 'INVALID_URL'
      ) &&
      nonCanonSettingsRes.errors.some(
        (e) => e.field === 'socialLinks.twitter' && e.code === 'INVALID_URL'
      ),
    'Task 77 (validateSettings): Rejects non-canonical productionUrl and backslash socialLinks.twitter with INVALID_URL'
  );

  // 14. Task 78 — Reject Malformed Percent-Encoding in HTTP(S) URLs
  console.log('\n--- 10. Task 78: isValidHttpUrl() Malformed Percent-Encoding Rejection ---');

  const malformedPercentRejectCases = [
    { url: 'https://example.com/%', label: 'trailing bare percent' },
    { url: 'https://example.com/%ZZ', label: 'non-hex percent sequence %ZZ' },
    { url: 'https://example.com/%2', label: 'truncated single hex digit %2' },
    { url: 'https://example.com/path%GG/image.webp', label: 'non-hex percent sequence in path' },
    { url: 'https://example.com/?q=%', label: 'bare percent in query' },
    { url: 'https://example.com/#%ZZ', label: 'non-hex percent sequence in fragment' },
    { url: 'https://example.com/%%20', label: 'double percent before valid escape' },
    { url: 'https://example.com/%2%20', label: 'single hex digit followed by another percent' },
  ];
  for (const { url, label } of malformedPercentRejectCases) {
    testAssert(
      isValidHttpUrl(url) === false,
      `Task 78 (Reject ${label}): Rejects "${url}"`
    );
  }

  const validPercentCases = [
    'https://example.com/%20image.webp',
    'https://example.com/%2Fimage.webp',
    'https://example.com/path%2Fimage.webp',
    'https://example.com/?q=hello%20world',
    'https://example.com/#section%20one',
    'https://example.com/%25encoded',
    'https://example.com/path%2f%aB',
  ];
  for (const validUrl of validPercentCases) {
    testAssert(
      isValidHttpUrl(validUrl) === true,
      `Task 78 (Accept valid percent-encoding): Accepts "${validUrl}"`
    );
  }

  // Integration check across article, tool, and settings validators
  const malformedPctArticleRes = validateArticle(
    {
      ...existingArticles[0],
      featuredImage: 'https://example.com/path%GG/image.webp',
      canonicalUrl: 'https://example.com/%2',
    },
    { categories: existingCategories }
  );
  testAssert(
    !malformedPctArticleRes.isValid &&
      malformedPctArticleRes.errors.some(
        (e) => e.field === 'featuredImage' && e.code === 'INVALID_URL'
      ) &&
      malformedPctArticleRes.errors.some(
        (e) => e.field === 'canonicalUrl' && e.code === 'INVALID_URL'
      ),
    'Task 78 (validateArticle): Rejects malformed percent-encoded featuredImage and canonicalUrl with INVALID_URL'
  );

  const malformedPctToolRes = validateTool(
    makeTool({ url: 'https://example.com/?q=%' }),
    { categories: existingCategories }
  );
  testAssert(
    !malformedPctToolRes.isValid &&
      malformedPctToolRes.errors.some((e) => e.field === 'url' && e.code === 'INVALID_URL'),
    'Task 78 (validateTool): Rejects malformed percent-encoded tool.url with INVALID_URL'
  );

  const malformedPctSettingsRes = validateSettings({
    ...existingSettings,
    productionUrl: 'https://example.com/%ZZ',
    socialLinks: {
      ...existingSettings.socialLinks,
      twitter: 'https://example.com/#%ZZ',
    },
  });
  testAssert(
    !malformedPctSettingsRes.isValid &&
      malformedPctSettingsRes.errors.some(
        (e) => e.field === 'productionUrl' && e.code === 'INVALID_URL'
      ) &&
      malformedPctSettingsRes.errors.some(
        (e) => e.field === 'socialLinks.twitter' && e.code === 'INVALID_URL'
      ),
    'Task 78 (validateSettings): Rejects malformed percent-encoded productionUrl and socialLinks.twitter with INVALID_URL'
  );

  const validPctArticleRes = validateArticle(
    {
      ...existingArticles[0],
      featuredImage: 'https://example.com/%20image.webp',
      canonicalUrl: 'https://example.com/path%2Farticle',
    },
    { categories: existingCategories }
  );
  testAssert(
    validPctArticleRes.isValid && validPctArticleRes.errors.length === 0,
    'Task 78 (validateArticle valid percent-encoding): Accepts valid percent-encoded featuredImage and canonicalUrl',
    JSON.stringify(validPctArticleRes.errors)
  );

  // 15. Task 80 — Harden HTTP(S) Port, Hostname, IPv4, and IPv6 Validation
  console.log('\n--- 11. Task 80: isValidHttpUrl() Port, Hostname, IPv4 & IPv6 Hardening ---');

  const portRejectCases = [
    { url: 'https://example.com:', label: 'empty port' },
    { url: 'https://example.com:0', label: 'port 0' },
    { url: 'https://example.com:00', label: 'leading-zero port :00' },
    { url: 'https://example.com:080', label: 'leading-zero port :080' },
    { url: 'https://example.com:00443', label: 'leading-zero port :00443' },
    { url: 'https://example.com:65536', label: 'port > 65535 (65536)' },
    { url: 'https://example.com:99999', label: 'port > 65535 (99999)' },
    { url: 'https://example.com:abc', label: 'non-numeric port' },
    { url: 'https://example.com:80abc', label: 'alphanumeric port' },
    { url: 'https://example.com:80:80', label: 'multiple colons in authority' },
    { url: 'https://:8080', label: 'port with empty host' },
  ];
  for (const { url, label } of portRejectCases) {
    testAssert(
      isValidHttpUrl(url) === false,
      `Task 80 (Port reject - ${label}): Rejects "${url}"`
    );
  }

  const portAcceptCases = [
    'https://example.com:1',
    'https://example.com:80',
    'https://example.com:443',
    'http://example.com:80',
    'http://example.com:443',
    'https://example.com:8080',
    'https://example.com:65535',
    'https://example.com:443/path?q=1#frag',
  ];
  for (const validUrl of portAcceptCases) {
    testAssert(
      isValidHttpUrl(validUrl) === true,
      `Task 80 (Port accept): Accepts "${validUrl}"`
    );
  }

  const host253 = `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(61)}`;
  const host254 = `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(62)}`;
  const label63 = `${'a'.repeat(63)}.com`;
  const label64 = `${'a'.repeat(64)}.com`;

  const dnsRejectCases = [
    { url: 'https://?query=1', label: 'empty hostname before query' },
    { url: 'https://#frag', label: 'empty hostname before fragment' },
    { url: `https://${host254}`, label: 'hostname length 254 (> 253)' },
    { url: `https://${label64}`, label: 'label length 64 (> 63)' },
    { url: 'https://example..com', label: 'consecutive dots / empty label' },
    { url: 'https://.example.com', label: 'leading dot' },
    { url: 'https://example.com.', label: 'trailing dot' },
    { url: 'https://-example.com', label: 'leading hyphen in label' },
    { url: 'https://example-.com', label: 'trailing hyphen in label' },
    { url: 'https://-.com', label: 'single hyphen label' },
    { url: 'https://sub_domain.example.com', label: 'underscore in hostname' },
    { url: 'https://exa!mple.com', label: 'exclamation mark in hostname' },
    { url: 'https://exa$mple.com', label: 'dollar sign in hostname' },
    { url: 'https://exa*mple.com', label: 'asterisk in hostname' },
    { url: 'https://exa%6dple.com', label: 'percent-encoded hostname' },
    { url: 'https://example%2ecom', label: 'percent-encoded dot in hostname' },
    { url: 'https://münchen.de.', label: 'IDN with trailing dot' },
    { url: 'https://-münchen.de', label: 'IDN with leading hyphen' },
    { url: 'https://münchen-.de', label: 'IDN with trailing hyphen' },
  ];
  for (const { url, label } of dnsRejectCases) {
    testAssert(
      isValidHttpUrl(url) === false,
      `Task 80 (DNS reject - ${label}): Rejects "${url}"`
    );
  }

  const dnsAcceptCases = [
    { url: `https://${host253}`, label: 'hostname length 253 boundary' },
    { url: `https://${label63}`, label: 'label length 63 boundary' },
    { url: 'https://a.b.c', label: 'single-char DNS labels' },
    { url: 'https://my-ai-tool.example.com', label: 'DNS label with internal hyphens' },
    { url: 'http://localhost:3000', label: 'localhost with port' },
    { url: 'https://localhost', label: 'localhost without port' },
    { url: 'https://intranet', label: 'single-label hostname' },
    { url: 'https://münchen.de', label: 'Unicode IDN (münchen.de)' },
    { url: 'https://例え.jp', label: 'Unicode IDN (例え.jp)' },
    { url: 'https://xn--mnchen-3ya.de', label: 'Punycode IDN (xn--mnchen-3ya.de)' },
    { url: 'https://xn--r8jz45g.jp', label: 'Punycode IDN (xn--r8jz45g.jp)' },
  ];
  for (const { url, label } of dnsAcceptCases) {
    testAssert(
      isValidHttpUrl(url) === true,
      `Task 80 (DNS accept - ${label}): Accepts "${url}"`
    );
  }

  const ipv4RejectCases = [
    { url: 'https://127.1', label: '2-part shorthand IPv4' },
    { url: 'https://127.0.1', label: '3-part shorthand IPv4' },
    { url: 'https://2130706433', label: 'integer IPv4' },
    { url: 'https://0x7f.0.0.1', label: 'hexadecimal IPv4' },
    { url: 'https://0x7f000001', label: 'single hex integer IPv4' },
    { url: 'https://0177.0.0.1', label: 'octal IPv4' },
    { url: 'https://127.0.0.1.', label: 'trailing single dot IPv4' },
    { url: 'https://127.0.0.1..', label: 'trailing double dot IPv4' },
    { url: 'https://127.000.0.1', label: 'leading-zero octet IPv4' },
    { url: 'https://192.168.01.1', label: 'leading-zero second octet IPv4' },
    { url: 'https://256.0.0.1', label: 'out-of-range octet > 255' },
    { url: 'https://127.0.0.%31', label: 'percent-encoded IPv4' },
  ];
  for (const { url, label } of ipv4RejectCases) {
    testAssert(
      isValidHttpUrl(url) === false,
      `Task 80 (IPv4 reject - ${label}): Rejects "${url}"`
    );
  }

  const ipv4AcceptCases = [
    'https://127.0.0.1',
    'http://192.168.1.1',
    'https://0.0.0.0',
    'https://255.255.255.255',
    'https://127.0.0.1:8080/health',
  ];
  for (const validUrl of ipv4AcceptCases) {
    testAssert(
      isValidHttpUrl(validUrl) === true,
      `Task 80 (IPv4 accept): Accepts "${validUrl}"`
    );
  }

  const ipv6AcceptCases = [
    'https://[::1]',
    'https://[2001:db8::1]',
    'https://[::1]:8080',
    'https://[2001:db8::1]:443/path',
  ];
  for (const validUrl of ipv6AcceptCases) {
    testAssert(
      isValidHttpUrl(validUrl) === true,
      `Task 80 (IPv6 accept): Accepts "${validUrl}"`
    );
  }

  const ipv6RejectCases = [
    { url: 'https://[::1', label: 'missing closing bracket' },
    { url: 'https://::1]', label: 'missing opening bracket' },
    { url: 'https://[]', label: 'empty IPv6 brackets' },
    { url: 'https://[:::]', label: 'malformed IPv6 literal' },
    { url: 'https://[::1]extra', label: 'trailing characters after bracket' },
    { url: 'https://[::1]:', label: 'empty port on IPv6' },
    { url: 'https://[::1]:080', label: 'leading-zero port on IPv6' },
    { url: 'https://[::1]:65536', label: 'out-of-range port on IPv6' },
  ];
  for (const { url, label } of ipv6RejectCases) {
    testAssert(
      isValidHttpUrl(url) === false,
      `Task 80 (IPv6 reject - ${label}): Rejects "${url}"`
    );
  }

  // Integration checks across article, tool, and settings validators
  const t80ArticleRes = validateArticle(
    {
      ...existingArticles[0],
      featuredImage: 'https://example.com:080/image.webp',
      canonicalUrl: 'https://127.1/article',
    },
    { categories: existingCategories }
  );
  testAssert(
    !t80ArticleRes.isValid &&
      t80ArticleRes.errors.some((e) => e.field === 'featuredImage' && e.code === 'INVALID_URL') &&
      t80ArticleRes.errors.some((e) => e.field === 'canonicalUrl' && e.code === 'INVALID_URL'),
    'Task 80 (validateArticle): Rejects leading-zero port featuredImage and shorthand IPv4 canonicalUrl with INVALID_URL'
  );

  const t80ToolRejectRes = validateTool(
    makeTool({ url: 'https://sub_domain.example.com:65536' }),
    { categories: existingCategories }
  );
  testAssert(
    !t80ToolRejectRes.isValid &&
      t80ToolRejectRes.errors.some((e) => e.field === 'url' && e.code === 'INVALID_URL'),
    'Task 80 (validateTool): Rejects invalid hostname/port tool.url with INVALID_URL'
  );

  const t80SettingsRejectRes = validateSettings({
    ...existingSettings,
    productionUrl: 'https://0x7f.0.0.1',
    socialLinks: {
      ...existingSettings.socialLinks,
      twitter: 'https://example.com:',
    },
  });
  testAssert(
    !t80SettingsRejectRes.isValid &&
      t80SettingsRejectRes.errors.some(
        (e) => e.field === 'productionUrl' && e.code === 'INVALID_URL'
      ) &&
      t80SettingsRejectRes.errors.some(
        (e) => e.field === 'socialLinks.twitter' && e.code === 'INVALID_URL'
      ),
    'Task 80 (validateSettings): Rejects hex IPv4 productionUrl and empty-port socialLinks.twitter with INVALID_URL'
  );

  const t80ValidIntegrationRes = validateTool(
    makeTool({ url: 'https://münchen.de:443/tools' }),
    { categories: existingCategories }
  );
  testAssert(
    t80ValidIntegrationRes.isValid && t80ValidIntegrationRes.errors.length === 0,
    'Task 80 (validateTool IDN + default port): Accepts valid IDN URL with explicit :443 port',
    JSON.stringify(t80ValidIntegrationRes.errors)
  );

  // 16. Task 82 — Dedicated HTTP(S) Origin Validator (isValidHttpOriginUrl)
  console.log('\n--- 12. Task 82: isValidHttpOriginUrl() Origin-Only Validation ---');

  const originAcceptCases = [
    'https://example.com',
    'http://example.com',
    'https://example.com/',
    'http://example.com/',
    'https://example.com:8080',
    'https://example.com:443/',
    'http://example.com:80/',
    'http://localhost',
    'http://localhost/',
    'http://localhost:3000',
    'http://localhost:3000/',
    'https://127.0.0.1',
    'http://192.168.1.1/',
    'https://127.0.0.1:8080',
    'https://127.0.0.1:443/',
    'https://[::1]',
    'https://[::1]/',
    'https://[2001:db8::1]',
    'https://[::1]:8080',
    'https://[2001:db8::1]:443/',
    'https://münchen.de',
    'https://münchen.de/',
    'https://xn--mnchen-3ya.de',
    'https://xn--mnchen-3ya.de:8443/',
  ];
  for (const validOrigin of originAcceptCases) {
    testAssert(
      isValidHttpOriginUrl(validOrigin) === true,
      `Task 82 (Origin accept): Accepts "${validOrigin}"`
    );
  }

  const originRejectCases = [
    { url: 'https://example.com/blog', label: 'non-root path' },
    { url: 'https://example.com/blog/', label: 'non-root path with trailing slash' },
    { url: 'https://example.com//', label: 'multiple trailing slashes' },
    { url: 'https://example.com///', label: 'triple trailing slash' },
    { url: 'https://example.com:8080//', label: 'port with multiple trailing slashes' },
    { url: 'https://example.com/?x=1', label: 'root slash with query' },
    { url: 'https://example.com/#section', label: 'root slash with fragment' },
    { url: 'https://example.com?', label: 'empty query delimiter without slash' },
    { url: 'https://example.com#', label: 'empty fragment delimiter without slash' },
    { url: 'https://example.com/?', label: 'empty query delimiter with root slash' },
    { url: 'https://example.com/#', label: 'empty fragment delimiter with root slash' },
    { url: 'https://example.com/path?x=1', label: 'path with query' },
    { url: 'https://example.com/path#section', label: 'path with fragment' },
    { url: 'https://example.com/.', label: 'dot segment path' },
    { url: 'https://example.com/..', label: 'double-dot segment path' },
    { url: 'https://127.0.0.1/health', label: 'IPv4 with non-root path' },
    { url: 'https://[::1]/path', label: 'IPv6 with non-root path' },
    { url: 'https://[::1]:8080?q=1', label: 'IPv6 with query' },
    { url: 'https://münchen.de/blog', label: 'IDN with non-root path' },
    { url: 'https://user@example.com', label: 'userinfo inherited rejection' },
    { url: 'https://127.1', label: 'shorthand IPv4 inherited rejection' },
    { url: 'https://example.com:080', label: 'leading-zero port inherited rejection' },
    { url: 'https://[::1', label: 'unclosed IPv6 inherited rejection' },
    { url: 'https://example.com/%ZZ', label: 'malformed percent inherited rejection' },
  ];
  for (const { url, label } of originRejectCases) {
    testAssert(
      isValidHttpOriginUrl(url) === false,
      `Task 82 (Origin reject - ${label}): Rejects "${url}"`
    );
  }

  // Task 82 validateSettings() integration & existing productionUrl compatibility
  testAssert(
    isValidHttpOriginUrl(existingSettings.productionUrl) === true,
    `Task 82 (Existing productionUrl compatibility): Accepts "${existingSettings.productionUrl}"`
  );

  const t82SettingsRejectInputs = [
    'https://example.com/blog',
    'https://example.com/blog/',
    'https://example.com//',
    'https://example.com/?x=1',
    'https://example.com/#section',
    'https://example.com?',
    'https://example.com#',
  ];
  for (const badProdUrl of t82SettingsRejectInputs) {
    const res = validateSettings({
      ...existingSettings,
      productionUrl: badProdUrl,
    });
    const prodErr = res.errors.find((e) => e.field === 'productionUrl');
    testAssert(
      !res.isValid &&
        Boolean(prodErr) &&
        prodErr.code === 'INVALID_URL' &&
        /origin/i.test(prodErr.message),
      `Task 82 (validateSettings reject): Rejects productionUrl "${badProdUrl}" with INVALID_URL and origin message`
    );
  }

  const t82SettingsAcceptInputs = [
    'https://example.com',
    'https://example.com/',
    'https://example.com:8443',
    'https://[::1]:8080/',
    'https://münchen.de/',
    'http://localhost:3000',
  ];
  for (const goodProdUrl of t82SettingsAcceptInputs) {
    const res = validateSettings({
      ...existingSettings,
      productionUrl: goodProdUrl,
      socialLinks: {
        ...existingSettings.socialLinks,
        twitter: 'https://x.com/ainovex/status?ref=1#top',
      },
    });
    testAssert(
      res.isValid && res.errors.length === 0,
      `Task 82 (validateSettings accept + non-origin socialLinks preserved): Accepts productionUrl "${goodProdUrl}"`,
      JSON.stringify(res.errors)
    );
  }

  console.log('\n================================================================');
  console.log(
    ` [Validators Test Suite Summary] Total: ${totalCount} | Passed: ${passCount} | Failed: ${failCount}`
  );
  console.log('================================================================\n');

  return { totalCount, passCount, failCount, success: failCount === 0 };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(__filename) &&
  process.argv.includes('--test')
) {
  const result = runValidatorTests();
  process.exit(result.success ? 0 : 1);
}

