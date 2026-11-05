import fs from 'node:fs';
import path from 'node:path';
import { INDEXABLE_STATIC_PATHS, isIndexable } from '../src/config/indexing.js';

const root = process.cwd();
const dist = path.join(root, 'dist');
const readJson = (file) => JSON.parse(fs.readFileSync(path.join(root, 'content', file), 'utf-8'));

if (!fs.existsSync(dist)) {
  console.error('[sitemap] dist/ not found — run `npm run build` first.');
  process.exit(1);
}

const settings = readJson('settings.json');
const articles = readJson('articles.json').filter((article) => article.isPublished);
const categories = readJson('categories.json');
const context = { articles, categories };
const baseUrl = settings.productionUrl.replace(/\/+$/, '');
const entries = new Map();
const dateOf = (article) => article.updatedAt || article.publishedAt;
const newest = (items) => items.map(dateOf).filter(Boolean).sort().pop();
const toLoc = (route) => `${baseUrl}${route === '/' ? '/' : `${route.replace(/\/+$/, '')}/`}`;

// Include every generated static page that is indexable by the shared robots policy.
for (const route of INDEXABLE_STATIC_PATHS) {
  if (isIndexable(route, context)) {
    const lastmod = ['/', '/blog'].includes(route) ? newest(articles) : undefined;
    entries.set(toLoc(route), lastmod);
  }
}

// Include every published article and every generated category route, even if a category is empty.
for (const article of articles) {
  const route = `/blog/${article.slug}/`;
  if (isIndexable(route, context)) entries.set(toLoc(route), dateOf(article));
}
for (const category of categories) {
  const route = `/category/${category.slug}/`;
  if (isIndexable(route, context)) {
    entries.set(toLoc(route), newest(articles.filter((article) => article.category === category.slug)));
  }
}

const escapeXml = (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
let sitemap = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n';
for (const [loc, lastmod] of entries) {
  sitemap += `  <url>\n    <loc>${escapeXml(loc)}</loc>\n${lastmod ? `    <lastmod>${escapeXml(lastmod)}</lastmod>\n` : ''}  </url>\n`;
}
sitemap += '</urlset>\n';
fs.writeFileSync(path.join(dist, 'sitemap.xml'), sitemap);
console.log(`[sitemap] Wrote ${entries.size} indexable URLs; excluded noindex pages.`);
