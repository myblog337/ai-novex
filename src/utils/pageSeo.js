// Shared Global & Page-Level SEO Resolver, Validator, and JSON-LD Builder.
// Used by BOTH the browser app (src/App.tsx, src/utils/seo.ts) and Node build scripts
// (scripts/postbuild.mjs, scripts/finalize-sitemap.mjs) so client-side metadata and
// pre-rendered static HTML always stay 100% consistent.

import { LEGAL_TITLES, LEGAL_BREADCRUMBS } from '../config/legal.js';
import {
  categoryHasContent,
  categoryTitle,
  findPublishedToolBySlug,
  isValidToolSlug,
} from '../config/indexing.js';
import { findAuthorBySlug, getArticleAuthorProfile } from './authors.js';
import {
  extractCustomPageDescription,
  findPublishedCustomPageBySlug,
  isValidCustomPageSlug,
} from './customPages.js';

export const DEFAULT_SITE_URL = 'https://ai-novex.netlify.app';
export const DEFAULT_SITE_NAME = 'AINOVEX';
export const DEFAULT_TITLE_TEMPLATE = '%s | AINOVEX';
export const DEFAULT_SEO_TITLE = 'AINOVEX - Discover the Best AI Tools & Resources';
export const DEFAULT_META_DESCRIPTION =
  'Discover the best AI tools, software reviews, and guides on AINOVEX. Boost productivity and work smarter with curated artificial intelligence.';
export const DEFAULT_OG_IMAGE = '/images/og-default.png';
export const DEFAULT_IMAGE_ALT = 'AINOVEX AI tools directory and editorial guides';

