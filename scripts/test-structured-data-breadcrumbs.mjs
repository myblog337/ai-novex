import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';

import {
  buildPageJsonLd,
  escapeJsonLd,
  isSafeStructuredData,
  resolvePageSeo,
} from '../src/utils/pageSeo.js';
import { applyResolvedSeoToHtml } from './postbuild.mjs';

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

function createIsolatedWorkspace({
  seoConfig = realSeoConfig,
  rawSeoText = null,
  omitSeoFile = false,
  settings = realSettings,
  templateHtml = indexHtml,
} = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ainovex-sd-bc-test-'));
  const distDir = path.join(tmpDir, 'dist');
  const contentDir = path.join(tmpDir, 'content');
  const articlesDir = path.join(contentDir, 'articles');
  const publicDir = path.join(tmpDir, 'public');

  fs.mkdirSync(distDir, { recursive: true });
  fs.mkdirSync(articlesDir, { recursive: true });
  fs.cpSync(path.join(REPO_ROOT, 'public'), publicDir, { recursive: true });

  fs.writeFileSync(path.join(distDir, 'index.html'), templateHtml);

  for (const file of ['categories.json', 'tools.json', 'articles.json', 'ads.json']) {
    fs.copyFileSync(path.join(REPO_ROOT, 'content', file), path.join(contentDir, file));
  }
  fs.writeFileSync(path.join(contentDir, 'settings.json'), JSON.stringify(settings, null, 2));

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

function runIsolatedPostbuild(tmpDir) {
  execFileSync(process.execPath, [path.join(REPO_ROOT, 'scripts', 'postbuild.mjs')], {
    cwd: tmpDir,
    stdio: 'pipe',
  });
}

function extractHead(html) {
  const m = html.match(/<head\b[^>]*>([\s\S]*?)<\/head>/i);
  assert.ok(m, 'Expected <head>...</head> in HTML');
  return m[1];
}

function getJsonLdScriptContents(html) {
  const head = extractHead(html);
  const matches = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(head)) !== null) {
    if (/type\s*=\s*["']application\/ld\+json["']/i.test(m[1])) {
      matches.push(m[2]);
    }
  }
  return matches;
}

function parseSingleJsonLdFromHtml(html) {
  const scripts = getJsonLdScriptContents(html);
  assert.equal(
    scripts.length,
    1,
    `Expected exactly 1 <script type="application/ld+json">, found ${scripts.length}`
  );
  return { raw: scripts[0], data: JSON.parse(scripts[0]) };
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
      if (lower === 'apos') return "'";
      if (lower === '#39') return "'";
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

function extractBreadcrumbNavFromHtml(html) {
  const navMatches = [...html.matchAll(/<nav\b[^>]*aria-label="Breadcrumb"[^>]*>([\s\S]*?)<\/nav>/gi)];
  if (navMatches.length === 0) return null;
  assert.equal(navMatches.length, 1, `Expected at most 1 Breadcrumb nav, found ${navMatches.length}`);
  const navInner = navMatches[0][1];
  const liMatches = [...navInner.matchAll(/<li\b([^>]*)>([\s\S]*?)<\/li>/gi)];
  const items = [];
  for (const li of liMatches) {
    if (/aria-hidden="true"/i.test(li[1])) continue;
    const body = li[2];
    const anchorMatch = body.match(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i);
    if (anchorMatch) {
      const labelText = decodeHtmlEntities(anchorMatch[2].replace(/<[^>]+>/g, '').trim());
      items.push({
        label: labelText,
        href: decodeHtmlEntities(anchorMatch[1]),
        isCurrent: /aria-current="page"/i.test(li[1]),
      });
    } else {
      const spanText = decodeHtmlEntities(body.replace(/<[^>]+>/g, '').trim());
      items.push({
        label: spanText,
        href: null,
        isCurrent: /aria-current="page"/i.test(li[1]),
      });
    }
  }
  return items;
}

/**
 * DOM Head simulator supporting <meta>, <link>, and <script type="application/ld+json">.
 */
class FakeElement {
  constructor(tagName, head) {
    this.tagName = tagName.toUpperCase();
    this.attrs = new Map();
    this.textContent = '';
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
    const el = new FakeElement(match[1].toLowerCase(), head);
    const attrRegex = /([a-zA-Z0-9:-]+)\s*=\s*"([^"]*)"/g;
    let attrMatch;
    while ((attrMatch = attrRegex.exec(match[2])) !== null) {
      el.setAttribute(attrMatch[1], attrMatch[2]);
    }
    head.appendChild(el);
  }

  const scriptRegex = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  while ((match = scriptRegex.exec(headInner)) !== null) {
    const el = new FakeElement('script', head);
    const attrRegex = /([a-zA-Z0-9:-]+)\s*=\s*"([^"]*)"/g;
    let attrMatch;
    while ((attrMatch = attrRegex.exec(match[1])) !== null) {
      el.setAttribute(attrMatch[1], attrMatch[2]);
    }
    el.textContent = match[2];
    head.appendChild(el);
  }

  return doc;
}

