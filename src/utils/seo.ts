import {
  ALLOWED_OG_TYPES,
  ALLOWED_TWITTER_CARDS,
  DEFAULT_SEO_TITLE,
  DEFAULT_SITE_NAME,
  DEFAULT_SITE_URL,
  buildPageJsonLd,
  escapeJsonLd,
  isSafeHttpUrl,
  isSafeStructuredData,
  resolvePageSeo,
} from './pageSeo.js';

export interface ArticleSeoMeta {
  published?: string;
  modified?: string;
  authorUrl?: string | null;
  section?: string;
  tags?: string[];
}

export interface BreadcrumbItem {
  label: string;
  path?: string;
}

export interface ResolvedPageSeo {
  notFound: boolean;
  routeKind: string;
  path: string;
  pageUrl: string;
  baseUrl: string;
  siteName: string;
  title: string;
  description: string;
  canonicalUrl: string | null;
  ogUrl: string | null;
  ogTitle: string;
  ogDescription: string;
  ogImage: string;
  ogImageRaw?: string;
  ogType: string;
  ogImageAlt: string;
  twitterTitle: string;
  twitterDescription: string;
  twitterImage: string;
  twitterCard: string;
  twitterSite: string;
  twitterImageAlt: string;
  imageAlt?: string;
  index: boolean;
  follow: boolean;
  noindex: boolean;
  nofollow: boolean;
  robotsContent: string;
  schemaType?: string;
  breadcrumbEnabled?: boolean;
  breadcrumbs?: BreadcrumbItem[];
  jsonLd?: Record<string, any> | null;
  articleMeta: ArticleSeoMeta | null;
  hasPageOverride?: boolean;
}

export interface ApplyRouteSeoInput {
  path?: string;
  seoConfig?: unknown;
  settings?: Record<string, any>;
  articles?: any[];
  categories?: any[];
  tools?: any[];
}

const CONTROL_CHAR_REGEX = /[\u0000-\u001F\u007F-\u009F]/g;
const TWITTER_HANDLE_REGEX = /^@[a-zA-Z0-9_]{1,30}$/;
const ARTICLE_META_SELECTOR = [
  'meta[property="article:published_time"]',
  'meta[property="article:modified_time"]',
  'meta[property="article:author"]',
  'meta[property="article:section"]',
  'meta[property="article:tag"]',
].join(', ');

function cleanMetaText(value: unknown, maxLen = 500): string {
  if (typeof value !== 'string') return '';
  const cleaned = value.replace(CONTROL_CHAR_REGEX, ' ').replace(/\s+/g, ' ').trim();
  if (!cleaned) return '';
  return cleaned.length > maxLen ? cleaned.slice(0, maxLen) : cleaned;
}

function getSafeHttpUrlOrEmpty(value: unknown): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return isSafeHttpUrl(trimmed) ? trimmed : '';
}

function inferImageMimeType(urlStr: string): string {
  try {
    const pathname = new URL(urlStr).pathname.toLowerCase();
    if (pathname.endsWith('.png')) return 'image/png';
    if (pathname.endsWith('.webp')) return 'image/webp';
    if (pathname.endsWith('.jpg') || pathname.endsWith('.jpeg')) return 'image/jpeg';
    if (pathname.endsWith('.gif')) return 'image/gif';
    if (pathname.endsWith('.avif')) return 'image/avif';
    if (pathname.endsWith('.svg')) return 'image/svg+xml';
  } catch {
    return '';
  }
  return '';
}

function isDefaultOgImagePath(urlStr: string): boolean {
  try {
    return new URL(urlStr).pathname === '/images/og-default.png';
  } catch {
    return false;
  }
}

function upsertSingleMeta(
  head: HTMLHeadElement,
  selector: string,
  attr: 'name' | 'property',
  key: string,
  value: string,
  doc: Document
) {
  const matches = Array.from(head.querySelectorAll<HTMLMetaElement>(selector));
  if (!value) {
    matches.forEach((el) => el.remove());
    return;
  }
  let el = matches[0];
  if (matches.length > 1) {
    matches.slice(1).forEach((dup) => dup.remove());
  }
  if (!el) {
    el = doc.createElement('meta');
    el.setAttribute(attr, key);
    head.appendChild(el);
  } else if (el.getAttribute(attr) !== key) {
    el.setAttribute(attr, key);
  }
  el.setAttribute('content', value);
}

