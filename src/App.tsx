import React, { useState, useEffect, useCallback, lazy, Suspense } from 'react';
import { ThemeProvider } from './context/ThemeContext';
import { Header } from './components/Header';
import { Footer } from './components/Footer';
import { ToolModal } from './components/ToolModal';
import { HomeView } from './views/HomeView';
import { ToolsView } from './views/ToolsView';
import { BlogView } from './views/BlogView';
import { CategoriesView } from './views/CategoriesView';
import { CategoryDetailView } from './views/CategoryDetailView';
import { ArticleDetailView } from './views/ArticleDetailView';
import { AboutView } from './views/AboutView';
import { ContactView } from './views/ContactView';
import { LegalView } from './views/LegalView';
import { AuthorView } from './views/AuthorView';
import { Tool, Category, Article } from './types';
import { applySeo, loadAnalytics } from './utils/seo';

// Only the search dialog is code-split: it is opened on demand. Every route view is bundled
// eagerly so the first client render matches the pre-rendered HTML (no blank flash).
const SearchModal = lazy(() => import('./components/SearchModal').then((m) => ({ default: m.SearchModal })));

import defaultCategories from '../content/categories.json';
import defaultTools from '../content/tools.json';
import defaultArticles from '../content/articles.json';
import defaultSettings from '../content/settings.json';
import { SITE_URL } from './config/site';
import { isIndexable, categoryTitle } from './config/indexing.js';

// Content is bundled at build time (read-only site): no runtime API requests are needed.
const CATEGORIES = defaultCategories as Category[];
const TOOLS = defaultTools as Tool[];
const ARTICLES = (defaultArticles as Article[]).filter((a) => a.isPublished);

