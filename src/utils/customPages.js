// Pure ESM helpers for Custom Static Pages shared across:
// - browser React runtime (src/App.tsx, src/views/CustomPageView.tsx)
// - client/build SEO resolution (src/utils/pageSeo.js, src/config/indexing.js)
// - build scripts (scripts/postbuild.mjs, scripts/finalize-sitemap.mjs)
//
// IMPORTANT: Must remain browser-safe (no Node built-in imports like node:fs or node:path)
// and enforce the exact same structural, slug, reserved-route, and safety rules as
// scripts/lib/validators.mjs.

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

const ALLOWED_CUSTOM_PAGE_FIELD_SET = new Set(ALLOWED_CUSTOM_PAGE_FIELDS);

export const PROTO_POLLUTION_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

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

const CUSTOM_PAGE_ID_REGEX = /^[a-z0-9][a-z0-9_-]{0,127}$/;
const CUSTOM_PAGE_SLUG_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SINGLE_LINE_CONTROL_REGEX = /[\u0000-\u001F\u007F-\u009F]/;
const MULTILINE_CONTROL_REGEX = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/;
const UNSAFE_HTML_TAG_REGEX = /<\/?\s*(?:script|iframe|object|embed|applet|base|meta)\b/i;
const UNSAFE_EVENT_ATTR_REGEX = /<[a-z][^>]*\bon[a-z]+\s*=/i;
const UNSAFE_URI_REGEX = /(?:javascript|vbscript):|data\s*:\s*text\/html/i;

function isPlainObject(val) {
  if (!val || typeof val !== 'object' || Array.isArray(val)) return false;
  const proto = Object.getPrototypeOf(val);
  return proto === Object.prototype || proto === null;
}

function isValidIsoTimestamp(ts) {
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
  return `${roundTrip.slice(0, 19)}Z` === ts;
}

/**
 * Checks whether a slug or route path collides with a reserved site route or prefix.
 */
