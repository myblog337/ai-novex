import React from 'react';
import { Sparkles, ArrowRight } from 'lucide-react';
import { Tool } from '../types';
import { isPublishedTool } from '../config/indexing.js';
import { isSafeAssetOrUrl, isSafeHttpUrl } from '../utils/pageSeo.js';

interface FeaturedToolsProps {
  tools: Tool[];
  onViewAll: () => void;
  onSelectTool: (tool: Tool) => void;
  onNavigate?: (path: string) => void;
}

export const FeaturedTools: React.FC<FeaturedToolsProps> = ({
  tools,
  onViewAll,
  onSelectTool,
  onNavigate,
}) => {
  const visibleTools = tools.filter(isPublishedTool);

  return (
    <section className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-10">
      {/* Section Header */}
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-3 mb-8">
        <div>
          <h2 className="flex items-center gap-2 text-xl sm:text-2xl font-bold text-slate-900 dark:text-white tracking-tight">
            <Sparkles className="w-5 h-5 text-sky-500 dark:text-sky-400" />
            <span>Featured AI Tools</span>
          </h2>
          <p className="text-xs sm:text-sm text-slate-600 dark:text-slate-400 mt-1">
            Handpicked top AI tools to help you work faster, create better and achieve more.
          </p>
        </div>
        <a
          href="/tools/"
          onClick={(e) => {
            e.preventDefault();
            onViewAll();
          }}
          className="inline-flex items-center gap-1.5 text-xs sm:text-sm font-semibold text-blue-600 dark:text-blue-400 hover:text-blue-500 dark:hover:text-blue-300 transition-colors group self-start sm:self-auto cursor-pointer"
        >
          <span>View All Tools</span>
          <ArrowRight className="w-4 h-4 transition-transform group-hover:translate-x-0.5" />
        </a>
      </div>

      {/* Grid of Featured Tool Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
        {visibleTools.map((tool) => {
          const detailPath = `/tools/${tool.slug}/`;
          const safeExternalUrl = isSafeHttpUrl(tool.url) ? tool.url.trim() : '';
          const safeIcon = isSafeAssetOrUrl(tool.icon) ? tool.icon.trim() : '';
          const handleDetailClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
            if (onNavigate) {
              e.preventDefault();
              onNavigate(detailPath);
            }
          };

          return (
            <article
              key={tool.id || tool.slug}
              className="flex flex-col justify-between p-6 rounded-2xl bg-white border border-slate-200/90 hover:border-blue-500/40 hover:shadow-xl shadow-sm dark:bg-slate-900/70 dark:border-slate-800/90 transition-all duration-200 hover:-translate-y-1 group text-center"
            >
              <div>
                {/* Tool Icon / Avatar */}
                <div className="w-16 h-16 mx-auto rounded-2xl flex items-center justify-center overflow-hidden mb-4 shadow-sm bg-slate-50 dark:bg-slate-800/80 group-hover:scale-105 transition-transform p-1.5 border border-slate-200/60 dark:border-slate-700/60">
                  {safeIcon ? (
                    <img
                      src={safeIcon}
                      alt={`${tool.name} Logo`}
                      className="w-full h-full object-contain rounded-xl"
                    />
                  ) : (
                    <span className="text-xl font-bold text-blue-600 dark:text-blue-400">
                      {tool.name.charAt(0).toUpperCase()}
                    </span>
                  )}
                </div>

                {/* Tool Name */}
                <h3 className="text-lg font-bold text-slate-900 dark:text-white group-hover:text-blue-600 dark:group-hover:text-blue-400 transition-colors mb-2">
                  <a
                    href={detailPath}
                    onClick={handleDetailClick}
                    className="hover:text-blue-600 dark:hover:text-blue-400 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 rounded"
                  >
                    {tool.name}
                  </a>
                </h3>

                {/* Tool Description */}
                <p className="text-xs sm:text-sm text-slate-600 dark:text-slate-400 line-clamp-2 leading-relaxed mb-4">
                  {tool.description}
                </p>

                {/* Tags */}
                <div className="flex flex-wrap items-center justify-center gap-1.5 mb-6">
                  {(tool.tags || []).map((tag) => (
                    <span
                      key={tag}
                      className="px-2.5 py-0.5 rounded-full text-[11px] font-medium bg-slate-100 text-slate-600 border border-slate-200 dark:bg-slate-800/80 dark:text-slate-300 dark:border-slate-700/50"
                    >
                      {tag}
                    </span>
                  ))}
                </div>
              </div>

              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <a
                    href={detailPath}
                    onClick={handleDetailClick}
                    aria-label={`View Details for ${tool.name}`}
                    className="flex-1 inline-flex items-center justify-center gap-1.5 py-2 px-3 rounded-xl text-xs font-semibold text-blue-600 dark:text-blue-400 bg-blue-50 hover:bg-blue-100 dark:bg-blue-950/50 dark:hover:bg-blue-900/60 border border-blue-200/80 dark:border-blue-500/30 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                  >
                    <span>View Details</span>
                  </a>
                  <button
                    type="button"
                    onClick={() => onSelectTool(tool)}
                    aria-label={`Quick View ${tool.name}`}
                    className="inline-flex items-center justify-center gap-1.5 py-2 px-3 rounded-xl text-xs font-semibold text-slate-700 dark:text-slate-200 bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 border border-slate-200 dark:border-slate-700 transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                  >
                    <span>Quick View</span>
                  </button>
                </div>

                {/* Visit Tool CTA Button */}
                {safeExternalUrl && (
                  <a
                    href={safeExternalUrl}
                    target="_blank"
                    rel="nofollow noopener noreferrer"
                    aria-label={`Visit Tool: ${tool.name}`}
                    className="w-full inline-flex items-center justify-center gap-2 py-2.5 px-4 rounded-xl text-xs sm:text-sm font-semibold text-white bg-slate-900 hover:bg-blue-600 dark:bg-slate-800/90 dark:border dark:border-slate-700/60 dark:hover:bg-blue-600 transition-all shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                  >
                    <span>Visit Tool</span>
                    <ArrowRight className="w-4 h-4" />
                  </a>
                )}
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
};
