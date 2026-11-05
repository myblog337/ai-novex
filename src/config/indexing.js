// SINGLE SOURCE OF TRUTH for indexing + category titles.
// Imported by BOTH the browser app (src/App.tsx) and the build script (scripts/postbuild.mjs),
// so pre-rendered HTML, client-side meta tags and sitemap.xml can never drift apart.
//
// To change what search engines may index, edit ONLY this file.

/** Pages that are indexable (normalised path: no trailing slash). */
export const INDEXABLE_STATIC_PATHS = new Set([
  '/',
  '/blog',
  '/tools',
  '/categories',
  '/privacy',
  '/terms',
  '/affiliate-disclosure',
]);

/** Remove ?query, #hash and trailing slashes. "/" stays "/". */
export function normalizePath(p) {
  const clean = String(p || '/').split(/[?#]/)[0].replace(/\/+$/, '');
  return clean === '' ? '/' : clean;
}

/** Whether a category route exists on the site. */
export function categoryHasContent(slug, categories) {
  return categories.some((c) => c.slug === slug);
}

/**
 * Should this URL be `index, follow` (true) or `noindex, follow` (false)?
 * About, contact, author, editorial-policy, unknown URLs and 404 are intentionally noindex.
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
    return categoryHasContent(slug, categories);
  }
  return false;
}

/** "AI Writing" -> "AI Writing Tools & Guides (2026) | AINOVEX" (no duplicated "AI AI"). */
export function categoryTitle(category) {
  return `${category.name} Tools & Practical Guides 2026 | AINOVEX`;
}
