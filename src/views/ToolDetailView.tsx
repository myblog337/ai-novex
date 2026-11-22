import React from 'react';
import { ArrowLeft, ArrowRight, CheckCircle2, ExternalLink, Star, Tag } from 'lucide-react';
import { Category, Tool } from '../types';
import { Breadcrumbs, BreadcrumbItem } from '../components/Breadcrumbs';
import { findPublishedToolBySlug, isPublishedTool } from '../config/indexing.js';
import { isSafeAssetOrUrl, isSafeHttpUrl } from '../utils/pageSeo.js';

interface ToolDetailViewProps {
  slug: string;
  tools: Tool[];
  categories: Category[];
  onNavigate: (path: string) => void;
  breadcrumbs?: BreadcrumbItem[];
  breadcrumbEnabled?: boolean;
}

function cleanDisplayText(value: unknown, maxLen = 2000): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ').trim();
  if (!trimmed) return '';
  return trimmed.length > maxLen ? `${trimmed.slice(0, maxLen).trim()}...` : trimmed;
}

export const ToolDetailView: React.FC<ToolDetailViewProps> = ({
  slug,
  tools,
  categories,
  onNavigate,
  breadcrumbs,
  breadcrumbEnabled = true,
}) => {
  const tool = findPublishedToolBySlug(slug, tools);

  if (!tool) {
    return (
      <div className="max-w-3xl mx-auto px-4 py-24 text-center">
        <span className="inline-block px-3 py-1 rounded-full text-xs font-bold bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400 mb-4">
          404 - Not Found
        </span>
        <h1 className="text-3xl sm:text-4xl font-extrabold text-slate-900 dark:text-white mb-3">
          Tool Not Found
        </h1>
        <p className="text-sm text-slate-600 dark:text-slate-400 mb-8 max-w-md mx-auto leading-relaxed">
          The AI tool profile you are looking for does not exist, has an invalid identifier, or is currently unavailable.
        </p>
        <div className="flex flex-wrap items-center justify-center gap-3">
          <a
            href="/tools/"
            onClick={(e) => {
              e.preventDefault();
              onNavigate('/tools/');
            }}
            className="inline-flex items-center gap-2 px-6 py-2.5 rounded-full bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold shadow-md shadow-blue-600/30 transition-colors cursor-pointer"
          >
            <ArrowLeft className="w-4 h-4" />
            <span>Back to AI Tools Directory</span>
          </a>
        </div>
      </div>
    );
  }

  const safeIcon = isSafeAssetOrUrl(tool.icon) ? tool.icon.trim() : '';
  const safeExternalUrl = isSafeHttpUrl(tool.url) ? tool.url.trim() : '';
  const hasValidRating =
    typeof tool.rating === 'number' &&
    Number.isFinite(tool.rating) &&
    tool.rating >= 0 &&
    tool.rating <= 5;

  const shortDesc = cleanDisplayText(tool.description, 1000);
  const longDesc = cleanDisplayText(tool.longDescription, 2000);
  const primaryOverview = longDesc || shortDesc;
  const showSubtitle = Boolean(shortDesc && longDesc && shortDesc !== longDesc);

  const matchedCategory = categories.find((c) => c.slug === tool.category) || null;
  const categoryLabel =
    cleanDisplayText(tool.categoryName, 100) || (matchedCategory ? matchedCategory.name : '');

  const pricingLabel = cleanDisplayText(tool.pricing, 40);
  const osLabel = cleanDisplayText(tool.operatingSystem, 120);

  const safeTags = Array.isArray(tool.tags)
    ? tool.tags.map((t) => cleanDisplayText(t, 60)).filter(Boolean)
    : [];

  const safeFeatures = Array.isArray(tool.features)
    ? tool.features.map((f) => cleanDisplayText(f, 240)).filter(Boolean)
    : [];

  const relatedTools = tools
    .filter((t) => isPublishedTool(t) && t.slug !== tool.slug && t.category === tool.category)
    .slice(0, 3);

  const defaultBreadcrumbs: BreadcrumbItem[] = [
    { label: 'Tools', path: '/tools/' },
    { label: tool.name },
  ];
  const effectiveBreadcrumbs = breadcrumbs !== undefined ? breadcrumbs : defaultBreadcrumbs;
  const showBreadcrumbs = breadcrumbEnabled !== false && effectiveBreadcrumbs.length > 0;

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      {showBreadcrumbs && <Breadcrumbs items={effectiveBreadcrumbs} onNavigate={onNavigate} />}

      <div className="mb-4">
        <a
          href="/tools/"
          onClick={(e) => {
            e.preventDefault();
            onNavigate('/tools/');
          }}
          className="inline-flex items-center gap-1.5 text-xs font-semibold text-blue-600 dark:text-blue-400 hover:underline cursor-pointer"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          <span>Back to AI Tools Directory</span>
        </a>
      </div>

      {/* Main Tool Profile Card */}
      <article className="bg-white dark:bg-slate-900/70 border border-slate-200 dark:border-slate-800 rounded-3xl p-6 sm:p-10 shadow-sm mb-10">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-6 pb-8 border-b border-slate-200 dark:border-slate-800">
          <div className="flex items-start sm:items-center gap-5">
            <div className="w-16 h-16 sm:w-20 sm:h-20 rounded-2xl bg-slate-50 dark:bg-slate-800/80 overflow-hidden flex items-center justify-center shrink-0 shadow-sm p-2 border border-slate-200/70 dark:border-slate-700/70">
              {safeIcon ? (
                <img
                  src={safeIcon}
                  alt={`${tool.name} Logo`}
                  className="w-full h-full object-contain rounded-xl"
                />
              ) : (
                <span className="text-2xl font-extrabold text-blue-600 dark:text-blue-400">
                  {tool.name.charAt(0).toUpperCase()}
                </span>
              )}
            </div>

            <div>
              <div className="flex flex-wrap items-center gap-2 mb-2">
                {matchedCategory ? (
                  <a
                    href={`/category/${matchedCategory.slug}/`}
                    onClick={(e) => {
                      e.preventDefault();
                      onNavigate(`/category/${matchedCategory.slug}/`);
                    }}
                    className="px-2.5 py-0.5 rounded-full text-xs font-semibold bg-blue-50 text-blue-600 border border-blue-200 dark:bg-blue-950/60 dark:text-blue-400 dark:border-blue-500/30 hover:bg-blue-100 transition-colors"
                  >
                    {categoryLabel || matchedCategory.name}
                  </a>
                ) : categoryLabel ? (
                  <span className="px-2.5 py-0.5 rounded-full text-xs font-semibold bg-blue-50 text-blue-600 border border-blue-200 dark:bg-blue-950/60 dark:text-blue-400 dark:border-blue-500/30">
                    {categoryLabel}
                  </span>
                ) : null}

                {pricingLabel && (
                  <span className="px-2.5 py-0.5 rounded-full text-xs font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200 dark:bg-emerald-950/50 dark:text-emerald-400 dark:border-emerald-500/30">
                    {pricingLabel}
                  </span>
                )}

                {hasValidRating && (
                  <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-amber-50 text-amber-700 border border-amber-200 dark:bg-amber-950/40 dark:text-amber-400 dark:border-amber-500/30">
                    <Star className="w-3.5 h-3.5 fill-amber-400 text-amber-400" />
                    <span>{tool.rating}</span>
                  </span>
                )}

                {osLabel && (
                  <span className="px-2.5 py-0.5 rounded-full text-xs font-medium bg-slate-100 text-slate-700 border border-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700">
                    {osLabel}
                  </span>
                )}
              </div>

              <h1 className="text-2xl sm:text-4xl font-extrabold text-slate-900 dark:text-white tracking-tight">
                {tool.name}
              </h1>

              {showSubtitle && (
                <p className="text-sm sm:text-base text-slate-600 dark:text-slate-300 mt-2 leading-relaxed">
                  {shortDesc}
                </p>
              )}
            </div>
          </div>

          {safeExternalUrl && (
            <div className="shrink-0">
              <a
                href={safeExternalUrl}
                target="_blank"
                rel="nofollow noopener noreferrer"
                className="w-full sm:w-auto inline-flex items-center justify-center gap-2 px-6 py-3 rounded-xl text-sm font-semibold text-white bg-blue-600 hover:bg-blue-500 shadow-md shadow-blue-600/30 transition-all"
              >
                <span>Visit Official Website</span>
                <ExternalLink className="w-4 h-4" />
              </a>
            </div>
          )}
        </div>

        {/* Overview Description */}
        {primaryOverview && (
          <section className="py-6 border-b border-slate-200 dark:border-slate-800/80">
            <h2 className="text-lg font-bold text-slate-900 dark:text-white mb-2">
              Overview
            </h2>
            <p className="text-sm sm:text-base text-slate-700 dark:text-slate-300 leading-relaxed">
              {primaryOverview}
            </p>
          </section>
        )}

        {/* Supported Features (rendered only when present in tool data) */}
        {safeFeatures.length > 0 && (
          <section className="py-6 border-b border-slate-200 dark:border-slate-800/80">
            <h2 className="text-lg font-bold text-slate-900 dark:text-white mb-3">
              Key Features
            </h2>
            <ul className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              {safeFeatures.map((feature, idx) => (
                <li
                  key={`${feature}-${idx}`}
                  className="flex items-start gap-2 text-sm text-slate-700 dark:text-slate-300"
                >
                  <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0 mt-0.5" />
                  <span>{feature}</span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* Tags */}
        {safeTags.length > 0 && (
          <section className="pt-6 flex items-center flex-wrap gap-2">
            <Tag className="w-4 h-4 text-slate-400 mr-1" />
            {safeTags.map((tag) => (
              <span
                key={tag}
                className="px-3 py-1 rounded-full text-xs font-medium bg-slate-100 text-slate-700 border border-slate-200 dark:bg-slate-800/80 dark:text-slate-300 dark:border-slate-700/50"
              >
                {tag}
              </span>
            ))}
          </section>
        )}
      </article>

      {/* Related Tools */}
      {relatedTools.length > 0 && (
        <section className="pt-2">
          <div className="flex items-center justify-between mb-5">
            <h2 className="text-xl font-bold text-slate-900 dark:text-white">
              Related Tools{categoryLabel ? ` in ${categoryLabel}` : ''}
            </h2>
            <a
              href="/tools/"
              onClick={(e) => {
                e.preventDefault();
                onNavigate('/tools/');
              }}
              className="text-xs sm:text-sm font-semibold text-blue-600 dark:text-blue-400 hover:underline cursor-pointer"
            >
              All Tools &rarr;
            </a>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-5">
            {relatedTools.map((rel) => {
              const safeRelIcon = isSafeAssetOrUrl(rel.icon) ? rel.icon.trim() : '';
              return (
                <a
                  key={rel.slug}
                  href={`/tools/${rel.slug}/`}
                  onClick={(e) => {
                    e.preventDefault();
                    onNavigate(`/tools/${rel.slug}/`);
                  }}
                  className="p-5 rounded-2xl bg-white dark:bg-slate-900/60 border border-slate-200 dark:border-slate-800 hover:border-blue-500/40 shadow-sm hover:shadow-md transition-all flex flex-col justify-between group block"
                >
                  <div>
                    <div className="flex items-center gap-3 mb-3">
                      <div className="w-10 h-10 rounded-xl bg-slate-50 dark:bg-slate-800 flex items-center justify-center p-1.5 border border-slate-200/60 dark:border-slate-700/60 shrink-0 overflow-hidden">
                        {safeRelIcon ? (
                          <img
                            src={safeRelIcon}
                            alt={`${rel.name} Logo`}
                            className="w-full h-full object-contain"
                          />
                        ) : (
                          <span className="text-sm font-bold text-blue-600 dark:text-blue-400">
                            {rel.name.charAt(0).toUpperCase()}
                          </span>
                        )}
                      </div>
                      <h3 className="text-base font-bold text-slate-900 dark:text-white group-hover:text-blue-600 dark:group-hover:text-blue-400 transition-colors">
                        {rel.name}
                      </h3>
                    </div>
                    {rel.description && (
                      <p className="text-xs text-slate-600 dark:text-slate-400 line-clamp-2 mb-3">
                        {rel.description}
                      </p>
                    )}
                  </div>
                  <span className="inline-flex items-center gap-1 text-xs font-semibold text-blue-600 dark:text-blue-400">
                    <span>View Profile</span>
                    <ArrowRight className="w-3.5 h-3.5" />
                  </span>
                </a>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
};
