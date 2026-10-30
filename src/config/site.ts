import settings from '../../content/settings.json';

/**
 * Centralized site configuration.
 * Single source of truth is `content/settings.json` (`productionUrl`).
 * When moving to a custom domain in the future, only update `productionUrl`
 * in `content/settings.json`.
 */
export const SITE_URL: string = (settings.productionUrl || 'https://ai-novex.netlify.app').replace(/\/+$/, '');
export const SITE_NAME: string = settings.siteTitle || 'AINOVEX';
export const SITE_TAGLINE: string = settings.siteTagline || 'Discover the Best AI Tools & Resources';
export const SITE_DESCRIPTION: string = settings.siteDescription || '';
export const AUTHOR_NAME: string = settings.authorName || 'Md Shamim';
export const DEFAULT_OG_IMAGE: string = settings.defaultOgImage || '';

/**
 * Helper to construct an absolute URL given a relative path.
 * Ensures leading slash and strips duplicate slashes.
 */
export const getAbsoluteUrl = (path: string = '/'): string => {
  const normalized = path.startsWith('/') ? path : `/${path}`;
  return `${SITE_URL}${normalized}`;
};

export default {
  SITE_URL,
  SITE_NAME,
  SITE_TAGLINE,
  SITE_DESCRIPTION,
  AUTHOR_NAME,
  DEFAULT_OG_IMAGE,
  getAbsoluteUrl,
};
