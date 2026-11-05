import React from 'react';

interface FooterProps {
  onNavigate: (path: string) => void;
}

export const Footer: React.FC<FooterProps> = ({ onNavigate }) => {
  const quickLinks = [
    { label: 'Home', path: '/' },
    { label: 'AI Tools', path: '/tools/' },
    { label: 'Blog', path: '/blog/' },
    { label: 'Categories', path: '/categories/' },
    { label: 'About', path: '/about/' },
    { label: 'Contact', path: '/contact/' },
  ];

  const popularCategories = [
    { label: 'AI Writing', slug: 'ai-writing' },
    { label: 'Image Generation', slug: 'image-generation' },
    { label: 'Video & Audio', slug: 'video-audio' },
    { label: 'Productivity', slug: 'productivity' },
    { label: 'Design & Art', slug: 'design-art' },
    { label: 'Code & Dev', slug: 'code-dev' },
    { label: 'Business', slug: 'business' },
    { label: 'Education', slug: 'education' },
  ];

  return (
    <footer className="border-t border-slate-200 dark:border-slate-800/80 bg-slate-50 dark:bg-[#070b14] pt-16 pb-12 transition-colors">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-12 gap-10 lg:gap-8 mb-14">
          {/* Brand Info */}
          <div className="lg:col-span-4">
            <a 
              href="/"
              onClick={(e) => {
                e.preventDefault();
                onNavigate('/');
              }}
              className="cursor-pointer inline-flex flex-col mb-4 select-none"
            >
              <div className="flex items-center gap-1 text-2xl font-black tracking-tight">
                <span className="text-transparent bg-clip-text bg-gradient-to-r from-sky-400 via-blue-400 to-blue-500">
                  AI
                </span>
                <span className="text-slate-900 dark:text-white">
                  NOVEX
                </span>
              </div>
              <span className="text-[10px] tracking-wider font-medium text-slate-500 dark:text-slate-400 -mt-0.5">
                AI Tools • News • Guides • More
              </span>
            </a>

            <p className="text-xs sm:text-sm text-slate-600 dark:text-slate-400 leading-relaxed max-w-sm">
              AINOVEX is your trusted source for the best AI tools, latest news, and helpful guides. Boost your productivity, creativity and work smarter with curated artificial intelligence.
            </p>
          </div>

          {/* Quick Links */}
          <div className="lg:col-span-2">
            <h4 className="text-xs font-bold uppercase tracking-wider text-slate-900 dark:text-white mb-4">
              QUICK LINKS
            </h4>
            <ul className="space-y-2.5 text-xs sm:text-sm">
              {quickLinks.map((item) => (
                <li key={item.path}>
                  <a
                    href={item.path}
                    onClick={(e) => {
                      e.preventDefault();
                      onNavigate(item.path);
                    }}
                    className="text-slate-600 hover:text-blue-600 dark:text-slate-400 dark:hover:text-blue-400 transition-colors cursor-pointer block"
                  >
                    {item.label}
                  </a>
                </li>
              ))}
            </ul>
          </div>

          {/* Popular Categories */}
          <div className="lg:col-span-3">
            <h4 className="text-xs font-bold uppercase tracking-wider text-slate-900 dark:text-white mb-4">
              POPULAR CATEGORIES
            </h4>
            <div className="grid grid-cols-2 gap-x-2 gap-y-2.5 text-xs sm:text-sm">
              {popularCategories.map((cat) => (
                <a
                  key={cat.slug}
                  href={`/category/${cat.slug}/`}
                  onClick={(e) => {
                    e.preventDefault();
                    onNavigate(`/category/${cat.slug}/`);
                  }}
                  className="text-left text-slate-600 hover:text-blue-600 dark:text-slate-400 dark:hover:text-blue-400 transition-colors truncate cursor-pointer block"
                >
                  {cat.label}
                </a>
              ))}
            </div>
          </div>

          {/* Stay Connected */}
          <div className="lg:col-span-3">
            <h4 className="text-xs font-bold uppercase tracking-wider text-slate-900 dark:text-white mb-4">
              EDITORIAL DESK
            </h4>
            <p className="text-xs text-slate-600 dark:text-slate-400 mb-3">
              Independent AI software reviews, benchmarks, workflows, and hands-on tutorials.
            </p>
            <div className="flex items-center gap-2 pt-1">
              <a
                href="/tools/"
                onClick={(e) => {
                  e.preventDefault();
                  onNavigate('/tools/');
                }}
                className="px-3 py-1 rounded-full bg-blue-600 text-white text-xs font-bold transition-all"
              >
                Directory
              </a>
            </div>
          </div>
        </div>

        {/* Bottom Bar */}
        <div className="pt-8 border-t border-slate-200 dark:border-slate-800/60 flex flex-col sm:flex-row items-center justify-between gap-4 text-xs text-slate-500 dark:text-slate-400">
          <p>© 2026 AINOVEX. All rights reserved.</p>

          <div className="flex flex-wrap items-center gap-5">
            <a
              href="/privacy/"
              onClick={(e) => {
                e.preventDefault();
                onNavigate('/privacy/');
              }}
              className="hover:text-blue-600 dark:hover:text-blue-400 transition-colors cursor-pointer"
            >
              Privacy Policy
            </a>
            <a
              href="/terms/"
              onClick={(e) => {
                e.preventDefault();
                onNavigate('/terms/');
              }}
              className="hover:text-blue-600 dark:hover:text-blue-400 transition-colors cursor-pointer"
            >
              Terms of Service
            </a>
            <a
              href="/editorial-policy/"
              onClick={(e) => {
                e.preventDefault();
                onNavigate('/editorial-policy/');
              }}
              className="hover:text-blue-600 dark:hover:text-blue-400 transition-colors cursor-pointer"
            >
              Editorial Policy
            </a>
            <a
              href="/affiliate-disclosure/"
              onClick={(e) => {
                e.preventDefault();
                onNavigate('/affiliate-disclosure/');
              }}
              className="hover:text-blue-600 dark:hover:text-blue-400 transition-colors cursor-pointer"
            >
              Disclaimer
            </a>
          </div>
        </div>
      </div>
    </footer>
  );
};
