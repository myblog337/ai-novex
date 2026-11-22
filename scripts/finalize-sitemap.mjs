import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isIndexable,
  categoryHasContent,
  isPublishedTool,
  isValidToolSlug,
} from '../src/config/indexing.js';
import { collectAuthors } from '../src/utils/authors.js';
import { STATIC_SEO_DEFAULTS, normalizeRoutePath, resolvePageSeo } from '../src/utils/pageSeo.js';
import { getRenderablePublishedCustomPages } from '../src/utils/customPages.js';
import {
  isValidCustomPageSlug,
  isReservedPageSlug,
  isValidHttpOriginUrl,
  isValidHttpUrl,
} from './lib/validators.mjs';

const escapeXml = (value) =>
  String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

function readOptionalSeoConfig(contentDir) {
  const seoPath = path.join(contentDir, 'seo.json');
  if (!fs.existsSync(seoPath)) {
    return null;
  }
  try {
    const lstat = fs.lstatSync(seoPath);
    if (lstat.isSymbolicLink() || !lstat.isFile()) {
      console.warn('[finalize-sitemap] Ignoring non-regular or symlink content/seo.json; using fallback defaults.');
      return null;
    }
    const raw = fs.readFileSync(seoPath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      console.warn('[finalize-sitemap] Malformed content/seo.json (expected object); using fallback defaults.');
      return null;
    }
    return parsed;
  } catch (err) {
    console.warn(`[finalize-sitemap] Failed to read or parse content/seo.json — using fallback defaults: ${err.message}`);
    return null;
  }
}

export function resolveRouteSeoSafe(
  routePath,
  { seoConfig, seoSettings, articles, categories, tools = [], pages = [] }
) {
  try {
    return resolvePageSeo({
      path: routePath,
      seoConfig,
      settings: seoSettings,
      articles,
      categories,
      tools,
      pages,
    });
  } catch (err) {
    console.warn(`[finalize-sitemap] SEO resolution failed for "${routePath}", falling back safely: ${err.message}`);
    try {
      return resolvePageSeo({
        path: routePath,
        seoConfig: null,
        settings: seoSettings,
        articles,
        categories,
        tools,
        pages,
      });
    } catch {
      return null;
    }
  }
}

export function isResolvedIndexable(resolved) {
  if (!resolved || typeof resolved !== 'object') return false;
  if (resolved.notFound) return false;
  if (resolved.index !== true || resolved.noindex === true) return false;
  const directives = String(resolved.robotsContent || '')
    .toLowerCase()
    .split(',')
    .map((token) => token.trim())
    .filter(Boolean);
  if (directives.includes('noindex')) return false;
  if (directives.length > 0 && !directives.includes('index')) return false;
  return true;
}

export function resolveSitemapCanonicalUrl(resolved, expectedOrigin, fallbackRoutePath) {
  const cleanBase = expectedOrigin.replace(/\/+$/, '');
  const fallbackNormPath = normalizeRoutePath(fallbackRoutePath);
  const fallbackUrl = `${cleanBase}${fallbackNormPath}`;

  const candidates = [resolved?.canonicalUrl, resolved?.pageUrl, fallbackUrl];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    const trimmed = candidate.trim();
    if (!trimmed) continue;
    if (!isValidHttpUrl(trimmed)) continue;

    let parsed;
    try {
      parsed = new URL(trimmed);
    } catch {
      continue;
    }

    if (parsed.origin !== expectedOrigin) continue;
    if (parsed.search !== '' || parsed.hash !== '') continue;
    if (parsed.pathname.includes('//')) continue;

    const normPathname = parsed.pathname === '/' ? '/' : `${parsed.pathname.replace(/\/+$/, '')}/`;
    const finalUrl = `${expectedOrigin}${normPathname}`;
    if (isValidHttpUrl(finalUrl) && finalUrl.endsWith('/')) {
      return finalUrl;
    }
  }

  return isValidHttpUrl(fallbackUrl) && fallbackUrl.endsWith('/') ? fallbackUrl : null;
}

function upsertSitemapEntry(entries, loc, lastmod) {
  if (!loc) return;
  const cleanLastmod = typeof lastmod === 'string' && lastmod.trim() ? lastmod.trim() : undefined;
  if (!entries.has(loc)) {
    entries.set(loc, cleanLastmod);
    return;
  }
  const existing = entries.get(loc);
  if (cleanLastmod && (!existing || cleanLastmod > existing)) {
    entries.set(loc, cleanLastmod);
  }
}

