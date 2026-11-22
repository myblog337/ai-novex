import React, { useState, useMemo } from 'react';
import { Search, Sparkles, ArrowRight, Star } from 'lucide-react';
import { Tool, Category } from '../types';
import { Breadcrumbs, BreadcrumbItem } from '../components/Breadcrumbs';
import { isPublishedTool } from '../config/indexing.js';
import { isSafeAssetOrUrl, isSafeHttpUrl } from '../utils/pageSeo.js';

interface ToolsViewProps {
  tools: Tool[];
  categories: Category[];
  initialQuery?: string;
  onNavigate: (path: string) => void;
  onSelectTool: (tool: Tool) => void;
  breadcrumbs?: BreadcrumbItem[];
  breadcrumbEnabled?: boolean;
}

const SLUG_CHAR_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export const ToolsView: React.FC<ToolsViewProps> = ({
  tools,
  categories,
  initialQuery = '',
  onNavigate,
  onSelectTool,
  breadcrumbs,
  breadcrumbEnabled = true,
}) => {
  const [search, setSearch] = useState(initialQuery);
  const [selectedCategory, setSelectedCategory] = useState<string>('all');
  const [selectedPricing, setSelectedPricing] = useState<string>('all');
  const [sortBy, setSortBy] = useState<'featured' | 'rating' | 'name'>('featured');

  const visibleTools = useMemo(() => {
    return tools.filter(
      (tool) =>
        Boolean(tool) &&
        typeof tool === 'object' &&
        tool.isPublished !== false &&
        typeof tool.name === 'string' &&
        tool.name.trim().length > 0 &&
        typeof tool.slug === 'string' &&
        SLUG_CHAR_PATTERN.test(tool.slug)
    );
  }, [tools]);

  const filteredTools = useMemo(() => {
    return visibleTools.filter((tool) => {
      const matchesSearch =
        !search ||
        tool.name.toLowerCase().includes(search.toLowerCase()) ||
        tool.description.toLowerCase().includes(search.toLowerCase()) ||
        tool.tags.some((t) => t.toLowerCase().includes(search.toLowerCase()));

      const matchesCat =
        selectedCategory === 'all' || tool.category === selectedCategory;

      const matchesPricing =
        selectedPricing === 'all' || tool.pricing.toLowerCase() === selectedPricing.toLowerCase();

      return matchesSearch && matchesCat && matchesPricing;
    }).sort((a, b) => {
      if (sortBy === 'rating') return (b.rating ?? 0) - (a.rating ?? 0);
      if (sortBy === 'name') return a.name.localeCompare(b.name);
      return (b.isFeatured ? 1 : 0) - (a.isFeatured ? 1 : 0);
    });
  }, [visibleTools, search, selectedCategory, selectedPricing, sortBy]);

  const effectiveBreadcrumbs =
    breadcrumbs !== undefined ? breadcrumbs : [{ label: 'AI Tools Directory' }];
  const showBreadcrumbs = breadcrumbEnabled !== false && effectiveBreadcrumbs.length > 0;

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      {showBreadcrumbs && <Breadcrumbs items={effectiveBreadcrumbs} onNavigate={onNavigate} />}

      {/* Header Banner */}
      <div className="py-6 text-center max-w-3xl mx-auto">
        <h1 className="text-3xl sm:text-4xl font-extrabold text-slate-900 dark:text-white tracking-tight mb-3">
          Explore All AI Tools & Software
        </h1>
        <p className="text-sm text-slate-600 dark:text-slate-300">
          Search and compare {visibleTools.length}+ handpicked artificial intelligence tools for writing, design, video editing, coding, and productivity.
        </p>
      </div>

      {/* Filter and Search Bar */}
      <div className="p-4 rounded-2xl bg-white dark:bg-slate-900/70 border border-slate-200 dark:border-slate-800 shadow-sm mb-8 space-y-4">
        <div className="flex flex-col sm:flex-row gap-3">
          <div className="relative flex-1">
            <Search className="w-4 h-4 absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search tools by name, feature, or keyword..."
              className="w-full pl-10 pr-4 py-2 text-sm rounded-xl bg-slate-50 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700/60 text-slate-900 dark:text-white focus:outline-none focus:border-blue-500"
            />
          </div>

          <div className="flex items-center gap-2">
            <select
              value={selectedPricing}
              onChange={(e) => setSelectedPricing(e.target.value)}
              className="px-3 py-2 text-xs font-semibold rounded-xl bg-slate-50 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700/60 text-slate-700 dark:text-slate-300 focus:outline-none"
            >
              <option value="all">Pricing: All</option>
              <option value="free">Free</option>
              <option value="freemium">Freemium</option>
              <option value="paid">Paid</option>
            </select>

            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as any)}
              className="px-3 py-2 text-xs font-semibold rounded-xl bg-slate-50 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700/60 text-slate-700 dark:text-slate-300 focus:outline-none"
            >
              <option value="featured">Sort: Featured</option>
              <option value="rating">Sort: Top Rated</option>
              <option value="name">Sort: Name (A-Z)</option>
            </select>
          </div>
        </div>

        {/* Categories Pills */}
        <div className="flex items-center gap-1.5 overflow-x-auto pb-1 scrollbar-thin">
          <button
            onClick={() => setSelectedCategory('all')}
            className={`px-3 py-1 rounded-full text-xs font-medium whitespace-nowrap transition-colors ${
              selectedCategory === 'all'
                ? 'bg-blue-600 text-white font-semibold'
                : 'bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300'
            }`}
          >
            All Categories
          </button>
          {categories.map((cat) => (
            <button
              key={cat.id || cat.slug}
              onClick={() => setSelectedCategory(cat.slug)}
              className={`px-3 py-1 rounded-full text-xs font-medium whitespace-nowrap transition-colors ${
                selectedCategory === cat.slug
                  ? 'bg-blue-600 text-white font-semibold'
                  : 'bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300'
              }`}
            >
              {cat.name}
            </button>
          ))}
        </div>
      </div>

      {/* Tools Grid */}
      {filteredTools.length === 0 ? (
        <div className="p-12 text-center rounded-2xl bg-white dark:bg-slate-900/50 border border-slate-200 dark:border-slate-800">
          <Sparkles className="w-8 h-8 mx-auto text-slate-400 mb-2" />
          <h3 className="text-base font-bold text-slate-900 dark:text-white mb-1">No tools match your criteria</h3>
          <p className="text-xs text-slate-500 dark:text-slate-400">Try adjusting your search terms or filters.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
          {filteredTools.map((tool) => {
            const canLinkDetail = isPublishedTool(tool);
            const detailPath = canLinkDetail ? `/tools/${tool.slug}/` : '';
            const safeExternalUrl = isSafeHttpUrl(tool.url) ? tool.url.trim() : '';
            const safeIcon = isSafeAssetOrUrl(tool.icon) ? tool.icon.trim() : '';

            return (
              <article
                key={tool.id || tool.slug}
                className="flex flex-col justify-between p-6 rounded-2xl bg-white dark:bg-slate-900/70 border border-slate-200 dark:border-slate-800/90 hover:border-blue-500/40 transition-all duration-200 hover:-translate-y-1 hover:shadow-xl shadow-sm group text-center"
              >
                <div>
                  {/* Icon */}
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

                  <div className="flex items-center justify-center gap-1 text-xs text-amber-500 font-semibold mb-1">
                    <Star className="w-3.5 h-3.5 fill-amber-400 text-amber-400" />
                    <span>{tool.rating ?? 4.8}</span>
                    <span className="text-slate-400">•</span>
                    <span className="text-slate-500 dark:text-slate-400 font-normal">{tool.pricing}</span>
                  </div>

                  <h3 className="text-lg font-bold text-slate-900 dark:text-white group-hover:text-blue-600 dark:group-hover:text-blue-400 transition-colors mb-2">
                    {canLinkDetail ? (
                      <a
                        href={detailPath}
                        onClick={(e) => {
                          e.preventDefault();
                          onNavigate(detailPath);
                        }}
                        className="hover:text-blue-600 dark:hover:text-blue-400 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 rounded"
                      >
                        {tool.name}
                      </a>
                    ) : (
                      tool.name
                    )}
                  </h3>

                  <p className="text-xs sm:text-sm text-slate-600 dark:text-slate-400 line-clamp-2 leading-relaxed mb-4">
                    {tool.description}
                  </p>

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
                    {canLinkDetail && (
                      <a
                        href={detailPath}
                        onClick={(e) => {
                          e.preventDefault();
                          onNavigate(detailPath);
                        }}
                        aria-label={`View Details for ${tool.name}`}
                        className="flex-1 inline-flex items-center justify-center gap-1.5 py-2 px-3 rounded-xl text-xs font-semibold text-blue-600 dark:text-blue-400 bg-blue-50 hover:bg-blue-100 dark:bg-blue-950/50 dark:hover:bg-blue-900/60 border border-blue-200/80 dark:border-blue-500/30 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                      >
                        <span>View Details</span>
                      </a>
                    )}
                    <button
                      type="button"
                      onClick={() => onSelectTool(tool)}
                      aria-label={`Quick View ${tool.name}`}
                      className={`${canLinkDetail ? '' : 'flex-1 '}inline-flex items-center justify-center gap-1.5 py-2 px-3 rounded-xl text-xs font-semibold text-slate-700 dark:text-slate-200 bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 border border-slate-200 dark:border-slate-700 transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500`}
                    >
                      <span>Quick View</span>
                    </button>
                  </div>

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
      )}
    </div>
  );
};
