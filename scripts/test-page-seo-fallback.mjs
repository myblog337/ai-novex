import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  resolvePageSeo,
  STATIC_SEO_DEFAULTS,
  DEFAULT_SEO_TITLE,
  DEFAULT_META_DESCRIPTION,
  trimMetaDescription,
} from '../src/utils/pageSeo.js';

const REPO_ROOT = process.cwd();
const realArticles = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, 'content', 'articles.json'), 'utf8')
);
const realCategories = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, 'content', 'categories.json'), 'utf8')
);
const realTools = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, 'content', 'tools.json'), 'utf8')
);
const realSettings = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, 'content', 'settings.json'), 'utf8')
);

const GLOBAL_DEFAULTS = {
  siteName: 'AINOVEX',
  titleTemplate: '%s | AINOVEX',
  defaultSeoTitle: 'GLOBAL DEFAULT TITLE | AINOVEX',
  defaultMetaDescription:
    'Global default meta description used only when neither a page override nor route-specific metadata exists.',
  defaultOgTitle: 'GLOBAL DEFAULT OG TITLE | AINOVEX',
  defaultOgDescription:
    'Global default Open Graph description used only when neither a page override nor route-specific metadata exists.',
  defaultOgImage: '/images/og-default.png',
  defaultOgType: 'website',
  defaultTwitterCard: 'summary_large_image',
  defaultSchemaType: 'WebPage',
  defaultBreadcrumbEnabled: true,
};

