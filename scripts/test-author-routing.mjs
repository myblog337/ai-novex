import test from 'node:test';
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

import {
  getAuthorSlug,
  getArticleAuthorProfile,
  collectAuthors,
  findAuthorBySlug,
} from '../src/utils/authors.js';
import { isIndexable } from '../src/config/indexing.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function makeArticle(overrides = {}) {
  const slug = overrides.slug || 'sample-ai-guide';
  return {
    id: slug,
    slug,
    title: `Title for ${slug}`,
    excerpt: `Excerpt for ${slug}`,
    contentPath: `content/articles/${slug}.md`,
    category: 'productivity',
    categoryName: 'Productivity',
    author: 'Md Shamim',
    publishedAt: '2026-04-01',
    updatedAt: '2026-04-05',
    isPublished: true,
    featuredImage: '/images/articles/best-free-ai-tools-2026.webp',
    ogImage: '/images/articles/best-free-ai-tools-2026-og.webp',
    imageAlt: 'Sample image',
    readingTime: '5 min read',
    tags: ['AI'],
    metaTitle: `Meta ${slug}`,
    metaDescription: `Meta description for ${slug}`,
    ...overrides,
  };
}

function createIsolatedWorkspace({ articles, copyRealContent = false }) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ainovex-author-test-'));
  const distDir = path.join(tmpDir, 'dist');
  const contentDir = path.join(tmpDir, 'content');
  const articlesDir = path.join(contentDir, 'articles');

  fs.mkdirSync(distDir, { recursive: true });
  fs.mkdirSync(articlesDir, { recursive: true });

  // Provide dist/index.html template based on repo index.html
  fs.copyFileSync(path.join(REPO_ROOT, 'index.html'), path.join(distDir, 'index.html'));
  fs.copyFileSync(path.join(REPO_ROOT, 'content', 'settings.json'), path.join(contentDir, 'settings.json'));
  fs.copyFileSync(path.join(REPO_ROOT, 'content', 'categories.json'), path.join(contentDir, 'categories.json'));
  fs.copyFileSync(path.join(REPO_ROOT, 'content', 'tools.json'), path.join(contentDir, 'tools.json'));

  if (copyRealContent) {
    fs.copyFileSync(path.join(REPO_ROOT, 'content', 'articles.json'), path.join(contentDir, 'articles.json'));
    for (const file of fs.readdirSync(path.join(REPO_ROOT, 'content', 'articles'))) {
      if (file.endsWith('.md')) {
        fs.copyFileSync(
          path.join(REPO_ROOT, 'content', 'articles', file),
          path.join(articlesDir, file)
        );
      }
    }
  } else {
    fs.writeFileSync(path.join(contentDir, 'articles.json'), JSON.stringify(articles, null, 2));
    for (const article of articles) {
      fs.writeFileSync(
        path.join(articlesDir, `${article.slug}.md`),
        `# ${article.title}\n\nSample body for ${article.slug}.\n`
      );
    }
  }

  return tmpDir;
}

