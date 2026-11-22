import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';

import { resolvePageSeo } from '../src/utils/pageSeo.js';
import { isIndexable, isPublishedTool, isValidToolSlug } from '../src/config/indexing.js';
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
          const attrMatches = [...part.matchAll(/\[([a-zA-Z0-9_:-]+)="([^"]*)"\]/g)];
          return attrMatches.every((am) => el.getAttribute(am[1]) === am[2]);
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
  seoConfig = realSeoConfig,
  rawSeoText = null,
  omitSeoFile = false,
} = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ainovex-tool-detail-seo-'));
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

  if (!omitSeoFile) {
    if (rawSeoText !== null) {
      fs.writeFileSync(path.join(contentDir, 'seo.json'), rawSeoText);
    } else if (seoConfig !== undefined) {
      fs.writeFileSync(path.join(contentDir, 'seo.json'), JSON.stringify(seoConfig, null, 2));
    }
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

function extractSitemapLocs(xml) {
  return [...xml.matchAll(/<loc>([^<]*)<\/loc>/g)].map((m) => decodeHtmlEntities(m[1]));
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

describe('Task 114-G — Individual Tool Pages & Complete Page-Level SEO Integration', () => {
  it('1-5. Routes valid Tools to individual pages, renders 404 for missing/invalid/unpublished tools, and preserves Tools directory', async () => {
    const vite = await createViteSsr();
    const origWindow = globalThis.window;
    try {
      const { ToolDetailView } = await vite.ssrLoadModule('/src/views/ToolDetailView.tsx');
      const { ToolsView } = await vite.ssrLoadModule('/src/views/ToolsView.tsx');

      // 1 & 2. Valid individual tool pages resolve distinctly for multiple tools
      for (const target of [realTools[0], realTools[4], realTools[6]]) {
        const html = renderToStaticMarkup(
          React.createElement(ToolDetailView, {
            slug: target.slug,
            tools: realTools,
            categories: realCategories,
            onNavigate: () => {},
          })
        );
        assert.match(html, new RegExp(`<h1[^>]*>${target.name}</h1>`));
        assert.match(html, /href="\/tools\/"/);
        assert.match(html, new RegExp(`href="${target.url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`));
        assert.match(html, new RegExp(`>${target.rating}<`));
      }

      // 3. Missing and invalid tool slugs render safe 404 UI
      for (const badSlug of ['nonexistent-tool', '../etc/passwd', 'bad_slug', 'a']) {
        const notFoundHtml = renderToStaticMarkup(
          React.createElement(ToolDetailView, {
            slug: badSlug,
            tools: realTools,
            categories: realCategories,
            onNavigate: () => {},
          })
        );
        assert.match(notFoundHtml, /Tool Not Found/);
        assert.match(notFoundHtml, /href="\/tools\/"/);
        assert.doesNotMatch(notFoundHtml, /etc\/passwd/);
      }

      // 4. Unpublished tool is inaccessible via ToolDetailView and App.tsx router
      const toolsWithUnpublished = [
        ...realTools,
        {
          ...realTools[0],
          id: 'draft-tool',
          name: 'Hidden Draft Tool',
          slug: 'hidden-draft-tool',
          isPublished: false,
        },
      ];
      const draftViewHtml = renderToStaticMarkup(
        React.createElement(ToolDetailView, {
          slug: 'hidden-draft-tool',
          tools: toolsWithUnpublished,
          categories: realCategories,
          onNavigate: () => {},
        })
      );
      assert.match(draftViewHtml, /Tool Not Found/);
      assert.doesNotMatch(draftViewHtml, /Hidden Draft Tool/);

      // Full App.tsx SSR check on /tools/chatgpt/ and /tools/missing-tool/
      globalThis.window = {
        location: { pathname: '/tools/chatgpt/', search: '' },
        matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
        addEventListener() {},
        removeEventListener() {},
        history: { pushState() {} },
        scrollTo() {},
      };
      const { default: App } = await vite.ssrLoadModule('/src/App.tsx');
      const appToolHtml = renderToStaticMarkup(React.createElement(App));
      assert.match(appToolHtml, /<h1[^>]*>ChatGPT<\/h1>/);
      assert.match(appToolHtml, /aria-label="Breadcrumb"/);
      assert.match(appToolHtml, /href="\/tools\/"/);

      globalThis.window.location.pathname = '/tools/does-not-exist/';
      const app404Html = renderToStaticMarkup(React.createElement(App));
      assert.match(app404Html, /Tool Not Found/);

      // 5. Existing Tools directory remains functional with preserved ratings
      const dirHtml = renderToStaticMarkup(
        React.createElement(ToolsView, {
          tools: realTools,
          categories: realCategories,
          onNavigate: () => {},
          onSelectTool: () => {},
        })
      );
      assert.match(dirHtml, /Explore All AI Tools &amp; Software/);
      assert.match(dirHtml, /ChatGPT/);
      assert.match(dirHtml, /<span>4\.9<\/span>/);
      assert.match(dirHtml, /Visit Tool/);
    } finally {
      if (origWindow === undefined) {
        delete globalThis.window;
      } else {
        globalThis.window = origWindow;
      }
      await vite.close();
    }
  });

  it('6-9. Applies tool-specific SEO overrides, prevents cross-tool leakage, and validates canonical/robots metadata', async () => {
    const seoConfig = structuredClone(realSeoConfig);
    seoConfig.pages['tool:chatgpt'] = {
      pageId: 'tool:chatgpt',
      pageType: 'tool',
      path: '/tools/chatgpt/',
      slug: 'chatgpt',
      seoTitle: 'ChatGPT Custom SEO Title | AINOVEX',
      metaDescription: 'Custom meta description for ChatGPT tool review and features.',
      focusKeyword: 'chatgpt ai review',
      secondaryKeywords: ['openai chatgpt', 'conversational ai'],
      canonicalUrl: 'https://ai-novex.netlify.app/tools/chatgpt-custom/',
      index: true,
      follow: false,
      ogTitle: 'ChatGPT OG Title',
      ogDescription: 'ChatGPT OG Description',
      ogImage: '/images/og-default.png',
      ogImageAlt: 'ChatGPT OG Alt',
      twitterTitle: 'ChatGPT Twitter Title',
      twitterDescription: 'ChatGPT Twitter Description',
      twitterImage: '/images/og-default.png',
      twitterCard: 'summary',
      twitterImageAlt: 'ChatGPT Twitter Alt',
      schemaType: 'SoftwareApplication',
      breadcrumb: {
        enabled: true,
        items: [
          { name: 'Home', path: '/' },
          { name: 'Directory', path: '/tools/' },
          { name: 'ChatGPT Guide', path: '/tools/chatgpt/' },
        ],
      },
    };
    seoConfig.pages['tool:claude'] = {
      pageId: 'tool:claude',
      pageType: 'tool',
      path: '/tools/claude/',
      slug: 'claude',
      seoTitle: 'Claude Review | AINOVEX',
      metaDescription: 'Claude AI review page set to noindex for testing.',
      canonicalUrl: 'javascript:alert(1)',
      index: false,
      follow: true,
    };
    // Attempt cross-tool leakage using mismatched pageId/slug pointing to midjourney's path
    seoConfig.pages['tool:leaked'] = {
      pageId: 'tool:chatgpt',
      pageType: 'tool',
      path: '/tools/midjourney/',
      slug: 'chatgpt',
      seoTitle: 'LEAKED TITLE DO NOT USE',
    };

    const vite = await createViteSsr();
    try {
      const { resolveAndApplyRouteSeo } = await vite.ssrLoadModule('/src/utils/seo.ts');
      const doc = createFakeDocumentFromHtml(indexHtmlTemplate);

      // 6. Overridden tool:chatgpt
      const chatRes = resolveAndApplyRouteSeo(
        {
          path: '/tools/chatgpt/',
          seoConfig,
          settings: realSettings,
          articles: realArticles,
          categories: realCategories,
          tools: realTools,
        },
        doc
      );
      assert.equal(chatRes.pageId, 'tool:chatgpt');
      assert.equal(chatRes.title, 'ChatGPT Custom SEO Title | AINOVEX');
      assert.equal(chatRes.focusKeyword, 'chatgpt ai review');
      assert.deepEqual(chatRes.secondaryKeywords, ['openai chatgpt', 'conversational ai']);
      assert.equal(doc.title, 'ChatGPT Custom SEO Title | AINOVEX');
      assert.equal(getMetaContent(doc, 'name', 'description'), 'Custom meta description for ChatGPT tool review and features.');
      assert.equal(getMetaContent(doc, 'name', 'robots'), 'index, nofollow, max-image-preview:large, max-snippet:-1, max-video-preview:-1');
      assert.equal(getCanonicalHref(doc), 'https://ai-novex.netlify.app/tools/chatgpt-custom/');
      assert.equal(getMetaContent(doc, 'property', 'og:title'), 'ChatGPT OG Title');
      assert.equal(getMetaContent(doc, 'property', 'og:image:alt'), 'ChatGPT OG Alt');
      assert.equal(getMetaContent(doc, 'name', 'twitter:card'), 'summary');
      assert.equal(getMetaContent(doc, 'name', 'twitter:title'), 'ChatGPT Twitter Title');
      assert.equal(getMetaContent(doc, 'name', 'twitter:image:alt'), 'ChatGPT Twitter Alt');

      // 7 & 8. Navigating to Midjourney must NOT inherit ChatGPT overrides or leaked record
      const midRes = resolveAndApplyRouteSeo(
        {
          path: '/tools/midjourney/',
          seoConfig,
          settings: realSettings,
          articles: realArticles,
          categories: realCategories,
          tools: realTools,
        },
        doc
      );
      assert.equal(midRes.pageId, 'tool:midjourney');
      assert.equal(midRes.title, 'Midjourney - AI Tool Review, Pricing & Overview | AINOVEX');
      assert.notEqual(midRes.title, 'LEAKED TITLE DO NOT USE');
      assert.equal(doc.title, 'Midjourney - AI Tool Review, Pricing & Overview | AINOVEX');
      assert.equal(getCanonicalHref(doc), 'https://ai-novex.netlify.app/tools/midjourney/');
      assert.match(getMetaContent(doc, 'name', 'robots'), /^index, follow/);
      assert.equal(getMetaContent(doc, 'name', 'twitter:card'), 'summary_large_image');

      // 9. Tool with noindex + unsafe canonical falls back canonical cleanly and sets noindex
      const claudeRes = resolveAndApplyRouteSeo(
        {
          path: '/tools/claude/',
          seoConfig,
          settings: realSettings,
          articles: realArticles,
          categories: realCategories,
          tools: realTools,
        },
        doc
      );
      assert.equal(claudeRes.noindex, true);
      assert.equal(getMetaContent(doc, 'name', 'robots'), 'noindex, follow');
      assert.equal(getCanonicalHref(doc), 'https://ai-novex.netlify.app/tools/claude/');

      // 404 omits canonical & og:url & stale tool tags
      const nfRes = resolveAndApplyRouteSeo(
        {
          path: '/tools/missing-slug/',
          seoConfig,
          settings: realSettings,
          articles: realArticles,
          categories: realCategories,
          tools: realTools,
        },
        doc
      );
      assert.equal(nfRes.notFound, true);
      assert.equal(getMetaContent(doc, 'name', 'robots'), 'noindex, follow');
      assert.equal(doc.head.querySelectorAll('link[rel="canonical"]').length, 0);
      assert.equal(doc.head.querySelectorAll('meta[property="og:url"]').length, 0);
    } finally {
      await vite.close();
    }
  });

  it('10-12. Enforces non-invented SoftwareApplication fields, JSON-LD escaping/dedup, and breadcrumb UI/JSON-LD parity', async () => {
    const customTools = [
      ...realTools,
      {
        id: 'minimal-tool',
        name: 'Minimal Tool',
        slug: 'minimal-tool',
        url: 'https://minimal.example.com',
        category: 'ai-writing',
        categoryName: 'AI Writing',
        tags: [],
        pricing: 'Free',
        isFeatured: false,
        icon: '/images/chatgpt.svg',
        // No description and no longDescription -> must fall back to WebPage
      },
      {
        id: 'xss-tool',
        name: 'AI <Tools> & Co',
        slug: 'xss-tool',
        url: 'https://xss.example.com',
        description: 'Handles <tags> & \u2028 line separator safely.',
        category: 'code-dev',
        categoryName: 'Code & Dev',
        tags: ['Code'],
        pricing: 'Free',
        isFeatured: false,
        icon: '/images/cursor.svg',
      },
    ];

    // 10. Real tool SoftwareApplication never invents operatingSystem, offers/price, reviewCount, or aggregateRating
    const chatRes = resolvePageSeo({
      path: '/tools/chatgpt/',
      seoConfig: realSeoConfig,
      settings: realSettings,
      articles: realArticles,
      categories: realCategories,
      tools: customTools,
    });
    const chatOrg = chatRes.jsonLd['@graph'].find((n) => n['@type'] === 'Organization');
    const chatSite = chatRes.jsonLd['@graph'].find((n) => n['@type'] === 'WebSite');
    const chatToolNode = chatRes.jsonLd['@graph'].find((n) => n['@type'] === 'SoftwareApplication');
    const chatBcNode = chatRes.jsonLd['@graph'].find((n) => n['@type'] === 'BreadcrumbList');
    assert.ok(chatOrg && chatSite && chatToolNode && chatBcNode);
    assert.equal(chatToolNode.operatingSystem, undefined);
    assert.equal(chatToolNode.offers, undefined);
    assert.equal(chatToolNode.aggregateRating, undefined);
    assert.equal(chatToolNode.featureList, undefined);
    assert.equal(chatToolNode.applicationCategory, 'AI Writing');

    // Default breadcrumb hierarchy: Home -> Tools -> ChatGPT
    assert.deepEqual(chatRes.breadcrumbs, [
      { label: 'Tools', path: '/tools/' },
      { label: 'ChatGPT' },
    ]);
    assert.deepEqual(
      chatBcNode.itemListElement.map((i) => ({ name: i.name, item: i.item })),
      [
        { name: 'Home', item: 'https://ai-novex.netlify.app/' },
        { name: 'Tools', item: 'https://ai-novex.netlify.app/tools/' },
        { name: 'ChatGPT', item: 'https://ai-novex.netlify.app/tools/chatgpt/' },
      ]
    );

    // Unsupported tool falls back to WebPage
    const minimalRes = resolvePageSeo({
      path: '/tools/minimal-tool/',
      seoConfig: realSeoConfig,
      settings: realSettings,
      articles: realArticles,
      categories: realCategories,
      tools: customTools,
    });
    assert.equal(minimalRes.schemaType, 'WebPage');
    assert.equal(
      minimalRes.jsonLd['@graph'].some((n) => n['@type'] === 'SoftwareApplication'),
      false
    );

    // 11. JSON-LD escaping, unsafe customStructuredData rejection, & duplicate script prevention in client runtime
    const vite = await createViteSsr();
    try {
      const { resolveAndApplyRouteSeo } = await vite.ssrLoadModule('/src/utils/seo.ts');
      const doc = createFakeDocumentFromHtml(indexHtmlTemplate);

      // Seed duplicate stale script
      const dupScript = createFakeElement('script');
      dupScript.setAttribute('type', 'application/ld+json');
      dupScript.textContent = '{"@type":"Product"}';
      doc.head.appendChild(dupScript);

      const badLdConfig = structuredClone(realSeoConfig);
      badLdConfig.pages['tool:xss-tool'] = {
        pageId: 'tool:xss-tool',
        pageType: 'tool',
        path: '/tools/xss-tool/',
        slug: 'xss-tool',
        schemaType: 'Custom',
        customStructuredData: {
          '@type': 'SoftwareApplication',
          name: '</script><script>alert(1)</script><!--',
        },
      };

      const xssRes = resolveAndApplyRouteSeo(
        {
          path: '/tools/xss-tool/',
          seoConfig: badLdConfig,
          settings: realSettings,
          articles: realArticles,
          categories: realCategories,
          tools: customTools,
        },
        doc
      );
      // Dangerous </script> customStructuredData was rejected so schemaType fell back safely
      assert.equal(xssRes.schemaType, 'SoftwareApplication');
      const scripts = doc.head.querySelectorAll('script[type="application/ld+json"]');
      assert.equal(scripts.length, 1);
      assert.doesNotMatch(scripts[0].textContent, /[<>]/);
      assert.doesNotMatch(scripts[0].textContent, /&/);
      assert.equal(scripts[0].textContent.includes('\u2028'), false);
      const parsedLd = JSON.parse(scripts[0].textContent);
      assert.equal(parsedLd['@graph'].some((n) => n['@type'] === 'Product'), false);
      const safeNode = parsedLd['@graph'].find((n) => n['@type'] === 'SoftwareApplication');
      assert.equal(safeNode.name, 'AI <Tools> & Co');

      // 12. Breadcrumb UI & JSON-LD parity with override
      const bcSeoConfig = structuredClone(realSeoConfig);
      bcSeoConfig.pages['tool:runway'] = {
        pageId: 'tool:runway',
        pageType: 'tool',
        path: '/tools/runway/',
        slug: 'runway',
        breadcrumb: {
          enabled: true,
          items: [
            { name: 'Home', path: '/' },
            { name: 'AI Directory', path: '/tools/' },
            { name: 'Runway Studio', path: '/tools/runway/' },
          ],
        },
      };
      const runwayRes = resolveAndApplyRouteSeo(
        {
          path: '/tools/runway/',
          seoConfig: bcSeoConfig,
          settings: realSettings,
          articles: realArticles,
          categories: realCategories,
          tools: customTools,
        },
        doc
      );
      const { ToolDetailView } = await vite.ssrLoadModule('/src/views/ToolDetailView.tsx');
      const markup = renderToStaticMarkup(
        React.createElement(ToolDetailView, {
          slug: 'runway',
          tools: customTools,
          categories: realCategories,
          onNavigate: () => {},
          breadcrumbs: runwayRes.breadcrumbs,
          breadcrumbEnabled: runwayRes.breadcrumbEnabled,
        })
      );
      const navItems = extractBreadcrumbNavFromHtml(markup);
      const ldItems = runwayRes.jsonLd['@graph'].find((n) => n['@type'] === 'BreadcrumbList').itemListElement;
      assert.deepEqual(
        navItems.map((n) => n.label),
        ldItems.map((l) => l.name)
      );
      assert.deepEqual(
        navItems.map((n) => n.label),
        ['Home', 'AI Directory', 'Runway Studio']
      );
    } finally {
      await vite.close();
    }
  });

  it('13-18. Generates deterministic static HTML & sitemap entries, enforces noindex/unpublished/traversal/unsafe URL security, and preserves existing routes', () => {
    const toolsMixed = [
      ...realTools,
      {
        id: 'draft-tool',
        name: 'Draft Secret Tool',
        slug: 'draft-secret-tool',
        url: 'https://draft.example.com',
        description: 'Must never appear publicly.',
        category: 'ai-writing',
        categoryName: 'AI Writing',
        tags: [],
        pricing: 'Free',
        isFeatured: false,
        icon: '/images/chatgpt.svg',
        isPublished: false,
      },
      {
        id: 'traversal-tool',
        name: 'Traversal Evil Tool',
        slug: '../../evil-traversal',
        url: 'https://evil.example.com',
        description: 'Traversal slug must be rejected.',
        category: 'ai-writing',
        categoryName: 'AI Writing',
        tags: [],
        pricing: 'Free',
        isFeatured: false,
        icon: '/images/chatgpt.svg',
      },
      {
        id: 'unsafe-links-tool',
        name: 'Unsafe Links Tool',
        slug: 'unsafe-links-tool',
        url: 'javascript:alert(1)',
        description: 'Published tool with unsafe url and icon schemes.',
        category: 'ai-writing',
        categoryName: 'AI Writing',
        tags: [],
        pricing: 'Free',
        isFeatured: false,
        icon: 'data:text/html,<script>alert(1)</script>',
        rating: undefined,
      },
    ];

    const seoConfig = structuredClone(realSeoConfig);
    seoConfig.pages['tool:claude'] = {
      pageId: 'tool:claude',
      pageType: 'tool',
      path: '/tools/claude/',
      slug: 'claude',
      index: false,
      follow: true,
    };
    seoConfig.pages['tool:draft-secret-tool'] = {
      pageId: 'tool:draft-secret-tool',
      pageType: 'tool',
      path: '/tools/draft-secret-tool/',
      slug: 'draft-secret-tool',
      index: true,
    };
    seoConfig.pages['tool:cursor'] = {
      pageId: 'tool:cursor',
      pageType: 'tool',
      path: '/tools/cursor/',
      slug: 'cursor',
      canonicalUrl: 'https://ai-novex.netlify.app/tools/cursor-ide/',
    };
    seoConfig.pages['tool:leonardo-ai'] = {
      pageId: 'tool:leonardo-ai',
      pageType: 'tool',
      path: '/tools/leonardo-ai/',
      slug: 'leonardo-ai',
      canonicalUrl: 'https://evil.example.org/hijacked/',
    };

    const tmpDir = createIsolatedWorkspace({ tools: toolsMixed, seoConfig });
    try {
      // Run full static build + finalize-sitemap TWICE for determinism check (18)
      runIsolatedBuildPipeline(tmpDir);
      const firstChatHtml = fs.readFileSync(
        path.join(tmpDir, 'dist', 'tools', 'chatgpt', 'index.html'),
        'utf8'
      );
      const firstSitemap = fs.readFileSync(path.join(tmpDir, 'dist', 'sitemap.xml'), 'utf8');

      runIsolatedBuildPipeline(tmpDir);
      const secondChatHtml = fs.readFileSync(
        path.join(tmpDir, 'dist', 'tools', 'chatgpt', 'index.html'),
        'utf8'
      );
      const secondSitemap = fs.readFileSync(path.join(tmpDir, 'dist', 'sitemap.xml'), 'utf8');

      assert.equal(secondChatHtml, firstChatHtml);
      assert.equal(secondSitemap, firstSitemap);

      // 13. Static HTML exists for published tools with matching metadata, breadcrumbs, JSON-LD, back link
      for (const tool of realTools) {
        const htmlPath = path.join(tmpDir, 'dist', 'tools', tool.slug, 'index.html');
        assert.ok(fs.existsSync(htmlPath), `Missing static HTML for ${tool.slug}`);
        const html = fs.readFileSync(htmlPath, 'utf8');
        assert.match(html, /href="\/tools\/"/);
        const nav = extractBreadcrumbNavFromHtml(html);
        const { parsed } = extractSingleJsonLdFromHtml(html);
        const bc = parsed['@graph'].find((n) => n['@type'] === 'BreadcrumbList');
        assert.deepEqual(
          nav.map((i) => i.label),
          bc.itemListElement.map((i) => i.name)
        );
      }

      // Unpublished & traversal tools must NOT exist in dist/
      assert.equal(
        fs.existsSync(path.join(tmpDir, 'dist', 'tools', 'draft-secret-tool', 'index.html')),
        false
      );
      assert.equal(fs.existsSync(path.join(tmpDir, 'evil-traversal', 'index.html')), false);

      // 17. Unsafe external url & icon omitted from generated HTML & JSON-LD, and missing rating not invented
      const unsafeToolHtml = fs.readFileSync(
        path.join(tmpDir, 'dist', 'tools', 'unsafe-links-tool', 'index.html'),
        'utf8'
      );
      assert.doesNotMatch(unsafeToolHtml, /javascript:/i);
      assert.doesNotMatch(unsafeToolHtml, /data:text\/html/i);
      assert.doesNotMatch(unsafeToolHtml, /&#9733;\s*4\.8/);

      // 14 & 15. Sitemap checks
      const locs = extractSitemapLocs(secondSitemap);
      const base = 'https://ai-novex.netlify.app';
      assert.ok(locs.includes(`${base}/tools/chatgpt/`));
      assert.ok(locs.includes(`${base}/tools/cursor-ide/`), 'Valid same-origin custom canonical used in sitemap');
      assert.ok(locs.includes(`${base}/tools/leonardo-ai/`), 'Cross-origin canonical falls back to route URL in sitemap');
      assert.equal(locs.includes(`${base}/tools/claude/`), false, 'noindex tool excluded from sitemap');
      assert.equal(locs.includes(`${base}/tools/draft-secret-tool/`), false, 'unpublished tool excluded from sitemap');
      assert.equal(locs.some((u) => u.includes('evil-traversal')), false);
      assert.equal(locs.some((u) => u.includes('evil.example.org')), false);
      assert.equal(new Set(locs).size, locs.length);

      // 16. Existing article, category, author, and static routes remain intact in dist/ and sitemap
      assert.ok(locs.includes(`${base}/`));
      assert.ok(locs.includes(`${base}/tools/`));
      assert.ok(locs.includes(`${base}/blog/`));
      assert.ok(locs.includes(`${base}/blog/best-free-ai-tools-2026/`));
      assert.ok(locs.includes(`${base}/category/productivity/`));
      assert.ok(locs.includes(`${base}/author/md-shamim/`));
      assert.ok(fs.existsSync(path.join(tmpDir, 'dist', 'blog', 'best-free-ai-tools-2026', 'index.html')));
      assert.ok(fs.existsSync(path.join(tmpDir, 'dist', 'category', 'productivity', 'index.html')));
      assert.ok(fs.existsSync(path.join(tmpDir, 'dist', 'author', 'md-shamim', 'index.html')));
      assert.ok(fs.existsSync(path.join(tmpDir, 'dist', 'tools', 'index.html')));

      // Helper sanity checks
      assert.equal(isValidToolSlug('chatgpt'), true);
      assert.equal(isValidToolSlug('../bad'), false);
      assert.equal(isPublishedTool({ slug: 'ok', name: 'Ok', isPublished: false }), false);
      assert.equal(isIndexable('/tools/chatgpt/', { articles: realArticles, categories: realCategories, tools: toolsMixed }), true);
      assert.equal(isIndexable('/tools/draft-secret-tool/', { articles: realArticles, categories: realCategories, tools: toolsMixed }), false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
