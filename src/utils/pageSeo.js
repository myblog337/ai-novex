// Shared Global & Page-Level SEO Resolver, Validator, and JSON-LD Builder.
// Used by BOTH the browser app (src/App.tsx, src/utils/seo.ts) and Node build scripts
// (scripts/postbuild.mjs, scripts/finalize-sitemap.mjs) so client-side metadata and
// pre-rendered static HTML always stay 100% consistent.

import { LEGAL_TITLES, LEGAL_BREADCRUMBS } from '../config/legal.js';
import { categoryHasContent, categoryTitle } from '../config/indexing.js';
import { findAuthorBySlug } from './authors.js';

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

function cleanString(val, maxLen = 500) {
  if (typeof val !== 'string') return '';
  if (CONTROL_CHAR_REGEX.test(val)) return '';
  const trimmed = val.trim();
  if (!trimmed || trimmed.length > maxLen) return '';
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

export function isSafeStructuredData(value, maxDepth = 6, maxBytes = 16384) {
  if (!isPlainObject(value)) return false;
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return false;
  }
  if (typeof serialized !== 'string' || serialized.length > maxBytes) return false;

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

    for (const key of Object.getOwnPropertyNames(node)) {
      if (PROTO_POLLUTION_KEYS.has(key)) return false;
      if (CONTROL_CHAR_REGEX.test(key)) return false;
      const val = node[key];
      if (val !== null && typeof val === 'object' && depth + 1 > maxDepth) return false;
      stack.push({ node: val, depth: depth + 1 });
    }
  }

  if (Object.prototype.hasOwnProperty.call(value, '@context') && value['@context'] !== undefined) {
    const ctx = value['@context'];
    if (
      typeof ctx !== 'string' ||
      (!['https://schema.org', 'http://schema.org', 'https://schema.org/', 'http://schema.org/'].includes(ctx) &&
        !isSafeHttpUrl(ctx))
    ) {
      return false;
    }
  }

  if (Object.prototype.hasOwnProperty.call(value, '@type') && value['@type'] !== undefined) {
    const t = value['@type'];
    const validSingle = (v) => typeof v === 'string' && SCHEMA_TYPE_VALUE_REGEX.test(v);
    if (Array.isArray(t)) {
      if (t.length === 0 || !t.every(validSingle)) return false;
    } else if (!validSingle(t)) {
      return false;
    }
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
  const defaultSeoTitle = cleanString(raw.defaultSeoTitle, 160) || '';
  const defaultMetaDescription = cleanString(raw.defaultMetaDescription, 320) || '';
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

/**
 * Finds the matching SEO page record in seoConfig.pages by canonical path first,
 * falling back to candidate pageIds when path matching isn't available.
 * Never mutates seoConfig and never throws on malformed data.
 */
export function findSeoPageRecord(seoConfig, canonicalPath, candidatePageIds = []) {
  if (!isPlainObject(seoConfig) || !isPlainObject(seoConfig.pages)) return null;
  const targetPath = normalizeRoutePath(canonicalPath);
  const pages = seoConfig.pages;

  for (const key of Object.keys(pages)) {
    if (PROTO_POLLUTION_KEYS.has(key)) continue;
    const rec = pages[key];
    if (!isPlainObject(rec)) continue;
    if (typeof rec.path === 'string' && rec.path.trim()) {
      if (normalizeRoutePath(rec.path) === targetPath) {
        return rec;
      }
    }
  }

  for (const id of candidatePageIds) {
    if (!id || PROTO_POLLUTION_KEYS.has(id)) continue;
    const rec = pages[id];
    if (isPlainObject(rec)) {
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
      let allValid = pageRecord.breadcrumb.items.length <= 10;
      if (allValid) {
        for (const item of pageRecord.breadcrumb.items) {
          if (
            !isPlainObject(item) ||
            !cleanString(item.name, 100) ||
            !isValidSeoPathFormat(item.path)
          ) {
            allValid = false;
            break;
          }
          validItems.push({
            name: item.name.trim(),
            path: normalizeRoutePath(item.path),
          });
        }
      }
      if (allValid && validItems.length > 0) {
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

  return {
    pageId: cleanString(pageRecord.pageId, 128) || null,
    pageType: cleanString(pageRecord.pageType, 32) || null,
    seoTitle: cleanString(pageRecord.seoTitle, 160) || null,
    metaDescription: cleanString(pageRecord.metaDescription, 320) || null,
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
function resolveBreadcrumbItems({ pageOverrides, breadcrumbEnabled, defaultCrumbs }) {
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

  const labelOverride = pageOverrides?.breadcrumb?.label;
  if (!Array.isArray(defaultCrumbs) || defaultCrumbs.length === 0) {
    return labelOverride ? [{ label: labelOverride }] : [];
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
  const cleanBase = String(baseUrl || DEFAULT_SITE_URL).replace(/\/+$/, '');
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

  const effectiveType = schemaType && schemaType !== 'Custom' ? schemaType : null;

  if (routeKind === 'home') {
    if (effectiveType && effectiveType !== 'WebSite') {
      graph.push({
        '@type': effectiveType,
        '@id': `${pageUrl}#webpage`,
        url: pageUrl,
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

    const articleNodeType =
      effectiveType === 'Article' ||
      effectiveType === 'BlogPosting' ||
      effectiveType === 'NewsArticle'
        ? effectiveType
        : 'BlogPosting';

    const articleNode = {
      '@type': articleNodeType,
      '@id': `${pageUrl}#article`,
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
      mainEntityOfPage: pageUrl,
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
        '@id': `${pageUrl}#faq`,
        mainEntity: BULK_ENRICHMENT_FAQ_ENTITIES,
      });
    }

    if (
      effectiveType &&
      effectiveType !== articleNodeType &&
      effectiveType !== 'WebPage' &&
      !(effectiveType === 'FAQPage' && entity.slug === 'best-ai-tools-bulk-product-catalog-enrichment')
    ) {
      graph.push({
        '@type': effectiveType,
        '@id': `${pageUrl}#webpage`,
        url: pageUrl,
        name: title,
        description,
        isPartOf: { '@id': `${cleanBase}/#website` },
        inLanguage: 'en-US',
      });
    }
  } else if (routeKind === 'tool' && entity) {
    const toolNodeType = effectiveType || 'SoftwareApplication';
    const toolImageUrl = toAbsoluteAssetUrl(entity.icon || imageUrl, cleanBase);
    const toolNode = {
      '@type': toolNodeType,
      '@id': `${pageUrl}#tool`,
      name: entity.name,
      description,
      url: pageUrl,
      sameAs: entity.url,
      image: toolImageUrl,
      isPartOf: { '@id': `${cleanBase}/#website` },
      inLanguage: 'en-US',
    };
    if (toolNodeType === 'SoftwareApplication' || toolNodeType === 'Product') {
      toolNode.applicationCategory = entity.categoryName || entity.category;
      toolNode.operatingSystem = 'Web';
      toolNode.offers = {
        '@type': 'Offer',
        ...(entity.pricing === 'Free' ? { price: '0', priceCurrency: 'USD' } : {}),
        category: entity.pricing,
      };
    }
    graph.push(toolNode);
  } else if (routeKind === 'author' && entity) {
    const profileType = effectiveType || 'ProfilePage';
    graph.push({
      '@type': profileType,
      '@id': `${pageUrl}#profile`,
      url: pageUrl,
      name: title,
      description,
      isPartOf: { '@id': `${cleanBase}/#website` },
      inLanguage: 'en-US',
      mainEntity: {
        '@type': 'Person',
        '@id': `${pageUrl}#person`,
        name: entity.name,
        url: pageUrl,
        jobTitle: entity.role,
        description: entity.schemaDescription,
        worksFor: { '@id': `${cleanBase}/#organization` },
      },
    });
  } else if (routeKind === 'category' && entity) {
    const catType = effectiveType || 'CollectionPage';
    graph.push({
      '@type': catType,
      '@id': `${pageUrl}#collection`,
      name: `${entity.name} AI Tools & Guides`,
      url: pageUrl,
      description,
      isPartOf: { '@id': `${cleanBase}/#website` },
      inLanguage: 'en-US',
    });
  } else {
    // Static routes: /tools/, /blog/, /categories/, /about/, /contact/, legal, etc.
    const staticDef = STATIC_SEO_DEFAULTS[normPath] || {};
    const nodeType = effectiveType || staticDef.schemaType || 'WebPage';
    if (!(schemaType === 'Custom' && customStructuredData)) {
      graph.push({
        '@type': nodeType,
        '@id': `${pageUrl}#webpage`,
        name: staticDef.schemaName || title,
        url: pageUrl,
        description,
        isPartOf: { '@id': `${cleanBase}/#website` },
        inLanguage: 'en-US',
      });
    }
  }

  // Merge safe customStructuredData without duplicating Organization, WebSite, or @id
  if (customStructuredData && isPlainObject(customStructuredData)) {
    const rawNodes = Array.isArray(customStructuredData['@graph'])
      ? customStructuredData['@graph']
      : [customStructuredData];

    for (const rawNode of rawNodes) {
      if (!isPlainObject(rawNode)) continue;
      const cloned = cloneSafeJson(rawNode);
      delete cloned['@context'];
      const nodeType = cloned['@type'];
      const nodeId = cloned['@id'];

      if (nodeId && graph.some((existing) => existing['@id'] === nodeId)) {
        continue;
      }
      if (!nodeId && (nodeType === 'Organization' || nodeType === 'WebSite')) {
        continue;
      }
      if (nodeType === 'BreadcrumbList') {
        const existingBcIdx = graph.findIndex((n) => n['@type'] === 'BreadcrumbList');
        if (existingBcIdx >= 0) {
          graph[existingBcIdx] = cloned;
          continue;
        }
      }
      graph.push(cloned);
    }
  }

  // Add ONE BreadcrumbList if enabled, has crumbs, and none was provided by customStructuredData
  if (
    breadcrumbEnabled &&
    Array.isArray(breadcrumbs) &&
    breadcrumbs.length > 0 &&
    !graph.some((n) => n['@type'] === 'BreadcrumbList')
  ) {
    graph.push({
      '@type': 'BreadcrumbList',
      '@id': `${pageUrl}#breadcrumb`,
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Home', item: `${cleanBase}/` },
        ...breadcrumbs.map((c, idx) => ({
          '@type': 'ListItem',
          position: idx + 2,
          name: c.label,
          item: c.path ? `${cleanBase}${normalizeRoutePath(c.path)}` : pageUrl,
        })),
      ],
    });
  }

  return { '@context': 'https://schema.org', '@graph': graph };
}

/**
 * Resolves effective SEO metadata, breadcrumbs, and structured data for any route.
 * Priority:
 * 1. Page-specific SEO override (from seo.json -> pages)
 * 2. Entity-specific SEO metadata (for article / category / tool / author)
 * 3. Global SEO defaults (from seo.json -> defaults)
 * 4. Existing safe page metadata fallback
 */
export function resolvePageSeo({
  path = '/',
  seoConfig = null,
  settings = {},
  articles = [],
  categories = [],
  tools = [],
  wordCount = null,
  imageSize = null,
}) {
  const baseUrl = String(settings?.productionUrl || DEFAULT_SITE_URL).replace(/\/+$/, '');
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
  const toolsPageRec = findSeoPageRecord(seoConfig, '/tools/', ['static:tools']);
  const blogCrumbLabel = cleanString(blogPageRec?.breadcrumb?.label, 100) || 'Blog';
  const categoriesCrumbLabel =
    cleanString(categoriesPageRec?.breadcrumb?.label, 100) || 'Categories';
  const toolsCrumbLabel =
    cleanString(toolsPageRec?.breadcrumb?.label, 100) || 'AI Tools Directory';

  const publishedArticles = (articles || []).filter((a) => a && a.isPublished !== false);

  if (STATIC_SEO_DEFAULTS[normPath]) {
    const def = STATIC_SEO_DEFAULTS[normPath];
    routeKind = def.pageType === 'home' ? 'home' : 'static';
    candidatePageIds = [def.pageId];
    fallbackTitle = def.title;
    fallbackDesc = def.description;
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
    candidatePageIds = [`tool:${slug}`];
    const found = !slug.includes('/') ? (tools || []).find((t) => t.slug === slug) : null;
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
      fallbackImageAlt = `${found.name} - ${found.categoryName || found.category} AI Tool`;
      fallbackSchemaType = 'SoftwareApplication';
      fallbackBreadcrumbEnabled = true;
      fallbackCrumbs = [{ label: toolsCrumbLabel, path: '/tools/' }, { label: found.name }];
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
  } else {
    notFound = true;
  }

  const rawPageRecord = !notFound
    ? findSeoPageRecord(seoConfig, canonicalRoutePath, candidatePageIds)
    : null;
  const pageOverrides = extractSafePageOverrides(rawPageRecord);

  // Resolve title & description with strict priority:
  // - Static routes: 1. page override -> 2. global default -> 3. hardcoded safe fallback
  // - Dynamic entity routes (article/category/tool/author): 1. page override -> entity metadata -> global default -> safe fallback
  const isEntityRoute = Boolean(entity);

  const seoTitle = pageOverrides?.seoTitle
    ? pageOverrides.seoTitle
    : isEntityRoute
      ? fallbackTitle || globalDefaultTitle
      : defaults.defaultSeoTitle || fallbackTitle;

  const rawDescription = pageOverrides?.metaDescription
    ? pageOverrides.metaDescription
    : isEntityRoute
      ? fallbackDesc || globalDefaultDesc
      : defaults.defaultMetaDescription || fallbackDesc;
  const metaDescription = trimMetaDescription(rawDescription, 155);

  // Open Graph & Twitter resolution matching Task 113 resolveEffectiveSeo semantics
  const ogTitle = pageOverrides?.ogTitle
    ? pageOverrides.ogTitle
    : pageOverrides?.seoTitle
      ? pageOverrides.seoTitle
      : isEntityRoute
        ? seoTitle
        : defaults.defaultOgTitle || defaults.defaultSeoTitle || seoTitle;

  const ogDescription = trimMetaDescription(
    pageOverrides?.ogDescription
      ? pageOverrides.ogDescription
      : pageOverrides?.metaDescription
        ? pageOverrides.metaDescription
        : isEntityRoute
          ? rawDescription
          : defaults.defaultOgDescription || defaults.defaultMetaDescription || rawDescription,
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
  });

  // Schema type & JSON-LD
  const resolvedSchemaType =
    pageOverrides?.schemaType ||
    (isEntityRoute ? fallbackSchemaType : null) ||
    (STATIC_SEO_DEFAULTS[normPath]?.schemaType ?? null) ||
    defaults.defaultSchemaType ||
    fallbackSchemaType;

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

  return {
    notFound,
    routeKind,
    path: canonicalRoutePath,
    pageUrl,
    baseUrl,
    siteName,
    title: seoTitle,
    description: metaDescription,
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
