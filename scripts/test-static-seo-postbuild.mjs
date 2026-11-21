import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { applyResolvedSeoToHtml } from './postbuild.mjs';
import { resolvePageSeo } from '../src/utils/pageSeo.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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

function createIsolatedWorkspace({ seoConfig = realSeoConfig, rawSeoText = null, omitSeoFile = false, templateHtml = null } = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ainovex-static-seo-test-'));
  const distDir = path.join(tmpDir, 'dist');
  const contentDir = path.join(tmpDir, 'content');
  const articlesDir = path.join(contentDir, 'articles');
  const publicDir = path.join(tmpDir, 'public');

  fs.mkdirSync(distDir, { recursive: true });
  fs.mkdirSync(articlesDir, { recursive: true });
  fs.cpSync(path.join(REPO_ROOT, 'public'), publicDir, { recursive: true });

  const baseTemplate = templateHtml ?? fs.readFileSync(path.join(REPO_ROOT, 'index.html'), 'utf8');
  fs.writeFileSync(path.join(distDir, 'index.html'), baseTemplate);

  for (const file of ['settings.json', 'categories.json', 'tools.json', 'articles.json', 'ads.json']) {
    fs.copyFileSync(path.join(REPO_ROOT, 'content', file), path.join(contentDir, file));
  }
  for (const file of fs.readdirSync(path.join(REPO_ROOT, 'content', 'articles'))) {
    if (file.endsWith('.md')) {
      fs.copyFileSync(path.join(REPO_ROOT, 'content', 'articles', file), path.join(articlesDir, file));
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

function extractHeadWithoutScriptsOrStyles(html) {
  return extractHead(html)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '');
}

function decodeHtmlEntitiesSinglePass(val) {
  return String(val ?? '').replace(
    /&(#x[0-9a-f]+|#[0-9]+|amp|lt|gt|quot|apos);/gi,
    (match, entity) => {
      const lower = entity.toLowerCase();
      if (lower === 'amp') return '&';
      if (lower === 'lt') return '<';
      if (lower === 'gt') return '>';
      if (lower === 'quot') return '"';
      if (lower === 'apos') return "'";
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

function getRawTitleText(html) {
  const head = extractHeadWithoutScriptsOrStyles(html);
  const matches = [...head.matchAll(/<title\b[^>]*>([\s\S]*?)<\/title>/gi)];
  assert.equal(matches.length, 1, `Expected exactly 1 <title>, found ${matches.length}`);
  return matches[0][1];
}

function getTitleText(html) {
  return decodeHtmlEntitiesSinglePass(getRawTitleText(html));
}

function getRawMetaMatches(html, attr, key) {
  const head = extractHeadWithoutScriptsOrStyles(html);
  const tags = [...head.matchAll(/<meta\b([^>]*)>/gi)];
  const matched = [];
  const attrRe = new RegExp(`(?:^|\\s)${attr}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i');
  const contentRe = /(?:^|\s)content\s*=\s*(?:"([^"]*)"|'([^']*)')/i;
  for (const m of tags) {
    const attrs = m[1];
    const kMatch = attrs.match(attrRe);
    if (!kMatch) continue;
    const kVal = (kMatch[1] ?? kMatch[2] ?? '').toLowerCase();
    if (kVal !== key.toLowerCase()) continue;
    const cMatch = attrs.match(contentRe);
    matched.push(cMatch ? (cMatch[1] ?? cMatch[2] ?? '') : '');
  }
  return matched;
}

function getMetaMatches(html, attr, key) {
  return getRawMetaMatches(html, attr, key).map(decodeHtmlEntitiesSinglePass);
}

function getRawSingleMeta(html, attr, key) {
  const values = getRawMetaMatches(html, attr, key);
  assert.equal(values.length, 1, `Expected exactly 1 <meta ${attr}="${key}">, found ${values.length}`);
  return values[0];
}

function getSingleMeta(html, attr, key) {
  const values = getMetaMatches(html, attr, key);
  assert.equal(values.length, 1, `Expected exactly 1 <meta ${attr}="${key}">, found ${values.length}`);
  return values[0];
}

function getCanonicalLinks(html) {
  const head = extractHeadWithoutScriptsOrStyles(html);
  const links = [...head.matchAll(/<link\b([^>]*)>/gi)];
  const matched = [];
  for (const m of links) {
    const attrs = m[1];
    const relMatch = attrs.match(/(?:^|\s)rel\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
    if (!relMatch) continue;
    const relVal = (relMatch[1] ?? relMatch[2] ?? '').toLowerCase().split(/\s+/);
    if (!relVal.includes('canonical')) continue;
    const hrefMatch = attrs.match(/(?:^|\s)href\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
    matched.push(hrefMatch ? decodeHtmlEntitiesSinglePass(hrefMatch[1] ?? hrefMatch[2] ?? '') : '');
  }
  return matched;
}

describe('Task 114-D — Static HTML SEO Integration in scripts/postbuild.mjs', () => {
  it('1-5. Generates accurate resolved SEO metadata for homepage, article, category, author, static pages, and 404', () => {
    const customSeo = structuredClone(realSeoConfig);
    customSeo.defaults.defaultTwitterSite = '@ainovex_ai';
    customSeo.pages.home.seoTitle = 'AINOVEX Home Override Title | AINOVEX';
    customSeo.pages.home.ogTitle = 'AINOVEX Home OG Override';
    customSeo.pages['article:best-free-ai-tools-2026'] = {
      pageId: 'article:best-free-ai-tools-2026',
      pageType: 'article',
      path: '/blog/best-free-ai-tools-2026/',
      slug: 'best-free-ai-tools-2026',
      seoTitle: 'Custom Article Override 2026 | AINOVEX',
      metaDescription: 'Custom article override description verified directly in generated static HTML.',
      canonicalUrl: 'https://ai-novex.netlify.app/blog/best-free-ai-tools-2026-canonical/',
      ogTitle: 'Custom Article OG Title',
      ogDescription: 'Custom Article OG Description.',
      ogImage: '/images/articles/top-ai-video-generators-guide-og.webp',
      twitterCard: 'summary',
      twitterTitle: 'Custom Article Twitter Title',
      twitterDescription: 'Custom Article Twitter Description.',
      twitterImage: '/images/articles/top-ai-video-generators-guide.webp',
    };
    customSeo.pages['category:productivity'] = {
      pageId: 'category:productivity',
      pageType: 'category',
      path: '/category/productivity/',
      slug: 'productivity',
      seoTitle: 'Custom Productivity Hub | AINOVEX',
      metaDescription: 'Custom productivity category description from seo.json.',
    };
    customSeo.pages['author:md-shamim'] = {
      pageId: 'author:md-shamim',
      pageType: 'author',
      path: '/author/md-shamim/',
      slug: 'md-shamim',
      seoTitle: 'Md Shamim Custom Profile SEO | AINOVEX',
      metaDescription: 'Custom editorial profile description for Md Shamim.',
    };

    const tmpDir = createIsolatedWorkspace({ seoConfig: customSeo });
    try {
      runIsolatedPostbuild(tmpDir);

      // 1. Homepage
      const homeHtml = fs.readFileSync(path.join(tmpDir, 'dist', 'index.html'), 'utf8');
      assert.equal(getTitleText(homeHtml), 'AINOVEX Home Override Title | AINOVEX');
      assert.equal(getSingleMeta(homeHtml, 'property', 'og:title'), 'AINOVEX Home OG Override');
      assert.equal(getSingleMeta(homeHtml, 'property', 'og:type'), 'website');
      assert.equal(getSingleMeta(homeHtml, 'property', 'og:url'), 'https://ai-novex.netlify.app/');
      assert.equal(getSingleMeta(homeHtml, 'property', 'og:site_name'), 'AINOVEX');
      assert.deepEqual(getCanonicalLinks(homeHtml), ['https://ai-novex.netlify.app/']);
      assert.equal(getSingleMeta(homeHtml, 'name', 'twitter:site'), '@ainovex_ai');
      assert.match(getSingleMeta(homeHtml, 'name', 'robots'), /^index, follow/);
      assert.equal(getMetaMatches(homeHtml, 'property', 'article:published_time').length, 0);

      // 2. Article with override
      const artHtml = fs.readFileSync(
        path.join(tmpDir, 'dist', 'blog', 'best-free-ai-tools-2026', 'index.html'),
        'utf8'
      );
      assert.equal(getTitleText(artHtml), 'Custom Article Override 2026 | AINOVEX');
      assert.equal(
        getSingleMeta(artHtml, 'name', 'description'),
        'Custom article override description verified directly in generated static HTML.'
      );
      assert.deepEqual(getCanonicalLinks(artHtml), [
        'https://ai-novex.netlify.app/blog/best-free-ai-tools-2026-canonical/',
      ]);
      assert.equal(
        getSingleMeta(artHtml, 'property', 'og:url'),
        'https://ai-novex.netlify.app/blog/best-free-ai-tools-2026/'
      );
      assert.equal(getSingleMeta(artHtml, 'property', 'og:type'), 'article');
      assert.equal(getSingleMeta(artHtml, 'property', 'og:title'), 'Custom Article OG Title');
      assert.equal(getSingleMeta(artHtml, 'property', 'og:description'), 'Custom Article OG Description.');
      assert.equal(
        getSingleMeta(artHtml, 'property', 'og:image'),
        'https://ai-novex.netlify.app/images/articles/top-ai-video-generators-guide-og.webp'
      );
      assert.equal(getSingleMeta(artHtml, 'property', 'og:image:type'), 'image/webp');
      assert.equal(getSingleMeta(artHtml, 'name', 'twitter:card'), 'summary');
      assert.equal(getSingleMeta(artHtml, 'name', 'twitter:title'), 'Custom Article Twitter Title');
      assert.equal(
        getSingleMeta(artHtml, 'name', 'twitter:description'),
        'Custom Article Twitter Description.'
      );
      assert.equal(
        getSingleMeta(artHtml, 'name', 'twitter:image'),
        'https://ai-novex.netlify.app/images/articles/top-ai-video-generators-guide.webp'
      );
      assert.equal(getSingleMeta(artHtml, 'name', 'twitter:site'), '@ainovex_ai');
      assert.equal(getSingleMeta(artHtml, 'property', 'article:published_time'), '2026-03-15');
      assert.equal(getSingleMeta(artHtml, 'property', 'article:modified_time'), '2026-10-10');
      assert.equal(
        getSingleMeta(artHtml, 'property', 'article:author'),
        'https://ai-novex.netlify.app/author/md-shamim/'
      );
      assert.equal(getSingleMeta(artHtml, 'property', 'article:section'), 'Productivity');
      assert.ok(getMetaMatches(artHtml, 'property', 'article:tag').length >= 4);

      // 3. Category pages (overridden indexable vs empty noindex)
      const prodCatHtml = fs.readFileSync(
        path.join(tmpDir, 'dist', 'category', 'productivity', 'index.html'),
        'utf8'
      );
      assert.equal(getTitleText(prodCatHtml), 'Custom Productivity Hub | AINOVEX');
      assert.equal(
        getSingleMeta(prodCatHtml, 'name', 'description'),
        'Custom productivity category description from seo.json.'
      );
      assert.match(getSingleMeta(prodCatHtml, 'name', 'robots'), /^index, follow/);

      const emptyCatHtml = fs.readFileSync(
        path.join(tmpDir, 'dist', 'category', 'ai-writing', 'index.html'),
        'utf8'
      );
      assert.equal(getTitleText(emptyCatHtml), 'AI Writing Tools & Practical Guides 2026 | AINOVEX');
      assert.equal(getSingleMeta(emptyCatHtml, 'name', 'robots'), 'noindex, follow');

      // 4. Author page
      const authorHtml = fs.readFileSync(
        path.join(tmpDir, 'dist', 'author', 'md-shamim', 'index.html'),
        'utf8'
      );
      assert.equal(getTitleText(authorHtml), 'Md Shamim Custom Profile SEO | AINOVEX');
      assert.equal(
        getSingleMeta(authorHtml, 'name', 'description'),
        'Custom editorial profile description for Md Shamim.'
      );
      assert.equal(getSingleMeta(authorHtml, 'property', 'og:type'), 'profile');
      assert.deepEqual(getCanonicalLinks(authorHtml), [
        'https://ai-novex.netlify.app/author/md-shamim/',
      ]);

      // 5. Static & listing pages
      const aboutHtml = fs.readFileSync(path.join(tmpDir, 'dist', 'about', 'index.html'), 'utf8');
      assert.equal(getTitleText(aboutHtml), 'About Us & Editorial Standards | AINOVEX');
      assert.match(getSingleMeta(aboutHtml, 'name', 'robots'), /^index, follow/);

      const privacyHtml = fs.readFileSync(path.join(tmpDir, 'dist', 'privacy', 'index.html'), 'utf8');
      assert.equal(getTitleText(privacyHtml), 'Privacy Policy | AINOVEX AI Platform');
      assert.equal(getSingleMeta(privacyHtml, 'name', 'robots'), 'noindex, follow');

      const toolsHtml = fs.readFileSync(path.join(tmpDir, 'dist', 'tools', 'index.html'), 'utf8');
      assert.equal(getTitleText(toolsHtml), 'Best AI Tools Directory & Software Reviews 2026 | AINOVEX');

      // 404 page
      const notFoundHtml = fs.readFileSync(path.join(tmpDir, 'dist', '404.html'), 'utf8');
      assert.equal(getSingleMeta(notFoundHtml, 'name', 'robots'), 'noindex, follow');
      assert.equal(getCanonicalLinks(notFoundHtml).length, 0);
      assert.equal(getMetaMatches(notFoundHtml, 'property', 'og:url').length, 0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('6-7. Enforces global defaults, safe fallbacks, and noindex/nofollow directives', () => {
    const seoWithDirectives = {
      version: 1,
      defaults: {
        siteName: 'AINOVEX',
        defaultSeoTitle: 'Global Fallback Title | AINOVEX',
        defaultMetaDescription: 'Global fallback description when no route metadata exists.',
        defaultOgImage: '/images/og-default.png',
        defaultTwitterCard: 'summary_large_image',
      },
      pages: {
        contact: {
          pageId: 'contact',
          pageType: 'contact',
          path: '/contact/',
          slug: 'contact',
          index: false,
          follow: false,
        },
        about: {
          pageId: 'about',
          pageType: 'about',
          path: '/about/',
          slug: 'about',
          index: true,
          follow: false,
        },
      },
    };

    const tmpDir = createIsolatedWorkspace({ seoConfig: seoWithDirectives });
    try {
      runIsolatedPostbuild(tmpDir);

      // noindex + nofollow
      const contactHtml = fs.readFileSync(path.join(tmpDir, 'dist', 'contact', 'index.html'), 'utf8');
      assert.equal(getSingleMeta(contactHtml, 'name', 'robots'), 'noindex, nofollow');
      assert.equal(getTitleText(contactHtml), 'Contact AINOVEX | Editorial & Support Team');

      // index + nofollow
      const aboutHtml = fs.readFileSync(path.join(tmpDir, 'dist', 'about', 'index.html'), 'utf8');
      assert.equal(
        getSingleMeta(aboutHtml, 'name', 'robots'),
        'index, nofollow, max-image-preview:large, max-snippet:-1, max-video-preview:-1'
      );

      // 404 picks up global default title while preserving noindex and omitting canonical/og:url
      const notFoundHtml = fs.readFileSync(path.join(tmpDir, 'dist', '404.html'), 'utf8');
      assert.equal(getTitleText(notFoundHtml), 'Global Fallback Title | AINOVEX');
      assert.equal(getSingleMeta(notFoundHtml, 'name', 'robots'), 'noindex, follow');
      assert.equal(getCanonicalLinks(notFoundHtml).length, 0);
      assert.equal(getMetaMatches(notFoundHtml, 'property', 'og:url').length, 0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('8-9. Rejects unsafe URLs, escapes HTML special characters, prevents injection, and preserves Unicode/Bengali', () => {
    const attackSeo = {
      version: 1,
      defaults: {
        siteName: 'AINOVEX & "Test" <AI>',
        defaultTwitterSite: 'bad handle!',
      },
      pages: {
        about: {
          pageId: 'about',
          pageType: 'about',
          path: '/about/',
          slug: 'about',
          seoTitle: 'বাংলা এআই গাইড — "AINOVEX" & <Tools> \'2026\' </title><script>alert(1)</script>',
          metaDescription:
            'বাংলায় বিস্তারিত AI গাইড & রিভিউ "quoted" <tag> \'single\' attr="injection" payload.',
          canonicalUrl: 'javascript:alert(1)',
          ogImage: '//evil.example/og.png',
          twitterImage: 'data:text/html,<script>alert(1)</script>',
          ogImageAlt: 'বাংলা অল্ট টেক্সট "injected" onclick="alert(1)"',
        },
        contact: {
          pageId: 'contact',
          pageType: 'contact',
          path: '/contact/',
          slug: 'contact',
          canonicalUrl: 'vbscript:msgbox(1)',
          ogImage: '/\\evil.example/a.png',
          twitterImage: 'https://user:pass@evil.example/x.png',
        },
      },
    };

    const tmpDir = createIsolatedWorkspace({ seoConfig: attackSeo });
    try {
      runIsolatedPostbuild(tmpDir);

      const aboutHtml = fs.readFileSync(path.join(tmpDir, 'dist', 'about', 'index.html'), 'utf8');
      const aboutHeadNoScripts = extractHeadWithoutScriptsOrStyles(aboutHtml);

      // No raw unescaped <script>alert(1)</script> or attribute breakout in head
      assert.doesNotMatch(aboutHeadNoScripts, /<script/i);
      assert.doesNotMatch(aboutHeadNoScripts, /javascript:/i);
      assert.doesNotMatch(aboutHeadNoScripts, /data:text\/html/i);
      assert.doesNotMatch(aboutHeadNoScripts, /\/\/evil\.example/i);

      // Bengali and escaped special characters preserved intact
      assert.equal(
        getTitleText(aboutHtml),
        'বাংলা এআই গাইড — "AINOVEX" & <Tools> \'2026\' </title><script>alert(1)</script>'
      );
      assert.match(aboutHtml, /<title>বাংলা এআই গাইড — &quot;AINOVEX&quot; &amp; &lt;Tools&gt; &#39;2026&#39; &lt;\/title&gt;&lt;script&gt;alert\(1\)&lt;\/script&gt;<\/title>/);
      assert.equal(
        getSingleMeta(aboutHtml, 'property', 'og:image:alt'),
        'বাংলা অল্ট টেক্সট "injected" onclick="alert(1)"'
      );
      // Unsafe canonicalUrl / ogImage / twitterImage fell back to safe pageUrl / defaultOgImage
      assert.deepEqual(getCanonicalLinks(aboutHtml), ['https://ai-novex.netlify.app/about/']);
      assert.equal(
        getSingleMeta(aboutHtml, 'property', 'og:image'),
        'https://ai-novex.netlify.app/images/og-default.png'
      );
      assert.equal(
        getSingleMeta(aboutHtml, 'name', 'twitter:image'),
        'https://ai-novex.netlify.app/images/og-default.png'
      );
      assert.equal(getMetaMatches(aboutHtml, 'name', 'twitter:site').length, 0);

      const contactHtml = fs.readFileSync(path.join(tmpDir, 'dist', 'contact', 'index.html'), 'utf8');
      assert.deepEqual(getCanonicalLinks(contactHtml), ['https://ai-novex.netlify.app/contact/']);
      assert.equal(
        getSingleMeta(contactHtml, 'property', 'og:image'),
        'https://ai-novex.netlify.app/images/og-default.png'
      );
      assert.equal(
        getSingleMeta(contactHtml, 'name', 'twitter:image'),
        'https://ai-novex.netlify.app/images/og-default.png'
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    // Direct defense-in-depth test on applyResolvedSeoToHtml()
    const baseHtml = fs.readFileSync(path.join(REPO_ROOT, 'index.html'), 'utf8');
    const sanitizedDirect = applyResolvedSeoToHtml(baseHtml, {
      notFound: false,
      title: 'বাংলা "Safe" <Title>',
      description: 'Valid unicode বাংলা description with "quotes" & <brackets>.',
      siteName: 'AINOVEX',
      canonicalUrl: 'javascript:alert(1)',
      ogUrl: '//evil.example/og',
      ogTitle: 'বাংলা OG Title',
      ogDescription: 'OG desc',
      ogImage: 'data:text/html,<script>',
      ogType: 'website',
      ogImageAlt: 'Should disappear when ogImage is rejected',
      twitterTitle: 'Twitter Title',
      twitterDescription: 'Twitter desc',
      twitterImage: 'vbscript:evil',
      twitterImageAlt: 'Should disappear when twitterImage is rejected',
      twitterCard: 'summary',
      twitterSite: 'not_valid_handle',
      robotsContent: 'index, follow',
    });
    assert.equal(getCanonicalLinks(sanitizedDirect).length, 0);
    assert.equal(getMetaMatches(sanitizedDirect, 'property', 'og:url').length, 0);
    assert.equal(getMetaMatches(sanitizedDirect, 'property', 'og:image').length, 0);
    assert.equal(getMetaMatches(sanitizedDirect, 'property', 'og:image:alt').length, 0);
    assert.equal(getMetaMatches(sanitizedDirect, 'property', 'og:image:width').length, 0);
    assert.equal(getMetaMatches(sanitizedDirect, 'name', 'twitter:image').length, 0);
    assert.equal(getMetaMatches(sanitizedDirect, 'name', 'twitter:image:alt').length, 0);
    assert.equal(getMetaMatches(sanitizedDirect, 'name', 'twitter:site').length, 0);
    assert.equal(getTitleText(sanitizedDirect), 'বাংলা "Safe" <Title>');
  });

  it('10-11. Repeated build processing creates zero duplicate managed tags and preserves unrelated metadata and functionality', () => {
    // Inject duplicate managed tags into the starting template to verify cleanup + idempotency
    const rawTemplate = fs.readFileSync(path.join(REPO_ROOT, 'index.html'), 'utf8').replace(
      '</head>',
      `    <meta name="description" content="duplicate desc" />
    <meta name="twitter:image:alt" content="stale alt 1" />
    <meta name="twitter:image:alt" content="stale alt 2" />
    <meta name="twitter:site" content="@stale" />
    <meta property="article:published_time" content="1999-01-01" />
    <meta property="article:tag" content="StaleTag" />
  </head>`
    );

    const tmpDir = createIsolatedWorkspace({ seoConfig: realSeoConfig, templateHtml: rawTemplate });
    try {
      // Run postbuild TWICE against the same dist/ directory
      runIsolatedPostbuild(tmpDir);
      runIsolatedPostbuild(tmpDir);

      const filesToCheck = [
        'index.html',
        'about/index.html',
        'privacy/index.html',
        'blog/best-free-ai-tools-2026/index.html',
        'category/productivity/index.html',
        'author/md-shamim/index.html',
        '404.html',
      ];

      for (const rel of filesToCheck) {
        const html = fs.readFileSync(path.join(tmpDir, 'dist', rel), 'utf8');
        const is404 = rel === '404.html';
        const isArticle = rel.startsWith('blog/') && rel !== 'blog/index.html';

        // Single instance of each managed tag
        getTitleText(html);
        getSingleMeta(html, 'name', 'description');
        getSingleMeta(html, 'name', 'robots');
        getSingleMeta(html, 'property', 'og:site_name');
        getSingleMeta(html, 'property', 'og:title');
        getSingleMeta(html, 'property', 'og:description');
        getSingleMeta(html, 'property', 'og:type');
        getSingleMeta(html, 'property', 'og:image');
        getSingleMeta(html, 'property', 'og:image:alt');
        getSingleMeta(html, 'name', 'twitter:card');
        getSingleMeta(html, 'name', 'twitter:title');
        getSingleMeta(html, 'name', 'twitter:description');
        getSingleMeta(html, 'name', 'twitter:image');
        getSingleMeta(html, 'name', 'twitter:image:alt');
        assert.equal(getMetaMatches(html, 'name', 'twitter:site').length, 0);

        if (is404) {
          assert.equal(getCanonicalLinks(html).length, 0);
          assert.equal(getMetaMatches(html, 'property', 'og:url').length, 0);
        } else {
          assert.equal(getCanonicalLinks(html).length, 1);
          assert.equal(getMetaMatches(html, 'property', 'og:url').length, 1);
        }

        if (isArticle) {
          assert.equal(getMetaMatches(html, 'property', 'article:published_time').length, 1);
          assert.equal(getMetaMatches(html, 'property', 'article:modified_time').length, 1);
          assert.equal(getMetaMatches(html, 'property', 'article:author').length, 1);
          assert.equal(getMetaMatches(html, 'property', 'article:section').length, 1);
          assert.ok(getMetaMatches(html, 'property', 'article:tag').length >= 1);
          assert.equal(getMetaMatches(html, 'property', 'article:tag').includes('StaleTag'), false);
        } else {
          assert.equal(getMetaMatches(html, 'property', 'article:published_time').length, 0);
          assert.equal(getMetaMatches(html, 'property', 'article:tag').length, 0);
        }

        // Unrelated metadata and body functionality preserved
        assert.match(html, /<meta charset="UTF-8" \/>/i);
        assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1\.0" \/>/i);
        assert.match(html, /<meta property="og:locale" content="en_US" \/>/i);
        assert.match(html, /<meta name="theme-color" content="#0b101b" \/>/i);
        assert.match(html, /<link rel="alternate" type="application\/rss\+xml"/i);
        assert.match(html, /<script type="application\/ld\+json">/i);
        assert.match(html, /<div id="root">\s*<header/i);
        assert.match(html, /<main id="main-content"/i);
      }

      // Check semantic page-specific body content stayed accurate after 2nd run
      const artAfter2 = fs.readFileSync(
        path.join(tmpDir, 'dist', 'blog', 'best-free-ai-tools-2026', 'index.html'),
        'utf8'
      );
      assert.match(artAfter2, /Best Free AI Tools in 2026 for Productivity and Creators/);
      assert.ok(fs.existsSync(path.join(tmpDir, 'dist', 'sitemap.xml')));
      assert.ok(fs.existsSync(path.join(tmpDir, 'dist', 'rss.xml')));
      assert.ok(fs.existsSync(path.join(tmpDir, 'dist', 'robots.txt')));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('12. Missing or malformed content/seo.json never breaks the build and falls back safely', () => {
    const badVariants = [
      { label: 'missing seo.json', omitSeoFile: true },
      { label: 'corrupt JSON syntax', rawSeoText: '{ invalid json !!!' },
      { label: 'non-object JSON array', rawSeoText: '[1, 2, 3]' },
      {
        label: 'malformed seo fields',
        seoConfig: {
          version: 'bad',
          defaults: { defaultSeoTitle: 'ab', defaultMetaDescription: 'tiny', defaultOgImage: '//evil.com/x.png' },
          pages: {
            home: { pageId: 'home', path: '/', seoTitle: 'x', metaDescription: 'y', ogType: 'invalid' },
            broken: 'not-an-object',
          },
        },
      },
    ];

    for (const variant of badVariants) {
      const tmpDir = createIsolatedWorkspace(variant);
      try {
        runIsolatedPostbuild(tmpDir);

        const homeHtml = fs.readFileSync(path.join(tmpDir, 'dist', 'index.html'), 'utf8');
        const expectedHome = resolvePageSeo({
          path: '/',
          seoConfig: null,
          settings: realSettings,
          articles: realArticles,
          categories: realCategories,
          tools: [],
        });
        assert.equal(getTitleText(homeHtml), expectedHome.title, `[${variant.label}] homepage title`);
        assert.equal(
          getSingleMeta(homeHtml, 'name', 'description'),
          expectedHome.description,
          `[${variant.label}] homepage description`
        );
        assert.equal(
          getSingleMeta(homeHtml, 'property', 'og:image'),
          'https://ai-novex.netlify.app/images/og-default.png',
          `[${variant.label}] safe og:image`
        );

        const aboutHtml = fs.readFileSync(path.join(tmpDir, 'dist', 'about', 'index.html'), 'utf8');
        assert.equal(getTitleText(aboutHtml), 'About Us & Editorial Standards | AINOVEX');
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    }
  });

  it('13. Encodes ampersands once without double-escaping, handles entity-looking text, quotes/brackets, Unicode/Bengali, and repeated runs', () => {
    const seoCases = structuredClone(realSeoConfig);
    seoCases.defaults.siteName = 'AINOVEX & "Labs" <AI>';
    seoCases.pages.home.seoTitle = 'AI Tools & Tech Reviews | AINOVEX';
    seoCases.pages.home.metaDescription = 'Compare R&D tools, "quotes", \'apostrophes\', & <tags> safely.';
    seoCases.pages.about.seoTitle = 'AT&amp;T &lt;AI&gt; &quot;Standards&quot; — বাংলা & Tech';
    seoCases.pages.about.metaDescription = 'Existing literal text: &amp; &lt;b&gt; and plain & with বাংলা ইউনিকোড.';
    seoCases.pages['article:best-free-ai-tools-2026'] = {
      pageId: 'article:best-free-ai-tools-2026',
      pageType: 'article',
      path: '/blog/best-free-ai-tools-2026/',
      slug: 'best-free-ai-tools-2026',
      seoTitle: 'বাংলা এআই টুলস & গাইড "2026" <Review> | AINOVEX',
      metaDescription: 'Free AI & Productivity tools: "Top Picks" \'2026\' <Compare> — বাংলা গাইড।',
      ogTitle: 'বাংলা OG & "AINOVEX" <2026>',
      ogDescription: 'OG &amp; Twitter entity-looking + plain & with বাংলা।',
      ogImageAlt: 'Alt & "Quote" <Img> বাংলা',
      twitterTitle: 'Twitter & "Title" <2026>',
      twitterDescription: 'Twitter &amp; plain & description.',
      twitterImageAlt: 'Twitter Alt & <Tag> \'Single\'',
    };

    const tmpDir = createIsolatedWorkspace({ seoConfig: seoCases });
    try {
      // Run postbuild three times against the same dist/ directory to verify no progressive escaping
      runIsolatedPostbuild(tmpDir);
      const firstRunHome = fs.readFileSync(path.join(tmpDir, 'dist', 'index.html'), 'utf8');
      const firstRunAbout = fs.readFileSync(path.join(tmpDir, 'dist', 'about', 'index.html'), 'utf8');
      const firstRunArticle = fs.readFileSync(
        path.join(tmpDir, 'dist', 'blog', 'best-free-ai-tools-2026', 'index.html'),
        'utf8'
      );

      runIsolatedPostbuild(tmpDir);
      runIsolatedPostbuild(tmpDir);

      const homeHtml = fs.readFileSync(path.join(tmpDir, 'dist', 'index.html'), 'utf8');
      const aboutHtml = fs.readFileSync(path.join(tmpDir, 'dist', 'about', 'index.html'), 'utf8');
      const articleHtml = fs.readFileSync(
        path.join(tmpDir, 'dist', 'blog', 'best-free-ai-tools-2026', 'index.html'),
        'utf8'
      );

      // Idempotency across repeated runs
      assert.equal(homeHtml, firstRunHome);
      assert.equal(aboutHtml, firstRunAbout);
      assert.equal(articleHtml, firstRunArticle);

      // 1) Plain ampersands + quotes + angle brackets on homepage
      assert.equal(getRawTitleText(homeHtml), 'AI Tools &amp; Tech Reviews | AINOVEX');
      assert.equal(getTitleText(homeHtml), 'AI Tools & Tech Reviews | AINOVEX');
      assert.equal(getRawSingleMeta(homeHtml, 'property', 'og:title'), 'AI Tools &amp; Tech Reviews | AINOVEX');
      assert.equal(getSingleMeta(homeHtml, 'property', 'og:title'), 'AI Tools & Tech Reviews | AINOVEX');
      assert.equal(
        getRawSingleMeta(homeHtml, 'name', 'description'),
        'Compare R&amp;D tools, &quot;quotes&quot;, &#39;apostrophes&#39;, &amp; &lt;tags&gt; safely.'
      );
      assert.equal(
        getSingleMeta(homeHtml, 'name', 'description'),
        'Compare R&D tools, "quotes", \'apostrophes\', & <tags> safely.'
      );
      assert.equal(
        getRawSingleMeta(homeHtml, 'property', 'og:site_name'),
        'AINOVEX &amp; &quot;Labs&quot; &lt;AI&gt;'
      );
      assert.equal(getSingleMeta(homeHtml, 'property', 'og:site_name'), 'AINOVEX & "Labs" <AI>');
      assert.doesNotMatch(extractHeadWithoutScriptsOrStyles(homeHtml), /&amp;amp;/);

      // 2) Existing entity-looking source text must be escaped once at HTML boundary so browser decodes back to literal source
      assert.equal(
        getRawTitleText(aboutHtml),
        'AT&amp;amp;T &amp;lt;AI&amp;gt; &amp;quot;Standards&amp;quot; — বাংলা &amp; Tech'
      );
      assert.equal(
        getTitleText(aboutHtml),
        'AT&amp;T &lt;AI&gt; &quot;Standards&quot; — বাংলা & Tech'
      );
      assert.equal(
        getSingleMeta(aboutHtml, 'name', 'description'),
        'Existing literal text: &amp; &lt;b&gt; and plain & with বাংলা ইউনিকোড.'
      );
      assert.equal(
        getSingleMeta(aboutHtml, 'property', 'og:title'),
        'AT&amp;T &lt;AI&gt; &quot;Standards&quot; — বাংলা & Tech'
      );

      // 3) Bengali, Unicode, quotes, brackets across title + OG + Twitter meta attributes on article
      assert.equal(
        getRawTitleText(articleHtml),
        'বাংলা এআই টুলস &amp; গাইড &quot;2026&quot; &lt;Review&gt; | AINOVEX'
      );
      assert.equal(
        getTitleText(articleHtml),
        'বাংলা এআই টুলস & গাইড "2026" <Review> | AINOVEX'
      );
      assert.equal(
        getSingleMeta(articleHtml, 'name', 'description'),
        'Free AI & Productivity tools: "Top Picks" \'2026\' <Compare> — বাংলা গাইড।'
      );
      assert.equal(getSingleMeta(articleHtml, 'property', 'og:title'), 'বাংলা OG & "AINOVEX" <2026>');
      assert.equal(
        getSingleMeta(articleHtml, 'property', 'og:description'),
        'OG &amp; Twitter entity-looking + plain & with বাংলা।'
      );
      assert.equal(getSingleMeta(articleHtml, 'property', 'og:image:alt'), 'Alt & "Quote" <Img> বাংলা');
      assert.equal(getSingleMeta(articleHtml, 'name', 'twitter:title'), 'Twitter & "Title" <2026>');
      assert.equal(
        getSingleMeta(articleHtml, 'name', 'twitter:description'),
        'Twitter &amp; plain & description.'
      );
      assert.equal(getSingleMeta(articleHtml, 'name', 'twitter:image:alt'), 'Twitter Alt & <Tag> \'Single\'');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    // Direct applyResolvedSeoToHtml() check including article:* tags, query ampersands, and repeated application
    const templateHtml = fs.readFileSync(path.join(REPO_ROOT, 'index.html'), 'utf8');
    const resolvedPayload = {
      notFound: false,
      title: 'R&D "Alpha" <Beta> \'Gamma\' &amp; বাংলা',
      description: 'Desc & "Quotes" <Tags> বাংলা',
      siteName: 'AINOVEX & Co',
      canonicalUrl: 'https://ai-novex.netlify.app/search/?q=a&b=c',
      ogUrl: 'https://ai-novex.netlify.app/search/?q=a&b=c',
      ogTitle: 'OG & "Title" <Tag> বাংলা',
      ogDescription: 'OG Desc &amp; plain &',
      ogImage: 'https://ai-novex.netlify.app/images/og-default.png',
      ogType: 'article',
      ogImageAlt: 'OG Alt & "Img"',
      twitterTitle: 'Twitter & Title',
      twitterDescription: 'Twitter Desc & "More"',
      twitterImage: 'https://ai-novex.netlify.app/images/og-default.png',
      twitterImageAlt: 'Twitter Alt & \'Single\'',
      twitterCard: 'summary_large_image',
      robotsContent: 'index, follow',
      articleMeta: {
        published: '2026-11-21',
        modified: '2026-11-21',
        authorUrl: 'https://ai-novex.netlify.app/author/md-shamim/',
        section: 'Video & Audio',
        tags: ['AI & ML', 'Tools <2026>', 'বাংলা'],
      },
    };

    const once = applyResolvedSeoToHtml(templateHtml, resolvedPayload);
    const twice = applyResolvedSeoToHtml(once, resolvedPayload);
    assert.equal(twice, once);

    assert.equal(getTitleText(twice), resolvedPayload.title);
    assert.equal(getSingleMeta(twice, 'name', 'description'), resolvedPayload.description);
    assert.equal(getSingleMeta(twice, 'property', 'og:title'), resolvedPayload.ogTitle);
    assert.equal(getSingleMeta(twice, 'property', 'og:description'), resolvedPayload.ogDescription);
    assert.equal(getSingleMeta(twice, 'property', 'og:site_name'), resolvedPayload.siteName);
    assert.equal(getSingleMeta(twice, 'property', 'og:image:alt'), resolvedPayload.ogImageAlt);
    assert.equal(getSingleMeta(twice, 'name', 'twitter:title'), resolvedPayload.twitterTitle);
    assert.equal(getSingleMeta(twice, 'name', 'twitter:description'), resolvedPayload.twitterDescription);
    assert.equal(getSingleMeta(twice, 'name', 'twitter:image:alt'), resolvedPayload.twitterImageAlt);
    assert.equal(getSingleMeta(twice, 'property', 'article:section'), 'Video & Audio');
    assert.deepEqual(getMetaMatches(twice, 'property', 'article:tag'), ['AI & ML', 'Tools <2026>', 'বাংলা']);
    assert.deepEqual(getCanonicalLinks(twice), ['https://ai-novex.netlify.app/search/?q=a&b=c']);
    assert.equal(getSingleMeta(twice, 'property', 'og:url'), 'https://ai-novex.netlify.app/search/?q=a&b=c');
  });
});
