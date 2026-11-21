import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';

const REPO_ROOT = process.cwd();

const realArticles = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, 'content', 'articles.json'), 'utf8')
).filter((a) => a.isPublished);
const realCategories = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, 'content', 'categories.json'), 'utf8')
);
const realSettings = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, 'content', 'settings.json'), 'utf8')
);
const realSeoConfig = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, 'content', 'seo.json'), 'utf8')
);
const indexHtml = fs.readFileSync(path.join(REPO_ROOT, 'index.html'), 'utf8');

/**
 * Lightweight DOM Head simulator matching browser Document/HTMLHeadElement APIs
 * used by src/utils/seo.ts (no external DOM package required).
 */
class FakeElement {
  constructor(tagName, head) {
    this.tagName = tagName.toUpperCase();
    this.attrs = new Map();
    this._head = head;
  }

  setAttribute(name, value) {
    this.attrs.set(String(name).toLowerCase(), String(value));
  }

  getAttribute(name) {
    const val = this.attrs.get(String(name).toLowerCase());
    return val === undefined ? null : val;
  }

  get rel() {
    return this.getAttribute('rel') || '';
  }

  set rel(v) {
    this.setAttribute('rel', v);
  }

  get href() {
    return this.getAttribute('href') || '';
  }

  set href(v) {
    this.setAttribute('href', v);
  }

  remove() {
    const idx = this._head.children.indexOf(this);
    if (idx >= 0) {
      this._head.children.splice(idx, 1);
    }
  }
}

function matchesSingleSelector(el, selector) {
  const s = selector.trim();
  const m = s.match(/^([a-z]+)\[([a-z-]+)="([^"]+)"\]$/i);
  if (!m) return false;
  const [, tag, attr, val] = m;
  return el.tagName === tag.toUpperCase() && el.getAttribute(attr) === val;
}

class FakeHead {
  constructor() {
    this.children = [];
  }

  appendChild(el) {
    if (!this.children.includes(el)) {
      this.children.push(el);
    }
    return el;
  }

  querySelectorAll(selectorString) {
    const parts = selectorString.split(',').map((s) => s.trim()).filter(Boolean);
    return this.children.filter((el) => parts.some((sel) => matchesSingleSelector(el, sel)));
  }

  querySelector(selectorString) {
    return this.querySelectorAll(selectorString)[0] || null;
  }
}

function createFakeDocumentFromHtml(html = indexHtml) {
  const head = new FakeHead();
  const titleMatch = html.match(/<title>([^<]*)<\/title>/i);
  const doc = {
    title: titleMatch ? titleMatch[1] : '',
    head,
    createElement(tagName) {
      return new FakeElement(tagName, head);
    },
  };

  const headMatch = html.match(/<head[^>]*>([\s\S]*?)<\/head>/i);
  const headInner = headMatch ? headMatch[1] : '';
  const tagRegex = /<(meta|link)\b([^>]*?)\/?>/gi;
  let match;
  while ((match = tagRegex.exec(headInner)) !== null) {
    const tag = match[1].toLowerCase();
    const attrsStr = match[2];
    const el = new FakeElement(tag, head);
    const attrRegex = /([a-zA-Z0-9:-]+)\s*=\s*"([^"]*)"/g;
    let attrMatch;
    while ((attrMatch = attrRegex.exec(attrsStr)) !== null) {
      el.setAttribute(attrMatch[1], attrMatch[2]);
    }
    head.appendChild(el);
  }

  return doc;
}

function getMetaContent(doc, attr, key) {
  const el = doc.head.querySelector(`meta[${attr}="${key}"]`);
  return el ? el.getAttribute('content') : null;
}

function countSelector(doc, selector) {
  return doc.head.querySelectorAll(selector).length;
}

function getCanonicalHref(doc) {
  const el = doc.head.querySelector('link[rel="canonical"]');
  return el ? el.getAttribute('href') : null;
}

