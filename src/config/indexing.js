// SINGLE SOURCE OF TRUTH for indexing + category titles.
// Imported by BOTH the browser app (src/App.tsx) and the build script (scripts/postbuild.mjs),
// so pre-rendered HTML, client-side meta tags and sitemap.xml can never drift apart.
//
// To change what search engines may index, edit ONLY this file.

import { authorHasContent } from '../utils/authors.js';
import { findPublishedCustomPageBySlug } from '../utils/customPages.js';

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

/** Strict tool slug validator (lowercase alphanumeric + single hyphens, 2-60 chars). */
export function isValidToolSlug(slug) {
  if (typeof slug !== 'string') return false;
  if (slug.length < 2 || slug.length > 60) return false;
  return /^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug);
}

/** Whether a tool record is structurally valid and published for public routes. */
export function isPublishedTool(tool) {
  if (!tool || typeof tool !== 'object' || Array.isArray(tool)) return false;
  if (!isValidToolSlug(tool.slug)) return false;
  if (typeof tool.name !== 'string' || !tool.name.trim()) return false;
  if (Object.prototype.hasOwnProperty.call(tool, 'isPublished') && tool.isPublished !== undefined) {
    return tool.isPublished === true;
  }
  return true;
}

/** Resolve a published tool by its validated slug. */
export function findPublishedToolBySlug(slug, tools = []) {
  if (!isValidToolSlug(slug) || !Array.isArray(tools)) return null;
  return tools.find((t) => isPublishedTool(t) && t.slug === slug) || null;
}

/**
 * Should this URL be `index, follow` (true) or `noindex, follow` (false)?
 * Legal pages (privacy, terms, affiliate), unknown URLs and 404 are intentionally noindex.
 */
export function isIndexable(path, { articles = [], categories = [], tools = [], pages = [] } = {}) {
  const p = normalizePath(path);
  if (INDEXABLE_STATIC_PATHS.has(p)) return true;
  if (p.startsWith('/blog/')) {
    const slug = p.slice('/blog/'.length);
    return articles.some((a) => a.slug === slug && a.isPublished !== false);
  }
  if (p.startsWith('/tools/')) {
    const slug = p.slice('/tools/'.length);
    return Boolean(findPublishedToolBySlug(slug, tools));
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
  if (p.startsWith('/') && p.length > 1 && !p.slice(1).includes('/')) {
    const slug = p.slice(1);
    return Boolean(findPublishedCustomPageBySlug(slug, pages));
  }
  return false;
}

/** "AI Writing" -> "AI Writing Tools & Guides (2026) | AINOVEX" (no duplicated "AI AI"). */
export function categoryTitle(category) {
  return `${category.name} Tools & Practical Guides 2026 | AINOVEX`;
}
