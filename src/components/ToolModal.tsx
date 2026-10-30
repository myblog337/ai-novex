import React, { useEffect } from 'react';
import { ExternalLink, X } from 'lucide-react';
import { Tool } from '../types';

interface ToolModalProps {
  tool: Tool | null;
  onClose: () => void;
}

/** Tool detail dialog. Rendered once at app level so it works from Home, Tools, Category and Search. */
export const ToolModal: React.FC<ToolModalProps> = ({ tool, onClose }) => {
  useEffect(() => {
    if (!tool) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [tool, onClose]);

  if (!tool) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`${tool.name} details`}
      onClick={() => onClose()}
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm animate-in fade-in"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-lg rounded-3xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 p-6 sm:p-8 shadow-2xl relative"
      >
        <button
          type="button"
          aria-label="Close"
          onClick={() => onClose()}
          className="absolute top-4 right-4 p-2 text-slate-400 hover:text-slate-600 dark:hover:text-white cursor-pointer"
        >
          <X className="w-5 h-5" />
        </button>

        <div className="flex items-center gap-4 mb-4">
          <div className="w-14 h-14 rounded-2xl bg-slate-50 dark:bg-slate-800 overflow-hidden flex items-center justify-center font-bold text-sky-500 dark:text-sky-400 text-xl shadow-sm p-1 border border-slate-200/60 dark:border-slate-700/60">
            <img
              src={tool.icon}
              alt={tool.name}
              className="w-full h-full object-contain rounded-xl"
            />
          </div>
          <div>
            <h2 className="text-xl font-bold text-slate-900 dark:text-white">
              {tool.name}
            </h2>
            <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
              <span>{tool.categoryName || tool.category}</span>
              <span>•</span>
              <span className="text-emerald-600 dark:text-emerald-400 font-semibold">{tool.pricing}</span>
            </div>
          </div>
        </div>

        <p className="text-sm text-slate-600 dark:text-slate-300 leading-relaxed mb-5">
          {tool.longDescription || tool.description}
        </p>

        <div className="mb-6">
          <div className="text-xs font-semibold text-slate-500 dark:text-slate-400 mb-2">Tags:</div>
          <div className="flex flex-wrap gap-1.5">
            {tool.tags.map((tag) => (
              <span
                key={tag}
                className="px-2.5 py-1 rounded-full text-xs bg-slate-100 text-slate-700 border border-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700"
              >
                {tag}
              </span>
            ))}
          </div>
        </div>

        <div className="flex gap-3">
          <a
            href={tool.url}
            target="_blank"
            rel="nofollow noopener noreferrer"
            className="flex-1 inline-flex items-center justify-center gap-2 py-3 px-4 rounded-xl text-sm font-semibold text-white bg-blue-600 hover:bg-blue-500 shadow-md shadow-blue-600/30 transition-all cursor-pointer"
          >
            <span>Visit Official Website</span>
            <ExternalLink className="w-4 h-4" />
          </a>
        </div>
      </div>
    </div>
  );
};