function upsertCanonicalLink(head: HTMLHeadElement, href: string, doc: Document) {
  const matches = Array.from(head.querySelectorAll<HTMLLinkElement>('link[rel="canonical"]'));
  if (!href) {
    matches.forEach((el) => el.remove());
    return;
  }
  let link = matches[0];
  if (matches.length > 1) {
    matches.slice(1).forEach((dup) => dup.remove());
  }
  if (!link) {
    link = doc.createElement('link');
    link.setAttribute('rel', 'canonical');
    head.appendChild(link);
  }
  link.setAttribute('href', href);
}

function syncArticleMetaTags(
  head: HTMLHeadElement,
  resolved: ResolvedPageSeo,
  ogType: string,
  doc: Document
) {
  Array.from(head.querySelectorAll<HTMLMetaElement>(ARTICLE_META_SELECTOR)).forEach((el) =>
    el.remove()
  );

  if (resolved.notFound || ogType !== 'article' || !resolved.articleMeta) {
    return;
  }

  const appendArticleMeta = (property: string, content: string) => {
    if (!content) return;
    const el = doc.createElement('meta');
    el.setAttribute('property', property);
    el.setAttribute('content', content);
    head.appendChild(el);
  };

  const published = cleanMetaText(resolved.articleMeta.published, 64);
  const modified = cleanMetaText(resolved.articleMeta.modified, 64);
  const authorUrl = getSafeHttpUrlOrEmpty(resolved.articleMeta.authorUrl);
  const section = cleanMetaText(resolved.articleMeta.section, 120);

  appendArticleMeta('article:published_time', published);
  appendArticleMeta('article:modified_time', modified);
  appendArticleMeta('article:author', authorUrl);
  appendArticleMeta('article:section', section);

  if (Array.isArray(resolved.articleMeta.tags)) {
    const seenTags = new Set<string>();
    for (const rawTag of resolved.articleMeta.tags) {
      const tag = cleanMetaText(rawTag, 100);
      if (!tag || seenTags.has(tag)) continue;
      seenTags.add(tag);
      appendArticleMeta('article:tag', tag);
    }
  }
}

function syncJsonLdScript(
  head: HTMLHeadElement,
  resolved: ResolvedPageSeo,
  doc: Document
) {
  const existing = Array.from(
    head.querySelectorAll<HTMLScriptElement>('script[type="application/ld+json"]')
  );

  const ld = resolved.jsonLd;
  const isValidLd =
    Boolean(ld) &&
    typeof ld === 'object' &&
    !Array.isArray(ld) &&
    isSafeStructuredData(ld, 10, 65536);

  if (!isValidLd) {
    existing.forEach((el) => el.remove());
    return;
  }

  let serialized = '';
  try {
    serialized = escapeJsonLd(ld);
  } catch {
    existing.forEach((el) => el.remove());
    return;
  }

  let el = existing[0];
  if (existing.length > 1) {
    existing.slice(1).forEach((dup) => dup.remove());
  }
  if (!el) {
    el = doc.createElement('script');
    el.setAttribute('type', 'application/ld+json');
    head.appendChild(el);
  }
  el.textContent = serialized;
}

function sanitizeSettingsForSeo(settings: unknown): Record<string, any> {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    return { productionUrl: DEFAULT_SITE_URL };
  }
  const raw = settings as Record<string, any>;
  const safeProductionUrl = getSafeHttpUrlOrEmpty(raw.productionUrl) || DEFAULT_SITE_URL;
  return {
    ...raw,
    productionUrl: safeProductionUrl,
  };
}

/**
 * Applies a resolved SEO object from `resolvePageSeo()` to the document head,
 * ensuring duplicate and stale metadata tags from previous routes are cleaned up.
 */
