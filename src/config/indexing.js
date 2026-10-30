// SINGLE SOURCE OF TRUTH for indexing + category titles.
// Imported by BOTH the browser app (src/App.tsx) and the build script (scripts/postbuild.mjs),
// so the pre-rendered HTML, the client-side <meta> tags and sitemap.xml can never drift apart.
//
// To change what search engines may index, edit ONLY this file.

/** Pages that are always indexable (normalised path: no trailing slash). */
export const INDEXABLE_STATIC_PATHS = new Set([
  '/',
  '/blog',
  '/tools',
  '/categories',
  '/about',
  '/contact',
  '/author/md-shamim',
  '/editorial-policy',
]);

/** Remove ?query, #hash and trailing slashes. "/" stays "/". */
export function normalizePath(p) {
  const clean = String(p || '/').split(/[?#]/)[0].replace(/\/+$/, '');
  return clean === '' ? '/' : clean;
}

/** A category is only worth indexing once it has at least one published article. */
export function categoryHasContent(slug, articles) {
  return articles.some((a) => a.isPublished !== false && a.category === slug);
}

/**
 * Should this URL be `index, follow` (true) or `noindex, follow` (false)?
 * Legal pages (privacy, terms, affiliate-disclosure), empty categories, unknown URLs and 404 => noindex.
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
    return categories.some((c) => c.slug === slug) && categoryHasContent(slug, articles);
  }
  return false;
}

/** "AI Writing" -> "AI Writing Tools & Guides (2026) | AINOVEX" (no duplicated "AI AI"). */
export function categoryTitle(category) {
  return `${category.name} Tools & Practical Guides 2026 | AINOVEX`;
}
