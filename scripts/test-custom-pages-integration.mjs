import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';

import {
  extractCustomPageDescription,
  findPublishedCustomPageBySlug,
  getRenderablePublishedCustomPages,
  isPublishedCustomPage,
  isReservedPageSlug,
  isValidCustomPageSlug,
} from '../src/utils/customPages.js';
import { renderMarkdown } from '../src/utils/markdown.js';
import { isIndexable } from '../src/config/indexing.js';
import { resolvePageSeo, STATIC_SEO_DEFAULTS, trimMetaDescription } from '../src/utils/pageSeo.js';
import { runFinalizeSitemap } from './finalize-sitemap.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const realArticles = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, 'content', 'articles.json'), 'utf8')
).filter((a) => a.isPublished);
const realCategories = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, 'content', 'categories.json'), 'utf8')
);
const realTools = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, 'content', 'tools.json'), 'utf8')
);
const realSettings = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, 'content', 'settings.json'), 'utf8')
);
const realSeoConfig = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, 'content', 'seo.json'), 'utf8')
);
const indexHtmlTemplate = fs.readFileSync(path.join(REPO_ROOT, 'index.html'), 'utf8');

function makeCustomPage(overrides = {}) {
  return {
    id: 'page-ai-glossary',
    slug: 'ai-glossary',
    title: 'AI Glossary & Key Concepts',
    content: [
      '# AI Glossary & Key Concepts',
      '',
      'Understand core artificial intelligence terms, model evaluation metrics, and practical automation workflows.',
      '',
      '## Key Definitions',
      '',
      '- **LLM**: Large Language Model trained on broad text corpora.',
      '- **RAG**: Retrieval-Augmented Generation for grounded outputs.',
      '',
      'Learn more in our [AI Tools Directory](/tools/) or read [OpenAI Docs](https://platform.openai.com/docs).',
    ].join('\n'),
    isPublished: true,
    createdAt: '2026-11-20T10:00:00.000Z',
    updatedAt: '2026-11-21T14:30:00.000Z',
    ...overrides,
  };
}