export function applyResolvedSeo(resolved: ResolvedPageSeo, doc: Document = document) {
  if (!doc || !doc.head) return;
  const head = doc.head;

  const title = cleanMetaText(resolved.title, 200) || DEFAULT_SEO_TITLE;
  const description = cleanMetaText(resolved.description, 320);
  const siteName = cleanMetaText(resolved.siteName, 100) || DEFAULT_SITE_NAME;
  const robots =
    cleanMetaText(resolved.robotsContent, 160) ||
    (resolved.noindex
      ? 'noindex, follow'
      : 'index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1');

  const canonicalUrl = resolved.notFound ? '' : getSafeHttpUrlOrEmpty(resolved.canonicalUrl);
  const ogUrl = resolved.notFound ? '' : getSafeHttpUrlOrEmpty(resolved.ogUrl);
  const ogType = ALLOWED_OG_TYPES.has(resolved.ogType) ? resolved.ogType : 'website';
  const ogTitle = cleanMetaText(resolved.ogTitle, 200) || title;
  const ogDescription = cleanMetaText(resolved.ogDescription, 320) || description;
  const ogImage = getSafeHttpUrlOrEmpty(resolved.ogImage);
  const ogImageAlt = ogImage ? cleanMetaText(resolved.ogImageAlt, 300) : '';
  const ogImageType = ogImage ? inferImageMimeType(ogImage) : '';
  const isDefaultOgImage = Boolean(ogImage && isDefaultOgImagePath(ogImage));

  const twitterCard = ALLOWED_TWITTER_CARDS.has(resolved.twitterCard)
    ? resolved.twitterCard
    : 'summary_large_image';
  const twitterTitle = cleanMetaText(resolved.twitterTitle, 200) || ogTitle;
  const twitterDescription = cleanMetaText(resolved.twitterDescription, 320) || ogDescription;
  const twitterImage = getSafeHttpUrlOrEmpty(resolved.twitterImage);
  const twitterImageAlt = twitterImage ? cleanMetaText(resolved.twitterImageAlt, 300) : '';
  const rawTwitterSite = cleanMetaText(resolved.twitterSite, 40);
  const twitterSite = TWITTER_HANDLE_REGEX.test(rawTwitterSite) ? rawTwitterSite : '';

  doc.title = title;

  upsertSingleMeta(head, 'meta[name="description"]', 'name', 'description', description, doc);
  upsertSingleMeta(head, 'meta[name="robots"]', 'name', 'robots', robots, doc);
  upsertCanonicalLink(head, canonicalUrl, doc);

  // Open Graph metadata
  upsertSingleMeta(head, 'meta[property="og:site_name"]', 'property', 'og:site_name', siteName, doc);
  upsertSingleMeta(head, 'meta[property="og:title"]', 'property', 'og:title', ogTitle, doc);
  upsertSingleMeta(
    head,
    'meta[property="og:description"]',
    'property',
    'og:description',
    ogDescription,
    doc
  );
  upsertSingleMeta(head, 'meta[property="og:type"]', 'property', 'og:type', ogType, doc);
  upsertSingleMeta(head, 'meta[property="og:url"]', 'property', 'og:url', ogUrl, doc);
  upsertSingleMeta(head, 'meta[property="og:image"]', 'property', 'og:image', ogImage, doc);
  upsertSingleMeta(head, 'meta[property="og:image:alt"]', 'property', 'og:image:alt', ogImageAlt, doc);
  upsertSingleMeta(
    head,
    'meta[property="og:image:type"]',
    'property',
    'og:image:type',
    ogImageType,
    doc
  );
  upsertSingleMeta(
    head,
    'meta[property="og:image:width"]',
    'property',
    'og:image:width',
    isDefaultOgImage ? '1200' : '',
    doc
  );
  upsertSingleMeta(
    head,
    'meta[property="og:image:height"]',
    'property',
    'og:image:height',
    isDefaultOgImage ? '630' : '',
    doc
  );

  // Twitter metadata
  upsertSingleMeta(head, 'meta[name="twitter:card"]', 'name', 'twitter:card', twitterCard, doc);
  upsertSingleMeta(head, 'meta[name="twitter:title"]', 'name', 'twitter:title', twitterTitle, doc);
  upsertSingleMeta(
    head,
    'meta[name="twitter:description"]',
    'name',
    'twitter:description',
    twitterDescription,
    doc
  );
  upsertSingleMeta(head, 'meta[name="twitter:image"]', 'name', 'twitter:image', twitterImage, doc);
  upsertSingleMeta(
    head,
    'meta[name="twitter:image:alt"]',
    'name',
    'twitter:image:alt',
    twitterImageAlt,
    doc
  );
  upsertSingleMeta(head, 'meta[name="twitter:site"]', 'name', 'twitter:site', twitterSite, doc);

  // Article-specific Open Graph tags
  syncArticleMetaTags(head, resolved, ogType, doc);

  // Structured data (JSON-LD)
  syncJsonLdScript(head, resolved, doc);
}

/**
 * Resolves page-level SEO metadata, breadcrumbs, and structured data without mutating the DOM.
 */
export function resolveRouteSeo(input: ApplyRouteSeoInput): ResolvedPageSeo {
  try {
    const safeSettings = sanitizeSettingsForSeo(input.settings);
    return resolvePageSeo({
      path: typeof input.path === 'string' && input.path.trim() ? input.path : '/',
      seoConfig: input.seoConfig ?? null,
      settings: safeSettings,
      articles: Array.isArray(input.articles) ? input.articles : [],
      categories: Array.isArray(input.categories) ? input.categories : [],
      tools: Array.isArray(input.tools) ? input.tools : [],
    }) as ResolvedPageSeo;
  } catch {
    return resolvePageSeo({
      path: '/',
      seoConfig: null,
      settings: { productionUrl: DEFAULT_SITE_URL },
      articles: [],
      categories: [],
      tools: [],
    }) as ResolvedPageSeo;
  }
}

