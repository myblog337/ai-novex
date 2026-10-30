import React, { useState, useEffect } from 'react';
import { Calendar, Clock, Share2, Check, Tag } from 'lucide-react';
import { Article } from '../types';
import { Breadcrumbs } from '../components/Breadcrumbs';

function getResponsiveSrcSet(imgPath: string): string {
  if (!imgPath) return '';
  if (imgPath.startsWith('/images/articles/') && imgPath.endsWith('.webp')) {
    const base = imgPath.slice(0, -5);
    return `${base}-600w.webp 600w, ${base}-900w.webp 900w, ${imgPath} 1200w`;
  }
  if (imgPath.includes('w=1200')) {
    return `${imgPath.replace('w=1200', 'w=600')} 600w, ${imgPath.replace('w=1200', 'w=900')} 900w, ${imgPath} 1200w`;
  }
  return '';
}

interface ArticleDetailViewProps {
  slug: string;
  onNavigate: (path: string) => void;
  allArticles: Article[];
}

// Markdown sources are bundled lazily (one chunk per article) instead of being fetched from an API.
const markdownLoaders = import.meta.glob('../../content/articles/*.md', {
  query: '?raw',
  import: 'default',
}) as Record<string, () => Promise<string>>;

// Capture the article HTML pre-rendered by scripts/postbuild.mjs once, at load time, so the first
// paint never flashes a spinner. It is only valid for the exact URL it was rendered for.
let prerendered: { slug: string; html: string } | null = null;
if (typeof document !== 'undefined') {
  const m = window.location.pathname.match(/^\/blog\/([^/]+)\/?$/);
  const el = document.getElementById('article-content-body');
  if (m && el && el.innerHTML.trim().length > 0) {
    try {
      prerendered = { slug: decodeURIComponent(m[1]), html: el.innerHTML };
    } catch {
      prerendered = null;
    }
  }
}

async function loadArticleHtml(article: Article): Promise<string> {
  const key = Object.keys(markdownLoaders).find((k) => k.endsWith(`/${article.slug}.md`));
  if (!key) return '';
  const [raw, { renderMarkdown }] = await Promise.all([markdownLoaders[key](), import('../utils/markdown')]);
  return renderMarkdown(raw);
}