test('Author slug generation, deduplication, and invalid/missing handling', () => {
  assert.equal(getAuthorSlug('Md Shamim'), 'md-shamim');
  assert.equal(getAuthorSlug('  Md  Shamim  '), 'md-shamim');
  assert.equal(getAuthorSlug('Jane Doe'), 'jane-doe');
  assert.equal(getAuthorSlug('José García'), 'jose-garcia');
  assert.equal(getAuthorSlug('Dr. Alice O\'Connor!'), 'dr-alice-o-connor');

  // Missing or invalid author values must return empty slug / null profile
  for (const invalid of [undefined, null, '', '   ', '!!!', '---', '...']) {
    assert.equal(getAuthorSlug(invalid), '');
    assert.equal(getArticleAuthorProfile(invalid), null);
  }

  // Deduplication for equivalent normalized slugs and exclusion of unpublished / missing authors
  const sampleArticles = [
    makeArticle({ slug: 'shamim-one', author: 'Md Shamim', updatedAt: '2026-05-01' }),
    makeArticle({ slug: 'jane-one', author: 'Jane Doe', updatedAt: '2026-05-02' }),
    makeArticle({ slug: 'jane-two', author: 'jane  doe!', updatedAt: '2026-05-03' }),
    makeArticle({ slug: 'missing-author-article', author: '', updatedAt: '2026-05-04' }),
    makeArticle({ slug: 'invalid-author-article', author: '---', updatedAt: '2026-05-05' }),
    makeArticle({ slug: 'draft-only-author', author: 'Draft Writer', isPublished: false }),
  ];

  const authors = collectAuthors(sampleArticles);
  assert.deepEqual(
    authors.map((a) => a.slug),
    ['md-shamim', 'jane-doe']
  );

  const jane = findAuthorBySlug('jane-doe', sampleArticles);
  assert.ok(jane);
  assert.equal(jane.name, 'Jane Doe');
  assert.deepEqual(
    jane.articles.map((a) => a.slug),
    ['jane-two', 'jane-one']
  );

  const shamim = findAuthorBySlug('md-shamim', sampleArticles);
  assert.ok(shamim);
  assert.deepEqual(
    shamim.articles.map((a) => a.slug),
    ['shamim-one']
  );

  assert.equal(findAuthorBySlug('draft-writer', sampleArticles), null);
  assert.equal(findAuthorBySlug('nonexistent', sampleArticles), null);
  assert.equal(findAuthorBySlug('', sampleArticles), null);

  // Indexing rules
  assert.equal(isIndexable('/author/md-shamim/', { articles: sampleArticles }), true);
  assert.equal(isIndexable('/author/jane-doe', { articles: sampleArticles }), true);
  assert.equal(isIndexable('/author/draft-writer/', { articles: sampleArticles }), false);
  assert.equal(isIndexable('/author/unknown-person/', { articles: sampleArticles }), false);
  assert.equal(isIndexable('/author/', { articles: sampleArticles }), false);
  assert.equal(isIndexable('/author/-/', { articles: sampleArticles }), false);
  assert.equal(isIndexable('/author/md-shamim/extra/', { articles: sampleArticles }), false);
});

