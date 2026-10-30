// Runs after `vite build`. Pre-renders every route into static HTML (crawlable without JS,
// instant first paint) and generates sitemap.xml, rss.xml, robots.txt and ads.txt into dist/.
//
// INDEXING POLICY: defined ONCE in src/config/indexing.js (shared with src/App.tsx), so the
// pre-rendered HTML, the client-side meta tags and sitemap.xml always agree.
//   indexable  -> home, /blog/, /tools/, /categories/, /about/, /contact/, /author/*, /editorial-policy/,
//                 every published article, every category that has >= 1 article
//   noindex    -> legal pages (privacy, terms, affiliate), empty categories, 404
//   sitemap.xml lists ONLY the indexable URLs.
import fs from 'node:fs';
import path from 'node:path';
import { renderMarkdown } from '../src/utils/markdown.js';
import { INDEXABLE_STATIC_PATHS, isIndexable, categoryHasContent, categoryTitle } from '../src/config/indexing.js';

const root = process.cwd();
const dist = path.join(root, 'dist');
const contentSrc = path.join(root, 'content');

if (!fs.existsSync(dist)) {
  console.error('dist/ not found — run `vite build` first.');
  process.exit(1);
}

const readJson = (f, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(contentSrc, f), 'utf-8'));
  } catch {
    return fallback;
  }
};

const esc = (v) =>
  String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const settings = readJson('settings.json', {});
const categories = readJson('categories.json', []);
const tools = readJson('tools.json', []);
const ads = readJson('ads.json', {});
const allArticles = readJson('articles.json', []);
const articles = allArticles.filter((a) => a.isPublished);
const baseUrl = (settings.productionUrl || 'https://ai-novex.netlify.app').replace(/\/+$/, '');
const defaultOgImage = settings.defaultOgImage || '/images/og-default.png';
const ctx = { articles, categories };
const indexable = (p) => isIndexable(p, ctx);
const today = new Date().toISOString().slice(0, 10);

// Sitemap.xml: ONLY indexable URLs, canonical trailing-slash form. <lastmod> is emitted only when it
// reflects a real content date (never "today"), because Google ignores sitemaps whose lastmod is always fresh.
const dateOf = (a) => a.updatedAt || a.publishedAt;
const newest = (list) => list.map(dateOf).filter(Boolean).sort().pop();
const sitemapEntries = [];
for (const p of INDEXABLE_STATIC_PATHS) {
  const loc = p === '/' ? '/' : `${p}/`;
  const lastmod = ['/', '/blog', '/author/md-shamim'].includes(p) ? newest(articles) : undefined;
  sitemapEntries.push({ loc, lastmod });
}
for (const a of articles) sitemapEntries.push({ loc: `/blog/${a.slug}/`, lastmod: dateOf(a) });
for (const c of categories) {
  if (!categoryHasContent(c.slug, articles)) continue; // empty category => noindex => not in sitemap
  sitemapEntries.push({ loc: `/category/${c.slug}/`, lastmod: newest(articles.filter((a) => a.category === c.slug)) });
}
let sm = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n`;
for (const e of sitemapEntries) {
  sm += `  <url>\n    <loc>${esc(`${baseUrl}${e.loc}`)}</loc>\n${e.lastmod ? `    <lastmod>${esc(e.lastmod)}</lastmod>\n` : ''}  </url>\n`;
}
sm += `</urlset>\n`;
fs.writeFileSync(path.join(dist, 'sitemap.xml'), sm);

// Rss.xml
let rss = `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">\n<channel>\n`;
rss += `  <title>${esc(settings.siteTitle || 'AINOVEX')}</title>\n  <link>${esc(baseUrl)}/</link>\n`;
rss += `  <description>${esc(settings.siteDescription || '')}</description>\n  <language>en-us</language>\n`;
rss += `  <atom:link href="${esc(baseUrl)}/rss.xml" rel="self" type="application/rss+xml" />\n`;
for (const a of [...articles].sort((x, y) => String(y.publishedAt).localeCompare(String(x.publishedAt)))) {
  const url = `${baseUrl}/blog/${a.slug}/`;
  rss += `  <item>\n    <title>${esc(a.title)}</title>\n    <link>${esc(url)}</link>\n    <guid isPermaLink="true">${esc(url)}</guid>\n    <description>${esc(a.excerpt || '')}</description>\n    <pubDate>${new Date(a.publishedAt).toUTCString()}</pubDate>\n  </item>\n`;
}
rss += `</channel>\n</rss>\n`;
fs.writeFileSync(path.join(dist, 'rss.xml'), rss);

// Robots.txt: everything stays crawlable (so crawlers can SEE the noindex tags); indexing is
// controlled per page. Do NOT add Disallow rules for noindex pages - a blocked page can't be
// recrawled and its noindex would never be read.
fs.writeFileSync(path.join(dist, 'robots.txt'), `User-agent: *\nAllow: /\n\nSitemap: ${baseUrl}/sitemap.xml\n`);

// Ads.txt
if (ads.enabled && ads.adsTxtContent && !/pub-X+/i.test(ads.adsTxtContent)) {
  fs.writeFileSync(path.join(dist, 'ads.txt'), ads.adsTxtContent);
}

