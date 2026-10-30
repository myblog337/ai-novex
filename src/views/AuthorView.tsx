import React from 'react';
import { Shield, BookOpen, ArrowRight } from 'lucide-react';
import { Article } from '../types';
import { Breadcrumbs } from '../components/Breadcrumbs';

interface AuthorViewProps {
  slug?: string;
  articles: Article[];
  onNavigate: (path: string) => void;
}

export const AuthorView: React.FC<AuthorViewProps> = ({
  slug = 'md-shamim',
  articles,
  onNavigate,
}) => {
  const authorName = 'Md Shamim';
  const authorRole = 'Lead researcher and editor at AINOVEX';

  const authorArticles = articles
    .filter((a) => a.isPublished && (a.author === authorName || !a.author))
    .sort((x, y) => String(y.updatedAt || y.publishedAt).localeCompare(String(x.updatedAt || x.publishedAt)));

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <Breadcrumbs
        items={[
          { label: 'Authors', path: '/about/' },
          { label: authorName },
        ]}
        onNavigate={onNavigate}
      />

      {/* Author Profile Header */}
      <div className="bg-white dark:bg-slate-900/70 border border-slate-200 dark:border-slate-800 rounded-3xl p-6 sm:p-10 shadow-sm mb-12">
        <div className="flex flex-col sm:flex-row items-start sm:items-center gap-6 mb-8 pb-8 border-b border-slate-200 dark:border-slate-800">
          <div className="w-20 h-20 sm:w-24 sm:h-24 rounded-3xl bg-gradient-to-tr from-blue-600 via-sky-500 to-blue-400 flex items-center justify-center font-extrabold text-white text-2xl sm:text-3xl shrink-0 shadow-lg shadow-blue-500/20">
            MS
          </div>
          <div className="flex-1">
            <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-blue-50 text-blue-600 border border-blue-200 dark:bg-blue-950/60 dark:border-blue-500/30 dark:text-blue-400 mb-2">
              <Shield className="w-3.5 h-3.5" />
              <span>Editorial Profile</span>
            </div>
            <h1 className="text-2xl sm:text-4xl font-extrabold text-slate-900 dark:text-white tracking-tight mb-1">
              {authorName}
            </h1>
            <p className="text-sm sm:text-base font-medium text-slate-600 dark:text-slate-300">
              {authorRole}
            </p>
          </div>
        </div>

        {/* Bio & Background (strictly verified facts, zero placeholders) */}
        <div className="space-y-6 text-sm sm:text-base text-slate-700 dark:text-slate-300 leading-relaxed">
          <div>
            <h2 className="text-lg font-bold text-slate-900 dark:text-white mb-2 flex items-center gap-2">
              <BookOpen className="w-5 h-5 text-blue-500" />
              Editorial Role
            </h2>
            <p className="mb-3">
              Md Shamim is the lead researcher and editor at <strong>AINOVEX</strong>. He conducts research, software evaluations, and technical guides published across the platform.
            </p>
            <p>
              His editorial work focuses on analyzing publicly available software documentation, vendor specifications, and user documentation to produce clear, structured comparisons for readers.
            </p>
          </div>

          <div className="border-t border-slate-200 dark:border-slate-800 pt-6">
            <h3 className="text-base font-bold text-slate-900 dark:text-white mb-2">
              Editorial Standards
            </h3>
            <p className="text-xs sm:text-sm text-slate-600 dark:text-slate-400 leading-relaxed mb-3">
              Md Shamim adheres to the{' '}
              <a
                href="/editorial-policy/"
                onClick={(e) => {
                  e.preventDefault();
                  onNavigate('/editorial-policy/');
                }}
                className="text-blue-600 dark:text-blue-400 underline font-semibold"
              >
                AINOVEX Editorial Policy
              </a>
              . Articles are compiled through independent technical research and official vendor documentation review.
            </p>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              For questions, feedback, or editorial corrections, please visit our{' '}
              <a
                href="/contact/"
                onClick={(e) => {
                  e.preventDefault();
                  onNavigate('/contact/');
                }}
                className="text-blue-600 dark:text-blue-400 underline font-medium"
              >
                Contact page
              </a>
              .
            </p>
          </div>
        </div>
      </div>

      {/* Articles by this Author */}
      <section>
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-xl sm:text-2xl font-bold text-slate-900 dark:text-white tracking-tight">
            Articles by Md Shamim ({authorArticles.length})
          </h2>
          <span className="text-xs text-slate-500 dark:text-slate-400">
            Sorted by update date
          </span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {authorArticles.map((a) => (
            <a
              key={a.slug}
              href={`/blog/${a.slug}/`}
              onClick={(e) => {
                e.preventDefault();
                onNavigate(`/blog/${a.slug}/`);
              }}
              className="group bg-white dark:bg-slate-900/60 border border-slate-200 dark:border-slate-800 rounded-2xl overflow-hidden shadow-sm hover:border-blue-500/50 hover:shadow-md transition-all flex flex-col justify-between block"
            >
              <div>
                <div className="relative aspect-[16/10] overflow-hidden bg-slate-100 dark:bg-slate-800">
                  <img
                    src={a.featuredImage}
                    alt={a.imageAlt || a.title}
                    className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                    loading="lazy"
                  />
                  <span className="absolute top-3 left-3 px-2.5 py-1 rounded-full text-[11px] font-bold uppercase tracking-wider bg-slate-900/80 text-white backdrop-blur-sm">
                    {a.categoryName || a.category}
                  </span>
                </div>
                <div className="p-5">
                  <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400 mb-2">
                    <span>Published: {a.publishedAt}</span>
                    {a.updatedAt && a.updatedAt !== a.publishedAt && (
                      <>
                        <span>•</span>
                        <span className="text-emerald-600 dark:text-emerald-400 font-medium">
                          Updated: {a.updatedAt}
                        </span>
                      </>
                    )}
                  </div>
                  <h3 className="text-base font-bold text-slate-900 dark:text-white group-hover:text-blue-600 dark:group-hover:text-blue-400 transition-colors line-clamp-2 mb-2 leading-snug">
                    {a.title}
                  </h3>
                  <p className="text-xs sm:text-sm text-slate-600 dark:text-slate-400 line-clamp-2 leading-relaxed">
                    {a.excerpt}
                  </p>
                </div>
              </div>
              <div className="px-5 pb-5 pt-2 flex items-center justify-between border-t border-slate-100 dark:border-slate-800/60 text-xs font-semibold text-blue-600 dark:text-blue-400">
                <span>Read Guide</span>
                <ArrowRight className="w-3.5 h-3.5 group-hover:translate-x-1 transition-transform" />
              </div>
            </a>
          ))}
        </div>
      </section>
    </div>
  );
};
