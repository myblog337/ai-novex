import React from 'react';
import { ChevronRight, Home } from 'lucide-react';
import { isValidSeoPathFormat, normalizeRoutePath } from '../utils/pageSeo.js';

export interface BreadcrumbItem {
  label: string;
  path?: string;
}

interface BreadcrumbsProps {
  items: BreadcrumbItem[];
  onNavigate: (path: string) => void;
}

export const Breadcrumbs: React.FC<BreadcrumbsProps> = ({ items, onNavigate }) => {
  if (!Array.isArray(items) || items.length === 0) {
    return null;
  }

  return (
    <nav aria-label="Breadcrumb" className="py-3 text-xs text-slate-500 dark:text-slate-400">
      <ol className="flex items-center flex-wrap gap-1.5">
        <li>
          <a
            href="/"
            onClick={(e) => {
              e.preventDefault();
              onNavigate('/');
            }}
            className="flex items-center gap-1 text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white transition-colors cursor-pointer"
          >
            <Home className="w-3.5 h-3.5" />
            <span>Home</span>
          </a>
        </li>

        {items.map((item, idx) => {
          const isLast = idx === items.length - 1;
          const safePath =
            !isLast &&
            typeof item.path === 'string' &&
            item.path.trim() &&
            isValidSeoPathFormat(item.path.trim())
              ? normalizeRoutePath(item.path.trim())
              : '';
          return (
            <React.Fragment key={`${item.label}-${idx}`}>
              <li className="text-slate-400 dark:text-slate-600" aria-hidden="true">
                <ChevronRight className="w-3.5 h-3.5" />
              </li>
              <li aria-current={isLast ? 'page' : undefined}>
                {isLast ? (
                  <span className="font-semibold text-slate-800 dark:text-slate-200 truncate max-w-[200px] sm:max-w-md inline-block">
                    {item.label}
                  </span>
                ) : safePath ? (
                  <a
                    href={safePath}
                    onClick={(e) => {
                      e.preventDefault();
                      onNavigate(safePath);
                    }}
                    className="text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white transition-colors cursor-pointer"
                  >
                    <span>{item.label}</span>
                  </a>
                ) : (
                  <span className="text-slate-500 dark:text-slate-400">
                    {item.label}
                  </span>
                )}
              </li>
            </React.Fragment>
          );
        })}
      </ol>
    </nav>
  );
};