export const ALLOWED_OG_TYPES = new Set(['website', 'article', 'profile']);
export const ALLOWED_TWITTER_CARDS = new Set(['summary', 'summary_large_image']);
export const ALLOWED_MAX_IMAGE_PREVIEW = new Set(['none', 'standard', 'large']);
export const ALLOWED_SCHEMA_TYPES = new Set([
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

const PROTO_POLLUTION_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const CONTROL_CHAR_REGEX = /[\u0000-\u001F\u007F-\u009F]/;
const DANGEROUS_MARKUP_REGEX = /<\/script|<!--|-->/i;
const DANGEROUS_SCHEME_REGEX = /^\s*(?:javascript|data|vbscript):/i;
const SCHEMA_TYPE_VALUE_REGEX = /^[A-Za-z][A-Za-z0-9_:-]{0,63}$/;
const SEO_PAGE_PATH_REGEX =
  /^\/(?:[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?(?:\/[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?)*\/?)?$/;

export const STATIC_SEO_DEFAULTS = {
  '/': {
    pageId: 'home',
    pageType: 'home',
    title: 'AINOVEX - AI Tools & Technology Platform',
    description:
      'Discover the best AI tools, software reviews, and guides on AINOVEX. Boost productivity and work smarter with curated artificial intelligence.',
    schemaType: 'WebSite',
    breadcrumbEnabled: false,
    crumbs: [],
    baseIndexable: true,
  },
  '/tools': {
    pageId: 'static:tools',
    pageType: 'static',
    title: 'Best AI Tools Directory & Software Reviews 2026 | AINOVEX',
    description:
      'Browse and compare the top artificial intelligence tools for writing, image creation, video, coding, and productivity. Find the best software for your needs.',
    schemaType: 'CollectionPage',
    schemaName: 'AI Tools Directory',
    breadcrumbEnabled: true,
    crumbs: [{ label: 'AI Tools Directory' }],
    baseIndexable: true,
  },
  '/blog': {
    pageId: 'static:blog',
    pageType: 'static',
    title: 'AI Insights, Tutorials & Technology Guides | AINOVEX',
    description:
      'Explore actionable AI tutorials, practical workflows, tool comparisons, and tech guides from the AINOVEX editorial team. Master modern AI applications today.',
    schemaType: 'CollectionPage',
    schemaName: 'AI Insights, Tutorials & Technology Guides',
    breadcrumbEnabled: true,
    crumbs: [{ label: 'Blog & Articles' }],
    baseIndexable: true,
  },
  '/categories': {
    pageId: 'static:categories',
    pageType: 'static',
    title: 'Browse AI Categories & Topics | AINOVEX',
    description:
      'Explore specialized AI software categories from writing and image generation to coding and productivity. Find the right tools for your specific workflow.',
    schemaType: 'CollectionPage',
    schemaName: 'Browse AI Categories',
    breadcrumbEnabled: true,
    crumbs: [{ label: 'Categories' }],
    baseIndexable: true,
  },
  '/about': {
    pageId: 'about',
    pageType: 'about',
    title: 'About Us & Editorial Standards | AINOVEX',
    description:
      'Learn about AINOVEX, our mission to simplify artificial intelligence, our testing standards, and our independent editorial review methodology.',
    schemaType: 'AboutPage',
    breadcrumbEnabled: true,
    crumbs: [{ label: 'About Us' }],
    baseIndexable: true,
  },
  '/contact': {
    pageId: 'contact',
    pageType: 'contact',
    title: 'Contact AINOVEX | Editorial & Support Team',
    description:
      'Contact the AINOVEX editorial team for software recommendations, directory submissions, editorial corrections, or partnership inquiries.',
    schemaType: 'ContactPage',
    breadcrumbEnabled: true,
    crumbs: [{ label: 'Contact Us' }],
    baseIndexable: true,
  },
  '/privacy': {
    pageId: 'privacy',
    pageType: 'privacy',
    title: 'Privacy Policy | AINOVEX AI Platform',
    description:
      'Read the official AINOVEX Privacy Policy. Learn how we safeguard your personal information, handle essential cookies, and maintain data privacy.',
    schemaType: 'WebPage',
    breadcrumbEnabled: true,
    crumbs: [{ label: LEGAL_BREADCRUMBS.privacy || 'Privacy Policy' }],
    baseIndexable: false,
  },
  '/terms': {
    pageId: 'terms',
    pageType: 'terms',
    title: 'Terms of Service | AINOVEX Platform',
    description:
      'Review the AINOVEX Terms of Service. Understand the rules, guidelines, disclaimers, and legal agreements governing the use of our website.',
    schemaType: 'WebPage',
    breadcrumbEnabled: true,
    crumbs: [{ label: LEGAL_BREADCRUMBS.terms || 'Terms of Service' }],
    baseIndexable: false,
  },
  '/editorial-policy': {
    pageId: 'static:editorial-policy',
    pageType: 'static',
    title: 'Editorial Policy & Review Standards | AINOVEX',
    description:
      'Explore AINOVEX editorial policy, review guidelines, testing benchmarks, and independence standards for recommending artificial intelligence tools.',
    schemaType: 'WebPage',
    breadcrumbEnabled: true,
    crumbs: [{ label: LEGAL_BREADCRUMBS.editorial || 'Editorial Policy' }],
    baseIndexable: true,
  },
  '/affiliate-disclosure': {
    pageId: 'static:affiliate-disclosure',
    pageType: 'static',
    title: 'Affiliate & Monetization Disclosure | AINOVEX',
    description:
      'Read the AINOVEX affiliate and advertising disclosure. Learn how our site remains free for readers through transparent monetization and integrity.',
    schemaType: 'WebPage',
    breadcrumbEnabled: true,
    crumbs: [{ label: LEGAL_BREADCRUMBS.affiliate || 'Affiliate Disclosure' }],
    baseIndexable: false,
  },
};

function isPlainObject(val) {
  if (!val || typeof val !== 'object' || Array.isArray(val)) return false;
  const proto = Object.getPrototypeOf(val);
  return proto === Object.prototype || proto === null;
}

function cleanString(val, maxLen = 500, minLen = 1) {
  if (typeof val !== 'string') return '';
  if (CONTROL_CHAR_REGEX.test(val)) return '';
  const trimmed = val.trim();
  if (!trimmed || trimmed.length < minLen || trimmed.length > maxLen) return '';
  return trimmed;
}

export function normalizeRoutePath(rawPath) {
  if (typeof rawPath !== 'string' || !rawPath.trim()) return '/';
  const clean = rawPath.split(/[?#]/)[0].trim();
  if (!clean || clean === '/') return '/';
  const withoutTrailing = clean.replace(/\/+$/, '');
  if (!withoutTrailing) return '/';
  const withLeading = withoutTrailing.startsWith('/') ? withoutTrailing : `/${withoutTrailing}`;
  return `${withLeading}/`;
}

export function stripTrailingSlash(rawPath) {
  const norm = normalizeRoutePath(rawPath);
  return norm === '/' ? '/' : norm.slice(0, -1);
}

export function isValidSeoPathFormat(rawPath) {
  if (typeof rawPath !== 'string' || rawPath.length < 1 || rawPath.length > 256) return false;
  if (CONTROL_CHAR_REGEX.test(rawPath) || /\s/.test(rawPath)) return false;
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

export function isSafeHttpUrl(urlStr) {
  if (typeof urlStr !== 'string' || !urlStr) return false;
  if (/[\u0000-\u001F\u007F\s]/.test(urlStr)) return false;
  if (urlStr.includes('\\')) return false;
  if (!/^https?:\/\/[^/]/i.test(urlStr)) return false;
  try {
    const parsed = new URL(urlStr);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    if (parsed.username !== '' || parsed.password !== '') return false;
    const afterScheme = urlStr.slice(urlStr.indexOf('://') + 3);
    const authorityEnd = afterScheme.search(/[/?#]/);
    const rawAuthority = authorityEnd === -1 ? afterScheme : afterScheme.slice(0, authorityEnd);
    if (!rawAuthority || rawAuthority.includes('@')) return false;
    return Boolean(parsed.hostname);
  } catch {
    return false;
  }
}

export function isSafeAssetOrUrl(pathStr) {
  if (typeof pathStr !== 'string' || !pathStr.trim()) return false;
  if (CONTROL_CHAR_REGEX.test(pathStr)) return false;
  if (
    pathStr.startsWith('/') &&
    !pathStr.startsWith('//') &&
    !pathStr.startsWith('/\\') &&
    !pathStr.includes('..') &&
    !pathStr.includes('\0')
  ) {
    return true;
  }
  return isSafeHttpUrl(pathStr);
}

export function toAbsoluteAssetUrl(img, baseUrl) {
  const cleanBase = String(baseUrl || DEFAULT_SITE_URL).replace(/\/+$/, '');
  if (!img || typeof img !== 'string') return '';
  if (/^https?:\/\//i.test(img)) return img;
  return `${cleanBase}${img.startsWith('/') ? '' : '/'}${img}`;
}

export function trimMetaDescription(desc, maxLen = 155) {
  const clean = String(desc || '').replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  if (clean.length <= maxLen) return clean;
  return clean.slice(0, maxLen - 3).trim() + '...';
}

export function formatTitleWithTemplate(rawTitle, titleTemplate, siteName = DEFAULT_SITE_NAME) {
  const title = cleanString(rawTitle, 200);
  if (!title) return '';
  const tpl = cleanString(titleTemplate, 120);
  if (tpl && tpl.includes('%s')) {
    if (siteName && title.includes(`| ${siteName}`)) {
      return title;
    }
    return tpl.replace('%s', title);
  }
  return siteName && !title.includes(`| ${siteName}`) ? `${title} | ${siteName}` : title;
}

const STRUCTURED_DATA_URL_KEYS = new Set([
  'url',
  '@id',
  'sameAs',
  'item',
  'contentUrl',
  'embedUrl',
  'target',
]);

function isSafeStructuredDataUrl(val) {
  if (typeof val !== 'string') return false;
  const trimmed = val.trim();
  if (!trimmed || CONTROL_CHAR_REGEX.test(trimmed)) return false;
  if (DANGEROUS_SCHEME_REGEX.test(trimmed) || DANGEROUS_MARKUP_REGEX.test(trimmed)) return false;
  if (isSafeHttpUrl(trimmed)) return true;
  if (trimmed.startsWith('/') && isSafeAssetOrUrl(trimmed)) return true;
  return false;
}

function validateStructuredDataUrls(val) {
  if (typeof val === 'string') return isSafeStructuredDataUrl(val);
  if (Array.isArray(val)) return val.every((item) => validateStructuredDataUrls(item));
  if (isPlainObject(val)) {
    if (typeof val['@id'] === 'string' && !isSafeStructuredDataUrl(val['@id'])) return false;
    if (typeof val.url === 'string' && !isSafeStructuredDataUrl(val.url)) return false;
    return true;
  }
  return false;
}

function isValidSchemaTypeValue(t) {
  const validSingle = (v) => typeof v === 'string' && SCHEMA_TYPE_VALUE_REGEX.test(v);
  if (Array.isArray(t)) {
    return t.length > 0 && t.every(validSingle);
  }
  return validSingle(t);
}

function isValidSchemaContextValue(ctx) {
  return (
    typeof ctx === 'string' &&
    (['https://schema.org', 'http://schema.org', 'https://schema.org/', 'http://schema.org/'].includes(ctx) ||
      isSafeHttpUrl(ctx))
  );
}

export function isSafeStructuredData(value, maxDepth = 6, maxBytes = 16384) {
  if (!isPlainObject(value)) return false;
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return false;
  }
  if (typeof serialized !== 'string') return false;

  let byteLength = serialized.length;
  if (typeof TextEncoder !== 'undefined') {
    byteLength = new TextEncoder().encode(serialized).length;
  } else if (typeof Buffer !== 'undefined') {
    byteLength = Buffer.byteLength(serialized, 'utf8');
  }
  if (byteLength > maxBytes) return false;

  const stack = [{ node: value, depth: 0 }];
  const seen = new WeakSet();

  while (stack.length > 0) {
    const { node, depth } = stack.pop();
    if (depth > maxDepth) return false;

    if (typeof node === 'string') {
      if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/.test(node)) return false;
      if (DANGEROUS_MARKUP_REGEX.test(node)) return false;
      if (DANGEROUS_SCHEME_REGEX.test(node)) return false;
      continue;
    }
    if (node === null || typeof node === 'boolean') continue;
    if (typeof node === 'number') {
      if (!Number.isFinite(node)) return false;
      continue;
    }
    if (typeof node !== 'object') return false;
    if (seen.has(node)) return false;
    seen.add(node);

    if (Array.isArray(node)) {
      for (const item of node) {
        if (item !== null && typeof item === 'object' && depth + 1 > maxDepth) return false;
        stack.push({ node: item, depth: depth + 1 });
      }
      continue;
    }
    if (!isPlainObject(node)) return false;

    if (
      Object.prototype.hasOwnProperty.call(node, '@context') &&
      node['@context'] !== undefined &&
      !isValidSchemaContextValue(node['@context'])
    ) {
      return false;
    }

    if (
      Object.prototype.hasOwnProperty.call(node, '@type') &&
      node['@type'] !== undefined &&
      !isValidSchemaTypeValue(node['@type'])
    ) {
      return false;
    }

    for (const key of Object.getOwnPropertyNames(node)) {
      if (PROTO_POLLUTION_KEYS.has(key)) return false;
      if (CONTROL_CHAR_REGEX.test(key)) return false;
      const val = node[key];
      if (STRUCTURED_DATA_URL_KEYS.has(key) && val !== undefined && !validateStructuredDataUrls(val)) {
        return false;
      }
      if (val !== null && typeof val === 'object' && depth + 1 > maxDepth) return false;
      stack.push({ node: val, depth: depth + 1 });
    }
  }

  const hasRootType =
    Object.prototype.hasOwnProperty.call(value, '@type') &&
    value['@type'] !== undefined &&
    isValidSchemaTypeValue(value['@type']);
  const hasValidGraph =
    Array.isArray(value['@graph']) &&
    value['@graph'].length > 0 &&
    value['@graph'].every(
      (item) => isPlainObject(item) && item['@type'] !== undefined && isValidSchemaTypeValue(item['@type'])
    );

  if (!hasRootType && !hasValidGraph) {
    return false;
  }

  return true;
}

function cloneSafeJson(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(cloneSafeJson);
  const out = {};
  for (const key of Object.keys(value)) {
    if (PROTO_POLLUTION_KEYS.has(key)) continue;
    out[key] = cloneSafeJson(value[key]);
  }
  return out;
}

/**
 * Safely escapes serialized JSON-LD for embedding inside <script type="application/ld+json">.
 * Escapes '<', '>', '&', and Unicode line/paragraph separators so content can never break out of <script>.
 */
export function escapeJsonLd(obj) {
  return JSON.stringify(obj, null, 2)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/**
 * Safely sanitizes seoConfig.defaults into validated fallback fields.
 */
export function extractSafeSeoDefaults(seoConfig) {
  const raw = isPlainObject(seoConfig?.defaults) ? seoConfig.defaults : {};
  const siteName = cleanString(raw.siteName, 100) || '';
  const titleTemplate =
    typeof raw.titleTemplate === 'string' && raw.titleTemplate.includes('%s')
      ? cleanString(raw.titleTemplate, 120)
      : '';
  const defaultSeoTitle = cleanString(raw.defaultSeoTitle, 160, 3) || '';
  const defaultMetaDescription = cleanString(raw.defaultMetaDescription, 320, 10) || '';
  const defaultFocusKeyword = cleanString(raw.defaultFocusKeyword, 120) || '';
  const defaultSecondaryKeywords = Array.isArray(raw.defaultSecondaryKeywords)
    ? raw.defaultSecondaryKeywords.filter((k) => cleanString(k, 100)).map((k) => k.trim())
    : [];
  const defaultIndex = typeof raw.defaultIndex === 'boolean' ? raw.defaultIndex : undefined;
  const defaultFollow = typeof raw.defaultFollow === 'boolean' ? raw.defaultFollow : undefined;
  const defaultMaxImagePreview = ALLOWED_MAX_IMAGE_PREVIEW.has(raw.defaultMaxImagePreview)
    ? raw.defaultMaxImagePreview
    : undefined;
  const defaultMaxSnippet =
    typeof raw.defaultMaxSnippet === 'number' &&
    Number.isSafeInteger(raw.defaultMaxSnippet) &&
    raw.defaultMaxSnippet >= -1 &&
    raw.defaultMaxSnippet <= 1000
      ? raw.defaultMaxSnippet
      : undefined;
  const defaultMaxVideoPreview =
    typeof raw.defaultMaxVideoPreview === 'number' &&
    Number.isSafeInteger(raw.defaultMaxVideoPreview) &&
    raw.defaultMaxVideoPreview >= -1 &&
    raw.defaultMaxVideoPreview <= 1000
      ? raw.defaultMaxVideoPreview
      : undefined;
  const defaultOgTitle = cleanString(raw.defaultOgTitle, 160) || '';
  const defaultOgDescription = cleanString(raw.defaultOgDescription, 320) || '';
  const defaultOgImage = isSafeAssetOrUrl(raw.defaultOgImage) ? raw.defaultOgImage.trim() : '';
  const defaultOgType = ALLOWED_OG_TYPES.has(raw.defaultOgType) ? raw.defaultOgType : undefined;
  const defaultTwitterTitle = cleanString(raw.defaultTwitterTitle, 160) || '';
  const defaultTwitterDescription = cleanString(raw.defaultTwitterDescription, 320) || '';
  const defaultTwitterImage = isSafeAssetOrUrl(raw.defaultTwitterImage)
    ? raw.defaultTwitterImage.trim()
    : '';
  const defaultTwitterCard = ALLOWED_TWITTER_CARDS.has(raw.defaultTwitterCard)
    ? raw.defaultTwitterCard
    : undefined;
  const defaultTwitterSite =
    typeof raw.defaultTwitterSite === 'string' &&
    !CONTROL_CHAR_REGEX.test(raw.defaultTwitterSite) &&
    /^@[a-zA-Z0-9_]{1,30}$/.test(raw.defaultTwitterSite.trim())
      ? raw.defaultTwitterSite.trim()
      : '';
  const defaultSchemaType = ALLOWED_SCHEMA_TYPES.has(raw.defaultSchemaType)
    ? raw.defaultSchemaType
    : undefined;
  const defaultBreadcrumbEnabled =
    typeof raw.defaultBreadcrumbEnabled === 'boolean' ? raw.defaultBreadcrumbEnabled : undefined;
  const defaultImageAlt = cleanString(raw.defaultImageAlt, 300) || '';

  return {
    siteName,
    titleTemplate,
    defaultSeoTitle,
    defaultMetaDescription,
    defaultFocusKeyword,
    defaultSecondaryKeywords,
    defaultIndex,
    defaultFollow,
    defaultMaxImagePreview,
    defaultMaxSnippet,
    defaultMaxVideoPreview,
    defaultOgTitle,
    defaultOgDescription,
    defaultOgImage,
    defaultOgType,
    defaultTwitterTitle,
    defaultTwitterDescription,
    defaultTwitterImage,
    defaultTwitterCard,
    defaultTwitterSite,
    defaultSchemaType,
    defaultBreadcrumbEnabled,
    defaultImageAlt,
  };
}

function matchesCandidateScope(
  rec,
  candidatePageIds = [],
  lookupKey = null,
  { strictStaticScope = false } = {}
) {
  if (!isPlainObject(rec)) return false;

  const targetToolId = candidatePageIds.find(
    (id) => typeof id === 'string' && id.startsWith('tool:')
  );
  if (targetToolId) {
    const targetToolSlug = targetToolId.slice('tool:'.length);
    if (lookupKey && lookupKey.startsWith('tool:') && lookupKey !== targetToolId) {
      return false;
    }
    const recPageId = cleanString(rec.pageId, 128);
    if (recPageId && recPageId !== targetToolId) {
      return false;
    }
    const recPageType = cleanString(rec.pageType, 32);
    if (recPageType && recPageType !== 'tool') {
      return false;
    }
    const recSlug = cleanString(rec.slug, 128);
    if (recSlug && recSlug !== targetToolSlug) {
      return false;
    }
    return true;
  }

  if (strictStaticScope) {
    const targetStaticId = candidatePageIds.find(
      (id) => typeof id === 'string' && id.startsWith('static:')
    );
    if (targetStaticId) {
      const targetStaticSlug = targetStaticId.slice('static:'.length);
      if (lookupKey && lookupKey.startsWith('static:') && lookupKey !== targetStaticId) {
        return false;
      }
      const recPageId = cleanString(rec.pageId, 128);
      if (recPageId && recPageId !== targetStaticId) {
        return false;
      }
      const recPageType = cleanString(rec.pageType, 32);
      if (recPageType && recPageType !== 'static') {
        return false;
      }
      const recSlug = cleanString(rec.slug, 128);
      if (recSlug && recSlug !== targetStaticSlug) {
        return false;
      }
    }
  }

  return true;
}

/**
 * Finds the matching SEO page record in seoConfig.pages by canonical path first,
 * falling back to candidate pageIds when path matching isn't available.
 * Never mutates seoConfig and never throws on malformed data.
 */
export function findSeoPageRecord(
  seoConfig,
  canonicalPath,
  candidatePageIds = [],
  options = {}
) {
  if (!isPlainObject(seoConfig) || !isPlainObject(seoConfig.pages)) return null;
  const targetPath = normalizeRoutePath(canonicalPath);
  const pages = seoConfig.pages;

  for (const key of Object.keys(pages)) {
    if (PROTO_POLLUTION_KEYS.has(key)) continue;
    const rec = pages[key];
    if (!isPlainObject(rec)) continue;
    if (typeof rec.path === 'string' && rec.path.trim()) {
      if (
        normalizeRoutePath(rec.path) === targetPath &&
        matchesCandidateScope(rec, candidatePageIds, key, options)
      ) {
        return rec;
      }
    }
  }

  for (const id of candidatePageIds) {
    if (!id || PROTO_POLLUTION_KEYS.has(id)) continue;
    const rec = pages[id];
    if (isPlainObject(rec) && matchesCandidateScope(rec, candidatePageIds, id, options)) {
      if (typeof rec.path === 'string' && rec.path.trim()) {
        if (normalizeRoutePath(rec.path) === targetPath) {
          return rec;
        }
      } else {
        return rec;
      }
    }
  }

  return null;
}

function extractSafePageOverrides(pageRecord) {
  if (!isPlainObject(pageRecord)) return null;

  let safeBreadcrumb = null;
  if (isPlainObject(pageRecord.breadcrumb)) {
    const enabled =
      typeof pageRecord.breadcrumb.enabled === 'boolean' ? pageRecord.breadcrumb.enabled : undefined;
    const label = cleanString(pageRecord.breadcrumb.label, 100) || undefined;
    let items;
    if (Array.isArray(pageRecord.breadcrumb.items)) {
      const validItems = [];
      const seenPaths = new Set();
      let allValid = pageRecord.breadcrumb.items.length > 0 && pageRecord.breadcrumb.items.length <= 10;
      if (allValid) {
        for (let idx = 0; idx < pageRecord.breadcrumb.items.length; idx++) {
          const item = pageRecord.breadcrumb.items[idx];
          const itemName = cleanString(item?.name, 100);
          if (!isPlainObject(item) || !itemName || !isValidSeoPathFormat(item.path)) {
            allValid = false;
            break;
          }
          const normItemPath = normalizeRoutePath(item.path);
          if (seenPaths.has(normItemPath)) {
            allValid = false;
            break;
          }
          if (normItemPath === '/' && idx > 0) {
            allValid = false;
            break;
          }
          if (itemName.toLowerCase() === 'home' && (idx > 0 || normItemPath !== '/')) {
            allValid = false;
            break;
          }
          seenPaths.add(normItemPath);
          validItems.push({
            name: itemName,
            path: normItemPath,
          });
        }
      }
      if (
        allValid &&
        validItems.length > 0 &&
        !(validItems.length === 1 && validItems[0].path === '/')
      ) {
        items = validItems;
      }
    }
    safeBreadcrumb = { enabled, label, items };
  }

  let safeCustomImageAlts = {};
  if (isPlainObject(pageRecord.customImageAlts)) {
    for (const k of Object.keys(pageRecord.customImageAlts)) {
      if (PROTO_POLLUTION_KEYS.has(k)) continue;
      const alt = cleanString(pageRecord.customImageAlts[k], 300);
      if (alt) safeCustomImageAlts[k] = alt;
    }
  }

  let safeSecondaryKeywords = null;
  if (Array.isArray(pageRecord.secondaryKeywords)) {
    const cleaned = [];
    const seen = new Set();
    for (const rawKw of pageRecord.secondaryKeywords) {
      const kw = cleanString(rawKw, 100);
      if (!kw) continue;
      const lower = kw.toLowerCase();
      if (seen.has(lower)) continue;
      seen.add(lower);
      cleaned.push(kw);
      if (cleaned.length >= 20) break;
    }
    safeSecondaryKeywords = cleaned;
  }

  return {
    pageId: cleanString(pageRecord.pageId, 128) || null,
    pageType: cleanString(pageRecord.pageType, 32) || null,
    seoTitle: cleanString(pageRecord.seoTitle, 160, 3) || null,
    metaDescription: cleanString(pageRecord.metaDescription, 320, 10) || null,
    focusKeyword: cleanString(pageRecord.focusKeyword, 120) || null,
    secondaryKeywords: safeSecondaryKeywords,
    canonicalUrl: isSafeHttpUrl(pageRecord.canonicalUrl) ? pageRecord.canonicalUrl.trim() : null,
    index: typeof pageRecord.index === 'boolean' ? pageRecord.index : null,
    follow: typeof pageRecord.follow === 'boolean' ? pageRecord.follow : null,
    maxImagePreview: ALLOWED_MAX_IMAGE_PREVIEW.has(pageRecord.maxImagePreview)
      ? pageRecord.maxImagePreview
      : null,
    maxSnippet:
      typeof pageRecord.maxSnippet === 'number' &&
      Number.isSafeInteger(pageRecord.maxSnippet) &&
      pageRecord.maxSnippet >= -1 &&
      pageRecord.maxSnippet <= 1000
        ? pageRecord.maxSnippet
        : null,
    maxVideoPreview:
      typeof pageRecord.maxVideoPreview === 'number' &&
      Number.isSafeInteger(pageRecord.maxVideoPreview) &&
      pageRecord.maxVideoPreview >= -1 &&
      pageRecord.maxVideoPreview <= 1000
        ? pageRecord.maxVideoPreview
        : null,
    ogTitle: cleanString(pageRecord.ogTitle, 160) || null,
    ogDescription: cleanString(pageRecord.ogDescription, 320) || null,
    ogImage: isSafeAssetOrUrl(pageRecord.ogImage) ? pageRecord.ogImage.trim() : null,
    ogType: ALLOWED_OG_TYPES.has(pageRecord.ogType) ? pageRecord.ogType : null,
    twitterTitle: cleanString(pageRecord.twitterTitle, 160) || null,
    twitterDescription: cleanString(pageRecord.twitterDescription, 320) || null,
    twitterImage: isSafeAssetOrUrl(pageRecord.twitterImage) ? pageRecord.twitterImage.trim() : null,
    twitterCard: ALLOWED_TWITTER_CARDS.has(pageRecord.twitterCard) ? pageRecord.twitterCard : null,
    schemaType: ALLOWED_SCHEMA_TYPES.has(pageRecord.schemaType) ? pageRecord.schemaType : null,
    customStructuredData:
      pageRecord.customStructuredData && isSafeStructuredData(pageRecord.customStructuredData)
        ? cloneSafeJson(pageRecord.customStructuredData)
        : null,
    breadcrumb: safeBreadcrumb,
    imageAlt: cleanString(pageRecord.imageAlt, 300) || null,
    ogImageAlt: cleanString(pageRecord.ogImageAlt, 300) || null,
    twitterImageAlt: cleanString(pageRecord.twitterImageAlt, 300) || null,
    customImageAlts: safeCustomImageAlts,
  };
}

/**
 * Formats robots meta content from resolved flags & preview directives.
 */
export function formatRobotsContent({
  index,
  follow,
  maxImagePreview = 'large',
  maxSnippet = -1,
  maxVideoPreview = -1,
}) {
  const idxDirective = index ? 'index' : 'noindex';
  const followDirective = follow ? 'follow' : 'nofollow';
  if (!index) {
    return `${idxDirective}, ${followDirective}`;
  }
  return `${idxDirective}, ${followDirective}, max-image-preview:${maxImagePreview}, max-snippet:${maxSnippet}, max-video-preview:${maxVideoPreview}`;
}

/**
 * Resolves visible breadcrumb items from configured breadcrumb data or route defaults.
 * Strips redundant leading "Home" item because Breadcrumbs UI & BreadcrumbList always prepend Home.
 */
function resolveBreadcrumbItems({ pageOverrides, breadcrumbEnabled, defaultCrumbs, normPath = '/' }) {
  if (!breadcrumbEnabled) return [];
  const configuredItems = pageOverrides?.breadcrumb?.items;
  if (Array.isArray(configuredItems) && configuredItems.length > 0) {
    let list = configuredItems.map((item) => ({
      label: item.name,
      path: item.path,
    }));
    if (
      list.length > 0 &&
      (normalizeRoutePath(list[0].path) === '/' || list[0].label.toLowerCase() === 'home')
    ) {
      list = list.slice(1);
    }
    if (list.length === 0) return [];
    return list.map((item, idx) =>
      idx === list.length - 1 ? { label: item.label } : { label: item.label, path: item.path }
    );
  }

  if (normPath === '/') {
    return [];
  }

  const labelOverride = pageOverrides?.breadcrumb?.label;
  if (!Array.isArray(defaultCrumbs) || defaultCrumbs.length === 0) {
    return labelOverride && labelOverride.toLowerCase() !== 'home' ? [{ label: labelOverride }] : [];
  }

  return defaultCrumbs.map((c, idx) =>
    idx === defaultCrumbs.length - 1 && labelOverride
      ? { ...c, label: labelOverride }
      : { ...c }
  );
}

const BULK_ENRICHMENT_FAQ_ENTITIES = [
  {
    '@type': 'Question',
    name: 'What are the best AI tools for bulk product catalog enrichment?',
    acceptedAnswer: {
      '@type': 'Answer',
      text: "There is no single universal winner. Naper Studio is best suited for batch catalog editing and multichannel product content. Akeneo's Extraction module excels at structured attribute extraction for enterprise PIMs. Eligible BigCommerce merchants can use Catalog Enrichment for native storefront copy, while Bulkbase addresses CSV supplier feed transformations.",
    },
  },
  {
    '@type': 'Question',
    name: 'Can AI tools enrich thousands of product listings simultaneously?',
    acceptedAnswer: {
      '@type': 'Answer',
      text: 'Yes, but processing capacities depend on platform architecture. Akeneo documents extraction jobs accommodating up to 30,000 product rows, while Naper Studio provides batch catalog tools and bulk APIs. BigCommerce Catalog Enrichment caps individual requests at 250 products. Always test sample batches before processing entire inventories.',
    },
  },
  {
    '@type': 'Question',
    name: 'How does AI extract missing product attributes from supplier data?',
    acceptedAnswer: {
      '@type': 'Answer',
      text: 'The Extraction module analyzes raw supplier descriptions and digital asset sources to identify missing property values (such as materials, dimensions, or technical specifications). It then populates these into structured database fields, displaying visual bot indicators and routing low-confidence predictions to an editorial review queue.',
    },
  },
  {
    '@type': 'Question',
    name: 'What is the difference between product data enrichment and mapping?',
    acceptedAnswer: {
      '@type': 'Answer',
      text: 'Product data mapping aligns columns between two data formats (e.g., connecting a supplier\'s "Item_Description" to your store\'s "Body_HTML"). In contrast, enrichment enhances the data within those fields by filling in missing attributes, normalizing values, or generating clearer copy. Both steps are essential for clean catalog processing.',
    },
  },
  {
    '@type': 'Question',
    name: 'How can ecommerce managers prevent AI hallucinations in catalog specs?',
    acceptedAnswer: {
      '@type': 'Answer',
      text: 'Establish strict system prompts directing the AI to leave unknown fields empty rather than guessing values. Utilize tools with built-in confidence scoring, enforce controlled attribute dictionaries, and require mandatory human review for critical specifications such as dimensions, safety compliance, materials, and device compatibility.',
    },
  },
  {
    '@type': 'Question',
    name: 'Can AI enrich product catalogs directly on Shopify or BigCommerce?',
    acceptedAnswer: {
      '@type': 'Answer',
      text: 'BigCommerce offers native Catalog Enrichment for eligible stores to update titles, descriptions, and search snippets directly in the control panel. For Shopify, merchants can connect catalog management platforms like Naper Studio via dedicated apps or leverage REST API bulk update routines to synchronize enriched attributes.',
    },
  },
  {
    '@type': 'Question',
    name: 'How much do AI bulk catalog enrichment tools cost?',
    acceptedAnswer: {
      '@type': 'Answer',
      text: 'Pricing models vary by platform type. Naper provides 50 free credits upon signup (each credit generates one field output) with paid tiers outlined on its pricing page. BigCommerce Catalog Enrichment operates as a paid beta feature for eligible storefronts. Enterprise PIM platforms like Akeneo require custom licensing quotes, while Bulkbase pricing requires direct inquiry.',
    },
  },
  {
    '@type': 'Question',
    name: 'What is the recommended workflow for auditing enriched catalog data?',
    acceptedAnswer: {
      '@type': 'Answer',
      text: "Export an untouched backup of your master catalog before making changes. Run batch enrichment on a small pilot sample (such as under 200 products as recommended in Akeneo's documentation), inspect high-impact technical attributes against manufacturer source documents, verify that category fields populate correctly, and retain change logs before publishing mass updates to production.",
    },
  },
];

const ARTICLE_SCHEMA_TYPES = new Set(['BlogPosting', 'Article', 'NewsArticle']);
const ROUTE_PERMITTED_SCHEMA_TYPES = {
  home: new Set(['WebSite', 'WebPage', 'CollectionPage', 'AboutPage', 'ContactPage']),
  static: new Set(['WebPage', 'CollectionPage', 'AboutPage', 'ContactPage', 'WebSite']),
  article: new Set(['BlogPosting', 'Article', 'NewsArticle', 'WebPage']),
  category: new Set(['CollectionPage', 'WebPage']),
  author: new Set(['ProfilePage', 'WebPage']),
  tool: new Set(['SoftwareApplication', 'Product', 'WebPage']),
};

function hasNodeType(node, typeName) {
  const t = node?.['@type'];
  if (typeof t === 'string') return t === typeName;
  if (Array.isArray(t)) return t.includes(typeName);
  return false;
}

function isValidCustomFaqNode(node) {
  if (!Array.isArray(node?.mainEntity) || node.mainEntity.length === 0) return false;
  return node.mainEntity.every(
    (q) =>
      isPlainObject(q) &&
      hasNodeType(q, 'Question') &&
      Boolean(cleanString(q.name, 500)) &&
      isPlainObject(q.acceptedAnswer) &&
      hasNodeType(q.acceptedAnswer, 'Answer') &&
      Boolean(cleanString(q.acceptedAnswer.text, 5000))
  );
}

function toolSupportsSoftwareApplication(entity) {
  if (!isPlainObject(entity)) return false;
  const hasName = Boolean(cleanString(entity.name, 200));
  const hasDesc = Boolean(
    cleanString(entity.longDescription, 2000) || cleanString(entity.description, 1000)
  );
  return hasName && hasDesc;
}

function resolvePermittedSchemaType({
  routeKind,
  requestedSchemaType,
  customStructuredData = null,
  staticDefaultSchemaType = null,
  entity = null,
  fallbackSchemaType = 'WebPage',
  notFound = false,
}) {
  if (notFound) return 'WebPage';
  const defaultType = staticDefaultSchemaType || fallbackSchemaType || 'WebPage';
  if (!requestedSchemaType) return defaultType;

  if (requestedSchemaType === 'Custom') {
    if (customStructuredData && isSafeStructuredData(customStructuredData)) {
      return 'Custom';
    }
    return defaultType;
  }

  if (routeKind === 'article' && entity) {
    if (
      requestedSchemaType === 'FAQPage' &&
      entity.slug === 'best-ai-tools-bulk-product-catalog-enrichment'
    ) {
      return 'FAQPage';
    }
    if (ARTICLE_SCHEMA_TYPES.has(requestedSchemaType)) {
      return requestedSchemaType;
    }
    return defaultType;
  }

  if (routeKind === 'tool') {
    const permittedTool = ROUTE_PERMITTED_SCHEMA_TYPES.tool;
    if (permittedTool.has(requestedSchemaType)) {
      if (requestedSchemaType === 'SoftwareApplication' && !toolSupportsSoftwareApplication(entity)) {
        return 'WebPage';
      }
      return requestedSchemaType;
    }
    return defaultType === 'SoftwareApplication' && !toolSupportsSoftwareApplication(entity)
      ? 'WebPage'
      : defaultType;
  }

  const permitted = ROUTE_PERMITTED_SCHEMA_TYPES[routeKind];
  if (permitted && permitted.has(requestedSchemaType)) {
    return requestedSchemaType;
  }
  return defaultType;
}

/**
 * Builds valid, deduplicated Schema.org JSON-LD @graph for a resolved page.
 */
export function buildPageJsonLd({
  baseUrl,
  siteName,
  siteDescription,
  pageUrl,
  normPath,
  routeKind,
  title,
  description,
  imageUrl,
  imageSize = null,
  schemaType,
  customStructuredData = null,
  breadcrumbs = [],
  breadcrumbEnabled = true,
  entity = null,
  authorProfile = null,
  wordCount = null,
  notFound = false,
}) {
  const cleanBase = (isSafeHttpUrl(String(baseUrl || ''))
    ? new URL(String(baseUrl)).origin
    : DEFAULT_SITE_URL
  ).replace(/\/+$/, '');
  const safePageUrl = isSafeHttpUrl(String(pageUrl || ''))
    ? String(pageUrl).trim()
    : `${cleanBase}${normalizeRoutePath(normPath || '/')}`;

  const orgNode = {
    '@type': 'Organization',
    '@id': `${cleanBase}/#organization`,
    name: siteName || DEFAULT_SITE_NAME,
    url: `${cleanBase}/`,
    logo: {
      '@type': 'ImageObject',
      '@id': `${cleanBase}/#logo`,
      url: `${cleanBase}/logo-512.png`,
      width: 512,
      height: 512,
    },
  };
  const websiteNode = {
    '@type': 'WebSite',
    '@id': `${cleanBase}/#website`,
    url: `${cleanBase}/`,
    name: siteName || DEFAULT_SITE_NAME,
    description: siteDescription || DEFAULT_META_DESCRIPTION,
    inLanguage: 'en-US',
    publisher: { '@id': `${cleanBase}/#organization` },
  };

  const graph = [orgNode, websiteNode];

  if (notFound) {
    graph.push({
      '@type': 'WebPage',
      name: title,
      description,
      isPartOf: { '@id': `${cleanBase}/#website` },
      inLanguage: 'en-US',
    });
    return { '@context': 'https://schema.org', '@graph': graph };
  }

  const safeCustomData =
    customStructuredData && isSafeStructuredData(customStructuredData)
      ? customStructuredData
      : null;

  const staticDef = STATIC_SEO_DEFAULTS[normPath] || {};
  const resolvedType = resolvePermittedSchemaType({
    routeKind,
    requestedSchemaType: schemaType,
    customStructuredData: safeCustomData,
    staticDefaultSchemaType: staticDef.schemaType || null,
    entity,
    fallbackSchemaType:
      routeKind === 'article'
        ? 'BlogPosting'
        : routeKind === 'category'
          ? 'CollectionPage'
          : routeKind === 'author'
            ? 'ProfilePage'
            : routeKind === 'tool'
              ? 'SoftwareApplication'
              : routeKind === 'home'
                ? 'WebSite'
                : 'WebPage',
    notFound,
  });

  const effectiveType = resolvedType !== 'Custom' ? resolvedType : null;

  if (routeKind === 'home') {
    if (effectiveType && effectiveType !== 'WebSite') {
      graph.push({
        '@type': effectiveType,
        '@id': `${safePageUrl}#webpage`,
        url: safePageUrl,
        name: title,
        description,
        isPartOf: { '@id': `${cleanBase}/#website` },
        inLanguage: 'en-US',
      });
    }
  } else if (routeKind === 'article' && entity) {
    const absAuthorUrl = authorProfile ? `${cleanBase}${authorProfile.path}` : null;
    if (authorProfile && absAuthorUrl) {
      graph.push({
        '@type': 'Person',
        '@id': `${absAuthorUrl}#person`,
        name: authorProfile.name,
        url: absAuthorUrl,
        jobTitle: authorProfile.role,
        description: authorProfile.schemaDescription,
        worksFor: { '@id': `${cleanBase}/#organization` },
      });
    }

    const articleNodeType = ARTICLE_SCHEMA_TYPES.has(effectiveType) ? effectiveType : 'BlogPosting';

    const articleNode = {
      '@type': articleNodeType,
      '@id': `${safePageUrl}#article`,
      isPartOf: { '@id': `${cleanBase}/#website` },
      headline: entity.title,
      description,
      image: {
        '@type': 'ImageObject',
        url: imageUrl,
        ...(imageSize || {}),
      },
      datePublished: entity.publishedAt,
      dateModified: entity.updatedAt || entity.publishedAt,
      ...(typeof wordCount === 'number' && wordCount > 0 ? { wordCount } : {}),
      mainEntityOfPage: safePageUrl,
      author: absAuthorUrl
        ? { '@id': `${absAuthorUrl}#person` }
        : { '@id': `${cleanBase}/#organization` },
      publisher: { '@id': `${cleanBase}/#organization` },
      inLanguage: 'en-US',
      articleSection: entity.categoryName || entity.category,
      keywords: Array.isArray(entity.tags) ? entity.tags : [],
    };
    graph.push(articleNode);

    if (entity.slug === 'best-ai-tools-bulk-product-catalog-enrichment') {
      graph.push({
        '@type': 'FAQPage',
        '@id': `${safePageUrl}#faq`,
        mainEntity: BULK_ENRICHMENT_FAQ_ENTITIES,
      });
    }
  } else if (routeKind === 'tool' && entity) {
    if (!(resolvedType === 'Custom' && safeCustomData)) {
      const supportsSoftwareApp = toolSupportsSoftwareApplication(entity);
      const toolNodeType =
        effectiveType === 'SoftwareApplication' && !supportsSoftwareApp
          ? 'WebPage'
          : effectiveType || (supportsSoftwareApp ? 'SoftwareApplication' : 'WebPage');
      const safeName = cleanString(entity.name, 200) || title;
      const safeSameAs = isSafeHttpUrl(entity.url) ? entity.url.trim() : '';
      const safeRawImg = isSafeAssetOrUrl(entity.icon)
        ? entity.icon.trim()
        : isSafeAssetOrUrl(imageUrl)
          ? String(imageUrl).trim()
          : '';
      const toolImageUrl = safeRawImg ? toAbsoluteAssetUrl(safeRawImg, cleanBase) : '';
      const safeAppCategory = cleanString(entity.categoryName || entity.category, 120);
      const safeOs = cleanString(entity.operatingSystem, 120);
      const safeTags = Array.isArray(entity.tags)
        ? entity.tags.map((t) => cleanString(t, 100)).filter(Boolean)
        : [];
      const safeFeatures = Array.isArray(entity.features)
        ? entity.features.map((f) => cleanString(f, 200)).filter(Boolean)
        : [];

      const toolNode = {
        '@type': toolNodeType,
        '@id': `${safePageUrl}#tool`,
        name: safeName,
        description,
        url: safePageUrl,
        ...(safeSameAs ? { sameAs: safeSameAs } : {}),
        ...(toolImageUrl && isSafeHttpUrl(toolImageUrl) ? { image: toolImageUrl } : {}),
        isPartOf: { '@id': `${cleanBase}/#website` },
        inLanguage: 'en-US',
      };
      if (toolNodeType === 'SoftwareApplication') {
        if (safeAppCategory) {
          toolNode.applicationCategory = safeAppCategory;
        }
        if (safeOs) {
          toolNode.operatingSystem = safeOs;
        }
        if (safeFeatures.length > 0) {
          toolNode.featureList = safeFeatures;
        }
        if (safeTags.length > 0) {
          toolNode.keywords = safeTags;
        }
      } else if (toolNodeType === 'Product') {
        if (safeAppCategory) {
          toolNode.category = safeAppCategory;
        }
      }
      graph.push(toolNode);
    }
  } else if (routeKind === 'author' && entity) {
    const profileType = effectiveType || 'ProfilePage';
    graph.push({
      '@type': profileType,
      '@id': `${safePageUrl}#profile`,
      url: safePageUrl,
      name: title,
      description,
      isPartOf: { '@id': `${cleanBase}/#website` },
      inLanguage: 'en-US',
      mainEntity: {
        '@type': 'Person',
        '@id': `${safePageUrl}#person`,
        name: entity.name,
        url: safePageUrl,
        jobTitle: entity.role,
        description: entity.schemaDescription,
        worksFor: { '@id': `${cleanBase}/#organization` },
      },
    });
  } else if (routeKind === 'category' && entity) {
    const catType = effectiveType || 'CollectionPage';
    graph.push({
      '@type': catType,
      '@id': `${safePageUrl}#collection`,
      name: `${entity.name} AI Tools & Guides`,
      url: safePageUrl,
      description,
      isPartOf: { '@id': `${cleanBase}/#website` },
      inLanguage: 'en-US',
    });
  } else {
    // Static routes: /tools/, /blog/, /categories/, /about/, /contact/, legal, etc.
    const nodeType = effectiveType || staticDef.schemaType || 'WebPage';
    if (!(resolvedType === 'Custom' && safeCustomData)) {
      graph.push({
        '@type': nodeType,
        '@id': `${safePageUrl}#webpage`,
        name: staticDef.schemaName || title,
        url: safePageUrl,
        description,
        isPartOf: { '@id': `${cleanBase}/#website` },
        inLanguage: 'en-US',
      });
    }
  }

  // Merge safe customStructuredData without duplicating Organization, WebSite, FAQPage, or @id,
  // and ignoring BreadcrumbList so JSON-LD stays strictly consistent with resolved breadcrumbs.
  if (safeCustomData) {
    const rawNodes = Array.isArray(safeCustomData['@graph'])
      ? safeCustomData['@graph']
      : [safeCustomData];

    for (const rawNode of rawNodes) {
      if (!isPlainObject(rawNode)) continue;
      if (!rawNode['@type'] || !isValidSchemaTypeValue(rawNode['@type'])) continue;
      const cloned = cloneSafeJson(rawNode);
      delete cloned['@context'];
      const nodeId = cloned['@id'];

      if (hasNodeType(cloned, 'BreadcrumbList')) {
        continue;
      }
      if (nodeId && graph.some((existing) => existing['@id'] === nodeId)) {
        continue;
      }
      if (hasNodeType(cloned, 'Organization') || hasNodeType(cloned, 'WebSite')) {
        continue;
      }
      if (hasNodeType(cloned, 'FAQPage')) {
        if (graph.some((existing) => hasNodeType(existing, 'FAQPage'))) {
          continue;
        }
        if (!isValidCustomFaqNode(cloned)) {
          continue;
        }
      }
      graph.push(cloned);
    }
  }

  // Add ONE authoritative BreadcrumbList if enabled and non-empty
  if (breadcrumbEnabled && Array.isArray(breadcrumbs) && breadcrumbs.length > 0) {
    graph.push({
      '@type': 'BreadcrumbList',
      '@id': `${safePageUrl}#breadcrumb`,
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Home', item: `${cleanBase}/` },
        ...breadcrumbs.map((c, idx) => {
          const hasValidItemPath =
            typeof c.path === 'string' && c.path.trim() && isValidSeoPathFormat(c.path);
          return {
            '@type': 'ListItem',
            position: idx + 2,
            name: c.label,
            item: hasValidItemPath ? `${cleanBase}${normalizeRoutePath(c.path)}` : safePageUrl,
          };
        }),
      ],
    });
  }

  return { '@context': 'https://schema.org', '@graph': graph };
}

/**
 * Resolves effective SEO metadata, breadcrumbs, and structured data for any route.
 * Priority:
 * 1. Explicit valid page-level SEO override (from seo.json -> pages)
 * 2. Entity-specific SEO metadata (for article / category / tool / author) or
 *    route-specific static SEO metadata (from STATIC_SEO_DEFAULTS)
 * 3. Global SEO defaults (from seo.json -> defaults)
 * 4. Safe final fallback
 */
export function resolvePageSeo({
  path = '/',
  seoConfig = null,
  settings = {},
  articles = [],
  categories = [],
  tools = [],
  pages = [],
  wordCount = null,
  imageSize = null,
}) {
  const rawProductionUrl =
    typeof settings?.productionUrl === 'string' ? settings.productionUrl.trim() : '';
  let baseUrl = DEFAULT_SITE_URL;
  if (isSafeHttpUrl(rawProductionUrl)) {
    try {
      baseUrl = new URL(rawProductionUrl).origin.replace(/\/+$/, '');
    } catch {
      baseUrl = DEFAULT_SITE_URL;
    }
  }
  const defaults = extractSafeSeoDefaults(seoConfig);

  const siteName = defaults.siteName || cleanString(settings?.siteTitle, 100) || DEFAULT_SITE_NAME;
  const titleTemplate = defaults.titleTemplate || DEFAULT_TITLE_TEMPLATE;
  const globalDefaultTitle = defaults.defaultSeoTitle || DEFAULT_SEO_TITLE;
  const globalDefaultDesc =
    defaults.defaultMetaDescription ||
    cleanString(settings?.siteDescription, 320) ||
    DEFAULT_META_DESCRIPTION;
  const globalDefaultImage =
    defaults.defaultOgImage ||
    (isSafeAssetOrUrl(settings?.defaultOgImage) ? settings.defaultOgImage : '') ||
    DEFAULT_OG_IMAGE;

  const normPath = stripTrailingSlash(path);
  const canonicalRoutePath = normPath === '/' ? '/' : `${normPath}/`;
  const pageUrl = `${baseUrl}${canonicalRoutePath}`;

  // Identify route kind and entity
  let routeKind = 'unknown';
  let candidatePageIds = [];
  let entity = null;
  let authorProfile = null;
  let notFound = false;
  let baseIndexable = false;

  let fallbackTitle = 'Page Not Found | AINOVEX';
  let fallbackDesc =
    'The page you are looking for does not exist. Browse our AI tools directory, tutorials, and category archives on AINOVEX.';
  let fallbackOgType = 'website';
  let fallbackSchemaType = 'WebPage';
  let fallbackImage = '';
  let fallbackImageAlt = '';
  let fallbackCrumbs = [];
  let fallbackBreadcrumbEnabled = false;
  let entityCanonicalUrl = null;
  let articleMeta = null;

  const blogPageRec = findSeoPageRecord(seoConfig, '/blog/', ['static:blog']);
  const categoriesPageRec = findSeoPageRecord(seoConfig, '/categories/', ['static:categories']);
  const blogCrumbLabel = cleanString(blogPageRec?.breadcrumb?.label, 100) || 'Blog';
  const categoriesCrumbLabel =
    cleanString(categoriesPageRec?.breadcrumb?.label, 100) || 'Categories';

  const publishedArticles = (articles || []).filter((a) => a && a.isPublished !== false);

  if (STATIC_SEO_DEFAULTS[normPath]) {
    const def = STATIC_SEO_DEFAULTS[normPath];
    routeKind = def.pageType === 'home' ? 'home' : 'static';
    candidatePageIds = [def.pageId];
    fallbackTitle = def.title || DEFAULT_SEO_TITLE;
    fallbackDesc = def.description || DEFAULT_META_DESCRIPTION;
    fallbackSchemaType = def.schemaType;
    fallbackCrumbs = def.crumbs;
    fallbackBreadcrumbEnabled = def.breadcrumbEnabled;
    baseIndexable = def.baseIndexable;
  } else if (normPath.startsWith('/blog/')) {
    routeKind = 'article';
    const slug = normPath.slice('/blog/'.length);
    candidatePageIds = [`article:${slug}`];
    const found = !slug.includes('/') ? publishedArticles.find((a) => a.slug === slug) : null;
    if (found) {
      entity = found;
      authorProfile = getArticleAuthorProfile(found.author);
      baseIndexable = true;
      fallbackTitle =
        cleanString(found.metaTitle, 160) ||
        formatTitleWithTemplate(found.title, titleTemplate, siteName);
      fallbackDesc =
        cleanString(found.metaDescription, 320) ||
        cleanString(found.excerpt, 320) ||
        globalDefaultDesc;
      fallbackImage =
        (isSafeAssetOrUrl(found.ogImage) ? found.ogImage : '') ||
        (isSafeAssetOrUrl(found.featuredImage) ? found.featuredImage : '');
      fallbackImageAlt = cleanString(found.imageAlt, 300) || cleanString(found.title, 300);
      fallbackOgType = 'article';
      fallbackSchemaType = 'BlogPosting';
      fallbackBreadcrumbEnabled = true;
      fallbackCrumbs = [
        { label: blogCrumbLabel, path: '/blog/' },
        { label: found.categoryName || found.category, path: `/category/${found.category}/` },
        { label: found.title },
      ];
      entityCanonicalUrl = isSafeHttpUrl(found.canonicalUrl) ? found.canonicalUrl.trim() : null;
      articleMeta = {
        published: found.publishedAt,
        modified: found.updatedAt || found.publishedAt,
        authorUrl: authorProfile ? `${baseUrl}${authorProfile.path}` : null,
        section: found.categoryName || found.category,
        tags: Array.isArray(found.tags) ? found.tags : [],
      };
    } else {
      notFound = true;
      fallbackTitle = 'Article Not Found | AINOVEX';
      fallbackDesc = 'The requested article could not be located on AINOVEX.';
    }
  } else if (normPath.startsWith('/category/')) {
    routeKind = 'category';
    const slug = normPath.slice('/category/'.length);
    candidatePageIds = [`category:${slug}`];
    const found = !slug.includes('/') ? (categories || []).find((c) => c.slug === slug) : null;
    if (found) {
      entity = found;
      baseIndexable = categoryHasContent(slug, categories, publishedArticles);
      fallbackTitle = categoryTitle(found);
      const baseCatDesc =
        cleanString(found.description, 220) ||
        'Explore the best artificial intelligence tools and workflows.';
      fallbackDesc = `${baseCatDesc} Browse handpicked software reviews and tutorials on ${siteName}.`;
      fallbackImageAlt = `${found.name} AI Tools & Guides`;
      fallbackSchemaType = 'CollectionPage';
      fallbackBreadcrumbEnabled = true;
      fallbackCrumbs = [
        { label: categoriesCrumbLabel, path: '/categories/' },
        { label: found.name },
      ];
    } else {
      notFound = true;
      fallbackTitle = 'Category Not Found | AINOVEX';
      fallbackDesc = 'The requested category could not be located on AINOVEX.';
    }
  } else if (normPath.startsWith('/tools/')) {
    routeKind = 'tool';
    const slug = normPath.slice('/tools/'.length);
    const validSlug = isValidToolSlug(slug);
    candidatePageIds = validSlug ? [`tool:${slug}`] : [];
    const found = validSlug ? findPublishedToolBySlug(slug, tools) : null;
    if (found) {
      entity = found;
      baseIndexable = true;
      fallbackTitle = formatTitleWithTemplate(
        `${found.name} - AI Tool Review, Pricing & Overview`,
        titleTemplate,
        siteName
      );
      fallbackDesc =
        cleanString(found.longDescription, 320) ||
        cleanString(found.description, 320) ||
        globalDefaultDesc;
      const catLabel = cleanString(found.categoryName || found.category, 100);
      fallbackImageAlt = catLabel
        ? `${found.name} - ${catLabel} AI Tool`
        : `${found.name} AI Tool`;
      fallbackSchemaType = toolSupportsSoftwareApplication(found)
        ? 'SoftwareApplication'
        : 'WebPage';
      fallbackBreadcrumbEnabled = true;
      fallbackCrumbs = [{ label: 'Tools', path: '/tools/' }, { label: found.name }];
    } else {
      notFound = true;
      fallbackTitle = 'Tool Not Found | AINOVEX';
      fallbackDesc = 'The requested AI tool profile could not be located on AINOVEX.';
    }
  } else if (normPath.startsWith('/author/')) {
    routeKind = 'author';
    const slug = normPath.slice('/author/'.length);
    candidatePageIds = [`author:${slug}`];
    const foundAuthor = !slug.includes('/') ? findAuthorBySlug(slug, publishedArticles) : null;
    if (foundAuthor) {
      entity = foundAuthor;
      baseIndexable = true;
      fallbackTitle = foundAuthor.seoTitle;
      fallbackDesc = foundAuthor.seoDescription;
      fallbackImageAlt = `${foundAuthor.name} - Editorial Profile at ${siteName}`;
      fallbackOgType = 'profile';
      fallbackSchemaType = 'ProfilePage';
      fallbackBreadcrumbEnabled = true;
      fallbackCrumbs = [{ label: 'Authors', path: '/about/' }, { label: foundAuthor.name }];
    } else {
      notFound = true;
      fallbackTitle = 'Author Not Found | AINOVEX';
      fallbackDesc =
        'The author profile you are looking for does not exist. Browse our AI tools directory, tutorials, and guides on AINOVEX.';
    }
  } else if (normPath.startsWith('/') && normPath.length > 1 && !normPath.slice(1).includes('/')) {
    const slug = normPath.slice(1);
    const foundCustomPage = isValidCustomPageSlug(slug)
      ? findPublishedCustomPageBySlug(slug, pages)
      : null;
    if (foundCustomPage) {
      routeKind = 'static';
      entity = foundCustomPage;
      candidatePageIds = [`static:${slug}`];
      baseIndexable = true;
      const cleanPageTitle = cleanString(foundCustomPage.title, 200) || slug;
      fallbackTitle = formatTitleWithTemplate(cleanPageTitle, titleTemplate, siteName);
      fallbackDesc = extractCustomPageDescription(foundCustomPage.content) || globalDefaultDesc;
      fallbackOgType = 'website';
      fallbackSchemaType = 'WebPage';
      fallbackBreadcrumbEnabled = true;
      fallbackCrumbs = [{ label: cleanPageTitle }];
    } else {
      notFound = true;
    }
  } else {
    notFound = true;
  }

  const isCustomStaticPage = routeKind === 'static' && Boolean(entity);
  const rawPageRecord = !notFound
    ? findSeoPageRecord(seoConfig, canonicalRoutePath, candidatePageIds, {
        strictStaticScope: isCustomStaticPage,
      })
    : null;
  const pageOverrides = extractSafePageOverrides(rawPageRecord);

  // Resolve title & description with strict priority:
  // - Static routes: 1. page override -> 2. route-specific static metadata -> 3. global default -> 4. safe final fallback
  // - Dynamic entity routes (article/category/tool/author): 1. page override -> entity metadata -> global default -> safe fallback
  const isEntityRoute = Boolean(entity);
  const staticDefault = !isEntityRoute && !notFound ? STATIC_SEO_DEFAULTS[normPath] || null : null;
  const staticTitle = cleanString(staticDefault?.title, 160, 3) || '';
  const staticDesc = cleanString(staticDefault?.description, 320, 10) || '';
  const staticOgTitle = cleanString(staticDefault?.ogTitle, 160, 1) || staticTitle;
  const staticOgDesc = cleanString(staticDefault?.ogDescription, 320, 1) || staticDesc;

  const seoTitle = isEntityRoute
    ? pageOverrides?.seoTitle || fallbackTitle || globalDefaultTitle
    : pageOverrides?.seoTitle ||
      staticTitle ||
      defaults.defaultSeoTitle ||
      fallbackTitle ||
      DEFAULT_SEO_TITLE;

  const rawDescription = isEntityRoute
    ? pageOverrides?.metaDescription || fallbackDesc || globalDefaultDesc
    : pageOverrides?.metaDescription ||
      staticDesc ||
      defaults.defaultMetaDescription ||
      fallbackDesc ||
      DEFAULT_META_DESCRIPTION;
  const metaDescription = trimMetaDescription(rawDescription, 155);

  const ogTitle = isEntityRoute
    ? pageOverrides?.ogTitle || pageOverrides?.seoTitle || seoTitle
    : pageOverrides?.ogTitle ||
      pageOverrides?.seoTitle ||
      staticOgTitle ||
      defaults.defaultOgTitle ||
      defaults.defaultSeoTitle ||
      seoTitle;

  const ogDescription = trimMetaDescription(
    isEntityRoute
      ? pageOverrides?.ogDescription || pageOverrides?.metaDescription || rawDescription
      : pageOverrides?.ogDescription ||
          pageOverrides?.metaDescription ||
          staticOgDesc ||
          defaults.defaultOgDescription ||
          defaults.defaultMetaDescription ||
          rawDescription,
    155
  );

  const ogImageRaw = pageOverrides?.ogImage || fallbackImage || globalDefaultImage;
  const ogImage = toAbsoluteAssetUrl(ogImageRaw, baseUrl);

  const ogType = pageOverrides?.ogType
    ? pageOverrides.ogType
    : isEntityRoute
      ? fallbackOgType
      : defaults.defaultOgType || fallbackOgType;

  const twitterTitle = pageOverrides?.twitterTitle
    ? pageOverrides.twitterTitle
    : defaults.defaultTwitterTitle && !pageOverrides?.ogTitle && !pageOverrides?.seoTitle && !isEntityRoute
      ? defaults.defaultTwitterTitle
      : ogTitle;

  const twitterDescription = trimMetaDescription(
    pageOverrides?.twitterDescription
      ? pageOverrides.twitterDescription
      : defaults.defaultTwitterDescription &&
          !pageOverrides?.ogDescription &&
          !pageOverrides?.metaDescription &&
          !isEntityRoute
        ? defaults.defaultTwitterDescription
        : ogDescription,
    155
  );

  const twitterImageRaw =
    pageOverrides?.twitterImage ||
    pageOverrides?.ogImage ||
    fallbackImage ||
    defaults.defaultTwitterImage ||
    globalDefaultImage;
  const twitterImage = toAbsoluteAssetUrl(twitterImageRaw, baseUrl);

  const twitterCard =
    pageOverrides?.twitterCard || defaults.defaultTwitterCard || 'summary_large_image';
  const twitterSite = defaults.defaultTwitterSite || '';

  // Image alt-text
  const imageAlt =
    pageOverrides?.imageAlt || fallbackImageAlt || defaults.defaultImageAlt || seoTitle;
  const ogImageAlt = pageOverrides?.ogImageAlt || imageAlt;
  const twitterImageAlt = pageOverrides?.twitterImageAlt || imageAlt;
  const customImageAlts = pageOverrides?.customImageAlts || {};

  // Robots & indexability
  let index = false;
  if (!notFound) {
    if (pageOverrides && typeof pageOverrides.index === 'boolean') {
      index = pageOverrides.index;
    } else if (defaults.defaultIndex === false) {
      index = false;
    } else {
      index = baseIndexable;
    }
  }
  const follow =
    pageOverrides && typeof pageOverrides.follow === 'boolean'
      ? pageOverrides.follow
      : typeof defaults.defaultFollow === 'boolean'
        ? defaults.defaultFollow
        : true;
  const maxImagePreview =
    pageOverrides?.maxImagePreview || defaults.defaultMaxImagePreview || 'large';
  const maxSnippet =
    typeof pageOverrides?.maxSnippet === 'number'
      ? pageOverrides.maxSnippet
      : typeof defaults.defaultMaxSnippet === 'number'
        ? defaults.defaultMaxSnippet
        : -1;
  const maxVideoPreview =
    typeof pageOverrides?.maxVideoPreview === 'number'
      ? pageOverrides.maxVideoPreview
      : typeof defaults.defaultMaxVideoPreview === 'number'
        ? defaults.defaultMaxVideoPreview
        : -1;

  const robotsContent = formatRobotsContent({
    index,
    follow,
    maxImagePreview,
    maxSnippet,
    maxVideoPreview,
  });

  // Canonical URL (omitted on 404)
  const canonicalUrl = notFound
    ? null
    : pageOverrides?.canonicalUrl || entityCanonicalUrl || pageUrl;

  // Breadcrumbs
  const breadcrumbEnabled = notFound
    ? false
    : typeof pageOverrides?.breadcrumb?.enabled === 'boolean'
      ? pageOverrides.breadcrumb.enabled
      : normPath === '/'
        ? false
        : typeof defaults.defaultBreadcrumbEnabled === 'boolean'
          ? defaults.defaultBreadcrumbEnabled
          : fallbackBreadcrumbEnabled;

  const breadcrumbs = resolveBreadcrumbItems({
    pageOverrides,
    breadcrumbEnabled,
    defaultCrumbs: fallbackCrumbs,
    normPath,
  });

  // Schema type & JSON-LD
  const requestedSchemaType = notFound
    ? 'WebPage'
    : pageOverrides?.schemaType ||
      (isEntityRoute ? fallbackSchemaType : null) ||
      (STATIC_SEO_DEFAULTS[normPath]?.schemaType ?? null) ||
      defaults.defaultSchemaType ||
      fallbackSchemaType;

  const resolvedSchemaType = resolvePermittedSchemaType({
    routeKind,
    requestedSchemaType,
    customStructuredData: pageOverrides?.customStructuredData || null,
    staticDefaultSchemaType: STATIC_SEO_DEFAULTS[normPath]?.schemaType ?? null,
    entity,
    fallbackSchemaType,
    notFound,
  });

  const jsonLd = buildPageJsonLd({
    baseUrl,
    siteName,
    siteDescription: globalDefaultDesc,
    pageUrl,
    normPath,
    routeKind,
    title: seoTitle,
    description: metaDescription,
    imageUrl: ogImage,
    imageSize,
    schemaType: resolvedSchemaType,
    customStructuredData: pageOverrides?.customStructuredData || null,
    breadcrumbs,
    breadcrumbEnabled,
    entity,
    authorProfile,
    wordCount,
    notFound,
  });

  const resolvedFocusKeyword = notFound
    ? ''
    : pageOverrides?.focusKeyword ||
      cleanString(entity?.primaryKeyword, 120) ||
      defaults.defaultFocusKeyword ||
      '';
  const entitySecondaryKeywords = Array.isArray(entity?.secondaryKeywords)
    ? entity.secondaryKeywords.map((k) => cleanString(k, 100)).filter(Boolean)
    : [];
  const resolvedSecondaryKeywords = notFound
    ? []
    : Array.isArray(pageOverrides?.secondaryKeywords) && pageOverrides.secondaryKeywords.length > 0
      ? pageOverrides.secondaryKeywords
      : entitySecondaryKeywords.length > 0
        ? entitySecondaryKeywords
        : defaults.defaultSecondaryKeywords || [];

  const resolvedPageId = notFound
    ? null
    : pageOverrides?.pageId || candidatePageIds[0] || null;

  return {
    notFound,
    pageId: resolvedPageId,
    routeKind,
    path: canonicalRoutePath,
    pageUrl,
    baseUrl,
    siteName,
    title: seoTitle,
    description: metaDescription,
    focusKeyword: resolvedFocusKeyword,
    secondaryKeywords: resolvedSecondaryKeywords,
    canonicalUrl,
    ogUrl: notFound ? null : pageUrl,
    ogTitle,
    ogDescription,
    ogImage,
    ogImageRaw,
    ogType,
    ogImageAlt,
    twitterTitle,
    twitterDescription,
    twitterImage,
    twitterCard,
    twitterSite,
    twitterImageAlt,
    imageAlt,
    customImageAlts,
    index,
    follow,
    noindex: !index,
    nofollow: !follow,
    maxImagePreview,
    maxSnippet,
    maxVideoPreview,
    robotsContent,
    schemaType: resolvedSchemaType,
    breadcrumbEnabled,
    breadcrumbs,
    jsonLd,
    articleMeta,
    entity,
    authorProfile,
    hasPageOverride: Boolean(pageOverrides),
  };
}
