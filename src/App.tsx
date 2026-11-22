import React, { useState, useEffect, useCallback, useMemo, lazy, Suspense } from 'react';
import { ThemeProvider } from './context/ThemeContext';
import { Header } from './components/Header';
import { Footer } from './components/Footer';
import { ToolModal } from './components/ToolModal';
import { HomeView } from './views/HomeView';
import { ToolsView } from './views/ToolsView';
import { ToolDetailView } from './views/ToolDetailView';
import { BlogView } from './views/BlogView';
import { CategoriesView } from './views/CategoriesView';
import { CategoryDetailView } from './views/CategoryDetailView';
import { ArticleDetailView } from './views/ArticleDetailView';
import { AboutView } from './views/AboutView';
import { ContactView } from './views/ContactView';
import { LegalView } from './views/LegalView';
import { AuthorView } from './views/AuthorView';
import { CustomPageView } from './views/CustomPageView';
import { Tool, Category, Article, CustomPage } from './types';
import { resolveRouteSeo, applyResolvedSeo, loadAnalytics } from './utils/seo';
import { isPublishedTool } from './config/indexing.js';
import {
  findPublishedCustomPageBySlug,
  getRenderablePublishedCustomPages,
} from './utils/customPages.js';

// Only the search dialog is code-split: it is opened on demand. Every route view is bundled
// eagerly so the first client render matches the pre-rendered HTML (no blank flash).
const SearchModal = lazy(() => import('./components/SearchModal').then((m) => ({ default: m.SearchModal })));

import defaultCategories from '../content/categories.json';
import defaultTools from '../content/tools.json';
import defaultArticles from '../content/articles.json';
import defaultPages from '../content/pages.json';
import defaultSettings from '../content/settings.json';
import defaultSeoConfig from '../content/seo.json';
import { findAuthorBySlug } from './utils/authors.js';

