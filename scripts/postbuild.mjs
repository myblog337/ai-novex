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
import { fileURLToPath } from 'node:url';
import { renderMarkdown } from '../src/utils/markdown.js';
import {
  INDEXABLE_STATIC_PATHS,
  isIndexable,
  categoryHasContent,
  categoryTitle,
  isPublishedTool,
  isValidToolSlug,
} from '../src/config/indexing.js';
import { LEGAL_TITLES, LEGAL_BREADCRUMBS, formatLegalDate, getLegalContent } from '../src/config/legal.js';
import {
  isValidArticleSlug,
  isValidHttpOriginUrl,
  validatePages,
  isValidCustomPageSlug,
  isReservedPageSlug,
} from './lib/validators.mjs';
import { isInsideAuthorizedDirectory } from './lib/storage.mjs';
import { collectAuthors, getArticleAuthorProfile, DEFAULT_EDITORIAL_TEAM_NAME } from '../src/utils/authors.js';
import {
  ALLOWED_OG_TYPES,
  ALLOWED_TWITTER_CARDS,
  DEFAULT_SEO_TITLE,
  DEFAULT_SITE_NAME,
  escapeJsonLd,
  isSafeAssetOrUrl,
  isSafeHttpUrl,
  isSafeStructuredData,
  isValidSeoPathFormat,
  normalizeRoutePath,
  resolvePageSeo,
} from '../src/utils/pageSeo.js';

const CONTROL_CHAR_REGEX = /[\u0000-\u001F\u007F-\u009F]/g;
const TWITTER_HANDLE_REGEX = /^@[a-zA-Z0-9_]{1,30}$/;
const ARTICLE_META_PROPERTIES = new Set([
  'article:published_time',
  'article:modified_time',
  'article:author',
  'article:section',
  'article:tag',
]);

const esc = (v) =>
  String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

function cleanMetaText(value, maxLen = 500) {
  if (typeof value !== 'string') return '';
  const cleaned = value.replace(CONTROL_CHAR_REGEX, ' ').replace(/\s+/g, ' ').trim();
  if (!cleaned) return '';
  return cleaned.length > maxLen ? cleaned.slice(0, maxLen) : cleaned;
}

function getSafeHttpUrlOrEmpty(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return isSafeHttpUrl(trimmed) ? trimmed : '';
}