export function isReservedPageSlug(slugOrPath) {
  if (typeof slugOrPath !== 'string') return true;
  if (SINGLE_LINE_CONTROL_REGEX.test(slugOrPath) || /\s/.test(slugOrPath)) {
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
 * Validates a custom page ID (1..128 chars [a-z0-9_-], starting alphanumeric).
 */
export function isValidCustomPageId(id) {
  if (typeof id !== 'string') return false;
  if (PROTO_POLLUTION_KEYS.has(id)) return false;
  return CUSTOM_PAGE_ID_REGEX.test(id);
}

/**
 * Validates a custom static page slug:
 * - strictly 2..80 chars lowercase [a-z0-9] with single hyphens
 * - rejects path traversal, slashes, dots, whitespace, uppercase
 * - rejects reserved routes and prefixes
 */
export function isValidCustomPageSlug(slug) {
  if (typeof slug !== 'string') return false;
  if (slug.length < 2 || slug.length > 80) return false;
  if (!CUSTOM_PAGE_SLUG_REGEX.test(slug)) return false;
  if (isReservedPageSlug(slug)) return false;
  return true;
}

/**
 * Checks whether Markdown content for a custom page is safe and within bounds.
 */
export function isSafeCustomPageContent(content) {
  if (typeof content !== 'string') return false;
  if (MULTILINE_CONTROL_REGEX.test(content)) return false;
  if (!content.trim()) return false;
  if (content.length > MAX_CUSTOM_PAGE_CONTENT_LENGTH) return false;
  if (
    UNSAFE_HTML_TAG_REGEX.test(content) ||
    UNSAFE_EVENT_ATTR_REGEX.test(content) ||
    UNSAFE_URI_REGEX.test(content)
  ) {
    return false;
  }
  return true;
}

/**
 * Validates a stored custom static page record for safe public routing/rendering.
 */
export function isValidCustomPageRecord(page) {
  if (!isPlainObject(page)) return false;

  for (const key of Object.getOwnPropertyNames(page)) {
    if (PROTO_POLLUTION_KEYS.has(key)) return false;
    if (!ALLOWED_CUSTOM_PAGE_FIELD_SET.has(key)) return false;
  }

  if (!isValidCustomPageId(page.id)) return false;
  if (!isValidCustomPageSlug(page.slug)) return false;

  if (typeof page.title !== 'string') return false;
  if (SINGLE_LINE_CONTROL_REGEX.test(page.title)) return false;
  if (UNSAFE_HTML_TAG_REGEX.test(page.title) || UNSAFE_EVENT_ATTR_REGEX.test(page.title)) {
    return false;
  }
  const trimmedTitle = page.title.trim();
  if (trimmedTitle.length < 2 || trimmedTitle.length > 200) return false;

  if (!isSafeCustomPageContent(page.content)) return false;

  if (typeof page.isPublished !== 'boolean') return false;
  if (!isValidIsoTimestamp(page.createdAt)) return false;
  if (!isValidIsoTimestamp(page.updatedAt)) return false;
  if (Date.parse(page.updatedAt) < Date.parse(page.createdAt)) return false;

  return true;
}

/**
 * Whether a custom page record is structurally valid, safe, and explicitly published.
 */
export function isPublishedCustomPage(page) {
  return isValidCustomPageRecord(page) && page.isPublished === true;
}

/**
 * Counts how many times each slug appears in a raw pages array so duplicate slugs
 * can be rejected rather than silently picking an arbitrary record.
 */
function buildSlugFrequencyMap(pages) {
  const counts = new Map();
  if (!Array.isArray(pages)) return counts;
  for (const page of pages) {
    if (!isPlainObject(page) || typeof page.slug !== 'string') continue;
    const key = page.slug.trim().toLowerCase();
    if (!key) continue;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

/**
 * Returns only valid, unique-slug, explicitly published custom pages (safe for rendering).
 */
export function getRenderablePublishedCustomPages(pages = []) {
  if (!Array.isArray(pages)) return [];
  if (pages.length > MAX_CUSTOM_PAGES) return [];

  const slugCounts = buildSlugFrequencyMap(pages);
  const idCounts = new Map();
  for (const page of pages) {
    if (isPlainObject(page) && typeof page.id === 'string' && page.id) {
      idCounts.set(page.id, (idCounts.get(page.id) || 0) + 1);
    }
  }

  return pages.filter((page) => {
    if (!isPublishedCustomPage(page)) return false;
    if ((slugCounts.get(page.slug) || 0) !== 1) return false;
    if ((idCounts.get(page.id) || 0) !== 1) return false;
    return true;
  });
}

/**
 * Resolves a single published custom page by validated slug.
 * Rejects reserved slugs, duplicate slugs, unpublished records, and malformed records.
 */
export function findPublishedCustomPageBySlug(slug, pages = []) {
  if (!isValidCustomPageSlug(slug) || !Array.isArray(pages)) return null;
  if (pages.length > MAX_CUSTOM_PAGES) return null;

  const slugCounts = buildSlugFrequencyMap(pages);
  if ((slugCounts.get(slug) || 0) !== 1) return null;

  const match = pages.find((p) => isPlainObject(p) && p.slug === slug);
  if (!match || !isPublishedCustomPage(match)) return null;

  const idMatches = pages.filter((p) => isPlainObject(p) && p.id === match.id);
  if (idMatches.length !== 1) return null;

  return match;
}

/**
 * Extracts a clean plain-text description snippet from Markdown body content for fallback SEO.
 * Returns '' if no meaningful non-heading prose exists (< 10 chars).
 */
export function extractCustomPageDescription(content, maxLen = 320) {
  if (!isSafeCustomPageContent(content)) return '';
  let text = String(content).replace(/^#\s+[^\n]+\n+/, '');
  text = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^#{1,6}\s+.*$/gm, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/^>\s?/gm, '')
    .replace(/[`*_~|]/g, '')
    .replace(/\r?\n+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (text.length < 10) return '';
  return text.length > maxLen ? text.slice(0, maxLen).trim() : text;
}