// Inline main CSS into template
const indexPath = path.join(dist, 'index.html');
let baseHtml = fs.readFileSync(indexPath, 'utf-8');
if (baseUrl !== 'https://ai-novex.netlify.app') {
  baseHtml = baseHtml.replaceAll('https://ai-novex.netlify.app', baseUrl);
}
try {
  let inlinedBytes = 0;
  baseHtml = baseHtml.replace(/<link\b[^>]*>/gi, (tag) => {
    if (!/\brel=["']stylesheet["']/i.test(tag)) return tag;
    const m = tag.match(/\bhref=["'](\/assets\/[^"']+\.css)["']/i);
    if (!m) return tag;
    const cssFile = path.join(dist, m[1]);
    if (!fs.existsSync(cssFile)) return tag;
    const css = fs.readFileSync(cssFile, 'utf-8');
    if (css.length > 120 * 1024 || /<\/style/i.test(css)) return tag;
    inlinedBytes += css.length;
    return `<style>${css.replace(/\/\*# sourceMappingURL=[^*]*\*\//g, '')}</style>`;
  });
  if (inlinedBytes) {
    fs.writeFileSync(indexPath, baseHtml);
    console.log(`[postbuild] inlined ${(inlinedBytes / 1024).toFixed(1)} KB of CSS into index.html`);
  }
} catch (err) {
  console.warn('[postbuild] CSS inlining skipped:', err.message);
}

// Helper to keep meta description <= 155 characters
const trimDesc = (desc) => {
  const clean = String(desc || '').replace(/\s+/g, ' ').trim();
  if (clean.length <= 155) return clean;
  return clean.slice(0, 152).trim() + '...';
};

// ============================================================================
const getArticleSrcSet = (imgPath) => {
  if (!imgPath) return '';
  if (imgPath.startsWith('/images/articles/') && imgPath.endsWith('.webp')) {
    const base = imgPath.slice(0, -5);
    return `${base}-600w.webp 600w, ${base}-900w.webp 900w, ${imgPath} 1200w`;
  }
  if (imgPath.includes('w=1200')) {
    return `${imgPath.replace('w=1200', 'w=600')} 600w, ${imgPath.replace('w=1200', 'w=900')} 900w, ${imgPath} 1200w`;
  }
  return '';
};

// ============================================================================
// PRE-RENDER ENGINE: Render semantic HTML & rich metadata for every route
// ============================================================================

const renderHeader = () => `
<header class="sticky top-0 z-40 w-full backdrop-blur-xl border-b transition-colors duration-200 bg-white/95 border-slate-200/90 text-slate-900 dark:bg-[#0b101b]/90 dark:border-slate-800/80 dark:text-slate-100 shadow-sm" style="min-height: 80px;">
  <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-20 flex items-center justify-between">
    <a href="/" class="cursor-pointer group flex flex-col select-none">
      <div class="flex items-center gap-1 text-2xl font-black tracking-tight">
        <span class="text-transparent bg-clip-text bg-gradient-to-r from-sky-400 via-blue-400 to-blue-500">AI</span>
        <span class="text-slate-900 dark:text-white group-hover:text-sky-500 transition-colors">NOVEX</span>
      </div>
      <span class="text-[10px] tracking-wider font-medium text-slate-500 dark:text-slate-400 -mt-0.5">AI Tools • News • Guides • More</span>
    </a>
    <nav aria-label="Main Navigation" class="hidden md:flex items-center gap-7 text-sm font-medium">
      <a href="/" class="transition-colors py-1 text-slate-600 hover:text-slate-900 dark:text-slate-300 dark:hover:text-white">Home</a>
      <a href="/tools/" class="transition-colors py-1 text-slate-600 hover:text-slate-900 dark:text-slate-300 dark:hover:text-white">AI Tools</a>
      <a href="/categories/" class="transition-colors py-1 text-slate-600 hover:text-slate-900 dark:text-slate-300 dark:hover:text-white">Categories</a>
      <a href="/blog/" class="transition-colors py-1 text-slate-600 hover:text-slate-900 dark:text-slate-300 dark:hover:text-white">Blog</a>
      <a href="/about/" class="transition-colors py-1 text-slate-600 hover:text-slate-900 dark:text-slate-300 dark:hover:text-white">About</a>
      <a href="/contact/" class="transition-colors py-1 text-slate-600 hover:text-slate-900 dark:text-slate-300 dark:hover:text-white">Contact</a>
    </nav>
    <div class="flex items-center gap-2.5 sm:gap-3.5">
      <button aria-label="Search AI Tools" class="p-2 rounded-lg text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800/60 transition-colors cursor-pointer">
        <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8"></circle><path d="m21 21-4.3-4.3"></path></svg>
      </button>
      <button aria-label="Toggle theme" class="relative p-2.5 rounded-xl transition-all duration-300 flex items-center justify-center cursor-pointer shadow-sm text-amber-300 bg-slate-800/80 border border-slate-700/70">
        <svg class="w-5 h-5 text-sky-300" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"></path></svg>
        <span class="absolute top-1 right-1 w-2 h-2 rounded-full bg-sky-400"></span>
      </button>
      <a href="/tools/" class="hidden sm:inline-flex items-center gap-1.5 px-4 py-2 rounded-full text-xs sm:text-sm font-semibold text-white bg-blue-600 hover:bg-blue-500 shadow-md shadow-blue-600/30 transition-all">
        <span>Explore Tools</span>
        <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14"></path><path d="m12 5 7 7-7 7"></path></svg>
      </a>
      <button aria-label="Open Navigation Menu" class="md:hidden p-2 rounded-lg text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800/60 transition-colors">
        <svg class="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="4" x2="20" y1="12" y2="12"></line><line x1="4" x2="20" y1="6" y2="6"></line><line x1="4" x2="20" y1="18" y2="18"></line></svg>
      </button>
    </div>
  </div>
</header>`;

const renderFooter = () => `
<footer class="border-t border-slate-200 dark:border-slate-800/80 bg-slate-50 dark:bg-[#070b14] pt-16 pb-12 transition-colors mt-16">
  <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
    <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-12 gap-10 lg:gap-8 mb-14">
      <div class="lg:col-span-4">
        <a href="/" class="cursor-pointer inline-flex flex-col mb-4 select-none">
          <div class="flex items-center gap-1 text-2xl font-black tracking-tight">
            <span class="text-transparent bg-clip-text bg-gradient-to-r from-sky-400 via-blue-400 to-blue-500">AI</span>
            <span class="text-slate-900 dark:text-white">NOVEX</span>
          </div>
          <span class="text-[10px] tracking-wider font-medium text-slate-500 dark:text-slate-400 -mt-0.5">AI Tools • News • Guides • More</span>
        </a>
        <p class="text-xs sm:text-sm text-slate-600 dark:text-slate-400 leading-relaxed max-w-sm">
          AINOVEX is your trusted source for the best AI tools, latest news, and helpful guides. Boost your productivity and work smarter with curated artificial intelligence.
        </p>
      </div>
      <div class="lg:col-span-2">
        <h4 class="text-xs font-bold uppercase tracking-wider text-slate-900 dark:text-white mb-4">QUICK LINKS</h4>
        <ul class="space-y-2.5 text-xs sm:text-sm">
          <li><a href="/" class="text-slate-600 hover:text-blue-600 dark:text-slate-400 dark:hover:text-blue-400 transition-colors block">Home</a></li>
          <li><a href="/tools/" class="text-slate-600 hover:text-blue-600 dark:text-slate-400 dark:hover:text-blue-400 transition-colors block">AI Tools</a></li>
          <li><a href="/blog/" class="text-slate-600 hover:text-blue-600 dark:text-slate-400 dark:hover:text-blue-400 transition-colors block">Blog</a></li>
          <li><a href="/categories/" class="text-slate-600 hover:text-blue-600 dark:text-slate-400 dark:hover:text-blue-400 transition-colors block">Categories</a></li>
          <li><a href="/about/" class="text-slate-600 hover:text-blue-600 dark:text-slate-400 dark:hover:text-blue-400 transition-colors block">About</a></li>
          <li><a href="/contact/" class="text-slate-600 hover:text-blue-600 dark:text-slate-400 dark:hover:text-blue-400 transition-colors block">Contact</a></li>
        </ul>
      </div>
      <div class="lg:col-span-3">
        <h4 class="text-xs font-bold uppercase tracking-wider text-slate-900 dark:text-white mb-4">POPULAR CATEGORIES</h4>
        <div class="grid grid-cols-2 gap-x-2 gap-y-2.5 text-xs sm:text-sm">
          ${categories.slice(0, 8).map(c => `<a href="/category/${c.slug}/" class="text-left text-slate-600 hover:text-blue-600 dark:text-slate-400 dark:hover:text-blue-400 transition-colors truncate block">${esc(c.name)}</a>`).join('')}
        </div>
      </div>
      <div class="lg:col-span-3">
        <h4 class="text-xs font-bold uppercase tracking-wider text-slate-900 dark:text-white mb-4">EDITORIAL DESK</h4>
        <p class="text-xs text-slate-600 dark:text-slate-400 mb-3">
          Independent AI software reviews, benchmarks, workflows, and hands-on tutorials.
        </p>
        <div class="flex items-center gap-2 pt-1">
          <a href="/rss.xml" class="px-3 py-1 rounded-full bg-slate-200 hover:bg-blue-600 text-slate-700 hover:text-white dark:bg-slate-800 dark:text-slate-300 text-xs font-bold transition-all">RSS Feed</a>
          <a href="/tools/" class="px-3 py-1 rounded-full bg-blue-600 text-white text-xs font-bold transition-all">Directory</a>
        </div>
      </div>
    </div>
    <div class="pt-8 border-t border-slate-200 dark:border-slate-800/60 flex flex-col sm:flex-row items-center justify-between gap-4 text-xs text-slate-500 dark:text-slate-400">
      <p>&copy; 2026 AINOVEX. All rights reserved.</p>
      <div class="flex flex-wrap items-center gap-5">
        <a href="/privacy/" class="hover:text-blue-600 dark:hover:text-blue-400 transition-colors">Privacy Policy</a>
        <a href="/terms/" class="hover:text-blue-600 dark:hover:text-blue-400 transition-colors">Terms of Service</a>
        <a href="/editorial-policy/" class="hover:text-blue-600 dark:hover:text-blue-400 transition-colors">Editorial Policy</a>
        <a href="/affiliate-disclosure/" class="hover:text-blue-600 dark:hover:text-blue-400 transition-colors">Disclaimer</a>
      </div>
    </div>
  </div>
</footer>`;

// Breadcrumbs are rendered as plain visible HTML. The structured data for them is emitted ONCE as
// JSON-LD (see createPageHtml) - using microdata AND JSON-LD produced duplicate BreadcrumbList markup.
let pendingCrumbs = null; // picked up (and cleared) by the next createPageHtml() call
const renderBreadcrumb = (crumbs) => {
  pendingCrumbs = crumbs;
  return `
<nav aria-label="Breadcrumb" class="py-3 text-xs text-slate-500 dark:text-slate-400">
  <ol class="flex items-center flex-wrap gap-1.5">
    <li>
      <a href="/" class="flex items-center gap-1 text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white transition-colors cursor-pointer">
        <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path><polyline points="9 22 9 12 15 12 15 22"></polyline></svg>
        <span>Home</span>
      </a>
    </li>
    ${crumbs.map((c, i) => `
    <li class="text-slate-400 dark:text-slate-600" aria-hidden="true">
      <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"></path></svg>
    </li>
    <li${i === crumbs.length - 1 ? ' aria-current="page"' : ''}>
      ${c.path ? `<a href="${c.path.endsWith('/') ? c.path : c.path + '/'}" class="text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white transition-colors cursor-pointer"><span>${esc(c.label)}</span></a>` : `<span class="font-semibold text-slate-800 dark:text-slate-200 truncate max-w-[200px] sm:max-w-md inline-block">${esc(c.label)}</span>`}
    </li>`).join('')}
  </ol>
</nav>`;
};

const siteDescriptionLd = 'Discover the best AI tools, in-depth software reviews, and practical guides on AINOVEX. Boost your productivity and work smarter with curated artificial intelligence.';
const orgNode = {
  '@type': 'Organization',
  '@id': `${baseUrl}/#organization`,
  name: 'AINOVEX',
  url: `${baseUrl}/`,
  logo: { '@type': 'ImageObject', '@id': `${baseUrl}/#logo`, url: `${baseUrl}/logo-512.png`, width: 512, height: 512 },
};
const websiteNode = {
  '@type': 'WebSite',
  '@id': `${baseUrl}/#website`,
  url: `${baseUrl}/`,
  name: 'AINOVEX',
  description: siteDescriptionLd,
  inLanguage: 'en-US',
  publisher: { '@id': `${baseUrl}/#organization` },
};

const breadcrumbLd = (crumbs, pageUrl) => ({
  '@type': 'BreadcrumbList',
  '@id': `${pageUrl}#breadcrumb`,
  itemListElement: [
    { '@type': 'ListItem', position: 1, name: 'Home', item: `${baseUrl}/` },
    ...crumbs.map((c, i) => ({
      '@type': 'ListItem',
      position: i + 2,
      name: c.label,
      item: c.path ? `${baseUrl}${c.path.endsWith('/') ? c.path : c.path + '/'}` : pageUrl,
    })),
  ],
});

function toAbsoluteUrl(img) {
  if (!img) return '';
  if (img.startsWith('http://') || img.startsWith('https://')) return img;
  return `${baseUrl}${img.startsWith('/') ? '' : '/'}${img}`;
}

/** Read width/height of a local .webp/.png in /public without extra dependencies (null if unknown). */
const imageSizeCache = new Map();
function getImageSize(imgPath) {
  if (!imgPath || /^https?:/i.test(imgPath)) return null;
  if (imageSizeCache.has(imgPath)) return imageSizeCache.get(imgPath);
  let size = null;
  try {
    const buf = fs.readFileSync(path.join(root, 'public', imgPath));
    if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
      const kind = buf.toString('ascii', 12, 16);
      if (kind === 'VP8X') size = { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
      else if (kind === 'VP8 ') size = { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
      else if (kind === 'VP8L') {
        const b = buf.readUInt32LE(21);
        size = { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
      }
    } else if (buf.readUInt32BE(0) === 0x89504e47) {
      size = { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
  } catch {
    size = null;
  }
  imageSizeCache.set(imgPath, size);
  return size;
}
const mimeOf = (img) => (/\.png(\?|$)/i.test(img) ? 'image/png' : /\.jpe?g(\?|$)/i.test(img) ? 'image/jpeg' : /\.webp(\?|$)/i.test(img) ? 'image/webp' : '');

// JSON inside <script>: "<" must be escaped so content can never close the tag early.
const safeJson = (obj) => JSON.stringify(obj, null, 2).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

function createPageHtml({ title, description, path: pagePath, image, imageAlt, ogType = 'website', jsonLd, contentHtml, indexable: isIdx, notFound = false, preloadImage = null, articleMeta = null }) {
  const crumbs = pendingCrumbs;
  pendingCrumbs = null;
  const normPath = pagePath === '/' ? '/' : (pagePath.endsWith('/') ? pagePath : pagePath + '/');
  const url = `${baseUrl}${normPath}`;
  const ogImgRaw = image || defaultOgImage;
  const ogImg = toAbsoluteUrl(ogImgRaw);
  const ogSize = getImageSize(ogImgRaw);
  const safeDesc = trimDesc(description);
  const safeImgAlt = imageAlt || title;
  const is404 = notFound;
  // Indexing is decided in ONE place (src/config/indexing.js); callers may only pass a boolean computed from it.
  const indexableFlag = is404 ? false : (isIdx ?? indexable(normPath));

  let html = baseHtml;
  // NOTE: every replacement below uses a function so "$&", "$1", "$'" inside titles/descriptions/content
  // are inserted literally (a plain replacement string would interpret them as patterns).
  const set = (re, text) => {
    html = html.replace(re, () => text);
  };

  set(/<title>[^<]*<\/title>/i, `<title>${esc(title)}</title>`);
  set(/<meta\s+name=["']description["'][^>]*>/i, `<meta name="description" content="${esc(safeDesc)}" />`);

  if (is404) {
    // 404 pages MUST have noindex and MUST NOT have a canonical tag
    set(/<meta\s+name=["']robots["'][^>]*>/i, `<meta name="robots" content="noindex, follow" />`);
    html = html.replace(/<link\s+rel=["']canonical["'][^>]*>\s*/gi, '');
    html = html.replace(/<meta\s+property=["']og:url["'][^>]*>\s*/gi, '');
  } else {
    const robots = indexableFlag
      ? 'index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1'
      : 'noindex, follow';
    set(/<meta\s+name=["']robots["'][^>]*>/i, `<meta name="robots" content="${robots}" />`);
    // Canonical always points to the direct 200 URL with trailing slash
    if (/<link\s+rel=["']canonical["'][^>]*>/i.test(html)) {
      set(/<link\s+rel=["']canonical["'][^>]*>/i, `<link rel="canonical" href="${esc(url)}" />`);
    } else {
      html = html.replace('</head>', () => `    <link rel="canonical" href="${esc(url)}" />\n  </head>`);
    }
    set(/<meta\s+property=["']og:url["'][^>]*>/i, `<meta property="og:url" content="${esc(url)}" />`);
  }

  // Open Graph (absolute URLs; image size is only declared when it is really known)
  set(/<meta\s+property=["']og:title["'][^>]*>/i, `<meta property="og:title" content="${esc(title)}" />`);
  set(/<meta\s+property=["']og:description["'][^>]*>/i, `<meta property="og:description" content="${esc(safeDesc)}" />`);
  set(/<meta\s+property=["']og:type["'][^>]*>/i, `<meta property="og:type" content="${ogType}" />`);
  set(/<meta\s+property=["']og:image["'][^>]*>/i, `<meta property="og:image" content="${esc(ogImg)}" />`);
  set(/<meta\s+property=["']og:image:width["'][^>]*>\s*/i, ogSize ? `<meta property="og:image:width" content="${ogSize.width}" />\n    ` : '');
  set(/<meta\s+property=["']og:image:height["'][^>]*>\s*/i, ogSize ? `<meta property="og:image:height" content="${ogSize.height}" />\n    ` : '');
  set(/<meta\s+property=["']og:image:type["'][^>]*>\s*/i, mimeOf(ogImgRaw) ? `<meta property="og:image:type" content="${mimeOf(ogImgRaw)}" />\n    ` : '');
  set(/<meta\s+property=["']og:image:alt["'][^>]*>/i, `<meta property="og:image:alt" content="${esc(safeImgAlt)}" />`);

  // Twitter
  set(/<meta\s+name=["']twitter:title["'][^>]*>/i, `<meta name="twitter:title" content="${esc(title)}" />`);
  set(/<meta\s+name=["']twitter:description["'][^>]*>/i, `<meta name="twitter:description" content="${esc(safeDesc)}" />`);
  set(/<meta\s+name=["']twitter:image["'][^>]*>/i, `<meta name="twitter:image" content="${esc(ogImg)}" />\n    <meta name="twitter:image:alt" content="${esc(safeImgAlt)}" />`);

  // Article-only Open Graph tags (published/modified time, author, section, tags)
  if (articleMeta) {
    const tags = [
      `<meta property="article:published_time" content="${esc(articleMeta.published)}" />`,
      `<meta property="article:modified_time" content="${esc(articleMeta.modified)}" />`,
      `<meta property="article:author" content="${esc(articleMeta.authorUrl)}" />`,
      `<meta property="article:section" content="${esc(articleMeta.section)}" />`,
      ...(articleMeta.tags || []).map((t) => `<meta property="article:tag" content="${esc(t)}" />`),
    ].join('\n    ');
    html = html.replace('</head>', () => `    ${tags}\n  </head>`);
  }

  // Preload LCP hero/featured image if specified
  if (preloadImage) {
    let p900 = preloadImage;
    let srcset = '';
    if (preloadImage.startsWith('/images/articles/') && preloadImage.endsWith('.webp')) {
      const base = preloadImage.slice(0, -5);
      p900 = `${base}-900w.webp`;
      srcset = `${base}-600w.webp 600w, ${base}-900w.webp 900w, ${preloadImage} 1200w`;
    }
    const srcsetAttr = srcset ? ` imagesrcset="${esc(srcset)}" imagesizes="(max-width: 640px) 100vw, 896px"` : '';
    html = html.replace('</head>', () => `    <link rel="preload" as="image" href="${esc(p900)}"${srcsetAttr} fetchpriority="high">\n  </head>`);
  }

  // Structured data: replace the template's schema, and add ONE BreadcrumbList (JSON-LD) when the page has crumbs.
  let ld = jsonLd;
  if (crumbs && crumbs.length) {
    const bc = breadcrumbLd(crumbs, url);
    if (!ld) ld = { '@context': 'https://schema.org', '@graph': [orgNode, websiteNode, bc] };
    else if (Array.isArray(ld['@graph'])) {
      if (!ld['@graph'].some((n) => n['@type'] === 'BreadcrumbList')) ld = { ...ld, '@graph': [...ld['@graph'], bc] };
    } else {
      const { '@context': ctxVal, ...node } = ld;
      ld = { '@context': ctxVal || 'https://schema.org', '@graph': [node, bc] };
    }
  }
  if (ld) {
    const jsonLdScript = `<script type="application/ld+json">\n    ${safeJson(ld)}\n    </script>`;
    if (/<script\s+type=["']application\/ld\+json["']>[\s\S]*?<\/script>/i.test(html)) {
      set(/<script\s+type=["']application\/ld\+json["']>[\s\S]*?<\/script>/i, jsonLdScript);
    } else {
      html = html.replace('</head>', () => `    ${jsonLdScript}\n  </head>`);
    }
  }

  // Inject content inside <div id="root">
  const fullBody = `${renderHeader()}<main id="main-content" class="min-h-[70vh]">${contentHtml}</main>${renderFooter()}`;
  html = html.replace('<div id="root"></div>', () => `<div id="root">${fullBody}</div>`);

  return html;
}

const writePage = (relPath, html) => {
  const full = path.join(dist, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, html);
};

// ----------------------------------------------------------------------------
// 1. Homepage (/)
// ----------------------------------------------------------------------------
// Same selection as the client (src/views/HomeView.tsx): featured tools first, max 5.
const featuredHome = tools.filter((t) => t.isFeatured).slice(0, 5);
const homeTools = featuredHome.length ? featuredHome : tools.slice(0, 5);
const homeContent = `
<section class="relative pt-8 pb-14 px-4 sm:px-6 lg:px-8 max-w-5xl mx-auto text-center">
  <div class="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full text-xs font-semibold bg-blue-50 border border-blue-200 text-blue-600 dark:bg-blue-950/60 dark:border-blue-500/30 dark:text-blue-400 mb-6 shadow-sm">
    <span class="w-2 h-2 rounded-full bg-blue-500 animate-ping inline-block"></span>
    <span>Your AI Journey Starts Here</span>
  </div>
  <h1 class="text-4xl sm:text-5xl md:text-6xl font-extrabold tracking-tight text-slate-900 dark:text-white leading-[1.15] mb-5">
    Discover the Best <br class="hidden sm:inline" />
    <span class="text-transparent bg-clip-text bg-gradient-to-r from-blue-600 via-sky-500 to-blue-500 dark:from-blue-400 dark:via-sky-400 dark:to-blue-600">AI Tools</span> &amp; Resources
  </h1>
  <p class="max-w-2xl mx-auto text-base sm:text-lg text-slate-600 dark:text-slate-300 leading-relaxed mb-8">
    AINOVEX brings you the latest AI tools, helpful guides, tech news and insights — all in one place. Boost your productivity, creativity and work smarter with curated artificial intelligence software.
  </p>
  <div class="flex flex-wrap items-center justify-center gap-2 text-xs sm:text-sm text-slate-600 dark:text-slate-300 mb-8">
    <span class="font-semibold text-amber-500 dark:text-amber-400">Trending:</span>
    <a href="/category/ai-writing/" class="px-3 py-1 rounded-full text-xs font-medium bg-slate-100 hover:bg-blue-50 border border-slate-200 text-slate-700 hover:text-blue-600 dark:bg-slate-800 dark:border-slate-700/60 dark:text-slate-300 dark:hover:text-blue-400">ChatGPT</a>
    <a href="/category/image-generation/" class="px-3 py-1 rounded-full text-xs font-medium bg-slate-100 hover:bg-blue-50 border border-slate-200 text-slate-700 hover:text-blue-600 dark:bg-slate-800 dark:border-slate-700/60 dark:text-slate-300 dark:hover:text-blue-400">AI Image Generator</a>
    <a href="/category/video-audio/" class="px-3 py-1 rounded-full text-xs font-medium bg-slate-100 hover:bg-blue-50 border border-slate-200 text-slate-700 hover:text-blue-600 dark:bg-slate-800 dark:border-slate-700/60 dark:text-slate-300 dark:hover:text-blue-400">Video Editing</a>
    <a href="/category/productivity/" class="px-3 py-1 rounded-full text-xs font-medium bg-slate-100 hover:bg-blue-50 border border-slate-200 text-slate-700 hover:text-blue-600 dark:bg-slate-800 dark:border-slate-700/60 dark:text-slate-300 dark:hover:text-blue-400">Productivity</a>
  </div>
</section>

<section class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-10">
  <div class="flex items-center justify-between mb-6">
    <h2 class="text-xl sm:text-2xl font-bold text-slate-900 dark:text-white tracking-tight">Browse by Category</h2>
    <a href="/categories/" class="text-xs sm:text-sm font-semibold text-blue-600 dark:text-blue-400 hover:underline">View All Categories &rarr;</a>
  </div>
  <div class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-3.5 sm:gap-4">
    ${categories.map(c => `
    <a href="/category/${c.slug}/" class="flex flex-col items-center justify-center p-4 sm:p-5 rounded-2xl bg-white border border-slate-200 hover:border-blue-500 shadow-sm dark:bg-slate-900/60 dark:border-slate-800 text-center block">
      <span class="text-sm font-bold text-slate-800 dark:text-slate-200 line-clamp-1">${esc(c.name)}</span>
    </a>`).join('')}
  </div>
</section>

<section class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-10">
  <div class="flex flex-col sm:flex-row sm:items-end justify-between gap-3 mb-8">
    <div>
      <h2 class="text-xl sm:text-2xl font-bold text-slate-900 dark:text-white tracking-tight">Featured AI Tools</h2>
      <p class="text-xs sm:text-sm text-slate-600 dark:text-slate-400 mt-1">Handpicked top AI tools to help you work faster, create better and achieve more.</p>
    </div>
    <a href="/tools/" class="text-xs sm:text-sm font-semibold text-blue-600 dark:text-blue-400 hover:underline">View All Tools &rarr;</a>
  </div>
  <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
    ${homeTools.map(t => `
    <div class="p-6 rounded-2xl bg-white border border-slate-200 dark:bg-slate-900/70 dark:border-slate-800 text-center flex flex-col justify-between">
      <div>
        <div class="w-12 h-12 mx-auto mb-3 rounded-xl overflow-hidden bg-slate-50 dark:bg-slate-800/80 p-1 border border-slate-200/60 dark:border-slate-700/60 flex items-center justify-center">
          <img src="${esc(t.icon)}" alt="${esc(t.name)} Logo" class="w-full h-full object-contain" />
        </div>
        <h3 class="text-lg font-bold text-slate-900 dark:text-white mb-1">${esc(t.name)}</h3>
        <p class="text-xs sm:text-sm text-slate-600 dark:text-slate-400 line-clamp-2 mb-4">${esc(t.description)}</p>
      </div>
      <a href="${esc(t.url)}" target="_blank" rel="nofollow noopener noreferrer" class="w-full py-2 px-4 rounded-xl text-xs font-semibold text-white bg-slate-900 hover:bg-blue-600 dark:bg-slate-800 transition-colors inline-block">Visit Tool &rarr;</a>
    </div>`).join('')}
  </div>
</section>

<section class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
  <div class="flex flex-col sm:flex-row sm:items-end justify-between gap-3 mb-8">
    <div>
      <h2 class="text-xl sm:text-2xl font-bold text-slate-900 dark:text-white tracking-tight">Latest Blog &amp; News</h2>
      <p class="text-xs sm:text-sm text-slate-600 dark:text-slate-400 mt-1">Stay updated with the latest AI news, tips, tutorials and industry trends.</p>
    </div>
    <a href="/blog/" class="text-xs sm:text-sm font-semibold text-blue-600 dark:text-blue-400 hover:underline">View All Articles &rarr;</a>
  </div>
  <div class="grid grid-cols-1 md:grid-cols-3 gap-6">
    ${articles.slice(0, 3).map(a => `
    <a href="/blog/${a.slug}/" class="rounded-2xl bg-white border border-slate-200 overflow-hidden dark:bg-slate-900/60 dark:border-slate-800 block shadow-sm hover:border-blue-500 transition-all">
      <img src="${esc(a.featuredImage)}" alt="${esc(a.imageAlt || a.title)}" loading="lazy" decoding="async" class="w-full aspect-[16/10] object-cover" />
      <div class="p-5">
        <span class="text-xs font-bold uppercase text-blue-600 dark:text-blue-400">${esc(a.categoryName || a.category)}</span>
        <h3 class="text-base font-bold text-slate-900 dark:text-white mt-1 mb-2 line-clamp-2">${esc(a.title)}</h3>
        <p class="text-xs text-slate-600 dark:text-slate-400 line-clamp-2">${esc(a.excerpt)}</p>
      </div>
    </a>`).join('')}
  </div>
</section>`;

const homeHtml = createPageHtml({
  title: 'AINOVEX - AI Tools & Technology Platform',
  description: 'Discover the best AI tools, software reviews, and guides on AINOVEX. Boost productivity and work smarter with curated artificial intelligence.',
  path: '/',
  contentHtml: homeContent,
  jsonLd: {
    '@context': 'https://schema.org',
    '@graph': [orgNode, websiteNode],
  },
});
writePage('index.html', homeHtml);

// ----------------------------------------------------------------------------
// 2. Tools Directory (/tools/)
// ----------------------------------------------------------------------------
const toolsContent = `
<div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
  ${renderBreadcrumb([{ label: 'AI Tools Directory' }])}
  <div class="py-6 text-center max-w-3xl mx-auto">
    <h1 class="text-3xl sm:text-4xl font-extrabold text-slate-900 dark:text-white tracking-tight mb-3">
      Explore All AI Tools &amp; Software
    </h1>
    <p class="text-sm sm:text-base text-slate-600 dark:text-slate-300 leading-relaxed">
      Browse and compare top artificial intelligence tools for writing, image creation, video, coding, and productivity. Find the best software for your daily needs with transparent ratings and pricing models.
    </p>
  </div>
  <div class="flex flex-wrap items-center justify-center gap-2 mb-8">
    <a href="/tools/" class="px-3 py-1 rounded-full text-xs font-semibold bg-blue-600 text-white">All Tools (${tools.length})</a>
    ${categories.map(c => `<a href="/category/${c.slug}/" class="px-3 py-1 rounded-full text-xs font-medium bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 text-slate-700 dark:text-slate-300">${esc(c.name)}</a>`).join('')}
  </div>
  <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
    ${tools.map(t => `
    <div class="p-6 rounded-2xl bg-white dark:bg-slate-900/70 border border-slate-200 dark:border-slate-800 text-center flex flex-col justify-between">
      <div>
        <div class="w-12 h-12 mx-auto mb-3 rounded-xl overflow-hidden bg-slate-50 dark:bg-slate-800/80 p-1 border border-slate-200/60 dark:border-slate-700/60 flex items-center justify-center">
          <img src="${esc(t.icon)}" alt="${esc(t.name)} Logo" class="w-full h-full object-contain" />
        </div>
        <div class="text-xs text-amber-500 font-semibold mb-1">&#9733; ${t.rating || 4.8} &bull; ${esc(t.pricing)}</div>
        <h2 class="text-lg font-bold text-slate-900 dark:text-white mb-2">${esc(t.name)}</h2>
        <p class="text-xs sm:text-sm text-slate-600 dark:text-slate-400 line-clamp-2 leading-relaxed mb-4">${esc(t.description)}</p>
        <div class="flex flex-wrap items-center justify-center gap-1.5 mb-6">
          ${(t.tags || []).map(tag => `<span class="px-2.5 py-0.5 rounded-full text-[11px] bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300">${esc(tag)}</span>`).join('')}
        </div>
      </div>
      <a href="${esc(t.url)}" target="_blank" rel="nofollow noopener noreferrer" class="w-full py-2.5 px-4 rounded-xl text-xs font-semibold text-white bg-slate-900 hover:bg-blue-600 dark:bg-slate-800 transition-colors inline-block">Visit Tool &rarr;</a>
    </div>`).join('')}
  </div>
</div>`;

const toolsPageHtml = createPageHtml({
  title: 'Best AI Tools Directory & Software Reviews 2026 | AINOVEX',
  description: 'Browse and compare the top artificial intelligence tools for writing, image creation, video, coding, and productivity. Find the best software for your needs.',
  path: '/tools/',
  contentHtml: toolsContent,
  jsonLd: {
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name: 'AI Tools Directory',
    url: `${baseUrl}/tools/`,
    description: 'Browse and compare the top artificial intelligence tools for writing, image creation, video, coding, and productivity.',
  },
});
writePage('tools/index.html', toolsPageHtml);

// ----------------------------------------------------------------------------
// 3. Blog Archive (/blog/)
// ----------------------------------------------------------------------------
const blogContent = `
<div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
  ${renderBreadcrumb([{ label: 'Blog & Articles' }])}
  <div class="py-6 text-center max-w-3xl mx-auto">
    <h1 class="text-3xl sm:text-4xl font-extrabold text-slate-900 dark:text-white tracking-tight mb-3">
      AI Articles, Tutorials &amp; Reviews
    </h1>
    <p class="text-sm sm:text-base text-slate-600 dark:text-slate-300 leading-relaxed">
      Explore actionable AI tutorials, practical workflows, tool comparisons, and tech guides from the AINOVEX editorial team. Master modern AI applications today.
    </p>
  </div>
  <div class="flex flex-wrap items-center justify-center gap-2 mb-8">
    <a href="/blog/" class="px-3 py-1 rounded-full text-xs font-semibold bg-blue-600 text-white">All Guides (${articles.length})</a>
    ${categories.map(c => `<a href="/category/${c.slug}/" class="px-3 py-1 rounded-full text-xs font-medium bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 text-slate-700 dark:text-slate-300">${esc(c.name)}</a>`).join('')}
  </div>
  <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
    ${articles.map(a => `
    <a href="/blog/${a.slug}/" class="rounded-2xl bg-white dark:bg-slate-900/60 border border-slate-200 dark:border-slate-800 overflow-hidden shadow-sm hover:border-blue-500 transition-all block">
      <img src="${esc(a.featuredImage)}" alt="${esc(a.imageAlt || a.title)}" loading="lazy" decoding="async" class="w-full aspect-[16/10] object-cover" />
      <div class="p-5">
        <span class="text-xs font-bold uppercase text-blue-600 dark:text-blue-400">${esc(a.categoryName || a.category)}</span>
        <h2 class="text-lg font-bold text-slate-900 dark:text-white mt-1 mb-2 leading-snug">${esc(a.title)}</h2>
        <p class="text-xs sm:text-sm text-slate-600 dark:text-slate-400 line-clamp-2 leading-relaxed mb-4">${esc(a.excerpt)}</p>
        <span class="text-xs font-semibold text-blue-600 dark:text-blue-400">Read Guide &rarr;</span>
      </div>
    </a>`).join('')}
  </div>
</div>`;

const blogPageHtml = createPageHtml({
  title: 'AI Insights, Tutorials & Technology Guides | AINOVEX',
  description: 'Explore actionable AI tutorials, practical workflows, tool comparisons, and tech guides from the AINOVEX editorial team. Master modern AI applications today.',
  path: '/blog/',
  contentHtml: blogContent,
  jsonLd: {
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name: 'AI Insights, Tutorials & Technology Guides',
    url: `${baseUrl}/blog/`,
    description: 'Explore actionable AI tutorials, practical workflows, tool comparisons, and tech guides from the AINOVEX editorial team.',
  },
});
writePage('blog/index.html', blogPageHtml);

// ----------------------------------------------------------------------------
// 4. Categories Directory (/categories/)
// ----------------------------------------------------------------------------
const categoriesContent = `
<div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
  ${renderBreadcrumb([{ label: 'Categories' }])}
  <div class="py-6 text-center max-w-3xl mx-auto mb-8">
    <h1 class="text-3xl sm:text-4xl font-extrabold text-slate-900 dark:text-white tracking-tight mb-3">
      Explore AI Topics &amp; Categories
    </h1>
    <p class="text-sm sm:text-base text-slate-600 dark:text-slate-300 leading-relaxed">
      Explore specialized AI software categories from writing and image generation to coding and productivity. Find the right tools for your specific workflow.
    </p>
  </div>
  <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
    ${categories.map(c => `
    <a href="/category/${c.slug}/" class="p-6 rounded-2xl bg-white dark:bg-slate-900/60 border border-slate-200 dark:border-slate-800 hover:border-blue-500 shadow-sm transition-all block">
      <h2 class="text-xl font-bold text-slate-900 dark:text-white mb-2">${esc(c.name)}</h2>
      <p class="text-xs sm:text-sm text-slate-600 dark:text-slate-400 leading-relaxed mb-4">${esc(c.description)}</p>
      <span class="text-xs font-semibold text-blue-600 dark:text-blue-400">Browse ${esc(c.name)} &rarr;</span>
    </a>`).join('')}
  </div>
</div>`;

const categoriesPageHtml = createPageHtml({
  title: 'Browse AI Categories & Topics | AINOVEX',
  description: 'Explore specialized AI software categories from writing and image generation to coding and productivity. Find the right tools for your specific workflow.',
  path: '/categories/',
  contentHtml: categoriesContent,
  jsonLd: {
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name: 'Browse AI Categories',
    url: `${baseUrl}/categories/`,
    description: 'Explore specialized AI software categories from writing and image generation to coding and productivity.',
  },
});
writePage('categories/index.html', categoriesPageHtml);

// ----------------------------------------------------------------------------
// 5. Individual Article Pages (/blog/[slug]/)
// ----------------------------------------------------------------------------
for (const a of articles) {
  const mdFile = path.resolve(root, a.contentPath || `content/articles/${a.slug}.md`);
  let mdRaw = '';
  if (fs.existsSync(mdFile)) {
    mdRaw = fs.readFileSync(mdFile, 'utf-8');
  }
  const bodyHtml = renderMarkdown(mdRaw);

  const related = articles
    .filter(x => x.slug !== a.slug)
    .sort((x, y) => Number(y.category === a.category) - Number(x.category === a.category))
    .slice(0, 2);
  const imgSize = getImageSize(a.featuredImage);
  const authorSlug = (a.author || 'md-shamim').toLowerCase().replace(/[^a-z0-9]+/g, '-');

  const articleContent = `
<article class="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
  ${renderBreadcrumb([
    { label: 'Blog', path: '/blog/' },
    { label: a.categoryName || a.category, path: `/category/${a.category}/` },
    { label: a.title },
  ])}
  <div class="py-6 border-b border-slate-200 dark:border-slate-800/80 mb-8">
    <a href="/category/${a.category}/" class="inline-block px-3 py-1 rounded-full text-xs font-bold uppercase tracking-wider bg-blue-50 text-blue-600 border border-blue-200 dark:bg-blue-600/20 dark:text-blue-400 dark:border-blue-500/30 mb-4 hover:bg-blue-100 transition-colors">
      ${esc(a.categoryName || a.category)}
    </a>
    <h1 class="text-3xl sm:text-4xl md:text-5xl font-extrabold text-slate-900 dark:text-white tracking-tight leading-tight mb-4">
      ${esc(a.title)}
    </h1>
    <p class="text-base sm:text-lg text-slate-600 dark:text-slate-300 leading-relaxed mb-6">
      ${esc(a.excerpt)}
    </p>
    <div class="flex flex-wrap items-center gap-3 sm:gap-4 text-xs text-slate-500 dark:text-slate-400">
      <a href="/author/${authorSlug}/" class="font-semibold text-slate-800 dark:text-slate-200 hover:text-blue-600 dark:hover:text-blue-400 transition-colors">By ${esc(a.author || 'Md Shamim')}</a>
      <span>&bull;</span>
      <span>Published: <time datetime="${esc(a.publishedAt)}">${esc(a.publishedAt)}</time></span>
      ${a.updatedAt ? `<span>&bull;</span><span class="text-emerald-600 dark:text-emerald-400 font-medium">Last updated: <time datetime="${esc(a.updatedAt)}">${esc(a.updatedAt)}</time></span>` : ''}
      <span>&bull;</span>
      <span>${esc(a.readingTime || '9 min read')}</span>
    </div>
  </div>
  ${a.featuredImage ? `<div class="relative w-full aspect-[16/9] rounded-2xl overflow-hidden mb-8 shadow-lg border border-slate-200 dark:border-slate-800/80" style="aspect-ratio: 16/9; min-height: 200px;"><img src="${esc(a.featuredImage)}" srcset="${esc(getArticleSrcSet(a.featuredImage))}" sizes="(max-width: 640px) 100vw, (max-width: 1024px) 90vw, 896px" alt="${esc(a.imageAlt || a.title)}" width="${imgSize ? imgSize.width : 1200}" height="${imgSize ? imgSize.height : 675}" fetchpriority="high" decoding="async" class="w-full h-full object-cover" style="aspect-ratio: 16/9; width: 100%; height: auto;" /></div>` : ''}

  <div id="article-content-body" class="article-content mb-12">
    ${bodyHtml}
  </div>
  ${(a.tags && a.tags.length) ? `
  <div class="py-6 border-t border-b border-slate-200 dark:border-slate-800/80 flex items-center gap-2 flex-wrap mb-10">
    ${a.tags.map(t => `<span class="px-3 py-1 rounded-full text-xs font-medium bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300">#${esc(t)}</span>`).join('')}
  </div>` : ''}
  <div class="p-6 sm:p-7 rounded-3xl bg-white dark:bg-slate-900/60 border border-slate-200 dark:border-slate-800 shadow-sm flex flex-col sm:flex-row items-start gap-4 sm:gap-5 mb-12">
    <a href="/author/${authorSlug}/" class="w-14 h-14 rounded-2xl bg-gradient-to-tr from-blue-600 to-sky-400 flex items-center justify-center font-bold text-white text-lg shrink-0 shadow-md hover:opacity-90 transition-opacity">
      MS
    </a>
    <div class="flex-1">
      <div class="text-xs uppercase font-bold tracking-wider text-blue-600 dark:text-blue-400 mb-1">Author &amp; Lead Researcher</div>
      <h3 class="text-lg font-bold text-slate-900 dark:text-white mb-1">
        <a href="/author/${authorSlug}/" class="hover:text-blue-600 dark:hover:text-blue-400 transition-colors">${esc(a.author || 'Md Shamim')}</a>
      </h3>
      <p class="text-xs sm:text-sm text-slate-600 dark:text-slate-400 leading-relaxed mb-3">
        Lead researcher and editor at AINOVEX. Conducts research, software evaluations, and technical guides published across the platform.
      </p>
      <div class="flex flex-wrap items-center gap-4 text-xs font-semibold text-blue-600 dark:text-blue-400">
        <a href="/author/${authorSlug}/" class="hover:underline flex items-center gap-1">
          <span>View Editorial Profile &amp; Guides</span>
          <span>&rarr;</span>
        </a>
        <span>•</span>
        <a href="/editorial-policy/" class="text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200 hover:underline">Editorial Policy</a>
      </div>
    </div>
  </div>
  ${related.length ? `
  <div class="pt-6 border-t border-slate-200 dark:border-slate-800/80">
    <h3 class="text-xl font-bold text-slate-900 dark:text-white mb-6">Related Guides &amp; Tutorials</h3>
    <div class="grid grid-cols-1 sm:grid-cols-2 gap-6">
      ${related.map(r => `
      <a href="/blog/${r.slug}/" class="p-5 rounded-2xl bg-white dark:bg-slate-900/60 border border-slate-200 dark:border-slate-800 hover:border-blue-500 shadow-sm block">
        <div class="text-xs text-blue-600 dark:text-blue-400 font-semibold mb-2">${esc(r.categoryName || r.category)}</div>
        <h4 class="text-base font-bold text-slate-900 dark:text-white mb-2">${esc(r.title)}</h4>
        <p class="text-xs text-slate-600 dark:text-slate-400 line-clamp-2">${esc(r.excerpt)}</p>
      </a>`).join('')}
    </div>
  </div>` : ''}
</article>`;

  const absArticleUrl = `${baseUrl}/blog/${a.slug}/`;
  const absImageUrl = toAbsoluteUrl(a.ogImage || a.featuredImage);

  const graphNodes = [
    websiteNode,
    orgNode,
    {
      '@type': 'Person',
      '@id': `${baseUrl}/author/${authorSlug}/#person`,
      name: a.author || 'Md Shamim',
      url: `${baseUrl}/author/${authorSlug}/`,
      jobTitle: 'Lead researcher and editor at AINOVEX',
      description: 'Lead researcher and editor at AINOVEX. Focuses on artificial intelligence software analysis, catalog automation benchmarks, and technical workflows.',
      worksFor: {
        '@id': `${baseUrl}/#organization`,
      },
    },
    {
      '@type': 'BlogPosting',
      '@id': `${absArticleUrl}#article`,
      isPartOf: {
        '@id': `${baseUrl}/#website`,
      },
      headline: a.title,
      description: trimDesc(a.metaDescription || a.excerpt),
      image: {
        '@type': 'ImageObject',
        url: absImageUrl,
        ...(getImageSize(a.ogImage || a.featuredImage) || {}),
      },
      datePublished: a.publishedAt,
      dateModified: a.updatedAt || a.publishedAt,
      wordCount: mdRaw.split(/\s+/).filter(Boolean).length,
      mainEntityOfPage: absArticleUrl,
      author: {
        '@id': `${baseUrl}/author/${authorSlug}/#person`,
      },
      publisher: {
        '@id': `${baseUrl}/#organization`,
      },
      inLanguage: 'en-US',
      articleSection: a.categoryName || a.category,
      keywords: a.tags || [],
    },
  ];

  if (a.slug === 'best-ai-tools-bulk-product-catalog-enrichment') {
    graphNodes.push({
      '@type': 'FAQPage',
      '@id': `${absArticleUrl}#faq`,
      mainEntity: [
        {
          '@type': 'Question',
          name: 'What are the best AI tools for bulk product catalog enrichment?',
          acceptedAnswer: {
            '@type': 'Answer',
            text: 'There is no single universal winner. Naper Studio is best suited for batch catalog editing and multichannel product content. Akeneo\'s Extraction module excels at structured attribute extraction for enterprise PIMs. Eligible BigCommerce merchants can use Catalog Enrichment for native storefront copy, while Bulkbase addresses CSV supplier feed transformations.',
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
            text: 'Export an untouched backup of your master catalog before making changes. Run batch enrichment on a small pilot sample (such as under 200 products as recommended in Akeneo\'s documentation), inspect high-impact technical attributes against manufacturer source documents, verify that category fields populate correctly, and retain change logs before publishing mass updates to production.',
          },
        },
      ],
    });
  }

  const articleHtml = createPageHtml({
    title: a.metaTitle || `${a.title} | AINOVEX`,
    description: a.metaDescription || a.excerpt,
    path: `/blog/${a.slug}/`,
    image: a.ogImage || a.featuredImage,
    imageAlt: a.imageAlt || a.title,
    preloadImage: a.featuredImage,
    ogType: 'article',
    articleMeta: {
      published: a.publishedAt,
      modified: a.updatedAt || a.publishedAt,
      authorUrl: `${baseUrl}/author/${authorSlug}/`,
      section: a.categoryName || a.category,
      tags: a.tags || [],
    },
    contentHtml: articleContent,
    jsonLd: {
      '@context': 'https://schema.org',
      '@graph': graphNodes,
    },
  });

  writePage(`blog/${a.slug}/index.html`, articleHtml);
}

// ----------------------------------------------------------------------------
// 6. Category Detail Pages (/category/[slug]/)
// ----------------------------------------------------------------------------
for (const c of categories) {
  const catTools = tools.filter(t => t.category === c.slug);
  const catArticles = articles.filter(a => a.category === c.slug);

  const catContent = `
<div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
  ${renderBreadcrumb([
    { label: 'Categories', path: '/categories/' },
    { label: c.name },
  ])}
  <div class="py-8 border-b border-slate-200 dark:border-slate-800/80 mb-10 text-center max-w-3xl mx-auto">
    <h1 class="text-3xl sm:text-4xl font-extrabold text-slate-900 dark:text-white mb-3">
      ${esc(c.name)}
    </h1>
    <p class="text-sm sm:text-base text-slate-600 dark:text-slate-300 leading-relaxed">
      ${esc(c.description)} Browse handpicked software reviews and tutorials on AINOVEX.
    </p>
  </div>

  <div class="mb-14">
    <h2 class="text-xl font-bold text-slate-900 dark:text-white mb-6">Recommended AI Tools in ${esc(c.name)}</h2>
    ${catTools.length ? `
    <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
      ${catTools.map(t => `
      <div class="p-6 rounded-2xl bg-white dark:bg-slate-900/60 border border-slate-200 dark:border-slate-800 text-center flex flex-col justify-between">
        <div>
          <div class="w-12 h-12 mx-auto mb-3 rounded-xl overflow-hidden bg-slate-50 dark:bg-slate-800/80 p-1 border border-slate-200/60 dark:border-slate-700/60 flex items-center justify-center">
            <img src="${esc(t.icon)}" alt="${esc(t.name)} Logo" class="w-full h-full object-contain" />
          </div>
          <h3 class="text-base font-bold text-slate-900 dark:text-white mb-1">${esc(t.name)}</h3>
          <p class="text-xs text-slate-600 dark:text-slate-400 line-clamp-2 mb-4">${esc(t.description)}</p>
        </div>
        <a href="${esc(t.url)}" target="_blank" rel="nofollow noopener noreferrer" class="w-full py-2 px-3 rounded-xl text-xs font-semibold text-white bg-slate-900 hover:bg-blue-600 dark:bg-slate-800 transition-colors inline-block">Visit Tool &rarr;</a>
      </div>`).join('')}
    </div>` : `<p class="text-sm text-slate-500">More tools are being reviewed for this category.</p>`}
  </div>

  <div>
    <h2 class="text-xl font-bold text-slate-900 dark:text-white mb-6">Guides &amp; Tutorials for ${esc(c.name)}</h2>
    ${catArticles.length ? `
    <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
      ${catArticles.map(a => `
      <a href="/blog/${a.slug}/" class="p-6 rounded-2xl bg-white dark:bg-slate-900/60 border border-slate-200 dark:border-slate-800 hover:border-blue-500 shadow-sm block">
        <h3 class="text-lg font-bold text-slate-900 dark:text-white mb-2">${esc(a.title)}</h3>
        <p class="text-xs sm:text-sm text-slate-600 dark:text-slate-400 line-clamp-2 mb-4">${esc(a.excerpt)}</p>
        <span class="text-xs font-semibold text-blue-600 dark:text-blue-400">Read Guide &rarr;</span>
      </a>`).join('')}
    </div>` : `<p class="text-sm text-slate-500">Our editorial desk is preparing guides for this category.</p>`}
  </div>
</div>`;

  const catDesc = trimDesc(`${c.description} Browse handpicked software reviews and tutorials on AINOVEX.`);

  writePage(`category/${c.slug}/index.html`, createPageHtml({
    title: categoryTitle(c),
    description: catDesc,
    path: `/category/${c.slug}/`,
    contentHtml: catContent,
    jsonLd: {
      '@context': 'https://schema.org',
      '@type': 'CollectionPage',
      name: `${c.name} AI Tools & Guides`,
      url: `${baseUrl}/category/${c.slug}/`,
      description: catDesc,
    },
  }));
}

// ----------------------------------------------------------------------------
// 7. Static Pages: About, Contact, Privacy, Terms, Editorial, Disclaimer
// ----------------------------------------------------------------------------
const aboutContent = `
<div class="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
  ${renderBreadcrumb([{ label: 'About Us' }])}
  <div class="py-6 border-b border-slate-200 dark:border-slate-800 mb-10 text-center">
    <h1 class="text-3xl sm:text-5xl font-extrabold text-slate-900 dark:text-white tracking-tight mb-4">
      Empowering Creators with Artificial Intelligence
    </h1>
    <p class="text-base text-slate-600 dark:text-slate-300 max-w-2xl mx-auto leading-relaxed">
      Learn about AINOVEX, our mission to simplify artificial intelligence, our rigorous testing standards, and our independent editorial review methodology.
    </p>
  </div>
  <div class="space-y-8 text-slate-700 dark:text-slate-300 leading-relaxed text-sm sm:text-base">
    <section class="p-6 rounded-2xl bg-white dark:bg-slate-900/60 border border-slate-200 dark:border-slate-800 shadow-sm">
      <h2 class="text-xl font-bold text-slate-900 dark:text-white mb-3">Who We Are</h2>
      <p class="mb-3">
        Led by researcher and editor <strong>Md Shamim</strong>, AINOVEX is an independent digital publication and curated software directory headquartered on the open web. We cater to an audience across the United States, United Kingdom, Canada, and English-speaking technologists worldwide.
      </p>
      <p>
        With thousands of artificial intelligence startups launching monthly, finding tools that truly deliver ROI, protect user privacy, and preserve workflow sanity has become a daunting task. AINOVEX serves as your trusted filter.
      </p>
    </section>
    <section class="grid grid-cols-1 md:grid-cols-3 gap-6">
      <div class="p-5 rounded-2xl bg-white dark:bg-slate-900/50 border border-slate-200 dark:border-slate-800">
        <h3 class="text-base font-bold text-slate-900 dark:text-white mb-2">Hands-on Testing</h3>
        <p class="text-xs sm:text-sm text-slate-600 dark:text-slate-400">Every tool featured in our directory undergoes real testing on real tasks before receiving a recommendation.</p>
      </div>
      <div class="p-5 rounded-2xl bg-white dark:bg-slate-900/50 border border-slate-200 dark:border-slate-800">
        <h3 class="text-base font-bold text-slate-900 dark:text-white mb-2">Editorial Integrity</h3>
        <p class="text-xs sm:text-sm text-slate-600 dark:text-slate-400">Our guides are independent. We do not accept paid placements to inflate reviews or rankings.</p>
      </div>
      <div class="p-5 rounded-2xl bg-white dark:bg-slate-900/50 border border-slate-200 dark:border-slate-800">
        <h3 class="text-base font-bold text-slate-900 dark:text-white mb-2">Practical Workflows</h3>
        <p class="text-xs sm:text-sm text-slate-600 dark:text-slate-400">We focus on actionable recipes, prompt templates, and integrations that deliver tangible time savings.</p>
      </div>
    </section>
  </div>
</div>`;
writePage('about/index.html', createPageHtml({
  title: 'About Us & Editorial Standards | AINOVEX',
  description: 'Learn about AINOVEX, our mission to simplify artificial intelligence, our testing standards, and our independent editorial review methodology.',
  path: '/about/',
  contentHtml: aboutContent,
}));

const contactContent = `
<div class="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
  ${renderBreadcrumb([{ label: 'Contact Us' }])}
  <div class="py-6 border-b border-slate-200 dark:border-slate-800 mb-8 text-center">
    <h1 class="text-3xl sm:text-4xl font-extrabold text-slate-900 dark:text-white tracking-tight mb-2">
      Contact the Editorial Team
    </h1>
    <p class="text-sm text-slate-600 dark:text-slate-300">
      Contact the AINOVEX editorial team for software recommendations, directory submissions, editorial corrections, or media and partnership inquiries.
    </p>
  </div>
  <div class="p-6 rounded-2xl bg-white dark:bg-slate-900/60 border border-slate-200 dark:border-slate-800 shadow-sm text-center">
    <p class="text-sm text-slate-600 dark:text-slate-300 mb-2">Send editorial queries, tool submissions, and corrections to the editorial desk by e-mail${settings.contactEmail ? `: <a href="mailto:${esc(settings.contactEmail)}" class="font-semibold text-blue-600 dark:text-blue-400 underline">${esc(settings.contactEmail)}</a>` : ' using the message form on this page'}.</p>
    <p class="text-xs text-slate-500 dark:text-slate-400">We review all incoming inquiries and update documentation as verified.</p>
  </div>
</div>`;
writePage('contact/index.html', createPageHtml({
  title: 'Contact AINOVEX | Editorial & Support Team',
  description: 'Contact the AINOVEX editorial team for software recommendations, directory submissions, editorial corrections, or partnership inquiries.',
  path: '/contact/',
  contentHtml: contactContent,
}));

// ----------------------------------------------------------------------------
// Author Profile Page (/author/md-shamim/)
// ----------------------------------------------------------------------------
const authorArticlesList = articles
  .filter(a => a.author === 'Md Shamim' || !a.author)
  .sort((x, y) => String(y.updatedAt || y.publishedAt).localeCompare(String(x.updatedAt || x.publishedAt)));
const authorContent = `
<div class="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
  ${renderBreadcrumb([
    { label: 'Authors', path: '/about/' },
    { label: 'Md Shamim' },
  ])}

  <div class="bg-white dark:bg-slate-900/70 border border-slate-200 dark:border-slate-800 rounded-3xl p-6 sm:p-10 shadow-sm mb-12">
    <div class="flex flex-col sm:flex-row items-start sm:items-center gap-6 mb-8 pb-8 border-b border-slate-200 dark:border-slate-800">
      <div class="w-20 h-20 sm:w-24 sm:h-24 rounded-3xl bg-gradient-to-tr from-blue-600 via-sky-500 to-blue-400 flex items-center justify-center font-extrabold text-white text-2xl sm:text-3xl shrink-0 shadow-lg shadow-blue-500/20">
        MS
      </div>
      <div class="flex-1">
        <div class="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-blue-50 text-blue-600 border border-blue-200 dark:bg-blue-950/60 dark:border-blue-500/30 dark:text-blue-400 mb-2">
          <span>Editorial Profile</span>
        </div>
        <h1 class="text-2xl sm:text-4xl font-extrabold text-slate-900 dark:text-white tracking-tight mb-1">
          Md Shamim
        </h1>
        <p class="text-sm sm:text-base font-medium text-slate-600 dark:text-slate-300">
          Lead researcher and editor at AINOVEX
        </p>
      </div>
    </div>

    <div class="space-y-6 text-sm sm:text-base text-slate-700 dark:text-slate-300 leading-relaxed">
      <div>
        <h2 class="text-lg font-bold text-slate-900 dark:text-white mb-2">Editorial Role</h2>
        <p class="mb-3">
          Md Shamim is the lead researcher and editor at <strong>AINOVEX</strong>. He conducts research, software evaluations, and technical guides published across the platform.
        </p>
        <p>
          His editorial work focuses on analyzing publicly available software documentation, vendor specifications, and user documentation to produce clear, structured comparisons for readers.
        </p>
      </div>

      <div class="border-t border-slate-200 dark:border-slate-800 pt-6">
        <h3 class="text-base font-bold text-slate-900 dark:text-white mb-2">
          Editorial Standards
        </h3>
        <p class="text-xs sm:text-sm text-slate-600 dark:text-slate-400 leading-relaxed mb-3">
          Md Shamim adheres to the <a href="/editorial-policy/" class="text-blue-600 dark:text-blue-400 underline font-semibold">AINOVEX Editorial Policy</a>. Articles are compiled through independent technical research and official vendor documentation review.
        </p>
        <p class="text-xs text-slate-500 dark:text-slate-400">
          For questions, feedback, or editorial corrections, please visit our <a href="/contact/" class="text-blue-600 dark:text-blue-400 underline font-medium">Contact page</a>.
        </p>
      </div>
    </div>
  </div>

  <section>
    <div class="flex items-center justify-between mb-6">
      <h2 class="text-xl sm:text-2xl font-bold text-slate-900 dark:text-white tracking-tight">
        Articles &amp; Guides by Md Shamim (${authorArticlesList.length})
      </h2>
      <span class="text-xs text-slate-500 dark:text-slate-400">Sorted by most recent update</span>
    </div>

    <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
      ${authorArticlesList.map(a => `
      <a href="/blog/${a.slug}/" class="group bg-white dark:bg-slate-900/60 border border-slate-200 dark:border-slate-800 rounded-2xl overflow-hidden shadow-sm hover:border-blue-500/50 hover:shadow-md transition-all flex flex-col justify-between block">
        <div>
          <div class="relative aspect-[16/10] overflow-hidden bg-slate-100 dark:bg-slate-800">
            <img src="${esc(a.featuredImage)}" alt="${esc(a.imageAlt || a.title)}" class="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300" loading="lazy" />
            <span class="absolute top-3 left-3 px-2.5 py-1 rounded-full text-[11px] font-bold uppercase tracking-wider bg-slate-900/80 text-white backdrop-blur-sm">
              ${esc(a.categoryName || a.category)}
            </span>
          </div>
          <div class="p-5">
            <div class="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400 mb-2">
              <span>Published: ${esc(a.publishedAt)}</span>
              ${a.updatedAt && a.updatedAt !== a.publishedAt ? `<span>&bull;</span><span class="text-emerald-600 dark:text-emerald-400 font-medium">Updated: ${esc(a.updatedAt)}</span>` : ''}
            </div>
            <h3 class="text-base font-bold text-slate-900 dark:text-white group-hover:text-blue-600 dark:group-hover:text-blue-400 transition-colors line-clamp-2 mb-2 leading-snug">
              ${esc(a.title)}
            </h3>
            <p class="text-xs sm:text-sm text-slate-600 dark:text-slate-400 line-clamp-2 leading-relaxed">
              ${esc(a.excerpt)}
            </p>
          </div>
        </div>
        <div class="px-5 pb-5 pt-2 flex items-center justify-between border-t border-slate-100 dark:border-slate-800/60 text-xs font-semibold text-blue-600 dark:text-blue-400">
          <span>Read Full Guide &rarr;</span>
        </div>
      </a>`).join('')}
    </div>
  </section>
</div>`;

writePage('author/md-shamim/index.html', createPageHtml({
  title: 'Md Shamim - Lead Researcher & Editor | AINOVEX',
  description: 'Read the editorial profile and guides by Md Shamim, lead researcher and editor at AINOVEX specializing in AI tools and catalog enrichment.',
  path: '/author/md-shamim/',
  contentHtml: authorContent,
  jsonLd: {
    '@context': 'https://schema.org',
    '@graph': [orgNode, {
    '@type': 'ProfilePage',
    mainEntity: {
      '@type': 'Person',
      '@id': `${baseUrl}/author/md-shamim/#person`,
      name: 'Md Shamim',
      url: `${baseUrl}/author/md-shamim/`,
      jobTitle: 'Lead researcher and editor at AINOVEX',
      description: 'Lead researcher and editor at AINOVEX. Focuses on artificial intelligence software analysis, catalog automation benchmarks, and technical workflows.',
      worksFor: {
        '@id': `${baseUrl}/#organization`,
      },
    },
  }],
},
}));

const privacyContent = `
<div class="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
  ${renderBreadcrumb([{ label: 'Privacy Policy' }])}
  <div class="py-6 border-b border-slate-200 dark:border-slate-800 mb-8">
    <h1 class="text-3xl sm:text-4xl font-extrabold text-slate-900 dark:text-white tracking-tight mb-2">Privacy Policy</h1>
    <p class="text-xs text-slate-500">Last updated: October 18, 2026 &bull; Published by AINOVEX Editorial Team</p>
  </div>
  <div class="space-y-6 text-sm text-slate-700 dark:text-slate-300 leading-relaxed">
    <p>Read the official AINOVEX Privacy Policy. Learn how we safeguard your personal information, handle essential cookies, and maintain strict data privacy.</p>
    <h2 class="text-xl font-bold text-slate-900 dark:text-white">1. Information We Collect</h2>
    <p>At AINOVEX, the privacy of our visitors is paramount. We only collect standard web server access logs (IP address, user-agent, timestamp) for security and operational reliability. We do not sell user data.</p>
    <h2 class="text-xl font-bold text-slate-900 dark:text-white">2. Cookies &amp; Local Storage</h2>
    <p>We use local browser storage strictly for functional preferences (such as light or dark theme choices). We do not employ third-party cross-site trackers.</p>
  </div>
</div>`;
writePage('privacy/index.html', createPageHtml({
  title: 'Privacy Policy | AINOVEX AI Platform',
  description: 'Read the official AINOVEX Privacy Policy. Learn how we safeguard your personal information, handle essential cookies, and maintain data privacy.',
  path: '/privacy/',
  contentHtml: privacyContent,
}));

const termsContent = `
<div class="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
  ${renderBreadcrumb([{ label: 'Terms of Service' }])}
  <div class="py-6 border-b border-slate-200 dark:border-slate-800 mb-8">
    <h1 class="text-3xl sm:text-4xl font-extrabold text-slate-900 dark:text-white tracking-tight mb-2">Terms of Service</h1>
    <p class="text-xs text-slate-500">Last updated: October 18, 2026 &bull; Published by AINOVEX Editorial Team</p>
  </div>
  <div class="space-y-6 text-sm text-slate-700 dark:text-slate-300 leading-relaxed">
    <p>Review the AINOVEX Terms of Service. Understand the rules, guidelines, disclaimers, and legal agreements governing the use of our website and directory.</p>
    <h2 class="text-xl font-bold text-slate-900 dark:text-white">1. Acceptance of Terms</h2>
    <p>By accessing AINOVEX, you agree to comply with these terms, applicable laws, and regulations. All material is provided for informational and educational purposes.</p>
  </div>
</div>`;
writePage('terms/index.html', createPageHtml({
  title: 'Terms of Service | AINOVEX Platform',
  description: 'Review the AINOVEX Terms of Service. Understand the rules, guidelines, disclaimers, and legal agreements governing the use of our website.',
  path: '/terms/',
  contentHtml: termsContent,
}));

const editorialContent = `
<div class="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
  ${renderBreadcrumb([{ label: 'Editorial Policy' }])}
  <div class="py-6 border-b border-slate-200 dark:border-slate-800 mb-8">
    <h1 class="text-3xl sm:text-4xl font-extrabold text-slate-900 dark:text-white tracking-tight mb-2">Editorial Policy &amp; Review Standards</h1>
    <p class="text-xs text-slate-500">Last updated: October 18, 2026 &bull; Published by AINOVEX Editorial Team</p>
  </div>
  <div class="space-y-6 text-sm text-slate-700 dark:text-slate-300 leading-relaxed">
    <p>Explore AINOVEX strict editorial policy, review guidelines, testing benchmarks, and independence standards for recommending artificial intelligence tools.</p>
    <h2 class="text-xl font-bold text-slate-900 dark:text-white">1. Independence Commitment</h2>
    <p>All reviews are written following independent evaluation. Tool developers cannot pay for higher star ratings or biased coverage.</p>
  </div>
</div>`;
writePage('editorial-policy/index.html', createPageHtml({
  title: 'Editorial Policy & Review Standards | AINOVEX',
  description: 'Explore AINOVEX editorial policy, review guidelines, testing benchmarks, and independence standards for recommending artificial intelligence tools.',
  path: '/editorial-policy/',
  contentHtml: editorialContent,
}));

const affiliateContent = `
<div class="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
  ${renderBreadcrumb([{ label: 'Affiliate Disclosure' }])}
  <div class="py-6 border-b border-slate-200 dark:border-slate-800 mb-8">
    <h1 class="text-3xl sm:text-4xl font-extrabold text-slate-900 dark:text-white tracking-tight mb-2">Affiliate &amp; Monetization Disclosure</h1>
    <p class="text-xs text-slate-500">Last updated: October 18, 2026 &bull; Published by AINOVEX Editorial Team</p>
  </div>
  <div class="space-y-6 text-sm text-slate-700 dark:text-slate-300 leading-relaxed">
    <p>Read the AINOVEX affiliate and advertising disclosure. Learn how our site remains free for readers through transparent monetization and editorial integrity.</p>
    <h2 class="text-xl font-bold text-slate-900 dark:text-white">1. How We Fund Our Research</h2>
    <p>Certain links on AINOVEX may be affiliate links. If you click through and purchase a subscription, we may earn a small referral commission at no additional cost to you.</p>
  </div>
</div>`;
writePage('affiliate-disclosure/index.html', createPageHtml({
  title: 'Affiliate & Monetization Disclosure | AINOVEX',
  description: 'Read the AINOVEX affiliate and advertising disclosure. Learn how our site remains free for readers through transparent monetization and integrity.',
  path: '/affiliate-disclosure/',
  contentHtml: affiliateContent,
}));

// ----------------------------------------------------------------------------
// 8. 404 Error Page
// ----------------------------------------------------------------------------
const notFoundContent = `
<div class="max-w-3xl mx-auto px-4 py-24 text-center">
  <span class="inline-block px-3 py-1 rounded-full text-xs font-bold bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400 mb-4">404 Error</span>
  <h1 class="text-4xl sm:text-5xl font-extrabold text-slate-900 dark:text-white mb-4">Page Not Found</h1>
  <p class="text-sm sm:text-base text-slate-600 dark:text-slate-300 max-w-md mx-auto mb-8">
    The page you requested could not be located. Explore our curated AI tools directory or read the latest guides.
  </p>
  <div class="flex flex-wrap items-center justify-center gap-3">
    <a href="/" class="px-6 py-2.5 rounded-full bg-blue-600 text-white font-semibold text-sm hover:bg-blue-500">Return to Homepage</a>
    <a href="/tools/" class="px-6 py-2.5 rounded-full bg-slate-200 dark:bg-slate-800 text-slate-800 dark:text-slate-200 font-semibold text-sm">Explore AI Tools</a>
    <a href="/blog/" class="px-6 py-2.5 rounded-full bg-slate-200 dark:bg-slate-800 text-slate-800 dark:text-slate-200 font-semibold text-sm">Read Blog</a>
  </div>
</div>`;
const notFoundHtml = createPageHtml({
  title: 'Page Not Found (404) | AINOVEX',
  description: 'The page you requested could not be found. Explore top AI tools, software reviews, and guides on AINOVEX.',
  path: '/404/',
  contentHtml: notFoundContent,
  notFound: true,
});
writePage('404.html', notFoundHtml);

console.log(`[postbuild] Pre-rendered all 22+ static HTML routes with rich semantic markup, headings, links, and schema!`);
console.log(`[postbuild] ${articles.length} articles, ${categories.length} categories, ${tools.length} tools exported.`);