export function runFinalizeSitemap(root = process.cwd()) {
  const dist = path.join(root, 'dist');
  const contentDir = path.join(root, 'content');
  const readJson = (file) => JSON.parse(fs.readFileSync(path.join(contentDir, file), 'utf-8'));

  if (!fs.existsSync(dist)) {
    console.error('[sitemap] dist/ not found — run `npm run build` first.');
    process.exit(1);
  }

  const settings = readJson('settings.json');
  if (
    typeof settings?.productionUrl !== 'string' ||
    !settings.productionUrl.trim() ||
    !isValidHttpOriginUrl(settings.productionUrl)
  ) {
    console.error(
      '[finalize-sitemap] Invalid or missing productionUrl in content/settings.json: must be a valid HTTP or HTTPS origin URL without a path, query, or fragment (e.g., https://example.com)'
    );
    process.exit(1);
  }

  const rawArticles = readJson('articles.json');
  const articles = Array.isArray(rawArticles) ? rawArticles.filter((article) => Boolean(article && article.isPublished)) : [];
  const rawCategories = readJson('categories.json');
  const categories = Array.isArray(rawCategories) ? rawCategories : [];
  let rawTools = [];
  try {
    rawTools = fs.existsSync(path.join(contentDir, 'tools.json')) ? readJson('tools.json') : [];
  } catch (err) {
    console.warn(`[finalize-sitemap] Failed to read or parse content/tools.json — skipping tool URLs: ${err.message}`);
    rawTools = [];
  }
  const tools = Array.isArray(rawTools) ? rawTools.filter(isPublishedTool) : [];

  const pagesFilePath = path.join(contentDir, 'pages.json');
  let rawPages = [];
  if (fs.existsSync(pagesFilePath)) {
    let pagesLstat;
    try {
      pagesLstat = fs.lstatSync(pagesFilePath);
    } catch (err) {
      console.error(`[finalize-sitemap] Failed to inspect content/pages.json: ${err.message}`);
      process.exit(1);
    }
    if (pagesLstat.isSymbolicLink() || !pagesLstat.isFile()) {
      console.error('[finalize-sitemap] Security check failed: content/pages.json must be a regular file');
      process.exit(1);
    }
    try {
      rawPages = JSON.parse(fs.readFileSync(pagesFilePath, 'utf-8'));
    } catch (err) {
      console.error(`[finalize-sitemap] Failed to parse content/pages.json: ${err.message}`);
      process.exit(1);
    }
    if (!Array.isArray(rawPages)) {
      console.error('[finalize-sitemap] Invalid content/pages.json: expected a JSON array');
      process.exit(1);
    }
  }
  const pages = getRenderablePublishedCustomPages(rawPages);

  const seoConfig = readOptionalSeoConfig(contentDir);

  const context = { articles, categories, tools, pages };
  const baseUrl = settings.productionUrl.trim().replace(/\/+$/, '');
  const expectedOrigin = new URL(baseUrl).origin;
  const seoSettings = { ...settings, productionUrl: baseUrl };

  const entries = new Map();
  const seenRoutes = new Set();
  const dateOf = (article) => article.updatedAt || article.publishedAt;
  const newest = (items) => items.map(dateOf).filter(Boolean).sort().pop();

  // 1. Static routes defined in STATIC_SEO_DEFAULTS (indexable by default or via valid page-level override)
  for (const staticKey of Object.keys(STATIC_SEO_DEFAULTS)) {
    const route = normalizeRoutePath(staticKey);
    seenRoutes.add(route);
    const resolved = resolveRouteSeoSafe(route, { seoConfig, seoSettings, articles, categories, tools, pages });
    if (!isResolvedIndexable(resolved)) continue;
    const loc = resolveSitemapCanonicalUrl(resolved, expectedOrigin, route);
    const lastmod = ['/', '/blog'].includes(staticKey) ? newest(articles) : undefined;
    upsertSitemapEntry(entries, loc, lastmod);
  }

  // 2. Author profile routes (only valid authors with at least one published article, respecting noindex overrides)
  for (const author of collectAuthors(articles)) {
    if (!author?.slug || author.slug.includes('/')) continue;
    const route = `/author/${author.slug}/`;
    seenRoutes.add(route);
    if (!isIndexable(route, context)) continue;
    const resolved = resolveRouteSeoSafe(route, { seoConfig, seoSettings, articles, categories, tools, pages });
    if (!isResolvedIndexable(resolved)) continue;
    const loc = resolveSitemapCanonicalUrl(resolved, expectedOrigin, route);
    upsertSitemapEntry(entries, loc, newest(author.articles));
  }

  // 3. Published article routes (respecting noindex overrides and canonical URLs)
  for (const article of articles) {
    if (!article?.slug || typeof article.slug !== 'string' || article.slug.includes('/')) continue;
    const route = `/blog/${article.slug}/`;
    seenRoutes.add(route);
    if (!isIndexable(route, context)) continue;
    const resolved = resolveRouteSeoSafe(route, { seoConfig, seoSettings, articles, categories, tools, pages });
    if (!isResolvedIndexable(resolved)) continue;
    const loc = resolveSitemapCanonicalUrl(resolved, expectedOrigin, route);
    upsertSitemapEntry(entries, loc, dateOf(article));
  }

  // 4. Category routes (always exclude empty categories per policy, and respect noindex overrides)
  for (const category of categories) {
    if (!category?.slug || typeof category.slug !== 'string' || category.slug.includes('/')) continue;
    if (!categoryHasContent(category.slug, categories, articles)) continue;
    const route = `/category/${category.slug}/`;
    seenRoutes.add(route);
    if (!isIndexable(route, context)) continue;
    const resolved = resolveRouteSeoSafe(route, { seoConfig, seoSettings, articles, categories, tools, pages });
    if (!isResolvedIndexable(resolved)) continue;
    const loc = resolveSitemapCanonicalUrl(resolved, expectedOrigin, route);
    upsertSitemapEntry(entries, loc, newest(articles.filter((article) => article.category === category.slug)));
  }

  // 5. Published Tool detail routes (respecting noindex overrides, defaultIndex, and custom canonicals)
  for (const tool of tools) {
    if (!isValidToolSlug(tool.slug)) continue;
    const route = `/tools/${tool.slug}/`;
    seenRoutes.add(route);
    if (!isIndexable(route, context)) continue;
    const resolved = resolveRouteSeoSafe(route, { seoConfig, seoSettings, articles, categories, tools, pages });
    if (!isResolvedIndexable(resolved)) continue;
    const loc = resolveSitemapCanonicalUrl(resolved, expectedOrigin, route);
    upsertSitemapEntry(entries, loc);
  }

  // 6. Published Custom Static Pages (/[slug]/), excluding unpublished, invalid/duplicate/reserved slugs, and noindex
  for (const page of pages) {
    if (!page?.slug || !isValidCustomPageSlug(page.slug) || isReservedPageSlug(page.slug)) continue;
    const route = `/${page.slug}/`;
    if (seenRoutes.has(route)) continue;
    seenRoutes.add(route);
    if (!isIndexable(route, context)) continue;
    const resolved = resolveRouteSeoSafe(route, { seoConfig, seoSettings, articles, categories, tools, pages });
    if (!isResolvedIndexable(resolved)) continue;
    const loc = resolveSitemapCanonicalUrl(resolved, expectedOrigin, route);
    if (!loc) continue;
    const lastmod =
      typeof page.updatedAt === 'string' && /^\d{4}-\d{2}-\d{2}/.test(page.updatedAt)
        ? page.updatedAt.slice(0, 10)
        : undefined;
    upsertSitemapEntry(entries, loc, lastmod);
  }

  let sitemap = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n';
  for (const [loc, lastmod] of entries) {
    sitemap += `  <url>\n    <loc>${escapeXml(loc)}</loc>\n${lastmod ? `    <lastmod>${escapeXml(lastmod)}</lastmod>\n` : ''}  </url>\n`;
  }
  sitemap += '</urlset>\n';

  const sitemapPath = path.join(dist, 'sitemap.xml');
  const tmpSitemapPath = path.join(dist, `.sitemap.xml.tmp-${process.pid}-${Date.now()}`);
  try {
    fs.writeFileSync(tmpSitemapPath, sitemap, 'utf-8');
    fs.renameSync(tmpSitemapPath, sitemapPath);
  } catch (err) {
    try {
      if (fs.existsSync(tmpSitemapPath)) {
        fs.unlinkSync(tmpSitemapPath);
      }
    } catch {}
    throw err;
  }

  console.log(`[sitemap] Wrote ${entries.size} indexable URLs; excluded noindex pages.`);
  return { entries, sitemap };
}

const isDirectExecution =
  Boolean(process.argv[1]) &&
  fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(fileURLToPath(import.meta.url));

if (isDirectExecution) {
  runFinalizeSitemap();
}