describe('Task 114-B — Static Route SEO Fallback Precedence in resolvePageSeo()', () => {
  const representativeStaticRoutes = [
    { route: '/about/', key: '/about' },
    { route: '/contact/', key: '/contact' },
    { route: '/privacy/', key: '/privacy' },
    { route: '/terms/', key: '/terms' },
    { route: '/', key: '/' },
    { route: '/tools/', key: '/tools' },
    { route: '/blog/', key: '/blog' },
    { route: '/categories/', key: '/categories' },
    { route: '/editorial-policy/', key: '/editorial-policy' },
    { route: '/affiliate-disclosure/', key: '/affiliate-disclosure' },
  ];

  it('1. Preserves static route-specific title, description, ogTitle, and ogDescription when no page override exists', () => {
    const seoConfigNoPages = {
      version: 1,
      defaults: GLOBAL_DEFAULTS,
      pages: {},
    };

    for (const { route, key } of representativeStaticRoutes) {
      const expected = STATIC_SEO_DEFAULTS[key];
      const expectedDesc = trimMetaDescription(expected.description, 155);

      const resolved = resolvePageSeo({
        path: route,
        seoConfig: seoConfigNoPages,
        settings: realSettings,
        articles: realArticles,
        categories: realCategories,
        tools: realTools,
      });

      assert.equal(resolved.notFound, false, `${route} must not be 404`);
      assert.equal(resolved.hasPageOverride, false, `${route} should have no page override`);
      assert.equal(resolved.title, expected.title, `${route} title must preserve static default`);
      assert.equal(
        resolved.description,
        expectedDesc,
        `${route} description must preserve static default`
      );
      assert.equal(
        resolved.ogTitle,
        expected.title,
        `${route} ogTitle must preserve static default instead of global defaultOgTitle`
      );
      assert.equal(
        resolved.ogDescription,
        expectedDesc,
        `${route} ogDescription must preserve static default instead of global defaultOgDescription`
      );
      assert.notEqual(resolved.title, GLOBAL_DEFAULTS.defaultSeoTitle);
      assert.notEqual(resolved.ogTitle, GLOBAL_DEFAULTS.defaultOgTitle);
    }
  });

  it('2. Preserves static route-specific metadata even when global defaults omit defaultOgTitle/defaultOgDescription', () => {
    const seoConfig = {
      version: 1,
      defaults: {
        siteName: 'AINOVEX',
        defaultSeoTitle: 'GLOBAL SEO TITLE ONLY',
        defaultMetaDescription: 'Global meta description only that must not overwrite static routes.',
      },
      pages: {},
    };

    for (const route of ['/about/', '/contact/', '/privacy/', '/terms/']) {
      const key = route.slice(0, -1);
      const expected = STATIC_SEO_DEFAULTS[key];
      const expectedDesc = trimMetaDescription(expected.description, 155);

      const resolved = resolvePageSeo({
        path: route,
        seoConfig,
        settings: realSettings,
      });

      assert.equal(resolved.title, expected.title);
      assert.equal(resolved.description, expectedDesc);
      assert.equal(resolved.ogTitle, expected.title);
      assert.equal(resolved.ogDescription, expectedDesc);
    }
  });

  it('3. Gives explicit valid page-level overrides precedence over static route-specific and global defaults', () => {
    const seoConfig = {
      version: 1,
      defaults: GLOBAL_DEFAULTS,
      pages: {
        about: {
          pageId: 'about',
          pageType: 'about',
          path: '/about/',
          slug: 'about',
          seoTitle: 'Custom About Page SEO Title | AINOVEX',
          metaDescription:
            'Custom About page meta description overriding both static and global defaults.',
          ogTitle: 'Custom About OG Title',
          ogDescription: 'Custom About OG description overriding static and global defaults.',
        },
        contact: {
          pageId: 'contact',
          pageType: 'contact',
          path: '/contact/',
          slug: 'contact',
          seoTitle: 'Custom Contact SEO Title | AINOVEX',
          metaDescription:
            'Custom Contact meta description without explicit OG fields should propagate to OG.',
        },
        privacy: {
          pageId: 'privacy',
          pageType: 'privacy',
          path: '/privacy/',
          slug: 'privacy',
          ogTitle: 'Privacy Policy OpenGraph Override',
          ogDescription: 'Privacy Policy OpenGraph description override only.',
        },
      },
    };

    // Full explicit override on /about/
    const about = resolvePageSeo({ path: '/about/', seoConfig, settings: realSettings });
    assert.equal(about.hasPageOverride, true);
    assert.equal(about.title, 'Custom About Page SEO Title | AINOVEX');
    assert.equal(
      about.description,
      'Custom About page meta description overriding both static and global defaults.'
    );
    assert.equal(about.ogTitle, 'Custom About OG Title');
    assert.equal(
      about.ogDescription,
      'Custom About OG description overriding static and global defaults.'
    );

    // Partial override (seoTitle + metaDescription only) on /contact/ inherits into OG
    const contact = resolvePageSeo({ path: '/contact/', seoConfig, settings: realSettings });
    assert.equal(contact.title, 'Custom Contact SEO Title | AINOVEX');
    assert.equal(
      contact.description,
      'Custom Contact meta description without explicit OG fields should propagate to OG.'
    );
    assert.equal(contact.ogTitle, 'Custom Contact SEO Title | AINOVEX');
    assert.equal(
      contact.ogDescription,
      'Custom Contact meta description without explicit OG fields should propagate to OG.'
    );

    // Partial override (ogTitle + ogDescription only) on /privacy/ preserves static title/description
    const privacy = resolvePageSeo({ path: '/privacy/', seoConfig, settings: realSettings });
    assert.equal(privacy.title, STATIC_SEO_DEFAULTS['/privacy'].title);
    assert.equal(
      privacy.description,
      trimMetaDescription(STATIC_SEO_DEFAULTS['/privacy'].description, 155)
    );
    assert.equal(privacy.ogTitle, 'Privacy Policy OpenGraph Override');
    assert.equal(privacy.ogDescription, 'Privacy Policy OpenGraph description override only.');
  });

  it('4. Ignores empty and invalid page-level override values and falls back cleanly', () => {
    const invalidOverrideCases = [
      {
        label: 'null values',
        fields: { seoTitle: null, metaDescription: null, ogTitle: null, ogDescription: null },
      },
      {
        label: 'empty and whitespace-only strings',
        fields: { seoTitle: '', metaDescription: '   ', ogTitle: '  \t ', ogDescription: '' },
      },
      {
        label: 'non-string types',
        fields: { seoTitle: 12345, metaDescription: true, ogTitle: {}, ogDescription: [] },
      },
      {
        label: 'control characters',
        fields: {
          seoTitle: 'Bad\nTitle',
          metaDescription: 'Bad\x00Description long enough',
          ogTitle: 'Bad\rOG',
          ogDescription: 'Bad\nOG desc',
        },
      },
      {
        label: 'too-short seoTitle and metaDescription',
        fields: {
          seoTitle: 'ab',
          metaDescription: 'Too short',
          ogTitle: '',
          ogDescription: '   ',
        },
      },
      {
        label: 'over-max-length strings',
        fields: {
          seoTitle: 'T'.repeat(161),
          metaDescription: 'D'.repeat(321),
          ogTitle: 'O'.repeat(161),
          ogDescription: 'G'.repeat(321),
        },
      },
    ];

    for (const testCase of invalidOverrideCases) {
      const seoConfig = {
        version: 1,
        defaults: GLOBAL_DEFAULTS,
        pages: {
          terms: {
            pageId: 'terms',
            pageType: 'terms',
            path: '/terms/',
            slug: 'terms',
            ...testCase.fields,
          },
        },
      };

      const resolved = resolvePageSeo({
        path: '/terms/',
        seoConfig,
        settings: realSettings,
      });

      const expected = STATIC_SEO_DEFAULTS['/terms'];
      const expectedDesc = trimMetaDescription(expected.description, 155);

      assert.equal(
        resolved.title,
        expected.title,
        `[${testCase.label}] title must fall back to static route default`
      );
      assert.equal(
        resolved.description,
        expectedDesc,
        `[${testCase.label}] description must fall back to static route default`
      );
      assert.equal(
        resolved.ogTitle,
        expected.title,
        `[${testCase.label}] ogTitle must fall back to static route default`
      );
      assert.equal(
        resolved.ogDescription,
        expectedDesc,
        `[${testCase.label}] ogDescription must fall back to static route default`
      );
    }
  });

  it('5. Uses global defaults when no route-specific metadata exists, and safe final fallback when global defaults are missing/invalid', () => {
    // Route without static route-specific metadata + valid global defaults
    const withGlobals = resolvePageSeo({
      path: '/unconfigured-static-route/',
      seoConfig: { version: 1, defaults: GLOBAL_DEFAULTS, pages: {} },
      settings: realSettings,
    });
    assert.equal(withGlobals.notFound, true);
    assert.equal(withGlobals.title, GLOBAL_DEFAULTS.defaultSeoTitle);
    assert.equal(withGlobals.description, GLOBAL_DEFAULTS.defaultMetaDescription);
    assert.equal(withGlobals.ogTitle, GLOBAL_DEFAULTS.defaultOgTitle);
    assert.equal(withGlobals.ogDescription, GLOBAL_DEFAULTS.defaultOgDescription);

    // Route without static route-specific metadata + invalid/empty global defaults -> safe final fallback
    const withoutGlobals = resolvePageSeo({
      path: '/unconfigured-static-route/',
      seoConfig: {
        version: 1,
        defaults: {
          defaultSeoTitle: 'ab',
          defaultMetaDescription: 'short',
          defaultOgTitle: '   ',
          defaultOgDescription: null,
        },
        pages: {},
      },
      settings: {},
    });
    assert.equal(withoutGlobals.notFound, true);
    assert.equal(withoutGlobals.title, 'Page Not Found | AINOVEX');
    assert.ok(withoutGlobals.description.startsWith('The page you are looking for does not exist.'));
    assert.equal(withoutGlobals.ogTitle, 'Page Not Found | AINOVEX');
    assert.equal(withoutGlobals.ogDescription, withoutGlobals.description);

    // Known static route when seoConfig is null still uses route-specific static metadata (and never undefined)
    const nullConfigAbout = resolvePageSeo({
      path: '/about/',
      seoConfig: null,
      settings: {},
    });
    assert.equal(nullConfigAbout.title, STATIC_SEO_DEFAULTS['/about'].title);
    assert.equal(
      nullConfigAbout.description,
      trimMetaDescription(STATIC_SEO_DEFAULTS['/about'].description, 155)
    );
    assert.equal(nullConfigAbout.ogTitle, STATIC_SEO_DEFAULTS['/about'].title);
    assert.equal(nullConfigAbout.ogDescription, nullConfigAbout.description);
    assert.ok(DEFAULT_SEO_TITLE && DEFAULT_META_DESCRIPTION);
  });

  it('6. Preserves existing entity-route behavior (article, category, tool, author) unchanged', () => {
    const baseSeoConfig = {
      version: 1,
      defaults: GLOBAL_DEFAULTS,
      pages: {},
    };

    // Article without override -> uses article metaTitle / metaDescription
    const articleRes = resolvePageSeo({
      path: '/blog/best-free-ai-tools-2026/',
      seoConfig: baseSeoConfig,
      settings: realSettings,
      articles: realArticles,
      categories: realCategories,
      tools: realTools,
    });
    assert.equal(articleRes.routeKind, 'article');
    assert.equal(
      articleRes.title,
      'Best Free AI Tools in 2026 for Productivity & Creators | AINOVEX'
    );
    assert.equal(
      articleRes.ogTitle,
      'Best Free AI Tools in 2026 for Productivity & Creators | AINOVEX'
    );
    assert.equal(
      articleRes.description,
      'Explore top free AI tools in 2026. Boost your writing, design, research, and daily productivity without expensive software subscriptions.'
    );
    assert.equal(articleRes.ogDescription, articleRes.description);

    // Category without override -> uses categoryTitle + category description
    const categoryRes = resolvePageSeo({
      path: '/category/ai-writing/',
      seoConfig: baseSeoConfig,
      settings: realSettings,
      articles: realArticles,
      categories: realCategories,
      tools: realTools,
    });
    assert.equal(categoryRes.routeKind, 'category');
    assert.equal(categoryRes.title, 'AI Writing Tools & Practical Guides 2026 | AINOVEX');
    assert.equal(categoryRes.ogTitle, categoryRes.title);
    assert.match(categoryRes.description, /AI tools for generating high-quality blog posts/);
    assert.equal(categoryRes.ogDescription, categoryRes.description);

    // Tool without override -> uses tool title template + longDescription
    const toolRes = resolvePageSeo({
      path: '/tools/chatgpt/',
      seoConfig: baseSeoConfig,
      settings: realSettings,
      articles: realArticles,
      categories: realCategories,
      tools: realTools,
    });
    assert.equal(toolRes.routeKind, 'tool');
    assert.equal(toolRes.title, 'ChatGPT - AI Tool Review, Pricing & Overview | AINOVEX');
    assert.equal(toolRes.ogTitle, toolRes.title);
    assert.match(toolRes.description, /conversational AI model by OpenAI/);
    assert.equal(toolRes.ogDescription, toolRes.description);

    // Author without override -> uses author seoTitle + seoDescription
    const authorRes = resolvePageSeo({
      path: '/author/md-shamim/',
      seoConfig: baseSeoConfig,
      settings: realSettings,
      articles: realArticles,
      categories: realCategories,
      tools: realTools,
    });
    assert.equal(authorRes.routeKind, 'author');
    assert.equal(authorRes.title, 'Md Shamim - Lead Researcher & Editor | AINOVEX');
    assert.equal(authorRes.ogTitle, authorRes.title);
    assert.match(authorRes.description, /Md Shamim/);
    assert.equal(authorRes.ogDescription, authorRes.description);

    // Entity with explicit page-level override -> override wins, and invalid override falls back to entity
    const overrideSeoConfig = {
      version: 1,
      defaults: GLOBAL_DEFAULTS,
      pages: {
        'article:best-free-ai-tools-2026': {
          pageId: 'article:best-free-ai-tools-2026',
          pageType: 'article',
          path: '/blog/best-free-ai-tools-2026/',
          slug: 'best-free-ai-tools-2026',
          seoTitle: 'Override Article Title | AINOVEX',
          ogTitle: 'Override Article OG Title',
        },
        'tool:chatgpt': {
          pageId: 'tool:chatgpt',
          pageType: 'tool',
          path: '/tools/chatgpt/',
          slug: 'chatgpt',
          seoTitle: 'ab',
          metaDescription: 'short',
        },
      },
    };

    const overriddenArticle = resolvePageSeo({
      path: '/blog/best-free-ai-tools-2026/',
      seoConfig: overrideSeoConfig,
      settings: realSettings,
      articles: realArticles,
      categories: realCategories,
      tools: realTools,
    });
    assert.equal(overriddenArticle.title, 'Override Article Title | AINOVEX');
    assert.equal(overriddenArticle.ogTitle, 'Override Article OG Title');

    const invalidOverrideTool = resolvePageSeo({
      path: '/tools/chatgpt/',
      seoConfig: overrideSeoConfig,
      settings: realSettings,
      articles: realArticles,
      categories: realCategories,
      tools: realTools,
    });
    assert.equal(invalidOverrideTool.title, 'ChatGPT - AI Tool Review, Pricing & Overview | AINOVEX');
    assert.match(invalidOverrideTool.description, /conversational AI model by OpenAI/);
  });
});