describe('Task 114-F — Configurable Structured Data and Breadcrumbs Integration', () => {
  it('1. Resolves valid page-level structured-data config (schemaType & customStructuredData) in client and static HTML', async () => {
    const customSeo = structuredClone(realSeoConfig);
    customSeo.pages['article:best-free-ai-tools-2026'] = {
      pageId: 'article:best-free-ai-tools-2026',
      pageType: 'article',
      path: '/blog/best-free-ai-tools-2026/',
      slug: 'best-free-ai-tools-2026',
      schemaType: 'Article',
      customStructuredData: {
        '@context': 'https://schema.org',
        '@type': 'ItemList',
        '@id': 'https://ai-novex.netlify.app/blog/best-free-ai-tools-2026/#tools-list',
        name: 'Top Free AI Tools Featured',
        numberOfItems: 2,
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'ChatGPT', url: 'https://ai-novex.netlify.app/tools/' },
          { '@type': 'ListItem', position: 2, name: 'Claude', url: 'https://ai-novex.netlify.app/tools/' },
        ],
      },
    };
    customSeo.pages.contact = {
      ...customSeo.pages.contact,
      schemaType: 'Custom',
      customStructuredData: {
        '@context': 'https://schema.org',
        '@type': 'ContactPage',
        '@id': 'https://ai-novex.netlify.app/contact/#custom-contact',
        name: 'AINOVEX Editorial Contact Desk',
        url: 'https://ai-novex.netlify.app/contact/',
      },
    };

    const tmpDir = createIsolatedWorkspace({ seoConfig: customSeo });
    const vite = await createServer({
      configFile: false,
      plugins: [react()],
      server: { middlewareMode: true },
      appType: 'custom',
      logLevel: 'silent',
      optimizeDeps: { noDiscovery: true },
    });

    try {
      runIsolatedPostbuild(tmpDir);
      const { resolveAndApplyRouteSeo } = await vite.ssrLoadModule('/src/utils/seo.ts');
      const doc = createFakeDocumentFromHtml(indexHtml);

      // Article with schemaType: Article and valid customStructuredData ItemList
      const resolvedArticle = resolveAndApplyRouteSeo(
        {
          path: '/blog/best-free-ai-tools-2026/',
          seoConfig: customSeo,
          settings: realSettings,
          articles: realArticles,
          categories: realCategories,
          tools: [],
        },
        doc
      );
      assert.equal(resolvedArticle.schemaType, 'Article');

      const clientArticleLd = JSON.parse(
        doc.head.querySelector('script[type="application/ld+json"]').textContent
      );
      const staticArticleHtml = fs.readFileSync(
        path.join(tmpDir, 'dist', 'blog', 'best-free-ai-tools-2026', 'index.html'),
        'utf8'
      );
      const { data: staticArticleLd } = parseSingleJsonLdFromHtml(staticArticleHtml);

      for (const ld of [clientArticleLd, staticArticleLd]) {
        assert.equal(ld['@context'], 'https://schema.org');
        assert.ok(ld['@graph'].some((n) => n['@type'] === 'Article'));
        assert.ok(ld['@graph'].some((n) => n['@type'] === 'ItemList' && n.name === 'Top Free AI Tools Featured'));
        assert.ok(ld['@graph'].some((n) => n['@type'] === 'BreadcrumbList'));
      }

      // Static page with schemaType: Custom
      resolveAndApplyRouteSeo(
        {
          path: '/contact/',
          seoConfig: customSeo,
          settings: realSettings,
          articles: realArticles,
          categories: realCategories,
          tools: [],
        },
        doc
      );
      const clientContactLd = JSON.parse(
        doc.head.querySelector('script[type="application/ld+json"]').textContent
      );
      const staticContactHtml = fs.readFileSync(
        path.join(tmpDir, 'dist', 'contact', 'index.html'),
        'utf8'
      );
      const { data: staticContactLd } = parseSingleJsonLdFromHtml(staticContactHtml);

      assert.deepEqual(clientContactLd, staticContactLd);
      assert.ok(
        staticContactLd['@graph'].some(
          (n) => n['@id'] === 'https://ai-novex.netlify.app/contact/#custom-contact'
        )
      );
      assert.equal(
        staticContactLd['@graph'].some(
          (n) => n['@id'] === 'https://ai-novex.netlify.app/contact/#webpage'
        ),
        false,
        'Custom schemaType with valid customStructuredData should replace default #webpage node'
      );
      assert.equal(
        staticContactLd['@graph'].filter((n) => n['@type'] === 'Organization').length,
        1
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      await vite.close();
    }
  });

  it('2. Falls back cleanly when structured-data configuration or seo.json is missing', () => {
    const tmpDir = createIsolatedWorkspace({ omitSeoFile: true });
    try {
      runIsolatedPostbuild(tmpDir);

      const resolvedAbout = resolvePageSeo({
        path: '/about/',
        seoConfig: null,
        settings: realSettings,
        articles: realArticles,
        categories: realCategories,
        tools: [],
      });
      assert.equal(resolvedAbout.schemaType, 'AboutPage');
      assert.ok(resolvedAbout.jsonLd['@graph'].some((n) => n['@type'] === 'AboutPage'));

      const aboutHtml = fs.readFileSync(path.join(tmpDir, 'dist', 'about', 'index.html'), 'utf8');
      const { data: staticAboutLd } = parseSingleJsonLdFromHtml(aboutHtml);
      assert.deepEqual(staticAboutLd, resolvedAbout.jsonLd);

      const artHtml = fs.readFileSync(
        path.join(tmpDir, 'dist', 'blog', 'best-free-ai-tools-2026', 'index.html'),
        'utf8'
      );
      const { data: staticArtLd } = parseSingleJsonLdFromHtml(artHtml);
      assert.ok(staticArtLd['@graph'].some((n) => n['@type'] === 'BlogPosting'));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('3. Rejects malformed, unsupported, or unsafe structured-data input without breaking pages', () => {
    const pollutedObj = JSON.parse('{"@type":"WebPage","__proto__":{"polluted":true}}');
    assert.equal(isSafeStructuredData(pollutedObj), false);
    assert.equal(isSafeStructuredData({ '@type': 'WebPage', url: 'javascript:alert(1)' }), false);
    assert.equal(isSafeStructuredData({ '@type': 'WebPage', sameAs: ['//evil.example/a'] }), false);
    assert.equal(isSafeStructuredData({ '@type': 'WebPage', name: 'bad</script><script>alert(1)' }), false);
    assert.equal(isSafeStructuredData({ name: 'Missing @type and @graph' }), false);

    const unsupportedSeo = {
      version: 1,
      defaults: { defaultSchemaType: 'Product' },
      pages: {
        about: {
          pageId: 'about',
          pageType: 'about',
          path: '/about/',
          slug: 'about',
          schemaType: 'FAQPage', // unsupported for about page
          customStructuredData: {
            '@type': 'FAQPage',
            mainEntity: [], // empty fake FAQ
          },
        },
        contact: {
          pageId: 'contact',
          pageType: 'contact',
          path: '/contact/',
          slug: 'contact',
          schemaType: 'Custom', // Custom with invalid payload -> falls back to ContactPage
          customStructuredData: {
            '@type': 'WebPage',
            url: 'javascript:alert(1)',
          },
        },
        'category:productivity': {
          pageId: 'category:productivity',
          pageType: 'category',
          path: '/category/productivity/',
          slug: 'productivity',
          schemaType: 'Review', // unsupported review claim
        },
      },
    };

    const aboutRes = resolvePageSeo({
      path: '/about/',
      seoConfig: unsupportedSeo,
      settings: realSettings,
      articles: realArticles,
      categories: realCategories,
      tools: [],
    });
    assert.equal(aboutRes.schemaType, 'AboutPage');
    assert.equal(aboutRes.jsonLd['@graph'].some((n) => n['@type'] === 'FAQPage'), false);

    const contactRes = resolvePageSeo({
      path: '/contact/',
      seoConfig: unsupportedSeo,
      settings: realSettings,
      articles: realArticles,
      categories: realCategories,
      tools: [],
    });
    assert.equal(contactRes.schemaType, 'ContactPage');
    assert.doesNotMatch(JSON.stringify(contactRes.jsonLd), /javascript:/i);

    const catRes = resolvePageSeo({
      path: '/category/productivity/',
      seoConfig: unsupportedSeo,
      settings: realSettings,
      articles: realArticles,
      categories: realCategories,
      tools: [],
    });
    assert.equal(catRes.schemaType, 'CollectionPage');
    assert.equal(catRes.jsonLd['@graph'].some((n) => n['@type'] === 'Review'), false);
  });

  it('4. Escapes JSON-LD safely against script-tag breakout and HTML parser hazards while remaining valid JSON', () => {
    const payloadWithHazards = {
      '@context': 'https://schema.org',
      '@type': 'WebPage',
      name: 'Test & Tools <Guide> </script > <!-- comment --> \u2028 line \u2029 para',
      url: 'https://ai-novex.netlify.app/about/',
    };
    assert.equal(isSafeStructuredData(payloadWithHazards), false, 'Literal </script should be rejected by isSafeStructuredData');

    const safeObject = {
      '@context': 'https://schema.org',
      '@type': 'WebPage',
      name: 'AI & ML <Tools> \u2028 Next \u2029 End',
      url: 'https://ai-novex.netlify.app/search/?q=a&b=1',
    };
    const escaped = escapeJsonLd(safeObject);
    assert.doesNotMatch(escaped, /[<>]/);
    assert.doesNotMatch(escaped, /&/);
    assert.ok(!escaped.includes('\u2028'));
    assert.ok(!escaped.includes('\u2029'));
    assert.deepEqual(JSON.parse(escaped), safeObject);

    // Verify end-to-end static postbuild escaping when SEO title contains & < >
    const specialSeo = structuredClone(realSeoConfig);
    specialSeo.pages.about.seoTitle = 'R&D <AI> "Standards" & Ethics | AINOVEX';
    specialSeo.pages.about.breadcrumb = { enabled: true, label: 'About & <Team>' };

    const tmpDir = createIsolatedWorkspace({ seoConfig: specialSeo });
    try {
      runIsolatedPostbuild(tmpDir);
      const aboutHtml = fs.readFileSync(path.join(tmpDir, 'dist', 'about', 'index.html'), 'utf8');
      const { raw, data } = parseSingleJsonLdFromHtml(aboutHtml);
      assert.doesNotMatch(raw, /[<>]/);
      assert.doesNotMatch(raw, /&/);
      const webpageNode = data['@graph'].find((n) => n['@type'] === 'AboutPage');
      assert.equal(webpageNode.name, 'R&D <AI> "Standards" & Ethics | AINOVEX');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('5. Preserves existing Article schema metadata, wordCount, image dimensions, author Person, and real bulk-enrichment FAQPage without duplicating or faking FAQs', () => {
    const seoWithDupFaq = structuredClone(realSeoConfig);
    seoWithDupFaq.pages['article:best-ai-tools-bulk-product-catalog-enrichment'] = {
      pageId: 'article:best-ai-tools-bulk-product-catalog-enrichment',
      pageType: 'article',
      path: '/blog/best-ai-tools-bulk-product-catalog-enrichment/',
      slug: 'best-ai-tools-bulk-product-catalog-enrichment',
      customStructuredData: {
        '@type': 'FAQPage',
        mainEntity: [
          {
            '@type': 'Question',
            name: 'Duplicate question?',
            acceptedAnswer: { '@type': 'Answer', text: 'Should not duplicate.' },
          },
        ],
      },
    };
    // Article WITHOUT real FAQ should NOT gain FAQPage even if schemaType: FAQPage is requested
    seoWithDupFaq.pages['article:best-free-ai-tools-2026'] = {
      pageId: 'article:best-free-ai-tools-2026',
      pageType: 'article',
      path: '/blog/best-free-ai-tools-2026/',
      slug: 'best-free-ai-tools-2026',
      schemaType: 'FAQPage',
    };

    const tmpDir = createIsolatedWorkspace({ seoConfig: seoWithDupFaq });
    try {
      runIsolatedPostbuild(tmpDir);

      const bulkHtml = fs.readFileSync(
        path.join(
          tmpDir,
          'dist',
          'blog',
          'best-ai-tools-bulk-product-catalog-enrichment',
          'index.html'
        ),
        'utf8'
      );
      const { data: bulkLd } = parseSingleJsonLdFromHtml(bulkHtml);
      const faqNodes = bulkLd['@graph'].filter((n) => n['@type'] === 'FAQPage');
      assert.equal(faqNodes.length, 1, 'Expected exactly 1 FAQPage without duplication');
      assert.equal(faqNodes[0].mainEntity.length, 8);
      const blogPosting = bulkLd['@graph'].find((n) => n['@type'] === 'BlogPosting');
      assert.ok(blogPosting);
      assert.ok(blogPosting.wordCount > 100);
      assert.ok(blogPosting.image.width > 0);
      assert.ok(blogPosting.image.height > 0);
      assert.ok(bulkLd['@graph'].some((n) => n['@type'] === 'Person'));

      const regularArtHtml = fs.readFileSync(
        path.join(tmpDir, 'dist', 'blog', 'best-free-ai-tools-2026', 'index.html'),
        'utf8'
      );
      const { data: regularLd } = parseSingleJsonLdFromHtml(regularArtHtml);
      assert.equal(regularLd['@graph'].some((n) => n['@type'] === 'FAQPage'), false);
      assert.ok(regularLd['@graph'].some((n) => n['@type'] === 'BlogPosting'));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('6-7. Cleans up stale JSON-LD and prevents duplicate JSON-LD scripts across repeated client-side navigation', async () => {
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

      // Add duplicate stale JSON-LD script element beforehand
      const extraLd = doc.createElement('script');
      extraLd.setAttribute('type', 'application/ld+json');
      extraLd.textContent = '{"@context":"https://schema.org","@type":"Product","name":"Stale"}';
      doc.head.appendChild(extraLd);
      assert.equal(doc.head.querySelectorAll('script[type="application/ld+json"]').length, 2);

      const navSeo = structuredClone(realSeoConfig);
      navSeo.pages.contact = {
        ...navSeo.pages.contact,
        schemaType: 'Custom',
        customStructuredData: {
          '@type': 'ContactPage',
          '@id': 'https://ai-novex.netlify.app/contact/#custom',
          name: 'Custom Contact Node',
        },
      };

      const routes = [
        '/blog/best-ai-tools-bulk-product-catalog-enrichment/',
        '/contact/',
        '/category/productivity/',
        '/author/md-shamim/',
        '/about/',
        '/non-existent-route/',
        '/blog/best-free-ai-tools-2026/',
      ];

      for (const route of routes) {
        resolveAndApplyRouteSeo(
          {
            path: route,
            seoConfig: navSeo,
            settings: realSettings,
            articles: realArticles,
            categories: realCategories,
            tools: [],
          },
          doc
        );
        const scripts = doc.head.querySelectorAll('script[type="application/ld+json"]');
        assert.equal(scripts.length, 1, `Expected 1 JSON-LD script after navigating to ${route}`);
        const ld = JSON.parse(scripts[0].textContent);
        const graph = ld['@graph'] || [];

        if (route === '/blog/best-ai-tools-bulk-product-catalog-enrichment/') {
          assert.ok(graph.some((n) => n['@type'] === 'BlogPosting'));
          assert.ok(graph.some((n) => n['@type'] === 'FAQPage'));
        } else if (route === '/contact/') {
          assert.equal(graph.some((n) => n['@type'] === 'FAQPage'), false);
          assert.equal(graph.some((n) => n['@type'] === 'BlogPosting'), false);
          assert.ok(graph.some((n) => n['@id'] === 'https://ai-novex.netlify.app/contact/#custom'));
        } else if (route === '/category/productivity/') {
          assert.equal(graph.some((n) => n['@id'] === 'https://ai-novex.netlify.app/contact/#custom'), false);
          assert.ok(graph.some((n) => n['@type'] === 'CollectionPage'));
        } else if (route === '/author/md-shamim/') {
          assert.equal(graph.some((n) => n['@type'] === 'CollectionPage'), false);
          assert.ok(graph.some((n) => n['@type'] === 'ProfilePage'));
        } else if (route === '/non-existent-route/') {
          assert.equal(graph.some((n) => n['@type'] === 'BreadcrumbList'), false);
          assert.equal(graph.some((n) => n['@type'] === 'ProfilePage'), false);
          assert.equal(graph.some((n) => n['@type'] === 'AboutPage'), false);
          assert.ok(graph.some((n) => n['@type'] === 'WebPage'));
        }
      }
    } finally {
      await vite.close();
    }
  });

  it('8-11. Integrates configured breadcrumbs with URL validation, escaping, JSON-LD parity, and safe invalid fallback', async () => {
    const customSeo = structuredClone(realSeoConfig);
    customSeo.pages['category:productivity'] = {
      pageId: 'category:productivity',
      pageType: 'category',
      path: '/category/productivity/',
      slug: 'productivity',
      breadcrumb: {
        enabled: true,
        label: 'Productivity & AI',
        items: [
          { name: 'Home', path: '/' },
          { name: 'Directories', path: '/tools' },
          { name: 'All Categories', path: '/categories' },
          { name: 'Productivity & AI', path: '/category/productivity' },
        ],
      },
    };
    customSeo.pages.privacy = {
      ...customSeo.pages.privacy,
      breadcrumb: { enabled: false, label: 'Privacy Policy' },
    };
    customSeo.pages.contact = {
      ...customSeo.pages.contact,
      breadcrumb: {
        enabled: true,
        label: 'Contact Desk & <Support>',
        // Invalid items (unsafe javascript: path + duplicate) -> should fall back to label override
        items: [
          { name: 'Evil', path: 'javascript:alert(1)' },
          { name: 'Dup', path: '/about/' },
          { name: 'Dup2', path: '/about/' },
        ],
      },
      // Custom BreadcrumbList inside customStructuredData must be ignored so BreadcrumbList stays synced
      customStructuredData: {
        '@type': 'BreadcrumbList',
        itemListElement: [{ '@type': 'ListItem', position: 1, name: 'Spoofed', item: 'https://ai-novex.netlify.app/' }],
      },
    };

    const tmpDir = createIsolatedWorkspace({ seoConfig: customSeo });
    const vite = await createServer({
      configFile: false,
      plugins: [react()],
      server: { middlewareMode: true },
      appType: 'custom',
      logLevel: 'silent',
      optimizeDeps: { noDiscovery: true },
    });

    try {
      runIsolatedPostbuild(tmpDir);
      const { resolveRouteSeo } = await vite.ssrLoadModule('/src/utils/seo.ts');
      const { Breadcrumbs } = await vite.ssrLoadModule('/src/components/Breadcrumbs.tsx');
      const { CategoryDetailView } = await vite.ssrLoadModule('/src/views/CategoryDetailView.tsx');
      const { LegalView } = await vite.ssrLoadModule('/src/views/LegalView.tsx');
      const { ContactView } = await vite.ssrLoadModule('/src/views/ContactView.tsx');

      // A) Valid configured breadcrumb items on /category/productivity/
      const catSeo = resolveRouteSeo({
        path: '/category/productivity/',
        seoConfig: customSeo,
        settings: realSettings,
        articles: realArticles,
        categories: realCategories,
        tools: [],
      });
      assert.deepEqual(catSeo.breadcrumbs, [
        { label: 'Directories', path: '/tools/' },
        { label: 'All Categories', path: '/categories/' },
        { label: 'Productivity & AI' },
      ]);

      const catStaticHtml = fs.readFileSync(
        path.join(tmpDir, 'dist', 'category', 'productivity', 'index.html'),
        'utf8'
      );
      const { data: catStaticLd } = parseSingleJsonLdFromHtml(catStaticHtml);
      const catBcList = catStaticLd['@graph'].filter((n) => n['@type'] === 'BreadcrumbList');
      assert.equal(catBcList.length, 1);
      assert.deepEqual(
        catBcList[0].itemListElement.map((i) => ({ name: i.name, item: i.item })),
        [
          { name: 'Home', item: 'https://ai-novex.netlify.app/' },
          { name: 'Directories', item: 'https://ai-novex.netlify.app/tools/' },
          { name: 'All Categories', item: 'https://ai-novex.netlify.app/categories/' },
          { name: 'Productivity & AI', item: 'https://ai-novex.netlify.app/category/productivity/' },
        ]
      );

      const staticCatNav = extractBreadcrumbNavFromHtml(catStaticHtml);
      const reactCatMarkup = renderToStaticMarkup(
        React.createElement(CategoryDetailView, {
          slug: 'productivity',
          categories: realCategories,
          tools: [],
          articles: realArticles,
          onNavigate: () => {},
          onSelectTool: () => {},
          onSelectArticle: () => {},
          breadcrumbs: catSeo.breadcrumbs,
          breadcrumbEnabled: catSeo.breadcrumbEnabled,
        })
      );
      const reactCatNav = extractBreadcrumbNavFromHtml(reactCatMarkup);
      assert.deepEqual(staticCatNav, reactCatNav);
      assert.deepEqual(
        reactCatNav.map((i) => i.label),
        ['Home', 'Directories', 'All Categories', 'Productivity & AI']
      );

      // B) breadcrumb.enabled: false hides UI nav and omits BreadcrumbList JSON-LD
      const privSeo = resolveRouteSeo({
        path: '/privacy/',
        seoConfig: customSeo,
        settings: realSettings,
        articles: realArticles,
        categories: realCategories,
        tools: [],
      });
      assert.equal(privSeo.breadcrumbEnabled, false);
      assert.deepEqual(privSeo.breadcrumbs, []);
      assert.equal(privSeo.jsonLd['@graph'].some((n) => n['@type'] === 'BreadcrumbList'), false);

      const privHtml = fs.readFileSync(path.join(tmpDir, 'dist', 'privacy', 'index.html'), 'utf8');
      assert.equal(extractBreadcrumbNavFromHtml(privHtml), null);
      const { data: privLd } = parseSingleJsonLdFromHtml(privHtml);
      assert.equal(privLd['@graph'].some((n) => n['@type'] === 'BreadcrumbList'), false);

      const reactPrivMarkup = renderToStaticMarkup(
        React.createElement(LegalView, {
          page: 'privacy',
          onNavigate: () => {},
          breadcrumbs: privSeo.breadcrumbs,
          breadcrumbEnabled: privSeo.breadcrumbEnabled,
        })
      );
      assert.equal(extractBreadcrumbNavFromHtml(reactPrivMarkup), null);

      // C) Invalid configured items + spoofed BreadcrumbList + special characters escaping
      const contactSeo = resolveRouteSeo({
        path: '/contact/',
        seoConfig: customSeo,
        settings: realSettings,
        articles: realArticles,
        categories: realCategories,
        tools: [],
      });
      assert.deepEqual(contactSeo.breadcrumbs, [{ label: 'Contact Desk & <Support>' }]);
      const contactHtml = fs.readFileSync(path.join(tmpDir, 'dist', 'contact', 'index.html'), 'utf8');
      assert.doesNotMatch(contactHtml, /javascript:alert/);
      const contactNav = extractBreadcrumbNavFromHtml(contactHtml);
      assert.deepEqual(
        contactNav.map((i) => i.label),
        ['Home', 'Contact Desk & <Support>']
      );
      const { data: contactLd } = parseSingleJsonLdFromHtml(contactHtml);
      const contactBc = contactLd['@graph'].find((n) => n['@type'] === 'BreadcrumbList');
      assert.equal(contactBc.itemListElement[1].name, 'Contact Desk & <Support>');
      assert.equal(
        contactLd['@graph'].filter((n) => n['@type'] === 'BreadcrumbList').length,
        1
      );

      // Direct Breadcrumbs.tsx safety check against unsafe intermediate path props
      const unsafeComponentHtml = renderToStaticMarkup(
        React.createElement(Breadcrumbs, {
          items: [
            { label: 'Unsafe', path: 'javascript:alert(1)' },
            { label: 'Safe & <Valid>', path: '/blog' },
            { label: 'Current' },
          ],
          onNavigate: () => {},
        })
      );
      assert.doesNotMatch(unsafeComponentHtml, /javascript:/i);
      assert.match(unsafeComponentHtml, /href="\/blog\/"/);
      assert.match(unsafeComponentHtml, /Safe &amp; &lt;Valid&gt;/);

      const reactContactMarkup = renderToStaticMarkup(
        React.createElement(ContactView, {
          onNavigate: () => {},
          breadcrumbs: contactSeo.breadcrumbs,
          breadcrumbEnabled: contactSeo.breadcrumbEnabled,
        })
      );
      assert.deepEqual(extractBreadcrumbNavFromHtml(reactContactMarkup), contactNav);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      await vite.close();
    }
  });

  it('12. Omits breadcrumbs and page-specific/custom schema on 404 routes in both client runtime and static 404.html', async () => {
    const seo404Test = structuredClone(realSeoConfig);
    seo404Test.defaults.defaultSchemaType = 'AboutPage';
    seo404Test.defaults.defaultBreadcrumbEnabled = true;

    const tmpDir = createIsolatedWorkspace({ seoConfig: seo404Test });
    const vite = await createServer({
      configFile: false,
      plugins: [react()],
      server: { middlewareMode: true },
      appType: 'custom',
      logLevel: 'silent',
      optimizeDeps: { noDiscovery: true },
    });

    try {
      runIsolatedPostbuild(tmpDir);
      const { resolveAndApplyRouteSeo } = await vite.ssrLoadModule('/src/utils/seo.ts');
      const doc = createFakeDocumentFromHtml(indexHtml);

      const routes404 = ['/unknown-page/', '/blog/missing-article/', '/tools/chatgpt/', '/author/nobody/'];
      for (const r of routes404) {
        const res = resolveAndApplyRouteSeo(
          {
            path: r,
            seoConfig: seo404Test,
            settings: realSettings,
            articles: realArticles,
            categories: realCategories,
            tools: [],
          },
          doc
        );
        assert.equal(res.notFound, true, `Expected 404 for ${r}`);
        assert.equal(res.breadcrumbEnabled, false);
        assert.deepEqual(res.breadcrumbs, []);
        assert.equal(res.schemaType, 'WebPage');
        const ld = JSON.parse(doc.head.querySelector('script[type="application/ld+json"]').textContent);
        assert.equal(ld['@graph'].some((n) => n['@type'] === 'BreadcrumbList'), false);
        assert.equal(ld['@graph'].some((n) => n['@type'] === 'AboutPage'), false);
      }

      const static404 = fs.readFileSync(path.join(tmpDir, 'dist', '404.html'), 'utf8');
      assert.equal(extractBreadcrumbNavFromHtml(static404), null);
      const { data: static404Ld } = parseSingleJsonLdFromHtml(static404);
      assert.equal(static404Ld['@graph'].some((n) => n['@type'] === 'BreadcrumbList'), false);
      assert.equal(static404Ld['@graph'].some((n) => n['@type'] === 'AboutPage'), false);
      assert.ok(static404Ld['@graph'].some((n) => n['@type'] === 'WebPage'));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      await vite.close();
    }
  });

  it('13. Static HTML and client-side App.tsx / resolveRouteSeo produce consistent JSON-LD and breadcrumbs across representative routes', async () => {
    const tmpDir = createIsolatedWorkspace({ seoConfig: realSeoConfig });
    const vite = await createServer({
      configFile: false,
      plugins: [react()],
      server: { middlewareMode: true },
      appType: 'custom',
      logLevel: 'silent',
      optimizeDeps: { noDiscovery: true },
    });

    const origWindow = globalThis.window;
    try {
      runIsolatedPostbuild(tmpDir);
      const { resolveRouteSeo } = await vite.ssrLoadModule('/src/utils/seo.ts');
      const { default: App } = await vite.ssrLoadModule('/src/App.tsx');

      const representativeRoutes = [
        { path: '/', file: 'index.html', hasBreadcrumb: false },
        { path: '/about/', file: 'about/index.html', hasBreadcrumb: true },
        { path: '/blog/', file: 'blog/index.html', hasBreadcrumb: true },
        { path: '/contact/', file: 'contact/index.html', hasBreadcrumb: true },
        { path: '/privacy/', file: 'privacy/index.html', hasBreadcrumb: true },
        {
          path: '/blog/best-free-ai-tools-2026/',
          file: 'blog/best-free-ai-tools-2026/index.html',
          hasBreadcrumb: true,
        },
        {
          path: '/blog/best-ai-tools-bulk-product-catalog-enrichment/',
          file: 'blog/best-ai-tools-bulk-product-catalog-enrichment/index.html',
          hasBreadcrumb: true,
        },
        {
          path: '/category/productivity/',
          file: 'category/productivity/index.html',
          hasBreadcrumb: true,
        },
        {
          path: '/author/md-shamim/',
          file: 'author/md-shamim/index.html',
          hasBreadcrumb: true,
        },
      ];

      for (const route of representativeRoutes) {
        const staticHtml = fs.readFileSync(path.join(tmpDir, 'dist', route.file), 'utf8');
        const { data: staticLd } = parseSingleJsonLdFromHtml(staticHtml);
        const staticNav = extractBreadcrumbNavFromHtml(staticHtml);

        const clientResolved = resolveRouteSeo({
          path: route.path,
          seoConfig: realSeoConfig,
          settings: realSettings,
          articles: realArticles,
          categories: realCategories,
          tools: [],
        });

        // Compare JSON-LD graph types and BreadcrumbList identically
        assert.deepEqual(
          staticLd['@graph'].map((n) => n['@type']),
          clientResolved.jsonLd['@graph'].map((n) => n['@type']),
          `JSON-LD node types mismatch on ${route.path}`
        );

        const staticBcNode = staticLd['@graph'].find((n) => n['@type'] === 'BreadcrumbList') || null;
        const clientBcNode =
          clientResolved.jsonLd['@graph'].find((n) => n['@type'] === 'BreadcrumbList') || null;
        assert.deepEqual(staticBcNode, clientBcNode, `BreadcrumbList JSON-LD mismatch on ${route.path}`);

        // Render full React <App /> SSR markup for the route and compare visible breadcrumbs
        globalThis.window = {
          location: { pathname: route.path, search: '' },
          matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
          addEventListener() {},
          removeEventListener() {},
          history: { pushState() {} },
          scrollTo() {},
        };
        const appHtml = renderToStaticMarkup(React.createElement(App));
        const appNav = extractBreadcrumbNavFromHtml(appHtml);

        if (!route.hasBreadcrumb) {
          assert.equal(staticNav, null);
          assert.equal(appNav, null);
        } else {
          assert.deepEqual(appNav, staticNav, `Visible breadcrumb UI mismatch on ${route.path}`);
          assert.ok(staticBcNode, `Expected BreadcrumbList JSON-LD on ${route.path}`);
          assert.equal(
            staticNav.length,
            staticBcNode.itemListElement.length,
            `Visible vs JSON-LD breadcrumb count mismatch on ${route.path}`
          );
          for (let i = 0; i < staticNav.length; i++) {
            assert.equal(staticNav[i].label, staticBcNode.itemListElement[i].name);
          }
        }
      }
    } finally {
      if (origWindow === undefined) {
        delete globalThis.window;
      } else {
        globalThis.window = origWindow;
      }
      fs.rmSync(tmpDir, { recursive: true, force: true });
      await vite.close();
    }
  });

  it('14. Repeated postbuild execution produces zero duplicate JSON-LD scripts or breadcrumb markup (idempotent)', () => {
    const pollutedTemplate = indexHtml.replace(
      '</head>',
      `    <script type="application/ld+json">{"@context":"https://schema.org","@type":"WebPage","name":"Dup"}</script>\n  </head>`
    );
    const tmpDir = createIsolatedWorkspace({ seoConfig: realSeoConfig, templateHtml: pollutedTemplate });
    try {
      runIsolatedPostbuild(tmpDir);
      const firstRunFiles = new Map();
      const targetFiles = [
        'index.html',
        'about/index.html',
        'blog/index.html',
        'blog/best-free-ai-tools-2026/index.html',
        'category/productivity/index.html',
        'author/md-shamim/index.html',
        '404.html',
      ];
      for (const f of targetFiles) {
        firstRunFiles.set(f, fs.readFileSync(path.join(tmpDir, 'dist', f), 'utf8'));
      }

      runIsolatedPostbuild(tmpDir);
      runIsolatedPostbuild(tmpDir);

      for (const f of targetFiles) {
        const currentHtml = fs.readFileSync(path.join(tmpDir, 'dist', f), 'utf8');
        assert.equal(currentHtml, firstRunFiles.get(f), `Postbuild output changed on repeated run for ${f}`);
        assert.equal(
          getJsonLdScriptContents(currentHtml).length,
          1,
          `Expected exactly 1 JSON-LD script in ${f}`
        );
        const navMatches = currentHtml.match(/aria-label="Breadcrumb"/gi) || [];
        assert.ok(navMatches.length <= 1, `Duplicate breadcrumb nav found in ${f}`);
      }

      // Direct idempotency check on applyResolvedSeoToHtml with jsonLd
      const resolved = resolvePageSeo({
        path: '/about/',
        seoConfig: realSeoConfig,
        settings: realSettings,
        articles: realArticles,
        categories: realCategories,
        tools: [],
      });
      const once = applyResolvedSeoToHtml(pollutedTemplate, resolved);
      const twice = applyResolvedSeoToHtml(once, resolved);
      assert.equal(twice, once);
      assert.equal(getJsonLdScriptContents(twice).length, 1);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
