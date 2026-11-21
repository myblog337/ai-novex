// SINGLE SOURCE OF TRUTH for indexing + category titles.
// Imported by BOTH the browser app (src/App.tsx) and the build script (scripts/postbuild.mjs),
// so pre-rendered HTML, client-side meta tags and sitemap.xml can never drift apart.
//
// To change what search engines may index, edit ONLY this file.

import { authorHasContent } from '../utils/authors.js';

export const INDEXABLE_STATIC_PATHS = new Set([
  '/',
  '/blog',
  '/tools',
  '/categories',
  '/about',
  '/contact',
  '/editorial-policy',
]);

/** Remove ?query, #hash and trailing slashes. "/" stays "/". */
export function normalizePath(p) {
  const clean = String(p || '/').split(/[?#]/)[0].replace(/\/+$/, '');
  return clean === '' ? '/' : clean;
}

/** Whether a category route exists on the site and has at least one published article. */
export function categoryHasContent(slug, categories = [], articles = []) {
  const categoryExists = categories.some((c) => c.slug === slug);
  if (!categoryExists) return false;

  return articles.some(
    (a) => a.category === slug && a.isPublished !== false
  );
}

/**
 * Should this URL be `index, follow` (true) or `noindex, follow` (false)?
 * Legal pages (privacy, terms, affiliate), unknown URLs and 404 are intentionally noindex.
 */
export function isIndexable(path, { articles = [], categories = [] } = {}) {
  const p = normalizePath(path);
  if (INDEXABLE_STATIC_PATHS.has(p)) return true;
  if (p.startsWith('/blog/')) {
    const slug = p.slice('/blog/'.length);
    return articles.some((a) => a.slug === slug && a.isPublished !== false);
  }
  if (p.startsWith('/category/')) {
    const slug = p.slice('/category/'.length);
    return categoryHasContent(slug, categories, articles);
  }
  if (p.startsWith('/author/')) {
    const slug = p.slice('/author/'.length);
    if (!slug || slug.includes('/')) return false;
    return authorHasContent(slug, articles);
  }
  return false;
}

/** "AI Writing" -> "AI Writing Tools & Guides (2026) | AINOVEX" (no duplicated "AI AI"). */
export function categoryTitle(category) {
  return `${category.name} Tools & Practical Guides 2026 | AINOVEX`;
}