function inferImageMimeType(urlStr) {
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

/**
 * Safely reads width/height of a local JPEG/PNG/WebP/GIF image inside <projectRoot>/public.
 * Rejects symlinks, directory escapes, non-regular files, and corrupted/truncated headers.
 */
export function readSafeImageSize(imgPath, projectRoot = process.cwd()) {
  if (!imgPath || typeof imgPath !== 'string' || /^https?:/i.test(imgPath)) return null;
  if (!isSafeAssetOrUrl(imgPath) || !imgPath.startsWith('/')) return null;
  const cleanAssetPath = imgPath.split(/[?#]/)[0];
  if (!cleanAssetPath || cleanAssetPath.includes('\0') || cleanAssetPath.includes('\\')) return null;

  try {
    const publicDir = path.resolve(projectRoot, 'public');
    let publicLstat;
    try {
      publicLstat = fs.lstatSync(publicDir);
    } catch {
      return null;
    }
    if (publicLstat.isSymbolicLink() || !publicLstat.isDirectory()) {
      return null;
    }
    const canonicalPublicDir = fs.realpathSync(publicDir);

    const relSegments = cleanAssetPath.slice(1).split('/').filter(Boolean);
    if (relSegments.length === 0) return null;

    let currentPath = canonicalPublicDir;
    for (let i = 0; i < relSegments.length; i++) {
      const seg = relSegments[i];
      if (seg === '.' || seg === '..') return null;
      currentPath = path.resolve(currentPath, seg);
      if (!isInsideAuthorizedDirectory(canonicalPublicDir, currentPath)) {
        return null;
      }
      const st = fs.lstatSync(currentPath);
      if (st.isSymbolicLink()) {
        return null;
      }
      if (i < relSegments.length - 1) {
        if (!st.isDirectory()) return null;
      } else {
        if (!st.isFile()) return null;
      }
    }

    const realCandidate = fs.realpathSync(currentPath);
    if (!isInsideAuthorizedDirectory(canonicalPublicDir, realCandidate)) {
      return null;
    }

    const fileStat = fs.statSync(realCandidate);
    if (!fileStat.isFile() || fileStat.size <= 0 || fileStat.size > 20 * 1024 * 1024) {
      return null;
    }

    const buf = fs.readFileSync(realCandidate);
    let size = null;

    // WebP (RIFF....WEBP)
    if (
      buf.length >= 25 &&
      buf.toString('ascii', 0, 4) === 'RIFF' &&
      buf.toString('ascii', 8, 12) === 'WEBP'
    ) {
      const kind = buf.toString('ascii', 12, 16);
      if (kind === 'VP8X' && buf.length >= 30) {
        size = { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
      } else if (
        kind === 'VP8 ' &&
        buf.length >= 30 &&
        buf[23] === 0x9d &&
        buf[24] === 0x01 &&
        buf[25] === 0x2a
      ) {
        size = { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
      } else if (kind === 'VP8L' && buf.length >= 25 && buf[20] === 0x2f) {
        const b = buf.readUInt32LE(21);
        size = { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
      }
    } else if (
      // PNG
      buf.length >= 24 &&
      buf[0] === 0x89 &&
      buf[1] === 0x50 &&
      buf[2] === 0x4e &&
      buf[3] === 0x47 &&
      buf[4] === 0x0d &&
      buf[5] === 0x0a &&
      buf[6] === 0x1a &&
      buf[7] === 0x0a &&
      buf.toString('ascii', 12, 16) === 'IHDR'
    ) {
      size = { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    } else if (
      // GIF87a / GIF89a
      buf.length >= 10 &&
      (buf.toString('ascii', 0, 6) === 'GIF87a' || buf.toString('ascii', 0, 6) === 'GIF89a')
    ) {
      size = { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    } else if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
      // JPEG SOF marker scan
      let pos = 2;
      while (pos + 1 < buf.length) {
        if (buf[pos] !== 0xff) {
          size = null;
          break;
        }
        while (pos < buf.length && buf[pos] === 0xff) {
          pos++;
        }
        if (pos >= buf.length) break;
        const marker = buf[pos++];
        if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
          continue;
        }
        if (marker === 0xd9 || marker === 0xda) {
          break;
        }
        if (pos + 1 >= buf.length) break;
        const segLen = buf.readUInt16BE(pos);
        if (segLen < 2 || pos + segLen > buf.length) break;
        if (
          (marker >= 0xc0 && marker <= 0xc3) ||
          (marker >= 0xc5 && marker <= 0xc7) ||
          (marker >= 0xc9 && marker <= 0xcb) ||
          (marker >= 0xcd && marker <= 0xcf)
        ) {
          if (segLen < 7 || pos + 7 > buf.length) break;
          size = {
            height: buf.readUInt16BE(pos + 3),
            width: buf.readUInt16BE(pos + 5),
          };
          break;
        }
        pos += segLen;
      }
    }

    if (
      size &&
      Number.isSafeInteger(size.width) &&
      Number.isSafeInteger(size.height) &&
      size.width > 0 &&
      size.height > 0 &&
      size.width <= 65535 &&
      size.height <= 65535
    ) {
      return size;
    }
    return null;
  } catch {
    return null;
  }
}

function getTagAttr(attrsStr, attrName) {
  const re = new RegExp(`(?:^|\\s)${attrName}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>` + '`' + `]+))`, 'i');
  const m = attrsStr.match(re);
  if (!m) return null;
  return (m[1] ?? m[2] ?? m[3] ?? '').trim();
}

function removeSpanCleanly(str, start, end) {
  let lineStart = start;
  while (lineStart > 0 && (str[lineStart - 1] === ' ' || str[lineStart - 1] === '\t')) {
    lineStart--;
  }
  const isAtLineStart = lineStart === 0 || str[lineStart - 1] === '\n';
  let lineEnd = end;
  while (lineEnd < str.length && (str[lineEnd] === ' ' || str[lineEnd] === '\t')) {
    lineEnd++;
  }
  if (isAtLineStart && lineEnd < str.length && (str[lineEnd] === '\n' || str.slice(lineEnd, lineEnd + 2) === '\r\n')) {
    const nlLen = str[lineEnd] === '\r' ? 2 : 1;
    return { removeStart: lineStart, removeEnd: lineEnd + nlLen };
  }
  return { removeStart: start, removeEnd: end };
}

function findMetaInsertionPoint(headInner) {
  const tokenRegex = /<(script|style)\b[^>]*>[\s\S]*?<\/\1>|<(meta|link)\b[^>]*>/gi;
  let firstScriptOrStyleStart = -1;
  let lastMetaOrLinkEnd = -1;
  let m;
  while ((m = tokenRegex.exec(headInner)) !== null) {
    if (m[1]) {
      if (firstScriptOrStyleStart === -1) {
        firstScriptOrStyleStart = m.index;
      }
      break;
    }
    if (m[2]) {
      lastMetaOrLinkEnd = m.index + m[0].length;
    }
  }
  return { lastMetaOrLinkEnd, firstScriptOrStyleStart };
}

function insertHeadTags(headInner, tags) {
  const list = tags.filter(Boolean);
  if (list.length === 0) return headInner;
  const block = list.join('\n    ');
  const { lastMetaOrLinkEnd, firstScriptOrStyleStart } = findMetaInsertionPoint(headInner);
  if (lastMetaOrLinkEnd !== -1) {
    return `${headInner.slice(0, lastMetaOrLinkEnd)}\n    ${block}${headInner.slice(lastMetaOrLinkEnd)}`;
  }
  if (firstScriptOrStyleStart !== -1) {
    return `${headInner.slice(0, firstScriptOrStyleStart)}${block}\n    ${headInner.slice(firstScriptOrStyleStart)}`;
  }
  return `${headInner}\n    ${block}\n  `;
}

function upsertHeadTitle(headInner, titleText) {
  const titleTag = `<title>${esc(titleText)}</title>`;
  const tokenRegex = /<(script|style)\b[^>]*>[\s\S]*?<\/\1>|<title\b[^>]*>[\s\S]*?<\/title>/gi;
  const matches = [];
  let m;
  while ((m = tokenRegex.exec(headInner)) !== null) {
    if (!m[1]) {
      matches.push({ start: m.index, end: m.index + m[0].length });
    }
  }
  if (matches.length === 0) {
    const viewportMatch = headInner.match(/<meta\b[^>]*\bname\s*=\s*["']viewport["'][^>]*>/i);
    if (viewportMatch) {
      const insertAt = viewportMatch.index + viewportMatch[0].length;
      return `${headInner.slice(0, insertAt)}\n    ${titleTag}${headInner.slice(insertAt)}`;
    }
    return `\n    ${titleTag}${headInner}`;
  }
  let out = headInner;
  for (let i = matches.length - 1; i >= 0; i--) {
    const { start, end } = matches[i];
    if (i === 0) {
      out = `${out.slice(0, start)}${titleTag}${out.slice(end)}`;
    } else {
      const { removeStart, removeEnd } = removeSpanCleanly(out, start, end);
      out = `${out.slice(0, removeStart)}${out.slice(removeEnd)}`;
    }
  }
  return out;
}

function upsertHeadTag(headInner, tagKind, matchFn, newTagHtml) {
  const tokenRegex = /<(script|style)\b[^>]*>[\s\S]*?<\/\1>|<(meta|link)\b([^>]*)>/gi;
  const matches = [];
  let m;
  while ((m = tokenRegex.exec(headInner)) !== null) {
    if (m[1]) continue;
    const foundKind = m[2].toLowerCase();
    if (foundKind === tagKind && matchFn(m[3])) {
      matches.push({ start: m.index, end: m.index + m[0].length });
    }
  }
  if (matches.length === 0) {
    return newTagHtml ? insertHeadTags(headInner, [newTagHtml]) : headInner;
  }
  let out = headInner;
  for (let i = matches.length - 1; i >= 0; i--) {
    const { start, end } = matches[i];
    if (i === 0 && newTagHtml) {
      out = `${out.slice(0, start)}${newTagHtml}${out.slice(end)}`;
    } else {
      const { removeStart, removeEnd } = removeSpanCleanly(out, start, end);
      out = `${out.slice(0, removeStart)}${out.slice(removeEnd)}`;
    }
  }
  return out;
}

function removeHeadTags(headInner, tagKind, matchFn) {
  return upsertHeadTag(headInner, tagKind, matchFn, '');
}

const matchMetaAttr = (attr, key) => (attrsStr) => {
  const val = getTagAttr(attrsStr, attr);
  return val !== null && val.toLowerCase() === key.toLowerCase();
};

const matchCanonicalLink = (attrsStr) => {
  const rel = getTagAttr(attrsStr, 'rel');
  return rel !== null && rel.toLowerCase().split(/\s+/).includes('canonical');
};

const matchImagePreloadLink = (attrsStr) => {
  const rel = getTagAttr(attrsStr, 'rel');
  const asVal = getTagAttr(attrsStr, 'as');
  return (
    rel !== null &&
    rel.toLowerCase().split(/\s+/).includes('preload') &&
    asVal !== null &&
    asVal.toLowerCase() === 'image'
  );
};

function syncHeadJsonLdScript(headInner, jsonLd) {
  const scriptRegex = /<script\b([^>]*)>[\s\S]*?<\/script>/gi;
  const matches = [];
  let m;
  while ((m = scriptRegex.exec(headInner)) !== null) {
    const typeVal = getTagAttr(m[1], 'type');
    if (typeVal !== null && typeVal.toLowerCase() === 'application/ld+json') {
      matches.push({ start: m.index, end: m.index + m[0].length });
    }
  }

  const isValidLd =
    Boolean(jsonLd) &&
    typeof jsonLd === 'object' &&
    !Array.isArray(jsonLd) &&
    isSafeStructuredData(jsonLd, 10, 65536);

  let serialized = '';
  if (isValidLd) {
    try {
      serialized = escapeJsonLd(jsonLd);
    } catch {
      serialized = '';
    }
  }

  if (!serialized) {
    if (matches.length === 0) return headInner;
    let out = headInner;
    for (let i = matches.length - 1; i >= 0; i--) {
      const { removeStart, removeEnd } = removeSpanCleanly(out, matches[i].start, matches[i].end);
      out = `${out.slice(0, removeStart)}${out.slice(removeEnd)}`;
    }
    return out;
  }

  const scriptTag = `<script type="application/ld+json">\n    ${serialized}\n    </script>`;
  if (matches.length === 0) {
    const trimmedRight = headInner.replace(/[ \t]+$/, '');
    const sep = trimmedRight.endsWith('\n') ? '' : '\n';
    return `${trimmedRight}${sep}    ${scriptTag}\n  `;
  }

  let out = headInner;
  for (let i = matches.length - 1; i >= 0; i--) {
    const { start, end } = matches[i];
    if (i === 0) {
      out = `${out.slice(0, start)}${scriptTag}${out.slice(end)}`;
    } else {
      const { removeStart, removeEnd } = removeSpanCleanly(out, start, end);
      out = `${out.slice(0, removeStart)}${out.slice(removeEnd)}`;
    }
  }
  return out;
}

export function applyResolvedSeoToHtml(html, resolved, { preloadImage = null, getImageSizeFn = null } = {}) {
  if (typeof html !== 'string' || !resolved || typeof resolved !== 'object') {
    return html;
  }

  const headOpenMatch = html.match(/<head\b[^>]*>/i);
  const headCloseIdx = html.search(/<\/head>/i);
  if (!headOpenMatch || headCloseIdx === -1) {
    return html;
  }
  const headStart = headOpenMatch.index + headOpenMatch[0].length;
  if (headCloseIdx < headStart) {
    return html;
  }

  let headInner = html.slice(headStart, headCloseIdx);

  const title = cleanMetaText(resolved.title, 200) || DEFAULT_SEO_TITLE;
  const description = cleanMetaText(resolved.description, 320);
  const siteName = cleanMetaText(resolved.siteName, 100) || DEFAULT_SITE_NAME;
  const isNotFound = Boolean(resolved.notFound);

  const fallbackRobots = isNotFound
    ? `noindex, ${resolved.nofollow ? 'nofollow' : 'follow'}`
    : resolved.noindex
      ? `noindex, ${resolved.nofollow ? 'nofollow' : 'follow'}`
      : `index, ${resolved.nofollow ? 'nofollow' : 'follow'}, max-image-preview:large, max-snippet:-1, max-video-preview:-1`;
  const robots = cleanMetaText(resolved.robotsContent, 160) || fallbackRobots;

  const canonicalUrl = isNotFound ? '' : getSafeHttpUrlOrEmpty(resolved.canonicalUrl);
  const ogUrl = isNotFound ? '' : getSafeHttpUrlOrEmpty(resolved.ogUrl);
  const ogType = ALLOWED_OG_TYPES.has(resolved.ogType) ? resolved.ogType : 'website';
  const ogTitle = cleanMetaText(resolved.ogTitle, 200) || title;
  const ogDescription = cleanMetaText(resolved.ogDescription, 320) || description;
  const ogImage = getSafeHttpUrlOrEmpty(resolved.ogImage);
  const ogImageAlt = ogImage ? cleanMetaText(resolved.ogImageAlt, 300) : '';
  const ogImageType = ogImage ? inferImageMimeType(ogImage) : '';

  let ogSize = null;
  if (ogImage && typeof getImageSizeFn === 'function') {
    let localAssetPath = '';
    if (
      typeof resolved.ogImageRaw === 'string' &&
      resolved.ogImageRaw.startsWith('/') &&
      isSafeAssetOrUrl(resolved.ogImageRaw)
    ) {
      localAssetPath = resolved.ogImageRaw;
    } else if (typeof resolved.baseUrl === 'string' && resolved.baseUrl) {
      try {
        const parsedImg = new URL(ogImage);
        const parsedBase = new URL(resolved.baseUrl);
        if (parsedImg.origin === parsedBase.origin) {
          localAssetPath = parsedImg.pathname;
        }
      } catch {
        localAssetPath = '';
      }
    }
    if (localAssetPath) {
      ogSize = getImageSizeFn(localAssetPath);
    }
  }

  const twitterCard = ALLOWED_TWITTER_CARDS.has(resolved.twitterCard)
    ? resolved.twitterCard
    : 'summary_large_image';
  const twitterTitle = cleanMetaText(resolved.twitterTitle, 200) || ogTitle;
  const twitterDescription = cleanMetaText(resolved.twitterDescription, 320) || ogDescription;
  const twitterImage = getSafeHttpUrlOrEmpty(resolved.twitterImage);
  const twitterImageAlt = twitterImage ? cleanMetaText(resolved.twitterImageAlt, 300) : '';
  const rawTwitterSite = cleanMetaText(resolved.twitterSite, 40);
  const twitterSite = TWITTER_HANDLE_REGEX.test(rawTwitterSite) ? rawTwitterSite : '';

  headInner = upsertHeadTitle(headInner, title);

  headInner = upsertHeadTag(
    headInner,
    'meta',
    matchMetaAttr('name', 'description'),
    description ? `<meta name="description" content="${esc(description)}" />` : ''
  );
  headInner = upsertHeadTag(
    headInner,
    'meta',
    matchMetaAttr('name', 'robots'),
    `<meta name="robots" content="${esc(robots)}" />`
  );
  headInner = upsertHeadTag(
    headInner,
    'link',
    matchCanonicalLink,
    canonicalUrl ? `<link rel="canonical" href="${esc(canonicalUrl)}" />` : ''
  );

  // Open Graph metadata
  headInner = upsertHeadTag(
    headInner,
    'meta',
    matchMetaAttr('property', 'og:site_name'),
    siteName ? `<meta property="og:site_name" content="${esc(siteName)}" />` : ''
  );
  headInner = upsertHeadTag(
    headInner,
    'meta',
    matchMetaAttr('property', 'og:title'),
    ogTitle ? `<meta property="og:title" content="${esc(ogTitle)}" />` : ''
  );
  headInner = upsertHeadTag(
    headInner,
    'meta',
    matchMetaAttr('property', 'og:description'),
    ogDescription ? `<meta property="og:description" content="${esc(ogDescription)}" />` : ''
  );
  headInner = upsertHeadTag(
    headInner,
    'meta',
    matchMetaAttr('property', 'og:type'),
    `<meta property="og:type" content="${esc(ogType)}" />`
  );
  headInner = upsertHeadTag(
    headInner,
    'meta',
    matchMetaAttr('property', 'og:url'),
    ogUrl ? `<meta property="og:url" content="${esc(ogUrl)}" />` : ''
  );
  headInner = upsertHeadTag(
    headInner,
    'meta',
    matchMetaAttr('property', 'og:image'),
    ogImage ? `<meta property="og:image" content="${esc(ogImage)}" />` : ''
  );
  headInner = upsertHeadTag(
    headInner,
    'meta',
    matchMetaAttr('property', 'og:image:width'),
    ogImage && ogSize && Number.isSafeInteger(ogSize.width) && ogSize.width > 0
      ? `<meta property="og:image:width" content="${ogSize.width}" />`
      : ''
  );
  headInner = upsertHeadTag(
    headInner,
    'meta',
    matchMetaAttr('property', 'og:image:height'),
    ogImage && ogSize && Number.isSafeInteger(ogSize.height) && ogSize.height > 0
      ? `<meta property="og:image:height" content="${ogSize.height}" />`
      : ''
  );
  headInner = upsertHeadTag(
    headInner,
    'meta',
    matchMetaAttr('property', 'og:image:type'),
    ogImage && ogImageType ? `<meta property="og:image:type" content="${esc(ogImageType)}" />` : ''
  );
  headInner = upsertHeadTag(
    headInner,
    'meta',
    matchMetaAttr('property', 'og:image:alt'),
    ogImage && ogImageAlt ? `<meta property="og:image:alt" content="${esc(ogImageAlt)}" />` : ''
  );

  // Twitter metadata
  headInner = upsertHeadTag(
    headInner,
    'meta',
    matchMetaAttr('name', 'twitter:card'),
    `<meta name="twitter:card" content="${esc(twitterCard)}" />`
  );
  headInner = upsertHeadTag(
    headInner,
    'meta',
    matchMetaAttr('name', 'twitter:title'),
    twitterTitle ? `<meta name="twitter:title" content="${esc(twitterTitle)}" />` : ''
  );
  headInner = upsertHeadTag(
    headInner,
    'meta',
    matchMetaAttr('name', 'twitter:description'),
    twitterDescription ? `<meta name="twitter:description" content="${esc(twitterDescription)}" />` : ''
  );
  headInner = upsertHeadTag(
    headInner,
    'meta',
    matchMetaAttr('name', 'twitter:image'),
    twitterImage ? `<meta name="twitter:image" content="${esc(twitterImage)}" />` : ''
  );
  headInner = upsertHeadTag(
    headInner,
    'meta',
    matchMetaAttr('name', 'twitter:image:alt'),
    twitterImage && twitterImageAlt
      ? `<meta name="twitter:image:alt" content="${esc(twitterImageAlt)}" />`
      : ''
  );
  headInner = upsertHeadTag(
    headInner,
    'meta',
    matchMetaAttr('name', 'twitter:site'),
    twitterSite ? `<meta name="twitter:site" content="${esc(twitterSite)}" />` : ''
  );

  // Article-specific Open Graph tags (always strip stale/duplicate tags first)
  headInner = removeHeadTags(headInner, 'meta', (attrsStr) => {
    const prop = getTagAttr(attrsStr, 'property');
    return prop !== null && ARTICLE_META_PROPERTIES.has(prop.toLowerCase());
  });

  if (!isNotFound && ogType === 'article' && resolved.articleMeta && typeof resolved.articleMeta === 'object') {
    const articleTags = [];
    const published = cleanMetaText(resolved.articleMeta.published, 64);
    const modified = cleanMetaText(resolved.articleMeta.modified, 64);
    const authorUrl = getSafeHttpUrlOrEmpty(resolved.articleMeta.authorUrl);
    const section = cleanMetaText(resolved.articleMeta.section, 120);

    if (published) articleTags.push(`<meta property="article:published_time" content="${esc(published)}" />`);
    if (modified) articleTags.push(`<meta property="article:modified_time" content="${esc(modified)}" />`);
    if (authorUrl) articleTags.push(`<meta property="article:author" content="${esc(authorUrl)}" />`);
    if (section) articleTags.push(`<meta property="article:section" content="${esc(section)}" />`);

    if (Array.isArray(resolved.articleMeta.tags)) {
      const seenTags = new Set();
      for (const rawTag of resolved.articleMeta.tags) {
        const tag = cleanMetaText(rawTag, 100);
        if (!tag || seenTags.has(tag)) continue;
        seenTags.add(tag);
        articleTags.push(`<meta property="article:tag" content="${esc(tag)}" />`);
      }
    }

    if (articleTags.length > 0) {
      headInner = insertHeadTags(headInner, articleTags);
    }
  }

  // Preload LCP hero/featured image if specified (strip existing image preloads first to avoid duplicates)
  headInner = removeHeadTags(headInner, 'link', matchImagePreloadLink);
  if (
    typeof preloadImage === 'string' &&
    preloadImage.trim() &&
    !CONTROL_CHAR_REGEX.test(preloadImage) &&
    !/\s/.test(preloadImage.trim()) &&
    isSafeAssetOrUrl(preloadImage.trim())
  ) {
    const cleanPreload = preloadImage.trim();
    let p900 = cleanPreload;
    let srcset = '';
    if (cleanPreload.startsWith('/images/articles/') && cleanPreload.endsWith('.webp')) {
      const base = cleanPreload.slice(0, -5);
      p900 = `${base}-900w.webp`;
      srcset = `${base}-600w.webp 600w, ${base}-900w.webp 900w, ${cleanPreload} 1200w`;
    }
    const srcsetAttr = srcset ? ` imagesrcset="${esc(srcset)}" imagesizes="(max-width: 640px) 100vw, 896px"` : '';
    headInner = insertHeadTags(headInner, [
      `<link rel="preload" as="image" href="${esc(p900)}"${srcsetAttr} fetchpriority="high" />`,
    ]);
  }

  if ('jsonLd' in resolved) {
    headInner = syncHeadJsonLdScript(headInner, isNotFound ? (resolved.jsonLd ?? null) : resolved.jsonLd);
  }

  return `${html.slice(0, headStart)}${headInner}${html.slice(headCloseIdx)}`;
}

export function renderToolDirectoryCard(t) {
  return `
    <div class="p-6 rounded-2xl bg-white dark:bg-slate-900/70 border border-slate-200 dark:border-slate-800 text-center flex flex-col justify-between">
      <div>
        <div class="w-12 h-12 mx-auto mb-3 rounded-xl overflow-hidden bg-slate-50 dark:bg-slate-800/80 p-1 border border-slate-200/60 dark:border-slate-700/60 flex items-center justify-center">
          <img src="${esc(t.icon)}" alt="${esc(t.name)} Logo" class="w-full h-full object-contain" />
        </div>
        <div class="text-xs text-amber-500 font-semibold mb-1">&#9733; ${t.rating ?? 4.8} &bull; ${esc(t.pricing)}</div>
        <h2 class="text-lg font-bold text-slate-900 dark:text-white mb-2">${esc(t.name)}</h2>
        <p class="text-xs sm:text-sm text-slate-600 dark:text-slate-400 line-clamp-2 leading-relaxed mb-4">${esc(t.description)}</p>
        <div class="flex flex-wrap items-center justify-center gap-1.5 mb-6">
          ${(t.tags || []).map(tag => `<span class="px-2.5 py-0.5 rounded-full text-[11px] bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300">${esc(tag)}</span>`).join('')}
        </div>
      </div>
      <a href="${esc(t.url)}" target="_blank" rel="nofollow noopener noreferrer" class="w-full py-2.5 px-4 rounded-xl text-xs font-semibold text-white bg-slate-900 hover:bg-blue-600 dark:bg-slate-800 transition-colors inline-block">Visit Tool &rarr;</a>
    </div>`;
}

export function runPostbuild() {
const root = process.cwd();
const dist = path.join(root, 'dist');
const contentSrc = path.join(root, 'content');

if (!fs.existsSync(dist)) {
  console.error('dist/ not found — run `vite build` first.');
  process.exit(1);
}

const readJson = (f, { optional = false, fallback } = {}) => {
  const filePath = path.join(contentSrc, f);
  if (!fs.existsSync(filePath)) {
    if (optional) {
      return fallback;
    }
    console.error(`[postbuild] Critical file missing: ${f} (${filePath})`);
    process.exit(1);
  }
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    if (optional) {
      console.warn(`[postbuild] Optional file corrupted or invalid JSON: ${f} — using fallback. Error: ${err.message}`);
      return fallback;
    }
    console.error(`[postbuild] Failed to read or parse critical JSON file: ${f} (${filePath}). Error: ${err.message}`);
    process.exit(1);
  }
};

const settings = readJson('settings.json', { optional: false, fallback: {} });
if (
  typeof settings?.productionUrl !== 'string' ||
  !settings.productionUrl.trim() ||
  !isValidHttpOriginUrl(settings.productionUrl)
) {
  console.error(
    '[postbuild] Invalid or missing productionUrl in content/settings.json: must be a valid HTTP or HTTPS origin URL without a path, query, or fragment (e.g., https://example.com)'
  );
  process.exit(1);
}

const categories = readJson('categories.json', { optional: false, fallback: [] });
const rawTools = readJson('tools.json', { optional: false, fallback: [] });
const tools = Array.isArray(rawTools) ? rawTools.filter(isPublishedTool) : [];
const ads = readJson('ads.json', { optional: true, fallback: {} });
const seoConfig = readJson('seo.json', { optional: true, fallback: null });

const pagesFilePath = path.join(contentSrc, 'pages.json');
let rawPages = [];
if (fs.existsSync(pagesFilePath)) {
  let pagesLstat;
  try {
    pagesLstat = fs.lstatSync(pagesFilePath);
  } catch (err) {
    console.error(`[postbuild] Failed to inspect content/pages.json: ${err.message}`);
    process.exit(1);
  }
  if (pagesLstat.isSymbolicLink() || !pagesLstat.isFile()) {
    console.error('[postbuild] Security check failed: content/pages.json must be a regular file (symlinks forbidden)');
    process.exit(1);
  }
  try {
    rawPages = JSON.parse(fs.readFileSync(pagesFilePath, 'utf-8'));
  } catch (err) {
    console.error(`[postbuild] Failed to parse content/pages.json: ${err.message}`);
    process.exit(1);
  }
  const pagesValidation = validatePages(rawPages);
  if (!pagesValidation.isValid) {
    console.error('[postbuild] Validation failed for content/pages.json:');
    for (const err of pagesValidation.errors) {
      console.error(`  - ${err.field}: ${err.message} (${err.code})`);
    }
    process.exit(1);
  }
}
const customPages = rawPages.filter((p) => p && p.isPublished === true);

const allowedArticlesDir = path.resolve(root, 'content', 'articles');
const canonicalAllowedArticlesDir = fs.existsSync(allowedArticlesDir)
  ? fs.realpathSync(allowedArticlesDir)
  : allowedArticlesDir;

const validateArticleSlug = (slug) => {
  if (typeof slug !== 'string' || !slug.trim()) {
    throw new Error('Article slug is missing or empty');
  }
  if (slug.trim() !== slug) {
    throw new Error('Article slug contains leading or trailing whitespace');
  }
  if (slug.includes('\0')) {
    throw new Error('Article slug contains forbidden null bytes');
  }
  if (slug.includes('/') || slug.includes('\\') || slug.includes('..')) {
    throw new Error('Article slug contains directory separators or path traversal sequences');
  }
  if (slug.toLowerCase().endsWith('.md')) {
    throw new Error('Pass the article slug identifier without the .md extension');
  }
  if (slug.length < 3 || slug.length > 80) {
    throw new Error('Article slug length must be between 3 and 80 characters');
  }
  if (!isValidArticleSlug(slug)) {
    throw new Error(
      'Article slug contains invalid characters or formatting (must be 3-80 lowercase alphanumeric characters with single hyphens, no underscores or consecutive hyphens)'
    );
  }
  return slug;
};

const resolveArticleMarkdownPath = (article) => {
  const slug = article?.slug;
  validateArticleSlug(slug);

  // Reject any stored article record whose contentPath does not exactly equal "content/articles/${slug}.md"
  const expectedContentPath = `content/articles/${slug}.md`;
  if (article?.contentPath !== expectedContentPath) {
    throw new Error(
      `Stored article record contentPath "${article?.contentPath}" does not match server-generated path policy: "${expectedContentPath}"`
    );
  }

  // Always derive the Markdown path exclusively from the validated slug against canonical authorized articles directory
  const expectedFileName = `${slug}.md`;
  const candidatePath = path.resolve(canonicalAllowedArticlesDir, expectedFileName);

  // Enforce boundary containment inside authorized content/articles/ directory
  if (!isInsideAuthorizedDirectory(canonicalAllowedArticlesDir, candidatePath)) {
    throw new Error('Derived article path resolves outside the authorized content/articles/ directory');
  }

  // Ensure file exists
  if (!fs.existsSync(candidatePath)) {
    throw new Error(`Markdown file "${expectedFileName}" does not exist in the authorized content directory`);
  }

  // Symlink check on candidate path
  const lstat = fs.lstatSync(candidatePath);
  if (lstat.isSymbolicLink()) {
    throw new Error('Symlinks are forbidden for article Markdown files');
  }

  // Resolve canonical path to detect and prevent symlink directory escape
  let canonicalTarget;
  try {
    canonicalTarget = fs.realpathSync(candidatePath);
  } catch {
    throw new Error('Failed to resolve canonical path for Markdown file');
  }

  if (!isInsideAuthorizedDirectory(canonicalAllowedArticlesDir, canonicalTarget)) {
    throw new Error('Symlink target escapes authorized content/articles/ directory');
  }

  if (path.extname(canonicalTarget).toLowerCase() !== '.md') {
    throw new Error('Canonical target file must have a .md extension');
  }

  if (path.basename(canonicalTarget) !== expectedFileName) {
    throw new Error('Canonical target filename does not match expected article filename');
  }

  const stat = fs.statSync(canonicalTarget);
  if (!stat.isFile()) {
    throw new Error('Canonical target path is not a regular file');
  }

  return canonicalTarget;
};

const allArticles = readJson('articles.json', { optional: false, fallback: [] });

// Validate all stored article records against unified slug and server-generated contentPath policies
for (const a of allArticles) {
  try {
    validateArticleSlug(a?.slug);
    const expected = `content/articles/${a.slug}.md`;
    if (a?.contentPath !== expected) {
      throw new Error(
        `contentPath "${a?.contentPath}" does not match server-generated path policy: "${expected}"`
      );
    }
  } catch (err) {
    console.error(`[postbuild] Security validation failed for stored article "${a?.slug || 'unknown'}": ${err.message}`);
    process.exit(1);
  }
}

const articles = allArticles.filter((a) => a.isPublished);

if (articles.length === 0) {
  console.error('[postbuild] No published articles found in content/articles.json — aborting build to prevent empty sitemap.');
  process.exit(1);
}
const baseUrl = (settings.productionUrl || 'https://ai-novex.netlify.app').replace(/\/+$/, '');
const defaultOgImage = settings.defaultOgImage || '/images/og-default.png';
const ctx = { articles, categories, tools, pages: customPages };
const indexable = (p) => isIndexable(p, ctx);
const today = new Date().toISOString().slice(0, 10);

// Sitemap.xml: ONLY indexable URLs, canonical trailing-slash form. <lastmod> is emitted only when it
// reflects a real content date (never "today"), because Google ignores sitemaps whose lastmod is always fresh.
const dateOf = (a) => a.updatedAt || a.publishedAt;
const newest = (list) => list.map(dateOf).filter(Boolean).sort().pop();
const authors = collectAuthors(articles);
const sitemapEntries = [];
for (const p of INDEXABLE_STATIC_PATHS) {
  const loc = p === '/' ? '/' : `${p}/`;
  const lastmod = ['/', '/blog'].includes(p) ? newest(articles) : undefined;
  sitemapEntries.push({ loc, lastmod });
}
for (const author of authors) {
  sitemapEntries.push({ loc: `/author/${author.slug}/`, lastmod: newest(author.articles) });
}
for (const a of articles) sitemapEntries.push({ loc: `/blog/${a.slug}/`, lastmod: dateOf(a) });
for (const c of categories) {
  if (!categoryHasContent(c.slug, categories, articles)) continue;
  sitemapEntries.push({ loc: `/category/${c.slug}/`, lastmod: newest(articles.filter((a) => a.category === c.slug)) });
}
for (const t of tools) sitemapEntries.push({ loc: `/tools/${t.slug}/` });
for (const p of customPages) {
  const lastmod = typeof p.updatedAt === 'string' && /^\d{4}-\d{2}-\d{2}/.test(p.updatedAt) ? p.updatedAt.slice(0, 10) : undefined;
  sitemapEntries.push({ loc: `/${p.slug}/`, lastmod });
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

// Breadcrumbs are rendered as plain visible HTML from resolved page SEO. Structured data for
// BreadcrumbList is emitted ONCE inside the resolved JSON-LD @graph (via applyResolvedSeoToHtml).
const renderResolvedBreadcrumb = (resolved) => {
  if (!resolved || resolved.notFound || !resolved.breadcrumbEnabled) return '';
  const crumbs = Array.isArray(resolved.breadcrumbs) ? resolved.breadcrumbs : [];
  if (crumbs.length === 0) return '';

  const itemsHtml = crumbs
    .map((c, i) => {
      const isLast = i === crumbs.length - 1;
      const hasValidPath =
        !isLast && typeof c.path === 'string' && c.path.trim() && isValidSeoPathFormat(c.path);
      const safeHref = hasValidPath ? normalizeRoutePath(c.path) : '';
      return `
    <li class="text-slate-400 dark:text-slate-600" aria-hidden="true">
      <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"></path></svg>
    </li>
    <li${isLast ? ' aria-current="page"' : ''}>
      ${safeHref ? `<a href="${esc(safeHref)}" class="text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white transition-colors cursor-pointer"><span>${esc(c.label)}</span></a>` : `<span class="font-semibold text-slate-800 dark:text-slate-200 truncate max-w-[200px] sm:max-w-md inline-block">${esc(c.label)}</span>`}
    </li>`;
    })
    .join('');

  return `
<nav aria-label="Breadcrumb" class="py-3 text-xs text-slate-500 dark:text-slate-400">
  <ol class="flex items-center flex-wrap gap-1.5">
    <li>
      <a href="/" class="flex items-center gap-1 text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white transition-colors cursor-pointer">
        <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path><polyline points="9 22 9 12 15 12 15 22"></polyline></svg>
        <span>Home</span>
      </a>
    </li>${itemsHtml}
  </ol>
</nav>`;
};

/** Read width/height of a local JPEG/PNG/WebP/GIF in /public safely without extra dependencies (null if unknown). */
const imageSizeCache = new Map();
function getImageSize(imgPath) {
  if (!imgPath || typeof imgPath !== 'string' || /^https?:/i.test(imgPath)) return null;
  if (!isSafeAssetOrUrl(imgPath) || !imgPath.startsWith('/')) return null;
  const cleanAssetPath = imgPath.split(/[?#]/)[0];
  if (imageSizeCache.has(cleanAssetPath)) return imageSizeCache.get(cleanAssetPath);
  const size = readSafeImageSize(cleanAssetPath, root);
  imageSizeCache.set(cleanAssetPath, size);
  return size;
}

const seoSettings = {
  ...settings,
  productionUrl: baseUrl,
};

const resolveStaticRouteSeo = (routePath, { wordCount = null, imageSize = null } = {}) => {
  const targetPath = typeof routePath === 'string' && routePath.trim() ? routePath : '/';
  try {
    return resolvePageSeo({
      path: targetPath,
      seoConfig,
      settings: seoSettings,
      articles,
      categories,
      tools,
      pages: customPages,
      wordCount,
      imageSize,
    });
  } catch (err) {
    console.warn(`[postbuild] SEO resolution failed for "${targetPath}", falling back safely: ${err.message}`);
    try {
      return resolvePageSeo({
        path: targetPath,
        seoConfig: null,
        settings: seoSettings,
        articles,
        categories,
        tools,
        pages: customPages,
        wordCount,
        imageSize,
      });
    } catch {
      return resolvePageSeo({
        path: '/',
        seoConfig: null,
        settings: { productionUrl: baseUrl },
        articles: [],
        categories: [],
        tools: [],
        pages: [],
      });
    }
  }
};

const canonicalDistDir = fs.existsSync(dist) ? fs.realpathSync(dist) : path.resolve(dist);
const overriddenCanonicalFiles = new Set();
const writtenOutputPaths = new Set();

function createPageHtml({ seo, path: pagePath, contentHtml, preloadImage = null }) {
  const resolved = seo || resolveStaticRouteSeo(pagePath || '/');
  const url = resolved.pageUrl;
  const is404 = Boolean(resolved.notFound);
  const resolvedCanonical = is404 ? '' : getSafeHttpUrlOrEmpty(resolved.canonicalUrl);

  let html = applyResolvedSeoToHtml(baseHtml, resolved, {
    preloadImage,
    getImageSizeFn: getImageSize,
  });

  // Inject content inside <div id="root"> (supports idempotent repeated runs)
  const fullBody = `${renderHeader()}<main id="main-content" class="min-h-[70vh]">${contentHtml}</main>${renderFooter()}`;
  if (html.includes('<div id="root"></div>')) {
    html = html.replace('<div id="root"></div>', () => `<div id="root">${fullBody}</div>`);
  } else {
    html = html.replace(
      /<div id="root">[\s\S]*<\/div>(?=\s*(?:<script\b|<\/body>))/i,
      () => `<div id="root">${fullBody}</div>`
    );
  }

  return {
    html,
    hasCustomCanonical: Boolean(resolvedCanonical && resolvedCanonical !== url),
  };
}

const writePage = (relPath, pageOutput) => {
  const normRelPath = String(relPath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normRelPath) {
    console.error('[postbuild] Refusing to write empty output path');
    process.exit(1);
  }
  const full = path.resolve(canonicalDistDir, normRelPath);
  if (!isInsideAuthorizedDirectory(canonicalDistDir, full)) {
    console.error(`[postbuild] Security check rejected output path outside dist/: "${normRelPath}"`);
    process.exit(1);
  }
  if (writtenOutputPaths.has(normRelPath)) {
    console.error(`[postbuild] Duplicate output path detected: "${normRelPath}"`);
    process.exit(1);
  }
  writtenOutputPaths.add(normRelPath);

  const html = typeof pageOutput === 'string' ? pageOutput : pageOutput.html;
  if (pageOutput && typeof pageOutput === 'object' && pageOutput.hasCustomCanonical) {
    overriddenCanonicalFiles.add(normRelPath);
  }
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
  seo: resolveStaticRouteSeo('/'),
  path: '/',
  contentHtml: homeContent,
});
writePage('index.html', homeHtml);

// ----------------------------------------------------------------------------
// 2. Tools Directory (/tools/)
// ----------------------------------------------------------------------------
const toolsSeo = resolveStaticRouteSeo('/tools/');
const toolsContent = `
<div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
  ${renderResolvedBreadcrumb(toolsSeo)}
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
    ${tools.map(renderToolDirectoryCard).join('')}
  </div>
</div>`;

const toolsPageHtml = createPageHtml({
  seo: toolsSeo,
  path: '/tools/',
  contentHtml: toolsContent,
});
writePage('tools/index.html', toolsPageHtml);

// ----------------------------------------------------------------------------
// 2b. Individual Tool Pages (/tools/[slug]/)
// ----------------------------------------------------------------------------
for (const t of tools) {
  if (!isValidToolSlug(t.slug)) continue;
  const targetRelPath = `tools/${t.slug}/index.html`;
  const targetAbsPath = path.resolve(canonicalDistDir, targetRelPath);
  if (!isInsideAuthorizedDirectory(canonicalDistDir, targetAbsPath)) {
    console.error(`[postbuild] Security check rejected unsafe tool output path: "${t.slug}"`);
    continue;
  }

  const toolRoute = `/tools/${t.slug}/`;
  const toolSeo = resolveStaticRouteSeo(toolRoute);
  const safeIcon = isSafeAssetOrUrl(t.icon) ? t.icon.trim() : '';
  const safeUrl = isSafeHttpUrl(t.url) ? t.url.trim() : '';
  const hasValidRating =
    typeof t.rating === 'number' && Number.isFinite(t.rating) && t.rating >= 0 && t.rating <= 5;
  const matchedCat = categories.find((c) => c.slug === t.category) || null;
  const catLabel =
    typeof t.categoryName === 'string' && t.categoryName.trim()
      ? t.categoryName.trim()
      : matchedCat?.name || '';
  const pricingLabel = typeof t.pricing === 'string' && t.pricing.trim() ? t.pricing.trim() : '';
  const osLabel =
    typeof t.operatingSystem === 'string' && t.operatingSystem.trim()
      ? t.operatingSystem.trim()
      : '';
  const shortDesc = typeof t.description === 'string' ? t.description.trim() : '';
  const longDesc = typeof t.longDescription === 'string' ? t.longDescription.trim() : '';
  const primaryOverview = longDesc || shortDesc;
  const showSubtitle = Boolean(shortDesc && longDesc && shortDesc !== longDesc);
  const safeFeatures = Array.isArray(t.features)
    ? t.features.map((f) => (typeof f === 'string' ? f.trim() : '')).filter(Boolean)
    : [];
  const safeTags = Array.isArray(t.tags)
    ? t.tags.map((tag) => (typeof tag === 'string' ? tag.trim() : '')).filter(Boolean)
    : [];
  const relatedTools = tools
    .filter((other) => other.slug !== t.slug && other.category === t.category)
    .slice(0, 3);

  const toolContent = `
<div class="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
  ${renderResolvedBreadcrumb(toolSeo)}
  <div class="mb-4">
    <a href="/tools/" class="inline-flex items-center gap-1.5 text-xs font-semibold text-blue-600 dark:text-blue-400 hover:underline">&larr; Back to AI Tools Directory</a>
  </div>
  <article class="bg-white dark:bg-slate-900/70 border border-slate-200 dark:border-slate-800 rounded-3xl p-6 sm:p-10 shadow-sm mb-10">
    <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-6 pb-8 border-b border-slate-200 dark:border-slate-800">
      <div class="flex items-start sm:items-center gap-5">
        <div class="w-16 h-16 sm:w-20 sm:h-20 rounded-2xl bg-slate-50 dark:bg-slate-800/80 overflow-hidden flex items-center justify-center shrink-0 shadow-sm p-2 border border-slate-200/70 dark:border-slate-700/70">
          ${safeIcon ? `<img src="${esc(safeIcon)}" alt="${esc(t.name)} Logo" class="w-full h-full object-contain rounded-xl" />` : `<span class="text-2xl font-extrabold text-blue-600 dark:text-blue-400">${esc(t.name.charAt(0).toUpperCase())}</span>`}
        </div>
        <div>
          <div class="flex flex-wrap items-center gap-2 mb-2">
            ${matchedCat ? `<a href="/category/${esc(matchedCat.slug)}/" class="px-2.5 py-0.5 rounded-full text-xs font-semibold bg-blue-50 text-blue-600 border border-blue-200 dark:bg-blue-950/60 dark:text-blue-400 dark:border-blue-500/30 hover:bg-blue-100 transition-colors">${esc(catLabel || matchedCat.name)}</a>` : catLabel ? `<span class="px-2.5 py-0.5 rounded-full text-xs font-semibold bg-blue-50 text-blue-600 border border-blue-200 dark:bg-blue-950/60 dark:text-blue-400 dark:border-blue-500/30">${esc(catLabel)}</span>` : ''}
            ${pricingLabel ? `<span class="px-2.5 py-0.5 rounded-full text-xs font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200 dark:bg-emerald-950/50 dark:text-emerald-400 dark:border-emerald-500/30">${esc(pricingLabel)}</span>` : ''}
            ${hasValidRating ? `<span class="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-amber-50 text-amber-700 border border-amber-200 dark:bg-amber-950/40 dark:text-amber-400 dark:border-amber-500/30">&#9733; ${esc(t.rating)}</span>` : ''}
            ${osLabel ? `<span class="px-2.5 py-0.5 rounded-full text-xs font-medium bg-slate-100 text-slate-700 border border-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700">${esc(osLabel)}</span>` : ''}
          </div>
          <h1 class="text-2xl sm:text-4xl font-extrabold text-slate-900 dark:text-white tracking-tight">${esc(t.name)}</h1>
          ${showSubtitle ? `<p class="text-sm sm:text-base text-slate-600 dark:text-slate-300 mt-2 leading-relaxed">${esc(shortDesc)}</p>` : ''}
        </div>
      </div>
      ${safeUrl ? `<div class="shrink-0"><a href="${esc(safeUrl)}" target="_blank" rel="nofollow noopener noreferrer" class="w-full sm:w-auto inline-flex items-center justify-center gap-2 px-6 py-3 rounded-xl text-sm font-semibold text-white bg-blue-600 hover:bg-blue-500 shadow-md shadow-blue-600/30 transition-all">Visit Official Website &rarr;</a></div>` : ''}
    </div>
    ${primaryOverview ? `<section class="py-6 border-b border-slate-200 dark:border-slate-800/80"><h2 class="text-lg font-bold text-slate-900 dark:text-white mb-2">Overview</h2><p class="text-sm sm:text-base text-slate-700 dark:text-slate-300 leading-relaxed">${esc(primaryOverview)}</p></section>` : ''}
    ${safeFeatures.length ? `<section class="py-6 border-b border-slate-200 dark:border-slate-800/80"><h2 class="text-lg font-bold text-slate-900 dark:text-white mb-3">Key Features</h2><ul class="grid grid-cols-1 sm:grid-cols-2 gap-2.5">${safeFeatures.map((f) => `<li class="text-sm text-slate-700 dark:text-slate-300">${esc(f)}</li>`).join('')}</ul></section>` : ''}
    ${safeTags.length ? `<section class="pt-6 flex items-center flex-wrap gap-2">${safeTags.map((tag) => `<span class="px-3 py-1 rounded-full text-xs font-medium bg-slate-100 text-slate-700 border border-slate-200 dark:bg-slate-800/80 dark:text-slate-300 dark:border-slate-700/50">${esc(tag)}</span>`).join('')}</section>` : ''}
  </article>
  ${relatedTools.length ? `<section class="pt-2"><div class="flex items-center justify-between mb-5"><h2 class="text-xl font-bold text-slate-900 dark:text-white">Related Tools${catLabel ? ` in ${esc(catLabel)}` : ''}</h2><a href="/tools/" class="text-xs sm:text-sm font-semibold text-blue-600 dark:text-blue-400 hover:underline">All Tools &rarr;</a></div><div class="grid grid-cols-1 sm:grid-cols-3 gap-5">${relatedTools.map((rel) => `<a href="/tools/${esc(rel.slug)}/" class="p-5 rounded-2xl bg-white dark:bg-slate-900/60 border border-slate-200 dark:border-slate-800 hover:border-blue-500/40 shadow-sm block"><h3 class="text-base font-bold text-slate-900 dark:text-white mb-1">${esc(rel.name)}</h3>${rel.description ? `<p class="text-xs text-slate-600 dark:text-slate-400 line-clamp-2 mb-3">${esc(rel.description)}</p>` : ''}<span class="text-xs font-semibold text-blue-600 dark:text-blue-400">View Profile &rarr;</span></a>`).join('')}</div></section>` : ''}
</div>`;

  writePage(targetRelPath, createPageHtml({
    seo: toolSeo,
    path: toolRoute,
    contentHtml: toolContent,
  }));
}

// ----------------------------------------------------------------------------
// 3. Blog Archive (/blog/)
// ----------------------------------------------------------------------------
const blogSeo = resolveStaticRouteSeo('/blog/');
const blogContent = `
<div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
  ${renderResolvedBreadcrumb(blogSeo)}
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
  seo: blogSeo,
  path: '/blog/',
  contentHtml: blogContent,
});
writePage('blog/index.html', blogPageHtml);

// ----------------------------------------------------------------------------
// 4. Categories Directory (/categories/)
// ----------------------------------------------------------------------------
const categoriesSeo = resolveStaticRouteSeo('/categories/');
const categoriesContent = `
<div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
  ${renderResolvedBreadcrumb(categoriesSeo)}
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
  seo: categoriesSeo,
  path: '/categories/',
  contentHtml: categoriesContent,
});
writePage('categories/index.html', categoriesPageHtml);

// ----------------------------------------------------------------------------
// 5. Individual Article Pages (/blog/[slug]/)
// ----------------------------------------------------------------------------
for (const a of articles) {
  let mdFile;
  try {
    mdFile = resolveArticleMarkdownPath(a);
  } catch (err) {
    console.error(`[postbuild] Security validation failed for article "${a?.slug || 'unknown'}": ${err.message}`);
    process.exit(1);
  }
  const mdRaw = fs.readFileSync(mdFile, 'utf-8');
  const bodyHtml = renderMarkdown(mdRaw);

  const related = articles
    .filter(x => x.slug !== a.slug)
    .sort((x, y) => Number(y.category === a.category) - Number(x.category === a.category))
    .slice(0, 2);
  const imgSize = getImageSize(a.featuredImage);
  const ogImgSize = getImageSize(a.ogImage || a.featuredImage);
  const wordCount = mdRaw.split(/\s+/).filter(Boolean).length;
  const articleSeo = resolveStaticRouteSeo(`/blog/${a.slug}/`, {
    wordCount,
    imageSize: ogImgSize,
  });
  const authorProfile = getArticleAuthorProfile(a.author);

  const articleContent = `
<article class="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
  ${renderResolvedBreadcrumb(articleSeo)}
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
      ${authorProfile ? `<a href="${esc(authorProfile.path)}" class="font-semibold text-slate-800 dark:text-slate-200 hover:text-blue-600 dark:hover:text-blue-400 transition-colors">By ${esc(authorProfile.name)}</a>` : `<span class="font-semibold text-slate-800 dark:text-slate-200">By ${esc(DEFAULT_EDITORIAL_TEAM_NAME)}</span>`}
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
  ${authorProfile ? `
  <div class="p-6 sm:p-7 rounded-3xl bg-white dark:bg-slate-900/60 border border-slate-200 dark:border-slate-800 shadow-sm flex flex-col sm:flex-row items-start gap-4 sm:gap-5 mb-12">
    <a href="${esc(authorProfile.path)}" class="w-14 h-14 rounded-2xl bg-gradient-to-tr from-blue-600 to-sky-400 flex items-center justify-center font-bold text-white text-lg shrink-0 shadow-md hover:opacity-90 transition-opacity">
      ${esc(authorProfile.initials)}
    </a>
    <div class="flex-1">
      <div class="text-xs uppercase font-bold tracking-wider text-blue-600 dark:text-blue-400 mb-1">${esc(authorProfile.cardBadge)}</div>
      <h3 class="text-lg font-bold text-slate-900 dark:text-white mb-1">
        <a href="${esc(authorProfile.path)}" class="hover:text-blue-600 dark:hover:text-blue-400 transition-colors">${esc(authorProfile.name)}</a>
      </h3>
      <p class="text-xs sm:text-sm text-slate-600 dark:text-slate-400 leading-relaxed mb-3">
        ${esc(authorProfile.shortBio)}
      </p>
      <div class="flex flex-wrap items-center gap-4 text-xs font-semibold text-blue-600 dark:text-blue-400">
        <a href="${esc(authorProfile.path)}" class="hover:underline flex items-center gap-1">
          <span>View Editorial Profile &amp; Guides</span>
          <span>&rarr;</span>
        </a>
        <span>•</span>
        <a href="/editorial-policy/" class="text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200 hover:underline">Editorial Policy</a>
      </div>
    </div>
  </div>` : `
  <div class="p-6 sm:p-7 rounded-3xl bg-white dark:bg-slate-900/60 border border-slate-200 dark:border-slate-800 shadow-sm flex flex-col sm:flex-row items-start gap-4 sm:gap-5 mb-12">
    <div class="w-14 h-14 rounded-2xl bg-gradient-to-tr from-blue-600 to-sky-400 flex items-center justify-center font-bold text-white text-lg shrink-0 shadow-md">
      AE
    </div>
    <div class="flex-1">
      <div class="text-xs uppercase font-bold tracking-wider text-blue-600 dark:text-blue-400 mb-1">Editorial Desk</div>
      <h3 class="text-lg font-bold text-slate-900 dark:text-white mb-1">${esc(DEFAULT_EDITORIAL_TEAM_NAME)}</h3>
      <p class="text-xs sm:text-sm text-slate-600 dark:text-slate-400 leading-relaxed mb-3">
        Independent AI software reviews, workflows, and technical guides published across the AINOVEX platform.
      </p>
      <div class="flex flex-wrap items-center gap-4 text-xs font-semibold text-blue-600 dark:text-blue-400">
        <a href="/editorial-policy/" class="text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200 hover:underline">Editorial Policy</a>
      </div>
    </div>
  </div>`}
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

  const articleHtml = createPageHtml({
    seo: articleSeo,
    path: `/blog/${a.slug}/`,
    preloadImage: a.featuredImage,
    contentHtml: articleContent,
  });

  writePage(`blog/${a.slug}/index.html`, articleHtml);
}

// ----------------------------------------------------------------------------
// 6. Category Detail Pages (/category/[slug]/)
// ----------------------------------------------------------------------------
for (const c of categories) {
  const catTools = tools.filter(t => t.category === c.slug);
  const catArticles = articles.filter(a => a.category === c.slug);
  const catSeo = resolveStaticRouteSeo(`/category/${c.slug}/`);

  const catContent = `
<div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
  ${renderResolvedBreadcrumb(catSeo)}
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

  writePage(`category/${c.slug}/index.html`, createPageHtml({
    seo: catSeo,
    path: `/category/${c.slug}/`,
    contentHtml: catContent,
  }));
}

// ----------------------------------------------------------------------------
// 7. Static Pages: About, Contact, Privacy, Terms, Editorial, Disclaimer
// ----------------------------------------------------------------------------
const aboutSeo = resolveStaticRouteSeo('/about/');
const aboutContent = `
<div class="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
  ${renderResolvedBreadcrumb(aboutSeo)}
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
  seo: aboutSeo,
  path: '/about/',
  contentHtml: aboutContent,
}));

const contactSeo = resolveStaticRouteSeo('/contact/');
const contactContent = `
<div class="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
  ${renderResolvedBreadcrumb(contactSeo)}
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
  seo: contactSeo,
  path: '/contact/',
  contentHtml: contactContent,
}));

// ----------------------------------------------------------------------------
// Author Profile Pages (/author/[slug]/)
// ----------------------------------------------------------------------------
for (const author of authors) {
  if (!author.slug || !author.articles || author.articles.length === 0) continue;

  const authorArticlesList = author.articles;
  const authorUrlPath = author.path;
  const authorSeo = resolveStaticRouteSeo(authorUrlPath);

  const authorContent = `
<div class="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
  ${renderResolvedBreadcrumb(authorSeo)}

  <div class="bg-white dark:bg-slate-900/70 border border-slate-200 dark:border-slate-800 rounded-3xl p-6 sm:p-10 shadow-sm mb-12">
    <div class="flex flex-col sm:flex-row items-start sm:items-center gap-6 mb-8 pb-8 border-b border-slate-200 dark:border-slate-800">
      <div class="w-20 h-20 sm:w-24 sm:h-24 rounded-3xl bg-gradient-to-tr from-blue-600 via-sky-500 to-blue-400 flex items-center justify-center font-extrabold text-white text-2xl sm:text-3xl shrink-0 shadow-lg shadow-blue-500/20">
        ${esc(author.initials)}
      </div>
      <div class="flex-1">
        <div class="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-blue-50 text-blue-600 border border-blue-200 dark:bg-blue-950/60 dark:border-blue-500/30 dark:text-blue-400 mb-2">
          <span>Editorial Profile</span>
        </div>
        <h1 class="text-2xl sm:text-4xl font-extrabold text-slate-900 dark:text-white tracking-tight mb-1">
          ${esc(author.name)}
        </h1>
        <p class="text-sm sm:text-base font-medium text-slate-600 dark:text-slate-300">
          ${esc(author.role)}
        </p>
      </div>
    </div>

    <div class="space-y-6 text-sm sm:text-base text-slate-700 dark:text-slate-300 leading-relaxed">
      <div>
        <h2 class="text-lg font-bold text-slate-900 dark:text-white mb-2">Editorial Role</h2>
        <p class="mb-3">
          ${esc(author.bioLead)}<strong>AINOVEX</strong>${esc(author.bioLeadSuffix)}
        </p>
        <p>
          ${esc(author.bioSecondary)}
        </p>
      </div>

      <div class="border-t border-slate-200 dark:border-slate-800 pt-6">
        <h3 class="text-base font-bold text-slate-900 dark:text-white mb-2">
          Editorial Standards
        </h3>
        <p class="text-xs sm:text-sm text-slate-600 dark:text-slate-400 leading-relaxed mb-3">
          ${esc(author.standardsPrefix)}<a href="/editorial-policy/" class="text-blue-600 dark:text-blue-400 underline font-semibold">AINOVEX Editorial Policy</a>${esc(author.standardsSuffix)}
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
        Articles &amp; Guides by ${esc(author.name)} (${authorArticlesList.length})
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

  writePage(`author/${author.slug}/index.html`, createPageHtml({
    seo: authorSeo,
    path: authorUrlPath,
    contentHtml: authorContent,
  }));
}

const legal = getLegalContent({ siteUrl: baseUrl, contactEmail: settings.contactEmail, strict: true });
const legalDateLabel = formatLegalDate();

const privacySeo = resolveStaticRouteSeo('/privacy/');
const privacyContent = `
<div class="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
  ${renderResolvedBreadcrumb(privacySeo)}
  <div class="py-6 border-b border-slate-200 dark:border-slate-800/80 mb-8">
    <h1 class="text-3xl sm:text-4xl font-extrabold text-slate-900 dark:text-white tracking-tight mb-2">${esc(LEGAL_TITLES.privacy)}</h1>
    <p class="text-xs text-slate-500 dark:text-slate-400">Last updated: ${esc(legalDateLabel)} &bull; Published by AINOVEX Editorial Team</p>
  </div>
  <div class="space-y-8 text-sm sm:text-base text-slate-700 dark:text-slate-300 leading-relaxed">
    <section>
      <h2 class="text-xl font-bold text-slate-900 dark:text-white mb-2">${esc(legal.privacy.sections[0].heading)}</h2>
      <p>${esc(legal.privacy.sections[0].textBeforeUrl)}${esc(legal.privacy.sections[0].siteUrl)}${esc(legal.privacy.sections[0].textAfterUrl)}</p>
    </section>
    <section>
      <h2 class="text-xl font-bold text-slate-900 dark:text-white mb-2">${esc(legal.privacy.sections[1].heading)}</h2>
      <p>${esc(legal.privacy.sections[1].paragraphs[0])}</p>
    </section>
    <section>
      <h2 class="text-xl font-bold text-slate-900 dark:text-white mb-2">${esc(legal.privacy.sections[2].heading)}</h2>
      <p>${esc(legal.privacy.sections[2].paragraphs[0])}</p>
    </section>
    <section>
      <h2 class="text-xl font-bold text-slate-900 dark:text-white mb-2">${esc(legal.privacy.sections[3].heading)}</h2>
      <p>${esc(legal.privacy.sections[3].textBeforeEmail)}<strong>${esc(legal.privacy.sections[3].email)}</strong>.</p>
    </section>
  </div>
</div>`;
writePage('privacy/index.html', createPageHtml({
  seo: privacySeo,
  path: '/privacy/',
  contentHtml: privacyContent,
}));

const termsSeo = resolveStaticRouteSeo('/terms/');
const termsContent = `
<div class="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
  ${renderResolvedBreadcrumb(termsSeo)}
  <div class="py-6 border-b border-slate-200 dark:border-slate-800/80 mb-8">
    <h1 class="text-3xl sm:text-4xl font-extrabold text-slate-900 dark:text-white tracking-tight mb-2">${esc(LEGAL_TITLES.terms)}</h1>
    <p class="text-xs text-slate-500 dark:text-slate-400">Last updated: ${esc(legalDateLabel)} &bull; Published by AINOVEX Editorial Team</p>
  </div>
  <div class="space-y-8 text-sm sm:text-base text-slate-700 dark:text-slate-300 leading-relaxed">
    <section>
      <h2 class="text-xl font-bold text-slate-900 dark:text-white mb-2">${esc(legal.terms.sections[0].heading)}</h2>
      <p>${esc(legal.terms.sections[0].paragraphs[0])}</p>
    </section>
    <section>
      <h2 class="text-xl font-bold text-slate-900 dark:text-white mb-2">${esc(legal.terms.sections[1].heading)}</h2>
      <p>${esc(legal.terms.sections[1].paragraphs[0])}</p>
    </section>
    <section>
      <h2 class="text-xl font-bold text-slate-900 dark:text-white mb-2">${esc(legal.terms.sections[2].heading)}</h2>
      <p>${esc(legal.terms.sections[2].paragraphs[0])}</p>
    </section>
  </div>
</div>`;
writePage('terms/index.html', createPageHtml({
  seo: termsSeo,
  path: '/terms/',
  contentHtml: termsContent,
}));

const editorialSeo = resolveStaticRouteSeo('/editorial-policy/');
const editorialContent = `
<div class="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
  ${renderResolvedBreadcrumb(editorialSeo)}
  <div class="py-6 border-b border-slate-200 dark:border-slate-800/80 mb-8">
    <h1 class="text-3xl sm:text-4xl font-extrabold text-slate-900 dark:text-white tracking-tight mb-2">${esc(LEGAL_TITLES.editorial)}</h1>
    <p class="text-xs text-slate-500 dark:text-slate-400">Last updated: ${esc(legalDateLabel)} &bull; Published by AINOVEX Editorial Team</p>
  </div>
  <div class="space-y-8 text-sm sm:text-base text-slate-700 dark:text-slate-300 leading-relaxed">
    <section>
      <h2 class="text-xl font-bold text-slate-900 dark:text-white mb-2">${esc(legal.editorial.sections[0].heading)}</h2>
      <p>${esc(legal.editorial.sections[0].textBeforeAuthor)}<strong>${esc(legal.editorial.sections[0].authorName)}</strong>.</p>
    </section>
    <section>
      <h2 class="text-xl font-bold text-slate-900 dark:text-white mb-2">${esc(legal.editorial.sections[1].heading)}</h2>
      <ul class="list-disc pl-5 space-y-2">
        ${legal.editorial.sections[1].bullets.map(b => `<li>${esc(b)}</li>`).join('\n        ')}
      </ul>
    </section>
  </div>
</div>`;
writePage('editorial-policy/index.html', createPageHtml({
  seo: editorialSeo,
  path: '/editorial-policy/',
  contentHtml: editorialContent,
}));

const affiliateSeo = resolveStaticRouteSeo('/affiliate-disclosure/');
const affiliateContent = `
<div class="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
  ${renderResolvedBreadcrumb(affiliateSeo)}
  <div class="py-6 border-b border-slate-200 dark:border-slate-800/80 mb-8">
    <h1 class="text-3xl sm:text-4xl font-extrabold text-slate-900 dark:text-white tracking-tight mb-2">${esc(LEGAL_TITLES.affiliate)}</h1>
    <p class="text-xs text-slate-500 dark:text-slate-400">Last updated: ${esc(legalDateLabel)} &bull; Published by AINOVEX Editorial Team</p>
  </div>
  <div class="space-y-8 text-sm sm:text-base text-slate-700 dark:text-slate-300 leading-relaxed">
    <section>
      <h2 class="text-xl font-bold text-slate-900 dark:text-white mb-2">${esc(legal.affiliate.sections[0].heading)}</h2>
      <p>${esc(legal.affiliate.sections[0].paragraphs[0])}</p>
    </section>
    <section>
      <h2 class="text-xl font-bold text-slate-900 dark:text-white mb-2">${esc(legal.affiliate.sections[1].heading)}</h2>
      <p>${esc(legal.affiliate.sections[1].paragraphs[0])}</p>
    </section>
  </div>
</div>`;
writePage('affiliate-disclosure/index.html', createPageHtml({
  seo: affiliateSeo,
  path: '/affiliate-disclosure/',
  contentHtml: affiliateContent,
}));

// ----------------------------------------------------------------------------
// 7b. Custom Static Pages (/[slug]/)
// ----------------------------------------------------------------------------
for (const page of customPages) {
  if (!isValidCustomPageSlug(page.slug) || isReservedPageSlug(page.slug)) {
    console.error(`[postbuild] Security check rejected custom page slug: "${page.slug}"`);
    process.exit(1);
  }
  const targetRelPath = `${page.slug}/index.html`;
  const targetAbsPath = path.resolve(canonicalDistDir, targetRelPath);
  if (!isInsideAuthorizedDirectory(canonicalDistDir, targetAbsPath)) {
    console.error(`[postbuild] Security check rejected unsafe custom page output path: "${page.slug}"`);
    process.exit(1);
  }

  const pageRoute = `/${page.slug}/`;
  const pageSeo = resolveStaticRouteSeo(pageRoute);
  const bodyHtml = renderMarkdown(page.content);
  const pageContent = `
<article class="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
  ${renderResolvedBreadcrumb(pageSeo)}
  <header class="py-6 border-b border-slate-200 dark:border-slate-800/80 mb-8">
    <h1 class="text-3xl sm:text-4xl font-extrabold text-slate-900 dark:text-white tracking-tight">${esc(page.title)}</h1>
  </header>
  <div id="custom-page-content-body" class="article-content mb-12">
    ${bodyHtml}
  </div>
</article>`;

  writePage(targetRelPath, createPageHtml({
    seo: pageSeo,
    path: pageRoute,
    contentHtml: pageContent,
  }));
}

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
  seo: resolveStaticRouteSeo('/404/'),
  path: '/404/',
  contentHtml: notFoundContent,
});
writePage('404.html', notFoundHtml);

console.log(`[postbuild] Pre-rendered all 22+ static HTML routes with rich semantic markup, headings, links, and schema!`);
console.log(`[postbuild] ${articles.length} articles, ${categories.length} categories, ${tools.length} tools, ${customPages.length} custom pages exported.`);

// ----------------------------------------------------------------------------
// URL Consistency Guard: Validate dist/**/*.html and sitemap.xml
// ----------------------------------------------------------------------------
function collectHtmlFiles(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const htmlFiles = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      htmlFiles.push(...collectHtmlFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.html')) {
      htmlFiles.push(full);
    }
  }
  return htmlFiles;
}

const offending = [];

// 1. Check sitemap.xml
const sitemapFile = path.join(dist, 'sitemap.xml');
if (fs.existsSync(sitemapFile)) {
  const sitemapXml = fs.readFileSync(sitemapFile, 'utf-8');
  for (const m of sitemapXml.matchAll(/<loc>([^<]+)<\/loc>/g)) {
    const loc = m[1].trim();
    if (!loc.endsWith('/')) {
      offending.push(`[sitemap.xml] <loc> does not end with "/": ${loc}`);
    }
  }
}

// 2. Check all dist/**/*.html files
const allHtmlFiles = collectHtmlFiles(dist);
for (const filePath of allHtmlFiles) {
  const relFile = path.relative(dist, filePath);
  const html = fs.readFileSync(filePath, 'utf-8');
  const is404 = path.basename(filePath) === '404.html';

  const canonMatch = html.match(/<link\b[^>]*\brel=["']canonical["'][^>]*>/i);
  const canonHref = canonMatch ? (canonMatch[0].match(/\bhref=["']([^"']+)["']/i) || [])[1] : null;

  const ogUrlMatch = html.match(/<meta\b[^>]*\bproperty=["']og:url["'][^>]*>/i);
  const ogUrlContent = ogUrlMatch ? (ogUrlMatch[0].match(/\bcontent=["']([^"']+)["']/i) || [])[1] : null;

  if (is404) {
    if (canonMatch) {
      offending.push(`[${relFile}] 404.html must not contain <link rel="canonical">`);
    }
    if (ogUrlMatch) {
      offending.push(`[${relFile}] 404.html must not contain <meta property="og:url">`);
    }
  } else {
    if (overriddenCanonicalFiles.has(relFile)) {
      if (!canonHref || !isSafeHttpUrl(canonHref)) {
        offending.push(`[${relFile}] custom canonical href "${canonHref}" is not a valid HTTP/HTTPS URL`);
      }
    } else if (!canonHref || !canonHref.startsWith(baseUrl) || !canonHref.endsWith('/')) {
      offending.push(`[${relFile}] canonical href "${canonHref}" does not start with baseUrl "${baseUrl}" or does not end with "/"`);
    }
    if (!ogUrlContent || !ogUrlContent.startsWith(baseUrl) || !ogUrlContent.endsWith('/')) {
      offending.push(`[${relFile}] og:url content "${ogUrlContent}" does not start with baseUrl "${baseUrl}" or does not end with "/"`);
    }
  }

  // Scan internal hrefs
  for (const m of html.matchAll(/\bhref=["']([^"']+)["']/gi)) {
    const href = m[1];
    if (href.startsWith('//')) continue;
    if (!href.startsWith('/')) continue;
    const cleanHref = href.split(/[?#]/)[0];
    if (cleanHref === '/' || cleanHref.endsWith('/')) continue;
    if (path.posix.extname(cleanHref) !== '') continue;
    offending.push(`[${relFile}] Internal href "${href}" has no extension and does not end with "/"`);
  }
}

if (offending.length > 0) {
  console.error('[postbuild] URL consistency check failed:');
  for (const err of offending) {
    console.error(`  - ${err}`);
  }
  process.exit(1);
}

console.log('[postbuild] URL consistency check passed');
}

const isDirectExecution =
  Boolean(process.argv[1]) &&
  fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(fileURLToPath(import.meta.url));

if (isDirectExecution) {
  runPostbuild();
}