describe('Task 114-C — Client-Side Page-Level SEO Runtime Integration', () => {
  it('1. Applies resolved SEO metadata on initial load and updates across client-side navigation without stale tags or duplicates', async () => {
    const vite = await createServer({
      configFile: false,
      plugins: [react()],
      server: { middlewareMode: true },
      appType: 'custom',
      logLevel: 'silent',
      optimizeDeps: { noDiscovery: true },
    });

    try {
      const { resolveAndApplyRouteSeo } = await vite.ssrLoadModule('/src/utils/seo.ts');
      const doc = createFakeDocumentFromHtml(indexHtml);

      // Inject duplicate managed tags beforehand to verify deduplication on first run
      const dupDesc = doc.createElement('meta');
      dupDesc.setAttribute('name', 'description');
      dupDesc.setAttribute('content', 'stale duplicate description');
      doc.head.appendChild(dupDesc);

      const dupCanon = doc.createElement('link');
      dupCanon.setAttribute('rel', 'canonical');
      dupCanon.setAttribute('href', 'https://ai-novex.netlify.app/stale/');
      doc.head.appendChild(dupCanon);

      // 1) Initial load on /
      resolveAndApplyRouteSeo(
        {
          path: '/',
          seoConfig: realSeoConfig,
          settings: realSettings,
          articles: realArticles,
          categories: realCategories,
          tools: [],
        },
        doc
      );

      assert.equal(doc.title, 'AINOVEX - AI Tools & Technology Platform');
      assert.equal(
        getCanonicalHref(doc),
        'https://ai-novex.netlify.app/'
      );
      assert.equal(countSelector(doc, 'link[rel="canonical"]'), 1);
      assert.equal(countSelector(doc, 'meta[name="description"]'), 1);
      assert.equal(getMetaContent(doc, 'property', 'og:type'), 'website');
      assert.equal(getMetaContent(doc, 'property', 'og:url'), 'https://ai-novex.netlify.app/');
      assert.equal(
        getMetaContent(doc, 'property', 'og:image'),
        'https://ai-novex.netlify.app/images/og-default.png'
      );
      assert.equal(getMetaContent(doc, 'property', 'og:image:type'), 'image/png');
      assert.equal(getMetaContent(doc, 'property', 'og:image:width'), '1200');
      assert.equal(getMetaContent(doc, 'property', 'og:image:height'), '630');
      assert.equal(
        getMetaContent(doc, 'name', 'robots'),
        'index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1'
      );

      // 2) Navigate to an Article route (/blog/best-free-ai-tools-2026/)
      resolveAndApplyRouteSeo(
        {
          path: '/blog/best-free-ai-tools-2026/',
          seoConfig: realSeoConfig,
          settings: realSettings,
          articles: realArticles,
          categories: realCategories,
          tools: [],
        },
        doc
      );

      assert.equal(
        doc.title,
        'Best Free AI Tools in 2026 for Productivity & Creators | AINOVEX'
      );
      assert.equal(
        getCanonicalHref(doc),
        'https://ai-novex.netlify.app/blog/best-free-ai-tools-2026/'
      );
      assert.equal(getMetaContent(doc, 'property', 'og:type'), 'article');
      assert.equal(
        getMetaContent(doc, 'property', 'og:image'),
        'https://ai-novex.netlify.app/images/articles/best-free-ai-tools-2026-og.webp'
      );
      assert.equal(getMetaContent(doc, 'property', 'og:image:type'), 'image/webp');
      assert.equal(countSelector(doc, 'meta[property="og:image:width"]'), 0);
      assert.equal(countSelector(doc, 'meta[property="og:image:height"]'), 0);
      assert.ok(getMetaContent(doc, 'property', 'article:published_time'));
      assert.ok(getMetaContent(doc, 'property', 'article:modified_time'));
      assert.equal(
        getMetaContent(doc, 'property', 'article:author'),
        'https://ai-novex.netlify.app/author/md-shamim/'
      );
      assert.ok(getMetaContent(doc, 'property', 'article:section'));
      assert.ok(countSelector(doc, 'meta[property="article:tag"]') > 0);

      // 3) Navigate to /about/ — previous article:* tags and webp image metadata must NOT remain stale
      resolveAndApplyRouteSeo(
        {
          path: '/about/',
          seoConfig: realSeoConfig,
          settings: realSettings,
          articles: realArticles,
          categories: realCategories,
          tools: [],
        },
        doc
      );

      assert.equal(doc.title, 'About Us & Editorial Standards | AINOVEX');
      assert.equal(getCanonicalHref(doc), 'https://ai-novex.netlify.app/about/');
      assert.equal(getMetaContent(doc, 'property', 'og:type'), 'website');
      assert.equal(
        getMetaContent(doc, 'property', 'og:image'),
        'https://ai-novex.netlify.app/images/og-default.png'
      );
      assert.equal(getMetaContent(doc, 'property', 'og:image:type'), 'image/png');
      assert.equal(getMetaContent(doc, 'property', 'og:image:width'), '1200');
      assert.equal(getMetaContent(doc, 'property', 'og:image:height'), '630');
      assert.equal(countSelector(doc, 'meta[property="article:published_time"]'), 0);
      assert.equal(countSelector(doc, 'meta[property="article:modified_time"]'), 0);
      assert.equal(countSelector(doc, 'meta[property="article:author"]'), 0);
      assert.equal(countSelector(doc, 'meta[property="article:section"]'), 0);
      assert.equal(countSelector(doc, 'meta[property="article:tag"]'), 0);

      // 4) Navigate to /privacy/ (noindex, follow)
      resolveAndApplyRouteSeo(
        {
          path: '/privacy/',
          seoConfig: realSeoConfig,
          settings: realSettings,
          articles: realArticles,
          categories: realCategories,
          tools: [],
        },
        doc
      );

      assert.equal(doc.title, 'Privacy Policy | AINOVEX AI Platform');
      assert.equal(getMetaContent(doc, 'name', 'robots'), 'noindex, follow');
      assert.equal(getCanonicalHref(doc), 'https://ai-novex.netlify.app/privacy/');

      // 5) Navigate to 404 unknown route — canonical and og:url must be removed
      resolveAndApplyRouteSeo(
        {
          path: '/unknown-route-xyz/',
          seoConfig: realSeoConfig,
          settings: realSettings,
          articles: realArticles,
          categories: realCategories,
          tools: [],
        },
        doc
      );

      assert.equal(countSelector(doc, 'link[rel="canonical"]'), 0);
      assert.equal(countSelector(doc, 'meta[property="og:url"]'), 0);
      assert.equal(getMetaContent(doc, 'name', 'robots'), 'noindex, follow');

      // 6) Navigate from 404 back to /author/md-shamim/ — canonical, og:url, and profile type restored
      resolveAndApplyRouteSeo(
        {
          path: '/author/md-shamim/',
          seoConfig: realSeoConfig,
          settings: realSettings,
          articles: realArticles,
          categories: realCategories,
          tools: [],
        },
        doc
      );

      assert.equal(doc.title, 'Md Shamim - Lead Researcher & Editor | AINOVEX');
      assert.equal(getCanonicalHref(doc), 'https://ai-novex.netlify.app/author/md-shamim/');
      assert.equal(
        getMetaContent(doc, 'property', 'og:url'),
        'https://ai-novex.netlify.app/author/md-shamim/'
      );
      assert.equal(getMetaContent(doc, 'property', 'og:type'), 'profile');
      assert.equal(
        getMetaContent(doc, 'name', 'robots'),
        'index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1'
      );

      // Verify zero duplicate single-value managed tags across all navigations
      for (const selector of [
        'link[rel="canonical"]',
        'meta[name="description"]',
        'meta[name="robots"]',
        'meta[property="og:site_name"]',
        'meta[property="og:title"]',
        'meta[property="og:description"]',
        'meta[property="og:type"]',
        'meta[property="og:url"]',
        'meta[property="og:image"]',
        'meta[property="og:image:alt"]',
        'meta[property="og:image:type"]',
        'meta[name="twitter:card"]',
        'meta[name="twitter:title"]',
        'meta[name="twitter:description"]',
        'meta[name="twitter:image"]',
        'meta[name="twitter:image:alt"]',
      ]) {
        assert.equal(
          countSelector(doc, selector),
          1,
          `Expected exactly 1 element matching ${selector}`
        );
      }
    } finally {
      await vite.close();
    }
  });

  it('2. Respects page-level SEO overrides and cleans up optional overrides like twitter:site', async () => {
    const vite = await createServer({
      configFile: false,
      plugins: [react()],
      server: { middlewareMode: true },
      appType: 'custom',
      logLevel: 'silent',
      optimizeDeps: { noDiscovery: true },
    });

    try {
      const { resolveAndApplyRouteSeo } = await vite.ssrLoadModule('/src/utils/seo.ts');
      const doc = createFakeDocumentFromHtml(indexHtml);

      const customSeoConfig = {
        version: 1,
        defaults: {
          ...realSeoConfig.defaults,
          defaultTwitterSite: '@ainovex_test',
        },
        pages: {
          about: {
            pageId: 'about',
            pageType: 'about',
            path: '/about/',
            slug: 'about',
            seoTitle: 'Custom About Override Title | AINOVEX',
            metaDescription: 'Custom About page description override verified in client runtime.',
            canonicalUrl: 'https://ai-novex.netlify.app/about-canonical/',
            index: false,
            follow: false,
            ogTitle: 'Custom About OG Title',
            ogDescription: 'Custom About OG Description verified.',
            ogImage: '/images/articles/best-free-ai-tools-2026-og.webp',
            ogType: 'profile',
            twitterTitle: 'Custom About Twitter Title',
            twitterDescription: 'Custom About Twitter Description.',
            twitterImage: '/images/articles/best-free-ai-tools-2026.webp',
            twitterCard: 'summary',
          },
        },
      };

      resolveAndApplyRouteSeo(
        {
          path: '/about/',
          seoConfig: customSeoConfig,
          settings: realSettings,
          articles: realArticles,
          categories: realCategories,
          tools: [],
        },
        doc
      );

      assert.equal(doc.title, 'Custom About Override Title | AINOVEX');
      assert.equal(
        getMetaContent(doc, 'name', 'description'),
        'Custom About page description override verified in client runtime.'
      );
      assert.equal(getCanonicalHref(doc), 'https://ai-novex.netlify.app/about-canonical/');
      assert.equal(getMetaContent(doc, 'property', 'og:url'), 'https://ai-novex.netlify.app/about/');
      assert.equal(getMetaContent(doc, 'name', 'robots'), 'noindex, nofollow');
      assert.equal(getMetaContent(doc, 'property', 'og:title'), 'Custom About OG Title');
      assert.equal(
        getMetaContent(doc, 'property', 'og:description'),
        'Custom About OG Description verified.'
      );
      assert.equal(getMetaContent(doc, 'property', 'og:type'), 'profile');
      assert.equal(
        getMetaContent(doc, 'property', 'og:image'),
        'https://ai-novex.netlify.app/images/articles/best-free-ai-tools-2026-og.webp'
      );
      assert.equal(getMetaContent(doc, 'name', 'twitter:card'), 'summary');
      assert.equal(getMetaContent(doc, 'name', 'twitter:title'), 'Custom About Twitter Title');
      assert.equal(
        getMetaContent(doc, 'name', 'twitter:description'),
        'Custom About Twitter Description.'
      );
      assert.equal(
        getMetaContent(doc, 'name', 'twitter:image'),
        'https://ai-novex.netlify.app/images/articles/best-free-ai-tools-2026.webp'
      );
      assert.equal(getMetaContent(doc, 'name', 'twitter:site'), '@ainovex_test');

      // Navigate with seoConfig lacking defaultTwitterSite -> stale twitter:site is removed
      resolveAndApplyRouteSeo(
        {
          path: '/contact/',
          seoConfig: realSeoConfig,
          settings: realSettings,
          articles: realArticles,
          categories: realCategories,
          tools: [],
        },
        doc
      );
      assert.equal(countSelector(doc, 'meta[name="twitter:site"]'), 0);
      assert.equal(doc.title, 'Contact AINOVEX | Editorial & Support Team');
      assert.equal(getCanonicalHref(doc), 'https://ai-novex.netlify.app/contact/');
    } finally {
      await vite.close();
    }
  });

  it('3. Falls back safely on invalid/missing SEO records and blocks unsafe URLs', async () => {
    const vite = await createServer({
      configFile: false,
      plugins: [react()],
      server: { middlewareMode: true },
      appType: 'custom',
      logLevel: 'silent',
      optimizeDeps: { noDiscovery: true },
    });

    try {
      const { resolveAndApplyRouteSeo, applyResolvedSeo } = await vite.ssrLoadModule(
        '/src/utils/seo.ts'
      );
      const doc = createFakeDocumentFromHtml(indexHtml);

      // Missing/null seoConfig and unsafe productionUrl
      const resNull = resolveAndApplyRouteSeo(
        {
          path: '/about/',
          seoConfig: null,
          settings: { productionUrl: 'javascript:alert(1)' },
          articles: realArticles,
          categories: realCategories,
          tools: [],
        },
        doc
      );
      assert.equal(resNull.title, 'About Us & Editorial Standards | AINOVEX');
      assert.equal(getCanonicalHref(doc), 'https://ai-novex.netlify.app/about/');
      assert.doesNotMatch(getCanonicalHref(doc), /javascript:/i);

      // Malformed page overrides (unsafe URLs, control chars, invalid ogType/twitterCard)
      resolveAndApplyRouteSeo(
        {
          path: '/contact/',
          seoConfig: {
            version: 1,
            defaults: {
              defaultTwitterSite: 'bad handle with spaces',
            },
            pages: {
              contact: {
                pageId: 'contact',
                pageType: 'contact',
                path: '/contact/',
                seoTitle: 'ab',
                metaDescription: 'short',
                canonicalUrl: 'javascript:alert(1)',
                ogImage: '//evil.example/og.png',
                twitterImage: 'data:text/html,<script>alert(1)</script>',
                ogType: 'invalid_og_type',
                twitterCard: 'invalid_card',
              },
            },
          },
          settings: realSettings,
          articles: realArticles,
          categories: realCategories,
          tools: [],
        },
        doc
      );

      assert.equal(doc.title, 'Contact AINOVEX | Editorial & Support Team');
      assert.equal(getCanonicalHref(doc), 'https://ai-novex.netlify.app/contact/');
      assert.equal(getMetaContent(doc, 'property', 'og:type'), 'website');
      assert.equal(getMetaContent(doc, 'name', 'twitter:card'), 'summary_large_image');
      assert.equal(
        getMetaContent(doc, 'property', 'og:image'),
        'https://ai-novex.netlify.app/images/og-default.png'
      );
      assert.equal(countSelector(doc, 'meta[name="twitter:site"]'), 0);

      // Direct applyResolvedSeo defense-in-depth against unsafe URLs
      applyResolvedSeo(
        {
          notFound: false,
          routeKind: 'static',
          path: '/about/',
          pageUrl: 'javascript:alert(1)',
          baseUrl: 'https://ai-novex.netlify.app',
          siteName: 'AINOVEX',
          title: 'Safe Title',
          description: 'Safe description text.',
          canonicalUrl: 'javascript:alert(1)',
          ogUrl: 'data:text/html,evil',
          ogTitle: 'Safe OG Title',
          ogDescription: 'Safe OG Description',
          ogImage: 'javascript:alert(2)',
          ogType: 'website',
          ogImageAlt: 'Alt',
          twitterTitle: 'Safe Twitter Title',
          twitterDescription: 'Safe Twitter Description',
          twitterImage: 'vbscript:msgbox(1)',
          twitterCard: 'summary',
          twitterSite: 'not-a-handle',
          twitterImageAlt: 'Alt',
          index: true,
          follow: true,
          noindex: false,
          nofollow: false,
          robotsContent: 'index, follow',
          articleMeta: null,
        },
        doc
      );

      assert.equal(countSelector(doc, 'link[rel="canonical"]'), 0);
      assert.equal(countSelector(doc, 'meta[property="og:url"]'), 0);
      assert.equal(countSelector(doc, 'meta[property="og:image"]'), 0);
      assert.equal(countSelector(doc, 'meta[name="twitter:image"]'), 0);
      assert.equal(countSelector(doc, 'meta[name="twitter:site"]'), 0);
    } finally {
      await vite.close();
    }
  });

  it('4. Preserves existing entity route SEO behavior and App.tsx client router rendering', async () => {
    const vite = await createServer({
      configFile: false,
      plugins: [react()],
      server: { middlewareMode: true },
      appType: 'custom',
      logLevel: 'silent',
      optimizeDeps: { noDiscovery: true },
    });

    try {
      const { resolveAndApplyRouteSeo } = await vite.ssrLoadModule('/src/utils/seo.ts');
      const doc = createFakeDocumentFromHtml(indexHtml);

      // Category with published content -> indexable
      resolveAndApplyRouteSeo(
        {
          path: '/category/productivity/',
          seoConfig: realSeoConfig,
          settings: realSettings,
          articles: realArticles,
          categories: realCategories,
          tools: [],
        },
        doc
      );
      assert.equal(doc.title, 'Productivity Tools & Practical Guides 2026 | AINOVEX');
      assert.match(getMetaContent(doc, 'name', 'robots'), /^index, follow/);
      assert.equal(getCanonicalHref(doc), 'https://ai-novex.netlify.app/category/productivity/');

      // Empty category (exists in categories, no published articles) -> noindex, follow with canonical
      resolveAndApplyRouteSeo(
        {
          path: '/category/ai-writing/',
          seoConfig: realSeoConfig,
          settings: realSettings,
          articles: realArticles,
          categories: realCategories,
          tools: [],
        },
        doc
      );
      assert.equal(doc.title, 'AI Writing Tools & Practical Guides 2026 | AINOVEX');
      assert.equal(getMetaContent(doc, 'name', 'robots'), 'noindex, follow');
      assert.equal(getCanonicalHref(doc), 'https://ai-novex.netlify.app/category/ai-writing/');

      // Unsupported /tools/:slug/ with tools: [] stays 404/noindex matching App router
      resolveAndApplyRouteSeo(
        {
          path: '/tools/chatgpt/',
          seoConfig: realSeoConfig,
          settings: realSettings,
          articles: realArticles,
          categories: realCategories,
          tools: [],
        },
        doc
      );
      assert.equal(getMetaContent(doc, 'name', 'robots'), 'noindex, follow');
      assert.equal(countSelector(doc, 'link[rel="canonical"]'), 0);

      // Verify App.tsx compiles/loads via Vite SSR and renders existing routes intact
      const origWindow = globalThis.window;
      globalThis.window = {
        location: { pathname: '/about/', search: '' },
        matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
        addEventListener() {},
        removeEventListener() {},
        history: { pushState() {} },
        scrollTo() {},
      };
      try {
        const { default: App } = await vite.ssrLoadModule('/src/App.tsx');
        const html = renderToStaticMarkup(React.createElement(App));
        assert.match(html, /AINOVEX/);
        assert.match(html, /Editorial/i);
      } finally {
        if (origWindow === undefined) {
          delete globalThis.window;
        } else {
          globalThis.window = origWindow;
        }
      }
    } finally {
      await vite.close();
    }
  });
});