function decodeHtmlEntities(val) {
  return String(val ?? '').replace(
    /&(#x[0-9a-f]+|#[0-9]+|amp|lt|gt|quot|apos);/gi,
    (match, entity) => {
      const lower = entity.toLowerCase();
      if (lower === 'amp') return '&';
      if (lower === 'lt') return '<';
      if (lower === 'gt') return '>';
      if (lower === 'quot') return '"';
      if (lower === 'apos' || lower === '#39') return "'";
      if (lower.startsWith('#x')) {
        const code = Number.parseInt(lower.slice(2), 16);
        return Number.isFinite(code) ? String.fromCodePoint(code) : match;
      }
      if (lower.startsWith('#')) {
        const code = Number.parseInt(lower.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : match;
      }
      return match;
    }
  );
}

function createFakeElement(tagName) {
  const attrs = new Map();
  return {
    tagName: tagName.toUpperCase(),
    attributes: attrs,
    textContent: '',
    _parent: null,
    setAttribute(name, value) {
      attrs.set(String(name).toLowerCase(), String(value));
    },
    getAttribute(name) {
      const val = attrs.get(String(name).toLowerCase());
      return val === undefined ? null : val;
    },
    remove() {
      if (this._parent) {
        const idx = this._parent._children.indexOf(this);
        if (idx !== -1) this._parent._children.splice(idx, 1);
        this._parent = null;
      }
    },
  };
}

function createFakeDocumentFromHtml(html) {
  const headMatch = html.match(/<head\b[^>]*>([\s\S]*?)<\/head>/i);
  const headHtml = headMatch ? headMatch[1] : '';
  const children = [];
  const tokenRe = /<(meta|link)\b([^>]*)>|<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = tokenRe.exec(headHtml)) !== null) {
    const tag = m[1] ? m[1].toLowerCase() : 'script';
    const attrsStr = m[1] ? m[2] : m[3];
    const el = createFakeElement(tag);
    if (!m[1]) el.textContent = m[4] || '';
    const attrRe = /([a-zA-Z0-9_:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    let am;
    while ((am = attrRe.exec(attrsStr)) !== null) {
      el.setAttribute(am[1], decodeHtmlEntities(am[2] ?? am[3] ?? ''));
    }
    el._parent = { _children: children };
    children.push(el);
  }
  const head = {
    _children: children,
    appendChild(el) {
      el._parent = head;
      children.push(el);
      return el;
    },
    querySelectorAll(selector) {
      const parts = selector
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      return children.filter((el) =>
        parts.some((part) => {
          const tagM = part.match(/^([a-zA-Z0-9]+)/);
          if (tagM && el.tagName.toLowerCase() !== tagM[1].toLowerCase()) return false;
          const attrMatches = [...part.matchAll(/\[([a-zA-Z0-9_:-]+)(\^?=)"([^"]*)"\]/g)];
          return attrMatches.every((am) => {
            const val = el.getAttribute(am[1]);
            if (val === null) return false;
            return am[2] === '^=' ? val.startsWith(am[3]) : val === am[3];
          });
        })
      );
    },
    querySelector(selector) {
      return head.querySelectorAll(selector)[0] || null;
    },
  };
  return { title: '', head, createElement: (t) => createFakeElement(t) };
}

function getMetaContent(doc, attr, key) {
  const matches = doc.head.querySelectorAll(`meta[${attr}="${key}"]`);
  assert.equal(matches.length, 1, `Expected 1 meta[${attr}="${key}"], found ${matches.length}`);
  return matches[0].getAttribute('content');
}

function getCanonicalHref(doc) {
  const matches = doc.head.querySelectorAll('link[rel="canonical"]');
  assert.equal(matches.length, 1, `Expected 1 canonical link, found ${matches.length}`);
  return matches[0].getAttribute('href');
}

function createIsolatedWorkspace({
  settings = realSettings,
  categories = realCategories,
  articles = realArticles,
  tools = realTools,
  pages = [],
  rawPagesText = null,
  omitPagesFile = false,
  seoConfig = realSeoConfig,
} = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ainovex-custom-pages-'));
  const distDir = path.join(tmpDir, 'dist');
  const contentDir = path.join(tmpDir, 'content');
  const articlesDir = path.join(contentDir, 'articles');
  const publicDir = path.join(tmpDir, 'public');

  fs.mkdirSync(distDir, { recursive: true });
  fs.mkdirSync(articlesDir, { recursive: true });
  fs.cpSync(path.join(REPO_ROOT, 'public'), publicDir, { recursive: true });
  fs.copyFileSync(path.join(REPO_ROOT, 'index.html'), path.join(distDir, 'index.html'));

  fs.writeFileSync(path.join(contentDir, 'settings.json'), JSON.stringify(settings, null, 2));
  fs.writeFileSync(path.join(contentDir, 'categories.json'), JSON.stringify(categories, null, 2));
  fs.writeFileSync(path.join(contentDir, 'tools.json'), JSON.stringify(tools, null, 2));
  fs.copyFileSync(path.join(REPO_ROOT, 'content', 'ads.json'), path.join(contentDir, 'ads.json'));
  fs.writeFileSync(path.join(contentDir, 'articles.json'), JSON.stringify(articles, null, 2));

  for (const file of fs.readdirSync(path.join(REPO_ROOT, 'content', 'articles'))) {
    if (file.endsWith('.md')) {
      fs.copyFileSync(
        path.join(REPO_ROOT, 'content', 'articles', file),
        path.join(articlesDir, file)
      );
    }
  }

  if (!omitPagesFile) {
    if (rawPagesText !== null) {
      fs.writeFileSync(path.join(contentDir, 'pages.json'), rawPagesText);
    } else {
      fs.writeFileSync(path.join(contentDir, 'pages.json'), JSON.stringify(pages, null, 2));
    }
  }

  if (seoConfig !== undefined && seoConfig !== null) {
    fs.writeFileSync(path.join(contentDir, 'seo.json'), JSON.stringify(seoConfig, null, 2));
  }

  return tmpDir;
}

function runIsolatedBuildPipeline(tmpDir) {
  execFileSync(process.execPath, [path.join(REPO_ROOT, 'scripts', 'postbuild.mjs')], {
    cwd: tmpDir,
    stdio: 'pipe',
  });
  execFileSync(process.execPath, [path.join(REPO_ROOT, 'scripts', 'finalize-sitemap.mjs')], {
    cwd: tmpDir,
    stdio: 'pipe',
  });
}

function extractBreadcrumbNavFromHtml(html) {
  const navMatch = html.match(/<nav\b[^>]*aria-label=["']Breadcrumb["'][^>]*>([\s\S]*?)<\/nav>/i);
  if (!navMatch) return null;
  const items = [];
  const liRe = /<li\b([^>]*)>([\s\S]*?)<\/li>/gi;
  let m;
  while ((m = liRe.exec(navMatch[1])) !== null) {
    if (/aria-hidden=["']true["']/i.test(m[1])) continue;
    const anchorMatch = m[2].match(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
    const rawText = decodeHtmlEntities(m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
    if (!rawText) continue;
    items.push({ label: rawText, href: anchorMatch ? decodeHtmlEntities(anchorMatch[1]) : null });
  }
  return items;
}

function extractSingleJsonLdFromHtml(html) {
  const scripts = [
    ...html.matchAll(
      /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
    ),
  ];
  assert.equal(scripts.length, 1, `Expected 1 JSON-LD script, found ${scripts.length}`);
  return { raw: scripts[0][1], parsed: JSON.parse(scripts[0][1]) };
}

function extractSitemapUrls(xml) {
  const urls = [];
  for (const match of xml.matchAll(/<url>\s*<loc>([^<]*)<\/loc>(?:\s*<lastmod>([^<]*)<\/lastmod>)?\s*<\/url>/g)) {
    urls.push({
      loc: decodeHtmlEntities(match[1]),
      lastmod: match[2] ? decodeHtmlEntities(match[2]) : null,
    });
  }
  return urls;
}

async function createViteSsr() {
  return createServer({
    configFile: false,
    plugins: [react()],
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'silent',
    optimizeDeps: { noDiscovery: true },
  });
}

describe('Task 114-H — Custom Static Pages Routing, Rendering, SEO & Sitemap Integration', () => {
  it('1-4. Resolves published custom pages, returns 404 for unpublished/missing/invalid pages, and rejects reserved route collisions', async () => {
    const publishedPage = makeCustomPage();
    const secondPublishedPage = makeCustomPage({
      id: 'page-workflow-playbook',
      slug: 'workflow-playbook',
      title: 'AI Workflow Playbook',
      content: '## Step 1\n\nAudit repetitive bottlenecks before adopting automation tools.',
    });
    const draftPage = makeCustomPage({
      id: 'page-secret-draft',
      slug: 'secret-draft',
      title: 'Secret Unpublished Draft',
      content: 'Unpublished confidential notes that must never be rendered publicly.',
      isPublished: false,
    });
    const reservedCollisionPage = makeCustomPage({
      id: 'page-reserved-about',
      slug: 'about',
      title: 'Hijacked About Page',
    });
    const malformedRecord = {
      id: 'page-bad-seo',
      slug: 'bad-seo-page',
      title: 'Bad SEO Field Page',
      content: 'Valid content here.',
      isPublished: true,
      createdAt: '2026-11-20T10:00:00.000Z',
      updatedAt: '2026-11-21T10:00:00.000Z',
      seoTitle: 'Forbidden SEO Field Inside Page Store',
    };

    const pagesPool = [
      publishedPage,
      secondPublishedPage,
      draftPage,
      reservedCollisionPage,
      malformedRecord,
    ];

    // 1. Published route resolution
    assert.ok(findPublishedCustomPageBySlug('ai-glossary', pagesPool));
    assert.ok(findPublishedCustomPageBySlug('workflow-playbook', pagesPool));
    assert.equal(
      isIndexable('/ai-glossary/', { articles: realArticles, categories: realCategories, tools: realTools, pages: pagesPool }),
      true
    );

    // 2 & 3. Unpublished, missing, and invalid pages resolve to null / non-indexable / 404
    assert.equal(findPublishedCustomPageBySlug('secret-draft', pagesPool), null);
    assert.equal(findPublishedCustomPageBySlug('does-not-exist', pagesPool), null);
    assert.equal(findPublishedCustomPageBySlug('bad-seo-page', pagesPool), null);
    assert.equal(findPublishedCustomPageBySlug('ai-glossary/nested', pagesPool), null);
    assert.equal(
      isIndexable('/secret-draft/', { articles: realArticles, categories: realCategories, tools: realTools, pages: pagesPool }),
      false
    );
    assert.equal(
      isIndexable('/bad-seo-page/', { articles: realArticles, categories: realCategories, tools: realTools, pages: pagesPool }),
      false
    );

    // 4. Reserved route collision rejection across all built-in routes & files
    for (const reserved of [
      'tools',
      'blog',
      'categories',
      'category',
      'author',
      'about',
      'contact',
      'privacy',
      'terms',
      'editorial-policy',
      'affiliate-disclosure',
      '404',
      'api',
      'assets',
      'images',
      'cms',
      'admin',
      'auth',
      'rss.xml',
      'sitemap.xml',
      'robots.txt',
      'llms.txt',
      'best-ai-tools-bulk-product-catalog-enrichment',
    ]) {
      assert.equal(isReservedPageSlug(reserved), true, `${reserved} must be reserved`);
      assert.equal(isValidCustomPageSlug(reserved), false, `${reserved} must fail custom slug validation`);
      assert.equal(
        findPublishedCustomPageBySlug(reserved, [makeCustomPage({ id: `res-${reserved}`, slug: reserved })]),
        null
      );
    }

    const vite = await createViteSsr();
    try {
      const { CustomPageView } = await vite.ssrLoadModule('/src/views/CustomPageView.tsx');

      // Published page renders cleanly
      const renderedHtml = renderToStaticMarkup(
        React.createElement(CustomPageView, {
          slug: 'ai-glossary',
          pages: pagesPool,
          onNavigate: () => {},
        })
      );
      assert.match(renderedHtml, /<h1[^>]*>AI Glossary &amp; Key Concepts<\/h1>/);
      assert.match(renderedHtml, /<h2 id="key-definitions">Key Definitions<\/h2>/);
      assert.doesNotMatch(renderedHtml, /404 - Page Not Found/);

      // Unpublished, missing, reserved, and malformed pages render 404 UI and never expose content
      for (const badSlug of ['secret-draft', 'nonexistent-page', 'about', 'bad-seo-page', '../etc/passwd']) {
        const notFoundHtml = renderToStaticMarkup(
          React.createElement(CustomPageView, {
            slug: badSlug,
            pages: pagesPool,
            onNavigate: () => {},
          })
        );
        assert.match(notFoundHtml, /404 - Page Not Found/, `Expected 404 UI for "${badSlug}"`);
        assert.doesNotMatch(notFoundHtml, /Unpublished confidential notes/);
        assert.doesNotMatch(notFoundHtml, /Hijacked About Page/);
        assert.doesNotMatch(notFoundHtml, /etc\/passwd/);
      }
    } finally {
      await vite.close();
    }
  });

  it('5. Safely renders Markdown content and rejects/escapes unsafe HTML and script payloads', async () => {
    const safeMarkdownPage = makeCustomPage({
      id: 'page-safe-md',
      slug: 'safe-markdown-guide',
      title: 'Safe Markdown Formatting',
      content: [
        '# Safe Markdown Formatting',
        '',
        'Intro paragraph with **bold**, *italic*, and `inline code`.',
        '',
        '## Checklist',
        '',
        '- First item with [Internal Tools Link](/tools/)',
        '- Second item with [External Docs](https://example.org/docs)',
        '',
        'Raw harmless HTML example: <div class="raw-note">Literal HTML snippet</div>',
      ].join('\n'),
    });

    const renderedBody = renderMarkdown(safeMarkdownPage.content);
    assert.match(renderedBody, /<h2 id="checklist">Checklist<\/h2>/);
    assert.match(renderedBody, /<ul>/);
    assert.match(renderedBody, /<a href="\/tools\/">Internal Tools Link<\/a>/);
    assert.match(
      renderedBody,
      /<a href="https:\/\/example\.org\/docs" target="_blank" rel="noopener noreferrer">External Docs<\/a>/
    );
    // Raw HTML must be escaped as literal text rather than injected as executable DOM
    assert.doesNotMatch(renderedBody, /<div class="raw-note">/);
    assert.match(renderedBody, /&lt;div class=&quot;raw-note&quot;&gt;/);

    // Unsafe HTML/script/event/javascript: URI payloads are rejected from public custom pages
    const unsafePayloads = [
      { label: 'script tag', content: '# Evil\n\n<script>alert(1)</script>' },
      { label: 'iframe tag', content: '# Evil\n\n<iframe src="https://evil.com"></iframe>' },
      { label: 'inline event handler', content: '# Evil\n\n<img src=x onerror=alert(1)>' },
      { label: 'javascript URI', content: '# Evil\n\n[Click](javascript:alert(1))' },
      { label: 'vbscript URI', content: '# Evil\n\n[Click](vbscript:msgbox(1))' },
      { label: 'data:text/html URI', content: '# Evil\n\n[Click](data:text/html,<script>alert(1)</script>)' },
      { label: 'title script tag', title: '<script>alert(1)</script>', content: 'Safe body content.' },
    ];

    const vite = await createViteSsr();
    try {
      const { CustomPageView } = await vite.ssrLoadModule('/src/views/CustomPageView.tsx');
      for (const payload of unsafePayloads) {
        const badPage = makeCustomPage({
          id: 'page-unsafe',
          slug: 'unsafe-page',
          ...payload,
        });
        assert.equal(isPublishedCustomPage(badPage), false, `[${payload.label}] must fail validation`);
        assert.equal(findPublishedCustomPageBySlug('unsafe-page', [badPage]), null);

        const html = renderToStaticMarkup(
          React.createElement(CustomPageView, {
            slug: 'unsafe-page',
            pages: [badPage],
            onNavigate: () => {},
          })
        );
        assert.match(html, /404 - Page Not Found/, `[${payload.label}] must return 404`);
        assert.doesNotMatch(html, /<script/i);
        assert.doesNotMatch(html, /<iframe/i);
        assert.doesNotMatch(html, /onerror=/i);
        assert.doesNotMatch(html, /javascript:/i);
      }

      // Also verify direct renderMarkdown neutralizes javascript: links if ever called directly
      const neutralized = renderMarkdown('[Bad](javascript:alert(1)) and ![img](data:text/html,xss)');
      assert.doesNotMatch(neutralized, /javascript:/i);
      assert.doesNotMatch(neutralized, /data:text\/html/i);
    } finally {
      await vite.close();
    }
  });

  it('6-7. Enforces SEO precedence, scope protection, canonical, robots, keywords, OG, and Twitter metadata', async () => {
    const richPage = makeCustomPage({
      id: 'page-glossary',
      slug: 'ai-glossary',
      title: 'AI Glossary',
      content: '# AI Glossary\n\nClear definitions for neural networks, embeddings, and retrieval pipelines used across modern AI engineering.',
    });
    const sparseContentPage = makeCustomPage({
      id: 'page-short-body',
      slug: 'short-body',
      title: 'Minimal Page',
      content: '# Minimal Page\n\nShort',
    });

    const pages = [richPage, sparseContentPage];

    const globalDefaults = {
      siteName: 'AINOVEX',
      titleTemplate: '%s | AINOVEX',
      defaultSeoTitle: 'Global Fallback Title | AINOVEX',
      defaultMetaDescription: 'Global default description applied when a route has neither override nor prose summary.',
      defaultFocusKeyword: 'global keyword',
      defaultSecondaryKeywords: ['global tag'],
      defaultOgTitle: 'Global OG Title',
      defaultOgDescription: 'Global OG Description',
      defaultOgImage: '/images/og-default.png',
      defaultTwitterCard: 'summary_large_image',
      defaultTwitterSite: '@ainovex',
      defaultImageAlt: 'AINOVEX Editorial Image',
    };

    const seoWithOverrides = {
      version: 1,
      defaults: globalDefaults,
      pages: {
        'static:ai-glossary': {
          pageId: 'static:ai-glossary',
          pageType: 'static',
          path: '/ai-glossary/',
          slug: 'ai-glossary',
          seoTitle: 'Custom Glossary SEO Title | AINOVEX',
          metaDescription: 'Explicit SEO meta description overriding route-derived and global defaults.',
          focusKeyword: 'artificial intelligence glossary',
          secondaryKeywords: ['ai terms', 'llm definitions'],
          canonicalUrl: 'https://ai-novex.netlify.app/ai-glossary-canonical/',
          index: true,
          follow: false,
          maxImagePreview: 'standard',
          maxSnippet: 160,
          maxVideoPreview: 0,
          ogTitle: 'Glossary Open Graph Title',
          ogDescription: 'Glossary Open Graph custom description.',
          ogImage: '/images/og-default.png',
          ogImageAlt: 'Glossary OG Alt',
          twitterTitle: 'Glossary Twitter Title',
          twitterDescription: 'Glossary Twitter Description',
          twitterImage: '/images/og-default.png',
          twitterCard: 'summary',
          twitterImageAlt: 'Glossary Twitter Alt',
        },
        // Attempt cross-page leakage onto /short-body/ using mismatched pageId/slug
        'static:leaked-other': {
          pageId: 'static:ai-glossary',
          pageType: 'static',
          path: '/short-body/',
          slug: 'ai-glossary',
          seoTitle: 'LEAKED TITLE DO NOT USE',
        },
      },
    };

    // Tier 1: Page-level override wins
    const overrideRes = resolvePageSeo({
      path: '/ai-glossary/',
      seoConfig: seoWithOverrides,
      settings: realSettings,
      pages,
    });
    assert.equal(overrideRes.notFound, false);
    assert.equal(overrideRes.pageId, 'static:ai-glossary');
    assert.equal(overrideRes.routeKind, 'static');
    assert.equal(overrideRes.title, 'Custom Glossary SEO Title | AINOVEX');
    assert.equal(
      overrideRes.description,
      'Explicit SEO meta description overriding route-derived and global defaults.'
    );
    assert.equal(overrideRes.focusKeyword, 'artificial intelligence glossary');
    assert.deepEqual(overrideRes.secondaryKeywords, ['ai terms', 'llm definitions']);
    assert.equal(overrideRes.canonicalUrl, 'https://ai-novex.netlify.app/ai-glossary-canonical/');
    assert.equal(
      overrideRes.robotsContent,
      'index, nofollow, max-image-preview:standard, max-snippet:160, max-video-preview:0'
    );
    assert.equal(overrideRes.ogTitle, 'Glossary Open Graph Title');
    assert.equal(overrideRes.ogDescription, 'Glossary Open Graph custom description.');
    assert.equal(overrideRes.ogImageAlt, 'Glossary OG Alt');
    assert.equal(overrideRes.twitterTitle, 'Glossary Twitter Title');
    assert.equal(overrideRes.twitterDescription, 'Glossary Twitter Description');
    assert.equal(overrideRes.twitterCard, 'summary');
    assert.equal(overrideRes.twitterSite, '@ainovex');
    assert.equal(overrideRes.twitterImageAlt, 'Glossary Twitter Alt');

    // Tier 2: Route-specific metadata (page title + Markdown summary) beats global defaults
    const routeFallbackRes = resolvePageSeo({
      path: '/ai-glossary/',
      seoConfig: { version: 1, defaults: globalDefaults, pages: {} },
      settings: realSettings,
      pages,
    });
    assert.equal(routeFallbackRes.title, 'AI Glossary | AINOVEX');
    assert.equal(
      routeFallbackRes.description,
      trimMetaDescription(extractCustomPageDescription(richPage.content), 155)
    );
    assert.equal(routeFallbackRes.ogTitle, 'AI Glossary | AINOVEX');
    assert.equal(routeFallbackRes.ogDescription, routeFallbackRes.description);
    assert.equal(routeFallbackRes.canonicalUrl, 'https://ai-novex.netlify.app/ai-glossary/');

    // Tier 3: Global defaults used when route lacks body prose summary (and leaked SEO record blocked)
    const globalFallbackRes = resolvePageSeo({
      path: '/short-body/',
      seoConfig: seoWithOverrides,
      settings: realSettings,
      pages,
    });
    assert.notEqual(globalFallbackRes.title, 'LEAKED TITLE DO NOT USE');
    assert.equal(globalFallbackRes.title, 'Minimal Page | AINOVEX');
    assert.equal(globalFallbackRes.description, globalDefaults.defaultMetaDescription);
    assert.equal(globalFallbackRes.focusKeyword, 'global keyword');

    // Tier 4: Safe final fallback when global defaults & settings are absent
    const safeFallbackRes = resolvePageSeo({
      path: '/short-body/',
      seoConfig: null,
      settings: {},
      pages,
    });
    assert.equal(safeFallbackRes.title, 'Minimal Page | AINOVEX');
    assert.ok(safeFallbackRes.description.length >= 10);
    assert.equal(safeFallbackRes.canonicalUrl, 'https://ai-novex.netlify.app/short-body/');
  });

  it('8. Validates WebPage default JSON-LD, permitted schema types, zero fabricated fields, breadcrumb parity, and 404 omissions', async () => {
    const customPages = [
      makeCustomPage({ id: 'p-default', slug: 'roadmap', title: 'Product Roadmap' }),
      makeCustomPage({ id: 'p-about', slug: 'company-story', title: 'Company Story' }),
      makeCustomPage({ id: 'p-bad-schema', slug: 'bad-schema-page', title: 'Bad Schema Page' }),
    ];

    const seoConfig = {
      ...structuredClone(realSeoConfig),
      pages: {
        ...structuredClone(realSeoConfig.pages),
        'static:company-story': {
          pageId: 'static:company-story',
          pageType: 'static',
          path: '/company-story/',
          slug: 'company-story',
          schemaType: 'AboutPage',
          breadcrumb: {
            enabled: true,
            items: [
              { name: 'Home', path: '/' },
              { name: 'Resources', path: '/blog/' },
              { name: 'Our Story', path: '/company-story/' },
            ],
          },
        },
        'static:bad-schema-page': {
          pageId: 'static:bad-schema-page',
          pageType: 'static',
          path: '/bad-schema-page/',
          slug: 'bad-schema-page',
          schemaType: 'SoftwareApplication',
          breadcrumb: { enabled: false },
        },
      },
    };

    // Default custom page emits WebPage with zero fabricated ratings/offers/authors/dates
    const roadmapSeo = resolvePageSeo({
      path: '/roadmap/',
      seoConfig,
      settings: realSettings,
      pages: customPages,
    });
    assert.equal(roadmapSeo.schemaType, 'WebPage');
    const roadmapNode = roadmapSeo.jsonLd['@graph'].find((n) => n['@type'] === 'WebPage');
    assert.ok(roadmapNode);
    assert.equal(roadmapNode.aggregateRating, undefined);
    assert.equal(roadmapNode.offers, undefined);
    assert.equal(roadmapNode.author, undefined);
    assert.equal(roadmapNode.datePublished, undefined);
    assert.equal(roadmapSeo.breadcrumbEnabled, true);
    assert.deepEqual(roadmapSeo.breadcrumbs, [{ label: 'Product Roadmap' }]);
    const roadmapBc = roadmapSeo.jsonLd['@graph'].find((n) => n['@type'] === 'BreadcrumbList');
    assert.deepEqual(
      roadmapBc.itemListElement.map((i) => i.name),
      ['Home', 'Product Roadmap']
    );

    // Permitted AboutPage schema + custom breadcrumbs UI & JSON-LD parity
    const storySeo = resolvePageSeo({
      path: '/company-story/',
      seoConfig,
      settings: realSettings,
      pages: customPages,
    });
    assert.equal(storySeo.schemaType, 'AboutPage');
    assert.ok(storySeo.jsonLd['@graph'].some((n) => n['@type'] === 'AboutPage'));

    const vite = await createViteSsr();
    try {
      const { CustomPageView } = await vite.ssrLoadModule('/src/views/CustomPageView.tsx');
      const storyMarkup = renderToStaticMarkup(
        React.createElement(CustomPageView, {
          slug: 'company-story',
          pages: customPages,
          onNavigate: () => {},
          breadcrumbs: storySeo.breadcrumbs,
          breadcrumbEnabled: storySeo.breadcrumbEnabled,
        })
      );
      const navItems = extractBreadcrumbNavFromHtml(storyMarkup);
      const storyBc = storySeo.jsonLd['@graph'].find((n) => n['@type'] === 'BreadcrumbList');
      assert.deepEqual(
        navItems.map((i) => i.label),
        storyBc.itemListElement.map((i) => i.name)
      );
      assert.deepEqual(
        navItems.map((i) => i.label),
        ['Home', 'Resources', 'Our Story']
      );

      // Unsupported schemaType for static route falls back to WebPage, and breadcrumbEnabled: false hides UI + BreadcrumbList
      const badSchemaSeo = resolvePageSeo({
        path: '/bad-schema-page/',
        seoConfig,
        settings: realSettings,
        pages: customPages,
      });
      assert.equal(badSchemaSeo.schemaType, 'WebPage');
      assert.equal(badSchemaSeo.breadcrumbEnabled, false);
      assert.equal(
        badSchemaSeo.jsonLd['@graph'].some((n) => n['@type'] === 'SoftwareApplication'),
        false
      );
      assert.equal(
        badSchemaSeo.jsonLd['@graph'].some((n) => n['@type'] === 'BreadcrumbList'),
        false
      );
      const noBcMarkup = renderToStaticMarkup(
        React.createElement(CustomPageView, {
          slug: 'bad-schema-page',
          pages: customPages,
          onNavigate: () => {},
          breadcrumbs: badSchemaSeo.breadcrumbs,
          breadcrumbEnabled: badSchemaSeo.breadcrumbEnabled,
        })
      );
      assert.equal(extractBreadcrumbNavFromHtml(noBcMarkup), null);
    } finally {
      await vite.close();
    }

    // 404 omits canonical, og:url, breadcrumbs, and indexable metadata
    const nfSeo = resolvePageSeo({
      path: '/nonexistent-custom/',
      seoConfig,
      settings: realSettings,
      pages: customPages,
    });
    assert.equal(nfSeo.notFound, true);
    assert.equal(nfSeo.canonicalUrl, null);
    assert.equal(nfSeo.ogUrl, null);
    assert.equal(nfSeo.noindex, true);
    assert.equal(nfSeo.breadcrumbEnabled, false);
    assert.deepEqual(nfSeo.breadcrumbs, []);
    assert.equal(
      nfSeo.jsonLd['@graph'].some((n) => n['@type'] === 'BreadcrumbList'),
      false
    );
  });

  it('9-12 & 16. Generates static HTML for published pages, skips unpublished, updates sitemap accurately, and preserves existing routes', () => {
    const pages = [
      makeCustomPage({
        id: 'page-indexable',
        slug: 'ai-glossary',
        title: 'AI Glossary & Terms',
        content: '# AI Glossary & Terms\n\nEssential definitions for teams adopting artificial intelligence responsibly.',
        isPublished: true,
        updatedAt: '2026-11-21T08:15:00.000Z',
      }),
      makeCustomPage({
        id: 'page-noindex',
        slug: 'internal-notes',
        title: 'Noindex Public Notes',
        content: '# Internal Notes\n\nThis custom page is published publicly but marked noindex in SEO config.',
        isPublished: true,
      }),
      makeCustomPage({
        id: 'page-draft',
        slug: 'hidden-draft-page',
        title: 'Hidden Draft Page',
        content: '# Secret\n\nMust never produce HTML or appear in sitemap.',
        isPublished: false,
      }),
    ];

    const seoConfig = structuredClone(realSeoConfig);
    seoConfig.pages['static:ai-glossary'] = {
      pageId: 'static:ai-glossary',
      pageType: 'static',
      path: '/ai-glossary/',
      slug: 'ai-glossary',
      seoTitle: 'AI Glossary SEO Title | AINOVEX',
      metaDescription: 'Complete AI glossary covering LLM, RAG, embeddings, and evaluation concepts.',
      index: true,
      follow: true,
    };
    seoConfig.pages['static:internal-notes'] = {
      pageId: 'static:internal-notes',
      pageType: 'static',
      path: '/internal-notes/',
      slug: 'internal-notes',
      index: false,
      follow: true,
    };
    // Unpublished draft tries to force index: true in seo.json -> must still be excluded
    seoConfig.pages['static:hidden-draft-page'] = {
      pageId: 'static:hidden-draft-page',
      pageType: 'static',
      path: '/hidden-draft-page/',
      slug: 'hidden-draft-page',
      index: true,
    };
    // Ghost SEO entry for a custom page missing from content/pages.json -> must be excluded
    seoConfig.pages['static:ghost-custom-page'] = {
      pageId: 'static:ghost-custom-page',
      pageType: 'static',
      path: '/ghost-custom-page/',
      slug: 'ghost-custom-page',
      index: true,
    };

    const tmpDir = createIsolatedWorkspace({ pages, seoConfig });
    try {
      runIsolatedBuildPipeline(tmpDir);

      // 9. Static HTML generated for published custom pages
      const glossaryHtmlPath = path.join(tmpDir, 'dist', 'ai-glossary', 'index.html');
      assert.ok(fs.existsSync(glossaryHtmlPath));
      const glossaryHtml = fs.readFileSync(glossaryHtmlPath, 'utf8');
      assert.match(glossaryHtml, /<title>AI Glossary SEO Title \| AINOVEX<\/title>/);
      assert.match(glossaryHtml, /<h1[^>]*>AI Glossary &amp; Terms<\/h1>/);
      assert.match(glossaryHtml, /Essential definitions for teams adopting artificial intelligence responsibly\./);
      assert.match(glossaryHtml, /<link rel="canonical" href="https:\/\/ai-novex\.netlify\.app\/ai-glossary\/"/);
      const nav = extractBreadcrumbNavFromHtml(glossaryHtml);
      const { parsed } = extractSingleJsonLdFromHtml(glossaryHtml);
      const bc = parsed['@graph'].find((n) => n['@type'] === 'BreadcrumbList');
      assert.deepEqual(
        nav.map((i) => i.label),
        bc.itemListElement.map((i) => i.name)
      );

      // Noindex published page STILL gets static HTML with noindex robots meta
      const notesHtmlPath = path.join(tmpDir, 'dist', 'internal-notes', 'index.html');
      assert.ok(fs.existsSync(notesHtmlPath));
      const notesHtml = fs.readFileSync(notesHtmlPath, 'utf8');
      assert.match(notesHtml, /<meta name="robots" content="noindex, follow"/);

      // 10. No static HTML for unpublished pages or ghost SEO pages
      assert.equal(fs.existsSync(path.join(tmpDir, 'dist', 'hidden-draft-page', 'index.html')), false);
      assert.equal(fs.existsSync(path.join(tmpDir, 'dist', 'ghost-custom-page', 'index.html')), false);

      // 11 & 12. Sitemap inclusion & exclusion
      const sitemapXml = fs.readFileSync(path.join(tmpDir, 'dist', 'sitemap.xml'), 'utf8');
      const sitemapEntries = extractSitemapUrls(sitemapXml);
      const locs = sitemapEntries.map((e) => e.loc);
      const base = 'https://ai-novex.netlify.app';

      assert.ok(locs.includes(`${base}/ai-glossary/`));
      const glossaryEntry = sitemapEntries.find((e) => e.loc === `${base}/ai-glossary/`);
      assert.equal(glossaryEntry?.lastmod, '2026-11-21');

      assert.equal(locs.includes(`${base}/internal-notes/`), false, 'noindex page excluded from sitemap');
      assert.equal(locs.includes(`${base}/hidden-draft-page/`), false, 'unpublished page excluded from sitemap');
      assert.equal(locs.includes(`${base}/ghost-custom-page/`), false, 'missing page excluded from sitemap');
      assert.equal(new Set(locs).size, locs.length, 'No duplicate URLs in sitemap');

      // 16. Existing Article, Category, Tool, Author, and built-in static routes remain intact
      assert.ok(locs.includes(`${base}/`));
      assert.ok(locs.includes(`${base}/about/`));
      assert.ok(locs.includes(`${base}/tools/`));
      assert.ok(locs.includes(`${base}/tools/chatgpt/`));
      assert.ok(locs.includes(`${base}/blog/`));
      assert.ok(locs.includes(`${base}/blog/best-free-ai-tools-2026/`));
      assert.ok(locs.includes(`${base}/category/productivity/`));
      assert.ok(locs.includes(`${base}/author/md-shamim/`));
      assert.ok(fs.existsSync(path.join(tmpDir, 'dist', 'about', 'index.html')));
      assert.ok(fs.existsSync(path.join(tmpDir, 'dist', 'tools', 'chatgpt', 'index.html')));
      assert.ok(fs.existsSync(path.join(tmpDir, 'dist', 'blog', 'best-free-ai-tools-2026', 'index.html')));
      assert.ok(fs.existsSync(path.join(tmpDir, 'dist', 'category', 'productivity', 'index.html')));
      assert.ok(fs.existsSync(path.join(tmpDir, 'dist', 'author', 'md-shamim', 'index.html')));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('13-14. Enforces duplicate slug, reserved collision, path traversal, corrupt JSON, and unsafe URL protections across build & sitemap', () => {
    const base = 'https://ai-novex.netlify.app';

    // 13a. Duplicate slug must fail postbuild and be excluded from finalize-sitemap & runtime resolution
    const dupPages = [
      makeCustomPage({ id: 'dup-1', slug: 'dup-page', title: 'Duplicate One' }),
      makeCustomPage({ id: 'dup-2', slug: 'dup-page', title: 'Duplicate Two' }),
    ];
    assert.equal(findPublishedCustomPageBySlug('dup-page', dupPages), null);
    assert.deepEqual(getRenderablePublishedCustomPages(dupPages), []);

    const tmpDup = createIsolatedWorkspace({ pages: dupPages });
    try {
      const postRes = spawnSync(process.execPath, [path.join(REPO_ROOT, 'scripts', 'postbuild.mjs')], {
        cwd: tmpDup,
        encoding: 'utf8',
      });
      assert.notEqual(postRes.status, 0, 'postbuild must fail on duplicate custom page slugs');
      assert.equal(fs.existsSync(path.join(tmpDup, 'dist', 'dup-page', 'index.html')), false);

      // finalize-sitemap excludes duplicate slugs safely
      const { entries } = runFinalizeSitemap(tmpDup);
      assert.equal(entries.has(`${base}/dup-page/`), false);
    } finally {
      fs.rmSync(tmpDup, { recursive: true, force: true });
    }

    // 14a. Path traversal & reserved slug must fail postbuild and write nothing outside or inside dist
    for (const badSlug of ['../../evil-escape', '../secret', 'tools', 'about', 'api/v1']) {
      const tmpBad = createIsolatedWorkspace({
        pages: [makeCustomPage({ id: 'bad-slug-id', slug: badSlug, title: 'Bad Slug' })],
      });
      try {
        const postRes = spawnSync(process.execPath, [path.join(REPO_ROOT, 'scripts', 'postbuild.mjs')], {
          cwd: tmpBad,
          encoding: 'utf8',
        });
        assert.notEqual(postRes.status, 0, `postbuild must reject bad slug "${badSlug}"`);
        assert.equal(fs.existsSync(path.join(tmpBad, 'evil-escape', 'index.html')), false);

        const { entries } = runFinalizeSitemap(tmpBad);
        const allLocs = [...entries.keys()];
        assert.equal(allLocs.some((u) => u.includes('evil-escape') || u.includes('secret')), false);
      } finally {
        fs.rmSync(tmpBad, { recursive: true, force: true });
      }
    }

    // 14b. Corrupt JSON in content/pages.json must fail postbuild (not silently skipped)
    const tmpCorrupt = createIsolatedWorkspace({ rawPagesText: '{ corrupt json !!!' });
    try {
      const postRes = spawnSync(process.execPath, [path.join(REPO_ROOT, 'scripts', 'postbuild.mjs')], {
        cwd: tmpCorrupt,
        encoding: 'utf8',
      });
      assert.notEqual(postRes.status, 0, 'postbuild must fail on corrupt content/pages.json');
    } finally {
      fs.rmSync(tmpCorrupt, { recursive: true, force: true });
    }

    // 14c. Unsafe / cross-origin canonical URLs on custom page rejected in SEO & sitemap
    const unsafeCanonPages = [
      makeCustomPage({ id: 'p-js-canon', slug: 'js-canon', title: 'JS Canonical Page' }),
      makeCustomPage({ id: 'p-ext-canon', slug: 'ext-canon', title: 'External Canonical Page' }),
    ];
    const unsafeSeo = structuredClone(realSeoConfig);
    unsafeSeo.pages['static:js-canon'] = {
      pageId: 'static:js-canon',
      pageType: 'static',
      path: '/js-canon/',
      slug: 'js-canon',
      canonicalUrl: 'javascript:alert(1)',
    };
    unsafeSeo.pages['static:ext-canon'] = {
      pageId: 'static:ext-canon',
      pageType: 'static',
      path: '/ext-canon/',
      slug: 'ext-canon',
      canonicalUrl: 'https://evil.example.org/hijacked/',
    };

    const tmpCanon = createIsolatedWorkspace({ pages: unsafeCanonPages, seoConfig: unsafeSeo });
    try {
      runIsolatedBuildPipeline(tmpCanon);
      const jsHtml = fs.readFileSync(path.join(tmpCanon, 'dist', 'js-canon', 'index.html'), 'utf8');
      assert.doesNotMatch(jsHtml, /javascript:/i);
      assert.match(jsHtml, /<link rel="canonical" href="https:\/\/ai-novex\.netlify\.app\/js-canon\/"/);

      const sitemapXml = fs.readFileSync(path.join(tmpCanon, 'dist', 'sitemap.xml'), 'utf8');
      const locs = extractSitemapUrls(sitemapXml).map((e) => e.loc);
      assert.equal(locs.some((u) => u.includes('javascript:')), false);
      assert.equal(locs.some((u) => u.includes('evil.example.org')), false);
      assert.ok(locs.includes(`${base}/js-canon/`));
      assert.ok(locs.includes(`${base}/ext-canon/`));
    } finally {
      fs.rmSync(tmpCanon, { recursive: true, force: true });
    }
  });

  it('15-16. Cleans up stale metadata across client-side navigation and preserves App.tsx SSR regression routes', async () => {
    const customPages = [
      makeCustomPage({
        id: 'p-nav-1',
        slug: 'ai-glossary',
        title: 'AI Glossary',
        content: '# AI Glossary\n\nComprehensive guide to key artificial intelligence concepts.',
      }),
    ];

    const vite = await createViteSsr();
    const origWindow = globalThis.window;
    try {
      const { resolveAndApplyRouteSeo } = await vite.ssrLoadModule('/src/utils/seo.ts');
      const doc = createFakeDocumentFromHtml(indexHtmlTemplate);

      // Navigate 1: Article route adds article:* tags + og:type=article
      resolveAndApplyRouteSeo(
        {
          path: '/blog/best-free-ai-tools-2026/',
          seoConfig: realSeoConfig,
          settings: realSettings,
          articles: realArticles,
          categories: realCategories,
          tools: realTools,
          pages: customPages,
        },
        doc
      );
      assert.equal(getMetaContent(doc, 'property', 'og:type'), 'article');
      assert.ok(doc.head.querySelectorAll('meta[property^="article:"]').length > 0);

      // Navigate 2: Custom static page clears all article:* tags, updates canonical, og:url, og:type=website, JSON-LD
      resolveAndApplyRouteSeo(
        {
          path: '/ai-glossary/',
          seoConfig: realSeoConfig,
          settings: realSettings,
          articles: realArticles,
          categories: realCategories,
          tools: realTools,
          pages: customPages,
        },
        doc
      );
      assert.equal(doc.head.querySelectorAll('meta[property^="article:"]').length, 0);
      assert.equal(getMetaContent(doc, 'property', 'og:type'), 'website');
      assert.equal(getCanonicalHref(doc), 'https://ai-novex.netlify.app/ai-glossary/');
      assert.equal(getMetaContent(doc, 'property', 'og:url'), 'https://ai-novex.netlify.app/ai-glossary/');
      assert.equal(doc.title, 'AI Glossary | AINOVEX');
      assert.equal(doc.head.querySelectorAll('script[type="application/ld+json"]').length, 1);

      // Navigate 3: Missing page (404) strips canonical and og:url and sets noindex
      resolveAndApplyRouteSeo(
        {
          path: '/missing-custom-page/',
          seoConfig: realSeoConfig,
          settings: realSettings,
          articles: realArticles,
          categories: realCategories,
          tools: realTools,
          pages: customPages,
        },
        doc
      );
      assert.equal(doc.head.querySelectorAll('link[rel="canonical"]').length, 0);
      assert.equal(doc.head.querySelectorAll('meta[property="og:url"]').length, 0);
      assert.equal(getMetaContent(doc, 'name', 'robots'), 'noindex, follow');

      // Navigate 4: Back to Tool / Home restores clean canonical & SEO
      resolveAndApplyRouteSeo(
        {
          path: '/tools/chatgpt/',
          seoConfig: realSeoConfig,
          settings: realSettings,
          articles: realArticles,
          categories: realCategories,
          tools: realTools,
          pages: customPages,
        },
        doc
      );
      assert.equal(getCanonicalHref(doc), 'https://ai-novex.netlify.app/tools/chatgpt/');
      assert.match(getMetaContent(doc, 'name', 'robots'), /^index, follow/);

      // 16. Full App.tsx SSR regression check for built-in routes and 404
      globalThis.window = {
        location: { pathname: '/about/', search: '' },
        matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
        addEventListener() {},
        removeEventListener() {},
        history: { pushState() {} },
        scrollTo() {},
      };
      const { default: App } = await vite.ssrLoadModule('/src/App.tsx');
      const aboutMarkup = renderToStaticMarkup(React.createElement(App));
      assert.match(aboutMarkup, /Empowering Creators with Artificial Intelligence/);

      globalThis.window.location.pathname = '/blog/best-free-ai-tools-2026/';
      const articleMarkup = renderToStaticMarkup(React.createElement(App));
      assert.match(articleMarkup, /Best Free AI Tools in 2026/);

      globalThis.window.location.pathname = '/tools/chatgpt/';
      const toolMarkup = renderToStaticMarkup(React.createElement(App));
      assert.match(toolMarkup, /<h1[^>]*>ChatGPT<\/h1>/);

      globalThis.window.location.pathname = '/author/md-shamim/';
      const authorMarkup = renderToStaticMarkup(React.createElement(App));
      assert.match(authorMarkup, /Md Shamim/);

      globalThis.window.location.pathname = '/does-not-exist-custom/';
      const missingMarkup = renderToStaticMarkup(React.createElement(App));
      assert.match(missingMarkup, /404 - Page Not Found/);
    } finally {
      if (origWindow === undefined) {
        delete globalThis.window;
      } else {
        globalThis.window = origWindow;
      }
      await vite.close();
    }
  });
});