/**
 * Resolves page-level SEO for the given route using `resolvePageSeo()` and applies it to the DOM.
 * Falls back safely if SEO config or entity records are invalid or missing.
 */
export function resolveAndApplyRouteSeo(
  input: ApplyRouteSeoInput,
  doc: Document = document
): ResolvedPageSeo {
  const resolved = resolveRouteSeo(input);
  applyResolvedSeo(resolved, doc);
  return resolved;
}

export function applySeo(
  opts:
    | ResolvedPageSeo
    | {
        title: string;
        description: string;
        path: string;
        baseUrl: string;
        image?: string;
        noindex?: boolean;
        type?: 'website' | 'article' | 'profile';
        notFound?: boolean;
      },
  doc: Document = document
) {
  if ('robotsContent' in opts && 'ogTitle' in opts) {
    applyResolvedSeo(opts, doc);
    return;
  }

  const base = getSafeHttpUrlOrEmpty(opts.baseUrl) || DEFAULT_SITE_URL;
  const cleanPath = (opts.path || '/').split(/[?#]/)[0] || '/';
  const formattedPath =
    cleanPath === '/' ? '/' : cleanPath.endsWith('/') ? cleanPath : `${cleanPath}/`;
  const url = `${base.replace(/\/+$/, '')}${formattedPath}`;
  const safeDesc =
    opts.description && opts.description.length > 155
      ? `${opts.description.slice(0, 152).trim()}...`
      : opts.description || '';
  const rawImg = opts.image || '';
  const img = rawImg
    ? /^https?:\/\//i.test(rawImg)
      ? rawImg
      : `${base.replace(/\/+$/, '')}${rawImg.startsWith('/') ? '' : '/'}${rawImg}`
    : '';
  const safeImg = getSafeHttpUrlOrEmpty(img);

  const cleanBase = base.replace(/\/+$/, '');
  const fallbackJsonLd = buildPageJsonLd({
    baseUrl: cleanBase,
    siteName: DEFAULT_SITE_NAME,
    siteDescription: safeDesc,
    pageUrl: url,
    normPath: formattedPath === '/' ? '/' : formattedPath.slice(0, -1),
    routeKind: opts.notFound ? 'unknown' : 'static',
    title: opts.title,
    description: safeDesc,
    imageUrl: safeImg,
    schemaType: 'WebPage',
    breadcrumbs: [],
    breadcrumbEnabled: false,
    notFound: Boolean(opts.notFound),
  });

  applyResolvedSeo(
    {
      notFound: Boolean(opts.notFound),
      routeKind: opts.notFound ? 'unknown' : 'static',
      path: formattedPath,
      pageUrl: url,
      baseUrl: cleanBase,
      siteName: DEFAULT_SITE_NAME,
      title: opts.title,
      description: safeDesc,
      canonicalUrl: opts.notFound ? null : url,
      ogUrl: opts.notFound ? null : url,
      ogTitle: opts.title,
      ogDescription: safeDesc,
      ogImage: safeImg,
      ogType: opts.type || 'website',
      ogImageAlt: opts.title,
      twitterTitle: opts.title,
      twitterDescription: safeDesc,
      twitterImage: safeImg,
      twitterCard: 'summary_large_image',
      twitterSite: '',
      twitterImageAlt: opts.title,
      index: !opts.noindex && !opts.notFound,
      follow: true,
      noindex: Boolean(opts.noindex || opts.notFound),
      nofollow: false,
      robotsContent:
        opts.noindex || opts.notFound
          ? 'noindex, follow'
          : 'index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1',
      schemaType: 'WebPage',
      breadcrumbEnabled: false,
      breadcrumbs: [],
      jsonLd: fallbackJsonLd,
      articleMeta: null,
    },
    doc
  );
}

/** Load Google Analytics only when a valid Measurement ID is configured. */
export function loadAnalytics(id: string | undefined) {
  if (!id || !/^G-[A-Z0-9]{4,20}$/.test(id)) return;
  if (document.getElementById('ga-script')) return;
  const s = document.createElement('script');
  s.id = 'ga-script';
  s.async = true;
  s.src = `https://www.googletagmanager.com/gtag/js?id=${id}`;
  document.head.appendChild(s);
  (window as any).dataLayer = (window as any).dataLayer || [];
  const gtag = function (..._args: any[]) {
    (window as any).dataLayer.push(arguments);
  };
  (window as any).gtag = gtag;
  gtag('js', new Date());
  gtag('config', id);
}