/** Canonical in-app path: always with a trailing slash (before any ?query / #hash). */
function canonicalize(path: string): string {
  const m = path.match(/^([^?#]*)(.*)$/);
  let p = m ? m[1] : path;
  const rest = m ? m[2] : '';
  if (!p.startsWith('/')) p = '/' + p;
  if (p !== '/' && !p.endsWith('/') && !/\.[a-z0-9]+$/i.test(p)) p += '/';
  return p + rest;
}

function AppContent() {
  // Navigation route state
  const [currentPath, setCurrentPath] = useState<string>(() => window.location.pathname || '/');

  // Search & Tool Modal
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [selectedToolModal, setSelectedToolModal] = useState<Tool | null>(null);
  const closeToolModal = useCallback(() => setSelectedToolModal(null), []);

  const categories = CATEGORIES;
  const tools = TOOLS;
  const articles = ARTICLES;
  const siteSettings = defaultSettings;

  useEffect(() => {
    // Analytics loads only when a Measurement ID is configured in content/settings.json.
    const load = () => loadAnalytics(siteSettings.googleAnalyticsId);
    if ('requestIdleCallback' in window) {
      (window as any).requestIdleCallback(load);
    } else {
      setTimeout(load, 1500);
    }
  }, []);

  useEffect(() => {
    // Listen to browser forward/backward buttons
    const handlePopState = () => {
      setCurrentPath(window.location.pathname);
      setSelectedToolModal(null);
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  const navigate = (rawPath: string) => {
    const path = canonicalize(rawPath);
    if (path !== currentPath) {
      window.history.pushState({}, '', path);
      setCurrentPath(path);
      setSelectedToolModal(null);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  };

  const normalizePath = (p: string) => {
    const clean = p.split(/[?#]/)[0].replace(/\/+$/, '');
    return clean === '' ? '/' : clean;
  };

  const normPath = normalizePath(currentPath);

  // Keep <title>, description, canonical and Open Graph tags in sync with the route
  useEffect(() => {
    const base = siteSettings.productionUrl || SITE_URL;
    const defaultDesc =
      siteSettings.siteDescription ||
      'AINOVEX brings you the latest AI tools, helpful guides, tech news and insights.';
    const defaultImage = siteSettings.defaultOgImage;
    let title = 'AINOVEX - Discover the Best AI Tools & Resources';
    let description = defaultDesc;
    let image = defaultImage;
    // INDEXING POLICY lives in src/config/indexing.js (shared with scripts/postbuild.mjs), so the
    // client-side meta tags always match the pre-rendered HTML and sitemap.xml.
    const noindex = !isIndexable(normPath, { articles, categories });
    let type: 'website' | 'article' = 'website';

    if (normPath === '/') {
      title = 'AINOVEX - AI Tools & Technology Platform';
      description = 'Discover the best AI tools, software reviews, and guides on AINOVEX. Boost productivity and work smarter with curated artificial intelligence.';
    } else if (normPath === '/tools') {
      title = 'Best AI Tools Directory & Software Reviews 2026 | AINOVEX';
      description = 'Browse and compare the top artificial intelligence tools for writing, image creation, video, coding, and productivity. Find the best software for your needs.';
    } else if (normPath === '/blog') {
      title = 'AI Insights, Tutorials & Technology Guides | AINOVEX';
      description = 'Explore actionable AI tutorials, practical workflows, tool comparisons, and tech guides from the AINOVEX editorial team. Master modern AI applications today.';
    } else if (normPath.startsWith('/blog/')) {
      const slug = normPath.replace('/blog/', '').replace(/\/$/, '');
      const found = articles.find((a) => a.slug === slug);
      if (found) {
        title = found.metaTitle || `${found.title} | AINOVEX`;
        description = found.metaDescription || found.excerpt || defaultDesc;
        image = found.ogImage || found.featuredImage || defaultImage;
        type = 'article';
      } else {
        title = 'Article Not Found | AINOVEX';
      }
    } else if (normPath === '/categories') {
      title = 'Browse AI Categories & Topics | AINOVEX';
      description = 'Explore specialized AI software categories from writing and image generation to coding and productivity. Find the right tools for your specific workflow.';
    } else if (normPath.startsWith('/category/')) {
      const slug = normPath.replace('/category/', '').replace(/\/$/, '');
      const found = categories.find((c) => c.slug === slug);
      if (found) {
        title = categoryTitle(found);
        const baseCatDesc = found.description || 'Explore the best artificial intelligence tools and workflows.';
        description = `${baseCatDesc} Browse handpicked software reviews and tutorials on AINOVEX.`;
      } else {
        title = 'Category Not Found | AINOVEX';
      }
    } else if (normPath === '/about') {
      title = 'About Us & Editorial Standards | AINOVEX';
      description = 'Learn about AINOVEX, our mission to simplify artificial intelligence, our testing standards, and our independent editorial review methodology.';
    } else if (normPath === '/contact') {
      title = 'Contact AINOVEX | Editorial & Support Team';
      description = 'Contact the AINOVEX editorial team for software recommendations, directory submissions, editorial corrections, or partnership inquiries.';
    } else if (normPath === '/privacy') {
      title = 'Privacy Policy | AINOVEX AI Platform';
      description = 'Read the official AINOVEX Privacy Policy. Learn how we safeguard your personal information, handle essential cookies, and maintain data privacy.';
    } else if (normPath === '/terms') {
      title = 'Terms of Service | AINOVEX Platform';
      description = 'Review the AINOVEX Terms of Service. Understand the rules, guidelines, disclaimers, and legal agreements governing the use of our website.';
    } else if (normPath === '/editorial-policy') {
      title = 'Editorial Policy & Review Standards | AINOVEX';
      description = 'Explore AINOVEX editorial policy, review guidelines, testing benchmarks, and independence standards for recommending artificial intelligence tools.';
    } else if (normPath === '/affiliate-disclosure') {
      title = 'Affiliate & Monetization Disclosure | AINOVEX';
      description = 'Read the AINOVEX affiliate and advertising disclosure. Learn how our site remains free for readers through transparent monetization and integrity.';
    } else if (normPath === '/author/md-shamim') {
      title = 'Md Shamim - Lead Researcher & Editor | AINOVEX';
      description = 'Read the editorial profile and guides by Md Shamim, lead researcher and editor at AINOVEX specializing in AI tools and catalog enrichment.';
    } else {
      // Unknown route
      title = 'Page Not Found | AINOVEX';
      description = 'The page you are looking for does not exist. Browse our AI tools directory, tutorials, and category archives on AINOVEX.';
    }

    const canonicalPath = normPath === '/' ? '/' : `${normPath}/`;
    applySeo({ title, description, path: canonicalPath, baseUrl: base, image, noindex, type });
  }, [normPath]);

  // Public View Router
  let viewContent: React.ReactNode = null;

  if (normPath === '/') {
    viewContent = (
      <HomeView
        categories={categories}
        tools={tools}
        articles={articles}
        onNavigate={navigate}
        onSelectTool={(tool) => setSelectedToolModal(tool)}
      />
    );
  } else if (normPath === '/tools') {
    const urlParams = new URLSearchParams(window.location.search);
    const q = urlParams.get('q') || '';
    viewContent = (
      <ToolsView
        key={q}
        tools={tools}
        categories={categories}
        initialQuery={q}
        onNavigate={navigate}
        onSelectTool={setSelectedToolModal}
      />
    );
  } else if (normPath === '/blog') {
    viewContent = (
      <BlogView
        articles={articles}
        categories={categories}
        onSelectArticle={(slug) => navigate(`/blog/${slug}/`)}
        onNavigate={navigate}
      />
    );
  } else if (normPath.startsWith('/blog/')) {
    const slug = normPath.replace('/blog/', '').replace(/\/$/, '');
    viewContent = (
      <ArticleDetailView
        key={slug}
        slug={slug}
        onNavigate={navigate}
        allArticles={articles}
      />
    );
  } else if (normPath === '/categories') {
    viewContent = (
      <CategoriesView
        categories={categories}
        onSelectCategory={(slug) => navigate(`/category/${slug}/`)}
        onNavigate={navigate}
      />
    );
  } else if (normPath.startsWith('/category/')) {
    const slug = normPath.replace('/category/', '').replace(/\/$/, '');
    viewContent = (
      <CategoryDetailView
        slug={slug}
        categories={categories}
        tools={tools}
        articles={articles}
        onNavigate={navigate}
        onSelectTool={(tool) => setSelectedToolModal(tool)}
        onSelectArticle={(slug) => navigate(`/blog/${slug}/`)}
      />
    );
  } else if (normPath === '/about') {
    viewContent = <AboutView onNavigate={navigate} />;
  } else if (normPath === '/contact') {
    viewContent = <ContactView onNavigate={navigate} />;
  } else if (normPath === '/privacy') {
    viewContent = <LegalView page="privacy" onNavigate={navigate} />;
  } else if (normPath === '/terms') {
    viewContent = <LegalView page="terms" onNavigate={navigate} />;
  } else if (normPath === '/editorial-policy') {
    viewContent = <LegalView page="editorial" onNavigate={navigate} />;
  } else if (normPath === '/affiliate-disclosure') {
    viewContent = <LegalView page="affiliate" onNavigate={navigate} />;
  } else if (normPath === '/author/md-shamim') {
    viewContent = <AuthorView slug="md-shamim" articles={articles} onNavigate={navigate} />;
  } else {
    // 404 Not Found fallback
    viewContent = (
      <div className="max-w-2xl mx-auto px-4 py-24 text-center">
        <h1 className="text-4xl font-extrabold text-slate-900 dark:text-white mb-3">404 - Page Not Found</h1>
        <p className="text-sm text-slate-500 dark:text-slate-400 mb-6">
          The page you are looking for does not exist or has been moved.
        </p>
        <button
          onClick={() => navigate('/')}
          className="px-6 py-2.5 rounded-full bg-blue-600 hover:bg-blue-500 text-white font-semibold text-xs shadow-md shadow-blue-600/30"
        >
          Return Home
        </button>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col bg-[#f8fafc] text-slate-900 dark:bg-[#0b101b] dark:text-slate-100 transition-colors duration-200">
      <Header
        onOpenSearch={() => setIsSearchOpen(true)}
        currentPath={currentPath}
        onNavigate={navigate}
      />

      <main className="flex-1">
        {viewContent}
      </main>

      <Footer onNavigate={navigate} />

      {/* Tool details dialog (works from every page) */}
      <ToolModal tool={selectedToolModal} onClose={closeToolModal} />

      {/* Global Quick Search Dialog */}
      {isSearchOpen && (
        <Suspense fallback={null}>
        <SearchModal
        isOpen={isSearchOpen}
        onClose={() => setIsSearchOpen(false)}
        tools={tools}
        articles={articles}
        categories={categories}
        onSelectTool={(tool) => {
          setSelectedToolModal(tool);
          setIsSearchOpen(false);
        }}
        onSelectArticle={(slug) => {
          setIsSearchOpen(false);
          navigate(`/blog/${slug}/`);
        }}
        onSelectCategory={(slug) => {
          setIsSearchOpen(false);
          navigate(`/category/${slug}/`);
        }}
      />
        </Suspense>
      )}
    </div>
  );
}

export default function App() {
  return (
    <ThemeProvider>
      <AppContent />
    </ThemeProvider>
  );
}