// Content is bundled at build time (read-only site): no runtime API requests are needed.
const CATEGORIES = defaultCategories as Category[];
const TOOLS = (defaultTools as Tool[]).filter(isPublishedTool);
const ARTICLES = (defaultArticles as Article[]).filter((a) => a.isPublished);
const CUSTOM_PAGES = getRenderablePublishedCustomPages(defaultPages as CustomPage[]) as CustomPage[];

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
  const customPages = CUSTOM_PAGES;
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

  const resolvedSeo = useMemo(() => {
    const canonicalPath = normPath === '/' ? '/' : `${normPath}/`;
    return resolveRouteSeo({
      path: canonicalPath,
      seoConfig: defaultSeoConfig,
      settings: siteSettings,
      articles,
      categories,
      tools,
      pages: customPages,
    });
  }, [normPath, articles, categories, tools, customPages, siteSettings]);

  // Keep <title>, description, canonical, robots, Open Graph, Twitter tags, and JSON-LD in sync with the route
  useEffect(() => {
    applyResolvedSeo(resolvedSeo);
  }, [resolvedSeo]);

  const routeBreadcrumbs = resolvedSeo.breadcrumbs || [];
  const routeBreadcrumbEnabled = Boolean(!resolvedSeo.notFound && resolvedSeo.breadcrumbEnabled);

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
        breadcrumbs={routeBreadcrumbs}
        breadcrumbEnabled={routeBreadcrumbEnabled}
      />
    );
  } else if (normPath.startsWith('/tools/')) {
    const slug = normPath.slice('/tools/'.length);
    viewContent = (
      <ToolDetailView
        key={slug}
        slug={slug}
        tools={tools}
        categories={categories}
        onNavigate={navigate}
        breadcrumbs={routeBreadcrumbs}
        breadcrumbEnabled={routeBreadcrumbEnabled}
      />
    );
  } else if (normPath === '/blog') {
    viewContent = (
      <BlogView
        articles={articles}
        categories={categories}
        onSelectArticle={(slug) => navigate(`/blog/${slug}/`)}
        onNavigate={navigate}
        breadcrumbs={routeBreadcrumbs}
        breadcrumbEnabled={routeBreadcrumbEnabled}
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
        breadcrumbs={routeBreadcrumbs}
        breadcrumbEnabled={routeBreadcrumbEnabled}
      />
    );
  } else if (normPath === '/categories') {
    viewContent = (
      <CategoriesView
        categories={categories}
        onSelectCategory={(slug) => navigate(`/category/${slug}/`)}
        onNavigate={navigate}
        breadcrumbs={routeBreadcrumbs}
        breadcrumbEnabled={routeBreadcrumbEnabled}
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
        breadcrumbs={routeBreadcrumbs}
        breadcrumbEnabled={routeBreadcrumbEnabled}
      />
    );
  } else if (normPath === '/about') {
    viewContent = (
      <AboutView
        onNavigate={navigate}
        breadcrumbs={routeBreadcrumbs}
        breadcrumbEnabled={routeBreadcrumbEnabled}
      />
    );
  } else if (normPath === '/contact') {
    viewContent = (
      <ContactView
        onNavigate={navigate}
        breadcrumbs={routeBreadcrumbs}
        breadcrumbEnabled={routeBreadcrumbEnabled}
      />
    );
  } else if (normPath === '/privacy') {
    viewContent = (
      <LegalView
        page="privacy"
        onNavigate={navigate}
        breadcrumbs={routeBreadcrumbs}
        breadcrumbEnabled={routeBreadcrumbEnabled}
      />
    );
  } else if (normPath === '/terms') {
    viewContent = (
      <LegalView
        page="terms"
        onNavigate={navigate}
        breadcrumbs={routeBreadcrumbs}
        breadcrumbEnabled={routeBreadcrumbEnabled}
      />
    );
  } else if (normPath === '/editorial-policy') {
    viewContent = (
      <LegalView
        page="editorial"
        onNavigate={navigate}
        breadcrumbs={routeBreadcrumbs}
        breadcrumbEnabled={routeBreadcrumbEnabled}
      />
    );
  } else if (normPath === '/affiliate-disclosure') {
    viewContent = (
      <LegalView
        page="affiliate"
        onNavigate={navigate}
        breadcrumbs={routeBreadcrumbs}
        breadcrumbEnabled={routeBreadcrumbEnabled}
      />
    );
  } else if (normPath.startsWith('/author/')) {
    const slug = normPath.slice('/author/'.length);
    const foundAuthor = !slug.includes('/') ? findAuthorBySlug(slug, articles) : null;
    if (foundAuthor) {
      viewContent = (
        <AuthorView
          slug={foundAuthor.slug}
          articles={articles}
          onNavigate={navigate}
          breadcrumbs={routeBreadcrumbs}
          breadcrumbEnabled={routeBreadcrumbEnabled}
        />
      );
    } else {
      viewContent = (
        <div className="max-w-2xl mx-auto px-4 py-24 text-center">
          <h1 className="text-4xl font-extrabold text-slate-900 dark:text-white mb-3">404 - Author Not Found</h1>
          <p className="text-sm text-slate-500 dark:text-slate-400 mb-6">
            The author profile you are looking for does not exist or has no published articles.
          </p>
          <button
            onClick={() => navigate('/blog/')}
            className="px-6 py-2.5 rounded-full bg-blue-600 hover:bg-blue-500 text-white font-semibold text-xs shadow-md shadow-blue-600/30"
          >
            Browse Blog Articles
          </button>
        </div>
      );
    }
  } else {
    const candidateSlug =
      normPath.startsWith('/') && normPath.length > 1 && !normPath.slice(1).includes('/')
        ? normPath.slice(1)
        : '';
    const foundCustomPage = candidateSlug
      ? findPublishedCustomPageBySlug(candidateSlug, customPages)
      : null;

    if (foundCustomPage) {
      viewContent = (
        <CustomPageView
          key={foundCustomPage.slug}
          slug={foundCustomPage.slug}
          page={foundCustomPage}
          pages={customPages}
          onNavigate={navigate}
          breadcrumbs={routeBreadcrumbs}
          breadcrumbEnabled={routeBreadcrumbEnabled}
        />
      );
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
