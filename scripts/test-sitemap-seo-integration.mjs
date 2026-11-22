import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  isResolvedIndexable,
  resolveSitemapCanonicalUrl,
  runFinalizeSitemap,
} from './finalize-sitemap.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const realSettings = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, 'content', 'settings.json'), 'utf8')
);
const realCategories = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, 'content', 'categories.json'), 'utf8')
);
const realArticles = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, 'content', 'articles.json'), 'utf8')
);
const realTools = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, 'content', 'tools.json'), 'utf8')
);
const realSeoConfig = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, 'content', 'seo.json'), 'utf8')
);

function createIsolatedWorkspace({
  settings = realSettings,
  categories = realCategories,
  articles = realArticles,
  tools = realTools,
  seoConfig = realSeoConfig,
  rawSeoText = null,
  omitSeoFile = false,
} = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ainovex-sitemap-seo-test-'));
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
      fs.copyFileSync(path.join(REPO_ROOT, 'content', 'articles', file), path.join(articlesDir, file));
    }
  }
  for (const article of articles) {
    if (article?.slug) {
      const mdPath = path.join(articlesDir, `${article.slug}.md`);
      if (!fs.existsSync(mdPath)) {
        fs.writeFileSync(mdPath, `# ${article.title || article.slug}\n\nTest article body.\n`);
      }
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

function runFinalizeCli(tmpDir) {
  execFileSync(process.execPath, [path.join(REPO_ROOT, 'scripts', 'finalize-sitemap.mjs')], {
    cwd: tmpDir,
    stdio: 'pipe',
  });
  return fs.readFileSync(path.join(tmpDir, 'dist', 'sitemap.xml'), 'utf8');
}

function runPostbuildAndFinalizeCli(tmpDir) {
  execFileSync(process.execPath, [path.join(REPO_ROOT, 'scripts', 'postbuild.mjs')], {
    cwd: tmpDir,
    stdio: 'pipe',
  });
  return runFinalizeCli(tmpDir);
}

function extractSitemapUrls(xml) {
  const urlBlocks = [...xml.matchAll(/<url>([\s\S]*?)<\/url>/g)].map((m) => m[1]);
  return urlBlocks.map((block) => {
    const locMatch = block.match(/<loc>([^<]*)<\/loc>/);
    const lastmodMatch = block.match(/<lastmod>([^<]*)<\/lastmod>/);
    return {
      loc: locMatch ? locMatch[1] : null,
      lastmod: lastmodMatch ? lastmodMatch[1] : null,
    };
  });
}

describe('Task 114-E — Page-Level SEO Integration with Sitemap and Indexing Rules', () => {
  it('1-2 & 5-8. Includes homepage, indexable static pages, published articles, non-empty categories, and authors while excluding noindex static pages and empty categories', () => {
    const tmpDir = createIsolatedWorkspace();
    try {
      const xml = runFinalizeCli(tmpDir);
      const entries = extractSitemapUrls(xml);
      const locs = entries.map((e) => e.loc);
      const base = 'https://ai-novex.netlify.app';

      // 1. Indexable homepage
      assert.ok(locs.includes(`${base}/`), 'Homepage must be included');

      // Other indexable static pages
      for (const staticRoute of ['/tools/', '/blog/', '/categories/', '/about/', '/contact/', '/editorial-policy/']) {
        assert.ok(locs.includes(`${base}${staticRoute}`), `${staticRoute} must be included`);
      }

      // 2. "noindex" static pages excluded
      for (const noindexRoute of ['/privacy/', '/terms/', '/affiliate-disclosure/']) {
        assert.equal(locs.includes(`${base}${noindexRoute}`), false, `${noindexRoute} must be excluded`);
      }

      // 5. Indexable published articles included
      for (const article of realArticles.filter((a) => a.isPublished)) {
        assert.ok(locs.includes(`${base}/blog/${article.slug}/`), `Article ${article.slug} must be included`);
      }

      // 6. Indexable non-empty categories included
      for (const catSlug of ['business', 'productivity', 'education', 'video-audio']) {
        assert.ok(locs.includes(`${base}/category/${catSlug}/`), `Category ${catSlug} must be included`);
      }

      // 8. Empty categories excluded
      for (const emptyCat of ['ai-writing', 'image-generation', 'design-art', 'code-dev', 'others']) {
        assert.equal(locs.includes(`${base}/category/${emptyCat}/`), false, `Empty category ${emptyCat} must be excluded`);
      }

      // 7. Indexable author included
      assert.ok(locs.includes(`${base}/author/md-shamim/`), 'Author md-shamim must be included');

      // Published tool detail pages included
      for (const tool of realTools) {
        assert.ok(locs.includes(`${base}/tools/${tool.slug}/`), `Tool ${tool.slug} must be included`);
      }

      // Exact expected baseline count (7 static + 1 author + 4 articles + 4 categories + 8 tools = 24)
      assert.equal(locs.length, 24);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('3. Excludes pages with page-level "noindex" overrides (homepage, static, article, category, author)', () => {
    const seoConfig = structuredClone(realSeoConfig);
    seoConfig.pages.home.index = false;
    seoConfig.pages.about.index = false;
    seoConfig.pages['article:best-free-ai-tools-2026'] = {
      pageId: 'article:best-free-ai-tools-2026',
      pageType: 'article',
      path: '/blog/best-free-ai-tools-2026/',
      slug: 'best-free-ai-tools-2026',
      index: false,
      follow: true,
    };
    seoConfig.pages['category:productivity'] = {
      pageId: 'category:productivity',
      pageType: 'category',
      path: '/category/productivity/',
      slug: 'productivity',
      index: false,
      follow: false,
    };
    seoConfig.pages['author:md-shamim'] = {
      pageId: 'author:md-shamim',
      pageType: 'author',
      path: '/author/md-shamim/',
      slug: 'md-shamim',
      index: false,
    };
    // index: true + follow: false must still be INCLUDED because it does NOT contain noindex
    seoConfig.pages.contact.index = true;
    seoConfig.pages.contact.follow = false;

    const tmpDir = createIsolatedWorkspace({ seoConfig });
    try {
      const xml = runFinalizeCli(tmpDir);
      const locs = extractSitemapUrls(xml).map((e) => e.loc);
      const base = 'https://ai-novex.netlify.app';

      assert.equal(locs.includes(`${base}/`), false);
      assert.equal(locs.includes(`${base}/about/`), false);
      assert.equal(locs.includes(`${base}/blog/best-free-ai-tools-2026/`), false);
      assert.equal(locs.includes(`${base}/category/productivity/`), false);
      assert.equal(locs.includes(`${base}/author/md-shamim/`), false);

      // index: true, follow: false remains included; other non-overridden pages remain included
      assert.ok(locs.includes(`${base}/contact/`));
      assert.ok(locs.includes(`${base}/blog/how-to-summarize-a-pdf-with-ai/`));
      assert.ok(locs.includes(`${base}/category/business/`));
      assert.equal(locs.length, 19);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('4 & 8. Honors page-level "index" overrides while enforcing safe existing policies (empty categories, unpublished articles, unrouted paths)', () => {
    const articlesWithDraft = [
      ...realArticles,
      {
        ...realArticles[0],
        id: 'draft-secret-guide',
        slug: 'draft-secret-guide',
        title: 'Unpublished Draft Guide',
        contentPath: 'content/articles/draft-secret-guide.md',
        author: 'Draft Author',
        isPublished: false,
      },
    ];

    const toolsWithUnpublished = [
      ...realTools,
      {
        ...realTools[0],
        id: 'secret-draft-tool',
        name: 'Secret Draft Tool',
        slug: 'secret-draft-tool',
        isPublished: false,
      },
    ];

    const seoConfig = structuredClone(realSeoConfig);
    // Global defaultIndex = false, but explicitly enable /about/, /privacy/, and published tool:chatgpt
    seoConfig.defaults.defaultIndex = false;
    delete seoConfig.pages.contact.index;
    seoConfig.pages.about.index = true;
    seoConfig.pages.privacy.index = true;

    // Attempt to force index: true on policy-excluded or unrouted entries
    seoConfig.pages['category:ai-writing'] = {
      pageId: 'category:ai-writing',
      pageType: 'category',
      path: '/category/ai-writing/',
      slug: 'ai-writing',
      index: true,
    };
    seoConfig.pages['article:draft-secret-guide'] = {
      pageId: 'article:draft-secret-guide',
      pageType: 'article',
      path: '/blog/draft-secret-guide/',
      slug: 'draft-secret-guide',
      index: true,
    };
    seoConfig.pages['author:draft-author'] = {
      pageId: 'author:draft-author',
      pageType: 'author',
      path: '/author/draft-author/',
      slug: 'draft-author',
      index: true,
    };
    seoConfig.pages['tool:chatgpt'] = {
      pageId: 'tool:chatgpt',
      pageType: 'tool',
      path: '/tools/chatgpt/',
      slug: 'chatgpt',
      index: true,
    };
    seoConfig.pages['tool:secret-draft-tool'] = {
      pageId: 'tool:secret-draft-tool',
      pageType: 'tool',
      path: '/tools/secret-draft-tool/',
      slug: 'secret-draft-tool',
      index: true,
    };
    seoConfig.pages['static:unrouted-custom'] = {
      pageId: 'static:unrouted-custom',
      pageType: 'static',
      path: '/unrouted-custom/',
      slug: 'unrouted-custom',
      index: true,
    };

    const tmpDir = createIsolatedWorkspace({
      articles: articlesWithDraft,
      tools: toolsWithUnpublished,
      seoConfig,
    });
    try {
      const xml = runFinalizeCli(tmpDir);
      const locs = extractSitemapUrls(xml).map((e) => e.loc);
      const base = 'https://ai-novex.netlify.app';

      // Page-level index: true overrides work for valid static pages and published tools
      assert.ok(locs.includes(`${base}/about/`));
      assert.ok(locs.includes(`${base}/privacy/`));
      assert.ok(locs.includes(`${base}/tools/chatgpt/`));

      // Contact and non-overridden published tools lack explicit page-level index: true so defaults.defaultIndex = false excludes them
      assert.equal(locs.includes(`${base}/contact/`), false);
      assert.equal(locs.includes(`${base}/tools/midjourney/`), false);

      // Empty category, unpublished article, draft author, unpublished tool, and unrouted paths remain strictly excluded
      assert.equal(locs.includes(`${base}/category/ai-writing/`), false);
      assert.equal(locs.includes(`${base}/blog/draft-secret-guide/`), false);
      assert.equal(locs.includes(`${base}/author/draft-author/`), false);
      assert.equal(locs.includes(`${base}/tools/secret-draft-tool/`), false);
      assert.equal(locs.includes(`${base}/unrouted-custom/`), false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('9-11. Uses valid same-origin custom canonicals, normalizes trailing slashes, rejects unsafe/invalid/cross-origin canonicals, and eliminates duplicate canonicals', () => {
    const seoConfig = structuredClone(realSeoConfig);
    // 9. Valid same-origin custom canonical (and one missing trailing slash)
    seoConfig.pages.about.canonicalUrl = 'https://ai-novex.netlify.app/about-canonical/';
    seoConfig.pages.contact.canonicalUrl = 'https://ai-novex.netlify.app/contact-canonical';

    // 11. Duplicate canonical: /editorial-policy/ points to /about-canonical/
    seoConfig.pages['static:editorial-policy'].canonicalUrl = 'https://ai-novex.netlify.app/about-canonical/';

    // 10. Unsafe, malformed, protocol-relative, and cross-origin canonicals
    seoConfig.pages.home.canonicalUrl = 'javascript:alert(1)';
    seoConfig.pages['static:tools'].canonicalUrl = '//evil.example.com/tools/';
    seoConfig.pages['static:blog'].canonicalUrl = 'https://external.example.com/hijacked-blog/';
    seoConfig.pages['static:categories'].canonicalUrl = 'https://user:pass@ai-novex.netlify.app/categories/';

    const articlesWithCanon = structuredClone(realArticles);
    articlesWithCanon[0].canonicalUrl = 'https://ai-novex.netlify.app/blog/custom-catalog-canonical/';
    articlesWithCanon[1].canonicalUrl = 'http://127.1/ssrf-attempt/';

    const tmpDir = createIsolatedWorkspace({ articles: articlesWithCanon, seoConfig });
    try {
      const xml = runFinalizeCli(tmpDir);
      const locs = extractSitemapUrls(xml).map((e) => e.loc);
      const base = 'https://ai-novex.netlify.app';

      // Valid custom canonicals applied with trailing slash policy preserved
      assert.ok(locs.includes(`${base}/about-canonical/`));
      assert.ok(locs.includes(`${base}/contact-canonical/`));
      assert.ok(locs.includes(`${base}/blog/custom-catalog-canonical/`));

      // Duplicate canonical eliminated (only appears once)
      assert.equal(locs.filter((u) => u === `${base}/about-canonical/`).length, 1);

      // Unsafe / cross-origin canonicals rejected and fell back to safe production-origin route URLs
      assert.ok(locs.includes(`${base}/`));
      assert.ok(locs.includes(`${base}/tools/`));
      assert.ok(locs.includes(`${base}/blog/`));
      assert.ok(locs.includes(`${base}/categories/`));
      assert.ok(locs.includes(`${base}/blog/${articlesWithCanon[1].slug}/`));

      assert.equal(locs.some((u) => u.includes('evil.example.com')), false);
      assert.equal(locs.some((u) => u.includes('external.example.com')), false);
      assert.equal(locs.some((u) => u.includes('javascript:')), false);
      assert.equal(locs.some((u) => u.includes('user:pass')), false);
      assert.equal(locs.some((u) => u.includes('127.1')), false);

      // Every URL ends with / and matches production origin
      for (const u of locs) {
        assert.ok(u.startsWith(`${base}/`), `Unexpected origin: ${u}`);
        assert.ok(u.endsWith('/'), `Missing trailing slash: ${u}`);
      }
      assert.equal(new Set(locs).size, locs.length, 'Duplicate URLs found in sitemap');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('12-13. Enforces configured productionUrl origin and produces valid escaped XML', () => {
    const customSettings = {
      ...realSettings,
      productionUrl: 'https://custom-ainovex.example.org',
    };
    const seoConfig = structuredClone(realSeoConfig);
    // Stale origin canonical from old domain must be rejected in favor of new productionUrl
    seoConfig.pages.about.canonicalUrl = 'https://ai-novex.netlify.app/about/';
    // Valid custom canonical on new origin with '&' and "'" characters in path to verify XML escaping
    seoConfig.pages.contact.canonicalUrl = "https://custom-ainovex.example.org/contact-us/q&a's/";

    const tmpDir = createIsolatedWorkspace({ settings: customSettings, seoConfig });
    try {
      const xml = runFinalizeCli(tmpDir);
      assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'));
      assert.ok(xml.endsWith('</urlset>\n'));

      // Verify XML escaping for '&' and '\''
      assert.ok(
        xml.includes('<loc>https://custom-ainovex.example.org/contact-us/q&amp;a&apos;s/</loc>'),
        'Expected XML-escaped &amp; and &apos; in <loc>'
      );
      assert.equal(/&(?!amp;|lt;|gt;|quot;|apos;)/.test(xml), false, 'Found unescaped ampersand in XML');

      const locs = extractSitemapUrls(xml).map((e) => e.loc);
      for (const u of locs) {
        assert.ok(u.startsWith('https://custom-ainovex.example.org/'), `Wrong origin: ${u}`);
        assert.equal(u.includes('ai-novex.netlify.app'), false);
      }
      assert.ok(locs.includes('https://custom-ainovex.example.org/about/'));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('14. Falls back safely when content/seo.json is missing or malformed without crashing', () => {
    const badVariants = [
      { label: 'missing seo.json', omitSeoFile: true },
      { label: 'corrupt JSON syntax', rawSeoText: '{ invalid json !!!' },
      { label: 'JSON array instead of object', rawSeoText: '[1, 2, 3]' },
      {
        label: 'malformed fields inside seo.json',
        seoConfig: {
          version: 'bad',
          defaults: { defaultIndex: 'not-a-boolean' },
          pages: {
            home: { pageId: 'home', path: '/', index: 'no', canonicalUrl: 'javascript:evil()' },
            privacy: { pageId: 'privacy', path: '/privacy/', index: 'yes' },
            broken: 'not-an-object',
          },
        },
      },
    ];

    for (const variant of badVariants) {
      const tmpDir = createIsolatedWorkspace(variant);
      try {
        const xml = runFinalizeCli(tmpDir);
        const locs = extractSitemapUrls(xml).map((e) => e.loc);
        const base = 'https://ai-novex.netlify.app';

        assert.ok(locs.includes(`${base}/`), `[${variant.label}] Homepage must fall back to indexable`);
        assert.ok(locs.includes(`${base}/about/`), `[${variant.label}] About must fall back to indexable`);
        assert.equal(locs.includes(`${base}/privacy/`), false, `[${variant.label}] Privacy must fall back to noindex`);
        assert.equal(locs.includes(`${base}/terms/`), false, `[${variant.label}] Terms must fall back to noindex`);
        assert.equal(locs.length, 24, `[${variant.label}] Baseline URL count preserved`);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    }
  });

  it('15-16. Produces deterministic output on repeated runs and preserves robots.txt crawling policy', () => {
    const tmpDir = createIsolatedWorkspace();
    try {
      const firstXml = runPostbuildAndFinalizeCli(tmpDir);
      const secondXml = runFinalizeCli(tmpDir);
      const thirdXml = runFinalizeCli(tmpDir);

      assert.equal(secondXml, firstXml);
      assert.equal(thirdXml, firstXml);

      const robotsTxt = fs.readFileSync(path.join(tmpDir, 'dist', 'robots.txt'), 'utf8');
      assert.equal(
        robotsTxt,
        'User-agent: *\nAllow: /\n\nSitemap: https://ai-novex.netlify.app/sitemap.xml\n'
      );
      assert.doesNotMatch(robotsTxt, /Disallow:/i);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('Unit checks on helper guards (isResolvedIndexable and resolveSitemapCanonicalUrl)', () => {
    assert.equal(isResolvedIndexable({ notFound: false, index: true, noindex: false, robotsContent: 'index, follow' }), true);
    assert.equal(isResolvedIndexable({ notFound: false, index: true, noindex: false, robotsContent: 'index, nofollow, max-image-preview:large' }), true);
    assert.equal(isResolvedIndexable({ notFound: false, index: false, noindex: true, robotsContent: 'noindex, follow' }), false);
    assert.equal(isResolvedIndexable({ notFound: true, index: true, noindex: false, robotsContent: 'index, follow' }), false);
    assert.equal(isResolvedIndexable({ notFound: false, index: true, noindex: false, robotsContent: 'noindex, follow' }), false);

    assert.equal(
      resolveSitemapCanonicalUrl(
        { canonicalUrl: 'https://ai-novex.netlify.app/custom', pageUrl: 'https://ai-novex.netlify.app/about/' },
        'https://ai-novex.netlify.app',
        '/about/'
      ),
      'https://ai-novex.netlify.app/custom/'
    );
    assert.equal(
      resolveSitemapCanonicalUrl(
        { canonicalUrl: 'https://evil.com/phish/', pageUrl: 'https://ai-novex.netlify.app/about/' },
        'https://ai-novex.netlify.app',
        '/about/'
      ),
      'https://ai-novex.netlify.app/about/'
    );
    assert.equal(
      resolveSitemapCanonicalUrl(
        { canonicalUrl: 'https://ai-novex.netlify.app/about/?q=1#top', pageUrl: 'https://ai-novex.netlify.app/about/' },
        'https://ai-novex.netlify.app',
        '/about/'
      ),
      'https://ai-novex.netlify.app/about/'
    );

    // Direct invocation of runFinalizeSitemap in isolated temp dir
    const tmpDir = createIsolatedWorkspace();
    try {
      const result = runFinalizeSitemap(tmpDir);
      assert.equal(result.entries.size, 24);
      assert.ok(fs.existsSync(path.join(tmpDir, 'dist', 'sitemap.xml')));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