export const ArticleDetailView: React.FC<ArticleDetailViewProps> = ({
  slug,
  onNavigate,
  allArticles,
}) => {
  const article = allArticles.find((a) => a.slug === slug) || null;
  const initialHtml = prerendered && prerendered.slug === slug ? prerendered.html : '';

  const [contentHtml, setContentHtml] = useState<string>(initialHtml);
  const [copied, setCopied] = useState(false);

  // Re-runs for every slug: navigating Article A -> Article B always shows B's own content.
  useEffect(() => {
    if (!article) return;
    if (prerendered && prerendered.slug === slug) {
      // First view of the landing page: reuse the pre-rendered HTML once, afterwards behave normally.
      setContentHtml(prerendered.html);
      prerendered = null;
      return;
    }
    let active = true;
    setContentHtml('');
    loadArticleHtml(article)
      .then((html) => {
        if (active) setContentHtml(html);
      })
      .catch((err) => console.error('Failed to load article:', err));
    return () => {
      active = false;
    };
  }, [slug, article]);

  const handleCopy = async () => {
    // navigator.clipboard is undefined on insecure origins and writeText() can reject (permissions):
    // fall back to a hidden textarea and only show "Copied" when something was really copied.
    const url = window.location.href;
    let ok = false;
    try {
      await navigator.clipboard.writeText(url);
      ok = true;
    } catch {
      try {
        const ta = document.createElement('textarea');
        ta.value = url;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        ok = document.execCommand('copy');
        document.body.removeChild(ta);
      } catch {
        ok = false;
      }
    }
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 3000);
    }
  };

  if (!article) {
    return (
      <div className="max-w-3xl mx-auto px-4 py-24 text-center">
        <h2 className="text-2xl font-bold text-slate-900 dark:text-white mb-2">Article Not Found</h2>
        <p className="text-sm text-slate-500 dark:text-slate-400 mb-6">The requested article could not be located.</p>
        <a
          href="/blog/"
          onClick={(e) => {
            e.preventDefault();
            onNavigate('/blog/');
          }}
          className="px-5 py-2.5 rounded-full bg-blue-600 text-white text-sm font-semibold hover:bg-blue-500 inline-block"
        >
          Return to Blog Archive
        </a>
      </div>
    );
  }

  const related = allArticles
    .filter((a) => a.slug !== article.slug && a.isPublished)
    .sort((x, y) => Number(y.category === article.category) - Number(x.category === article.category))
    .slice(0, 2);

  return (
    <article className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <Breadcrumbs
        items={[
          { label: 'Blog', path: '/blog/' },
          { label: article.categoryName || article.category, path: `/category/${article.category}/` },
          { label: article.title },
        ]}
        onNavigate={onNavigate}
      />

      {/* Header */}
      <div className="py-6 border-b border-slate-200 dark:border-slate-800/80 mb-8">
        <a
          href={`/category/${article.category}/`}
          onClick={(e) => {
            e.preventDefault();
            onNavigate(`/category/${article.category}/`);
          }}
          className="inline-block px-3 py-1 rounded-full text-xs font-bold uppercase tracking-wider bg-blue-50 text-blue-600 border border-blue-200 dark:bg-blue-600/20 dark:text-blue-400 dark:border-blue-500/30 mb-4 hover:bg-blue-100 transition-colors"
        >
          {article.categoryName || article.category}
        </a>

        <h1 className="text-3xl sm:text-4xl md:text-5xl font-extrabold text-slate-900 dark:text-white tracking-tight leading-tight mb-4">
          {article.title}
        </h1>

        <p className="text-base sm:text-lg text-slate-600 dark:text-slate-300 leading-relaxed mb-6">
          {article.excerpt}
        </p>

        <div className="flex flex-wrap items-center justify-between gap-4 text-xs text-slate-500 dark:text-slate-400">
          <div className="flex flex-wrap items-center gap-3 sm:gap-4">
            <a
              href="/author/md-shamim/"
              onClick={(e) => {
                e.preventDefault();
                onNavigate('/author/md-shamim/');
              }}
              className="flex items-center gap-2 group cursor-pointer"
            >
              <div className="w-7 h-7 rounded-full bg-blue-100 dark:bg-blue-600/20 border border-blue-200 dark:border-blue-500/30 flex items-center justify-center font-bold text-blue-600 dark:text-blue-400 text-xs">
                MS
              </div>
              <span className="font-semibold text-slate-800 dark:text-slate-200 group-hover:text-blue-600 dark:group-hover:text-blue-400 transition-colors">
                By {article.author || 'Md Shamim'}
              </span>
            </a>
            <span>•</span>
            <span className="flex items-center gap-1" title="Initial publication date">
              <Calendar className="w-3.5 h-3.5" />
              <span>
                Published: <time dateTime={article.publishedAt}>{article.publishedAt}</time>
              </span>
            </span>
            {article.updatedAt && (
              <>
                <span>•</span>
                <span className="flex items-center gap-1 text-emerald-600 dark:text-emerald-400 font-medium" title="Last updated date">
                  <Clock className="w-3.5 h-3.5" />
                  <span>
                    Last updated: <time dateTime={article.updatedAt}>{article.updatedAt}</time>
                  </span>
                </span>
              </>
            )}
            <span>•</span>
            <span className="flex items-center gap-1">
              <span>{article.readingTime || '9 min read'}</span>
            </span>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={handleCopy}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 dark:bg-slate-800 dark:hover:bg-slate-700 dark:text-slate-300 dark:hover:text-white transition-colors cursor-pointer"
            >
              {copied ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <Share2 className="w-3.5 h-3.5" />}
              <span>{copied ? 'Copied Link' : 'Share'}</span>
            </button>
          </div>
        </div>
      </div>

      {/* Featured Cover Image (LCP element - eager, self-hosted, dimensioned) */}
      {article.featuredImage && (
        <div
          className="relative w-full aspect-[16/9] rounded-2xl overflow-hidden mb-10 shadow-lg border border-slate-200 dark:border-slate-800/80"
          style={{ aspectRatio: '16/9', minHeight: '200px' }}
        >
          <img
            src={article.featuredImage}
            srcSet={getResponsiveSrcSet(article.featuredImage)}
            sizes="(max-width: 640px) 100vw, (max-width: 1024px) 90vw, 896px"
            alt={article.imageAlt || article.title}
            width={1200}
            height={675}
            loading="eager"
            fetchPriority="high"
            decoding="async"
            className="w-full h-full object-cover"
            style={{ aspectRatio: '16/9', width: '100%', height: 'auto' }}
          />
        </div>
      )}

      {/* Article Content Render */}
      <div
        id="article-content-body"
        className="article-content mb-12 min-h-[40vh]"
        dangerouslySetInnerHTML={{ __html: contentHtml }}
      />

      {/* Tags */}
      {article.tags && article.tags.length > 0 && (
        <div className="py-6 border-t border-b border-slate-200 dark:border-slate-800/80 flex items-center gap-2 flex-wrap mb-10">
          <Tag className="w-4 h-4 text-slate-400 mr-1" />
          {article.tags.map((tag) => (
            <span
              key={tag}
              className="px-3 py-1 rounded-full text-xs font-medium bg-slate-100 text-slate-700 border border-slate-200 dark:bg-slate-800/80 dark:text-slate-300 dark:border-slate-700/50"
            >
              #{tag}
            </span>
          ))}
        </div>
      )}

      {/* Author Card */}
      <div className="p-6 sm:p-7 rounded-3xl bg-white dark:bg-slate-900/60 border border-slate-200 dark:border-slate-800 shadow-sm flex flex-col sm:flex-row items-start gap-4 sm:gap-5 mb-12">
        <a
          href="/author/md-shamim/"
          onClick={(e) => {
            e.preventDefault();
            onNavigate('/author/md-shamim/');
          }}
          className="w-14 h-14 rounded-2xl bg-gradient-to-tr from-blue-600 to-sky-400 flex items-center justify-center font-bold text-white text-lg shrink-0 shadow-md hover:opacity-90 transition-opacity"
        >
          MS
        </a>
        <div className="flex-1">
          <div className="text-xs uppercase font-bold tracking-wider text-blue-600 dark:text-blue-400 mb-1">
            Author &amp; Lead Researcher
          </div>
          <h3 className="text-lg font-bold text-slate-900 dark:text-white mb-1">
            <a
              href="/author/md-shamim/"
              onClick={(e) => {
                e.preventDefault();
                onNavigate('/author/md-shamim/');
              }}
              className="hover:text-blue-600 dark:hover:text-blue-400 transition-colors"
            >
              {article.author || 'Md Shamim'}
            </a>
          </h3>
          <p className="text-xs sm:text-sm text-slate-600 dark:text-slate-400 leading-relaxed mb-3">
            Lead researcher and editor at AINOVEX. Conducts research, software evaluations, and technical guides published across the platform.
          </p>
          <div className="flex flex-wrap items-center gap-4 text-xs font-semibold text-blue-600 dark:text-blue-400">
            <a
              href="/author/md-shamim/"
              onClick={(e) => {
                e.preventDefault();
                onNavigate('/author/md-shamim/');
              }}
              className="hover:underline flex items-center gap-1"
            >
              <span>View Editorial Profile &amp; Guides</span>
              <span>&rarr;</span>
            </a>
            <span>•</span>
            <a
              href="/editorial-policy/"
              onClick={(e) => {
                e.preventDefault();
                onNavigate('/editorial-policy/');
              }}
              className="text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200 hover:underline"
            >
              Editorial Policy
            </a>
          </div>
        </div>
      </div>

      {/* Related Guides */}
      {related.length > 0 && (
        <div className="pt-6 border-t border-slate-200 dark:border-slate-800/80">
          <h3 className="text-xl font-bold text-slate-900 dark:text-white mb-6">
            Related Guides & Tutorials
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
            {related.map((r) => (
              <a
                key={r.slug}
                href={`/blog/${r.slug}/`}
                onClick={(e) => {
                  e.preventDefault();
                  onNavigate(`/blog/${r.slug}/`);
                }}
                className="p-5 rounded-2xl bg-white dark:bg-slate-900/60 border border-slate-200 dark:border-slate-800 hover:border-blue-500/40 shadow-sm hover:shadow-md cursor-pointer group transition-all block"
              >
                <div className="text-xs text-blue-600 dark:text-blue-400 font-semibold mb-2">
                  {r.categoryName || r.category}
                </div>
                <h4 className="text-base font-bold text-slate-900 dark:text-white group-hover:text-blue-600 dark:group-hover:text-blue-400 transition-colors line-clamp-2 mb-2">
                  {r.title}
                </h4>
                <p className="text-xs text-slate-600 dark:text-slate-400 line-clamp-2">{r.excerpt}</p>
              </a>
            ))}
          </div>
        </div>
      )}
    </article>
  );
};
