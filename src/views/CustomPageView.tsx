import React, { useMemo } from 'react';
import { Breadcrumbs, BreadcrumbItem } from '../components/Breadcrumbs';
import { CustomPage } from '../types';
import { renderMarkdown } from '../utils/markdown.js';
import {
  findPublishedCustomPageBySlug,
  isPublishedCustomPage,
} from '../utils/customPages.js';

interface CustomPageViewProps {
  slug?: string;
  page?: CustomPage | null;
  pages?: CustomPage[];
  onNavigate: (path: string) => void;
  breadcrumbs?: BreadcrumbItem[];
  breadcrumbEnabled?: boolean;
}

export const CustomPageView: React.FC<CustomPageViewProps> = ({
  slug,
  page = null,
  pages,
  onNavigate,
  breadcrumbs,
  breadcrumbEnabled = true,
}) => {
  const resolvedPage = useMemo(() => {
    if (Array.isArray(pages)) {
      const targetSlug = typeof slug === 'string' ? slug : page?.slug;
      return targetSlug ? findPublishedCustomPageBySlug(targetSlug, pages) : null;
    }
    if (page && isPublishedCustomPage(page)) {
      if (typeof slug === 'string' && page.slug !== slug) return null;
      return page;
    }
    return null;
  }, [slug, page, pages]);

  const contentHtml = useMemo(() => {
    if (!resolvedPage) return '';
    return renderMarkdown(resolvedPage.content);
  }, [resolvedPage]);

  if (!resolvedPage) {
    return (
      <div className="max-w-2xl mx-auto px-4 py-24 text-center">
        <h1 className="text-4xl font-extrabold text-slate-900 dark:text-white mb-3">
          404 - Page Not Found
        </h1>
        <p className="text-sm text-slate-500 dark:text-slate-400 mb-6">
          The page you are looking for does not exist or has been moved.
        </p>
        <a
          href="/"
          onClick={(e) => {
            e.preventDefault();
            onNavigate('/');
          }}
          className="px-6 py-2.5 rounded-full bg-blue-600 hover:bg-blue-500 text-white font-semibold text-xs shadow-md shadow-blue-600/30 inline-block"
        >
          Return Home
        </a>
      </div>
    );
  }

  const effectiveBreadcrumbs =
    breadcrumbs !== undefined ? breadcrumbs : [{ label: resolvedPage.title }];
  const showBreadcrumbs = breadcrumbEnabled !== false && effectiveBreadcrumbs.length > 0;

  return (
    <article className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      {showBreadcrumbs && <Breadcrumbs items={effectiveBreadcrumbs} onNavigate={onNavigate} />}

      <header className="py-6 border-b border-slate-200 dark:border-slate-800/80 mb-8">
        <h1 className="text-3xl sm:text-4xl font-extrabold text-slate-900 dark:text-white tracking-tight">
          {resolvedPage.title}
        </h1>
      </header>

      <div
        id="custom-page-content-body"
        className="article-content mb-12"
        dangerouslySetInnerHTML={{ __html: contentHtml }}
      />
    </article>
  );
};