test('React ArticleDetailView and AuthorView render dynamic author links and handle missing/invalid authors', async () => {
  const vite = await createServer({
    configFile: false,
    plugins: [react()],
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'silent',
    optimizeDeps: { noDiscovery: true },
  });

  try {
    const { ArticleDetailView } = await vite.ssrLoadModule('/src/views/ArticleDetailView.tsx');
    const { AuthorView } = await vite.ssrLoadModule('/src/views/AuthorView.tsx');

    const articles = [
      makeArticle({ slug: 'shamim-article', title: 'Shamim Guide', author: 'Md Shamim', updatedAt: '2026-06-01' }),
      makeArticle({ slug: 'jane-article-1', title: 'Jane Guide One', author: 'Jane Doe', updatedAt: '2026-06-02' }),
      makeArticle({ slug: 'jane-article-2', title: 'Jane Guide Two', author: 'jane  doe', updatedAt: '2026-06-03' }),
      makeArticle({ slug: 'no-author-article', title: 'No Author Guide', author: '', updatedAt: '2026-06-04' }),
    ];

    // 1. Existing Md Shamim article links to /author/md-shamim/
    const shamimDetailHtml = renderToStaticMarkup(
      React.createElement(ArticleDetailView, {
        slug: 'shamim-article',
        allArticles: articles,
        onNavigate: () => {},
      })
    );
    assert.match(shamimDetailHtml, /href="\/author\/md-shamim\/"/);
    assert.match(shamimDetailHtml, /By Md Shamim/);

    // 2. Second author article links to /author/jane-doe/ (not /author/md-shamim/)
    const janeDetailHtml = renderToStaticMarkup(
      React.createElement(ArticleDetailView, {
        slug: 'jane-article-1',
        allArticles: articles,
        onNavigate: () => {},
      })
    );
    assert.match(janeDetailHtml, /href="\/author\/jane-doe\/"/);
    assert.doesNotMatch(janeDetailHtml, /href="\/author\/md-shamim\/"/);
    assert.match(janeDetailHtml, /By Jane Doe/);
    assert.match(janeDetailHtml, />JD</);

    // 3. Missing author article renders no /author/.../ links
    const missingAuthorDetailHtml = renderToStaticMarkup(
      React.createElement(ArticleDetailView, {
        slug: 'no-author-article',
        allArticles: articles,
        onNavigate: () => {},
      })
    );
    assert.doesNotMatch(missingAuthorDetailHtml, /href="\/author\//);
    assert.match(missingAuthorDetailHtml, /By AINOVEX Editorial Team/);

    // 4. AuthorView for Md Shamim shows only his published article
    const shamimViewHtml = renderToStaticMarkup(
      React.createElement(AuthorView, {
        slug: 'md-shamim',
        articles,
        onNavigate: () => {},
      })
    );
    assert.match(shamimViewHtml, /Articles by Md Shamim \(1\)/);
    assert.match(shamimViewHtml, /Shamim Guide/);
    assert.doesNotMatch(shamimViewHtml, /Jane Guide/);
    assert.doesNotMatch(shamimViewHtml, /No Author Guide/);

    // 5. AuthorView for second author shows all equivalent-slug articles
    const janeViewHtml = renderToStaticMarkup(
      React.createElement(AuthorView, {
        slug: 'jane-doe',
        articles,
        onNavigate: () => {},
      })
    );
    assert.match(janeViewHtml, /Articles by Jane Doe \(2\)/);
    assert.match(janeViewHtml, /Jane Guide One/);
    assert.match(janeViewHtml, /Jane Guide Two/);
    assert.doesNotMatch(janeViewHtml, /Shamim Guide/);
    assert.doesNotMatch(janeViewHtml, /No Author Guide/);

    // 6. Unknown author renders Author Not Found
    const unknownViewHtml = renderToStaticMarkup(
      React.createElement(AuthorView, {
        slug: 'unknown-author',
        articles,
        onNavigate: () => {},
      })
    );
    assert.match(unknownViewHtml, /Author Not Found/);
  } finally {
    await vite.close();
  }
});

test('Isolated postbuild + finalize-sitemap generates deduplicated author pages with canonicals and no broken routes', () => {
  const syntheticArticles = [
    makeArticle({ slug: 'shamim-post-one', title: 'Shamim Post One', author: 'Md Shamim', updatedAt: '2026-07-01' }),
    makeArticle({ slug: 'jane-post-one', title: 'Jane Post One', author: 'Jane Doe', updatedAt: '2026-07-02' }),
    makeArticle({ slug: 'jane-post-two', title: 'Jane Post Two', author: 'Jane Doe', updatedAt: '2026-07-03' }),
    makeArticle({ slug: 'alex-post-one', title: 'Alex Post One', author: 'Alex Rivera', updatedAt: '2026-07-04' }),
    makeArticle({ slug: 'alex-post-two', title: 'Alex Post Two', author: 'alex  rivera!', updatedAt: '2026-07-05' }),
    makeArticle({ slug: 'missing-author-post', title: 'Missing Author Post', author: '', updatedAt: '2026-07-06' }),
    makeArticle({ slug: 'invalid-author-post', title: 'Invalid Author Post', author: '---', updatedAt: '2026-07-07' }),
    makeArticle({ slug: 'unpublished-author-post', title: 'Unpublished Post', author: 'Hidden Author', isPublished: false }),
  ];

  const tmpDir = createIsolatedWorkspace({ articles: syntheticArticles });
  try {
    execFileSync(process.execPath, [path.join(REPO_ROOT, 'scripts', 'postbuild.mjs')], {
      cwd: tmpDir,
      stdio: 'pipe',
    });
    execFileSync(process.execPath, [path.join(REPO_ROOT, 'scripts', 'finalize-sitemap.mjs')], {
      cwd: tmpDir,
      stdio: 'pipe',
    });

    const authorRootDir = path.join(tmpDir, 'dist', 'author');
    const generatedAuthorDirs = fs.readdirSync(authorRootDir).sort();
    assert.deepEqual(generatedAuthorDirs, ['alex-rivera', 'jane-doe', 'md-shamim']);

    // Check Md Shamim static page
    const shamimHtml = fs.readFileSync(path.join(authorRootDir, 'md-shamim', 'index.html'), 'utf-8');
    assert.match(shamimHtml, /<link rel="canonical" href="https:\/\/ai-novex\.netlify\.app\/author\/md-shamim\/" \/>/);
    assert.match(shamimHtml, /<meta property="og:url" content="https:\/\/ai-novex\.netlify\.app\/author\/md-shamim\/" \/>/);
    assert.match(shamimHtml, /Articles &amp; Guides by Md Shamim \(1\)/);
    assert.match(shamimHtml, /Shamim Post One/);
    assert.doesNotMatch(shamimHtml, /Jane Post/);
    assert.doesNotMatch(shamimHtml, /Missing Author Post/);

    // Check second author (Jane Doe) static page with multiple articles
    const janeHtml = fs.readFileSync(path.join(authorRootDir, 'jane-doe', 'index.html'), 'utf-8');
    assert.match(janeHtml, /<link rel="canonical" href="https:\/\/ai-novex\.netlify\.app\/author\/jane-doe\/" \/>/);
    assert.match(janeHtml, /<meta property="og:url" content="https:\/\/ai-novex\.netlify\.app\/author\/jane-doe\/" \/>/);
    assert.match(janeHtml, /<title>Jane Doe - Editorial Profile \| AINOVEX<\/title>/);
    assert.match(janeHtml, /Articles &amp; Guides by Jane Doe \(2\)/);
    assert.match(janeHtml, /Jane Post One/);
    assert.match(janeHtml, /Jane Post Two/);
    assert.doesNotMatch(janeHtml, /Shamim Post One/);

    // Check deduplicated author (Alex Rivera + alex  rivera!)
    const alexHtml = fs.readFileSync(path.join(authorRootDir, 'alex-rivera', 'index.html'), 'utf-8');
    assert.match(alexHtml, /<link rel="canonical" href="https:\/\/ai-novex\.netlify\.app\/author\/alex-rivera\/" \/>/);
    assert.match(alexHtml, /Articles &amp; Guides by Alex Rivera \(2\)/);
    assert.match(alexHtml, /Alex Post One/);
    assert.match(alexHtml, /Alex Post Two/);

    // Check article page links match generated author slugs
    const janeArticleHtml = fs.readFileSync(path.join(tmpDir, 'dist', 'blog', 'jane-post-one', 'index.html'), 'utf-8');
    assert.match(janeArticleHtml, /href="\/author\/jane-doe\/"/);
    assert.match(janeArticleHtml, /<meta property="article:author" content="https:\/\/ai-novex\.netlify\.app\/author\/jane-doe\/" \/>/);
    assert.doesNotMatch(janeArticleHtml, /href="\/author\/md-shamim\/"/);

    // Check missing/invalid author article pages do not emit broken /author/ links or article:author URL
    for (const badSlug of ['missing-author-post', 'invalid-author-post']) {
      const badArticleHtml = fs.readFileSync(path.join(tmpDir, 'dist', 'blog', badSlug, 'index.html'), 'utf-8');
      assert.doesNotMatch(badArticleHtml, /href="\/author\//);
      assert.doesNotMatch(badArticleHtml, /property="article:author"/);
      assert.match(badArticleHtml, /By AINOVEX Editorial Team/);
    }

    // Check sitemap.xml includes each valid author once and excludes invalid/unpublished authors
    const sitemap = fs.readFileSync(path.join(tmpDir, 'dist', 'sitemap.xml'), 'utf-8');
    const locs = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
    assert.equal(locs.filter((u) => u === 'https://ai-novex.netlify.app/author/md-shamim/').length, 1);
    assert.equal(locs.filter((u) => u === 'https://ai-novex.netlify.app/author/jane-doe/').length, 1);
    assert.equal(locs.filter((u) => u === 'https://ai-novex.netlify.app/author/alex-rivera/').length, 1);
    assert.equal(locs.some((u) => u.includes('/author/hidden-author')), false);
    assert.equal(locs.some((u) => u.endsWith('/author/')), false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Isolated build of live content preserves Md Shamim author page and all existing articles', () => {
  const tmpDir = createIsolatedWorkspace({ articles: [], copyRealContent: true });
  try {
    execFileSync(process.execPath, [path.join(REPO_ROOT, 'scripts', 'postbuild.mjs')], {
      cwd: tmpDir,
      stdio: 'pipe',
    });
    execFileSync(process.execPath, [path.join(REPO_ROOT, 'scripts', 'finalize-sitemap.mjs')], {
      cwd: tmpDir,
      stdio: 'pipe',
    });

    const authorRootDir = path.join(tmpDir, 'dist', 'author');
    assert.deepEqual(fs.readdirSync(authorRootDir), ['md-shamim']);

    const shamimHtml = fs.readFileSync(path.join(authorRootDir, 'md-shamim', 'index.html'), 'utf-8');
    assert.match(shamimHtml, /<link rel="canonical" href="https:\/\/ai-novex\.netlify\.app\/author\/md-shamim\/" \/>/);
    assert.match(shamimHtml, /Articles &amp; Guides by Md Shamim \(4\)/);
    assert.match(shamimHtml, /Best AI Tools for Bulk Product Catalog Enrichment in 2026/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
