import React from 'react';
import { Breadcrumbs } from '../components/Breadcrumbs';
import { SITE_URL } from '../config/site';
import settings from '../../content/settings.json';
import {
  LEGAL_TITLES,
  LEGAL_BREADCRUMBS,
  formatLegalDate,
  getLegalContent,
} from '../config/legal.js';

interface LegalViewProps {
  page: 'privacy' | 'terms' | 'editorial' | 'affiliate';
  onNavigate: (path: string) => void;
}

export const LegalView: React.FC<LegalViewProps> = ({ page, onNavigate }) => {
  const CONTACT_EMAIL: string = settings.contactEmail || '';
  if (!CONTACT_EMAIL) {
    console.error('[LegalView] "contactEmail" is missing or empty in content/settings.json');
  }
  const legal = getLegalContent({ siteUrl: SITE_URL, contactEmail: CONTACT_EMAIL, strict: false });
  const lastUpdatedLabel = formatLegalDate();

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <Breadcrumbs items={[{ label: LEGAL_BREADCRUMBS[page] }]} onNavigate={onNavigate} />

      <div className="py-6 border-b border-slate-200 dark:border-slate-800/80 mb-8">
        <h1 className="text-3xl sm:text-4xl font-extrabold text-slate-900 dark:text-white tracking-tight mb-2">
          {LEGAL_TITLES[page]}
        </h1>
        <p className="text-xs text-slate-500 dark:text-slate-400">
          Last updated: {lastUpdatedLabel} • Published by AINOVEX Editorial Team
        </p>
      </div>

      <div className="space-y-8 text-sm sm:text-base text-slate-700 dark:text-slate-300 leading-relaxed">
        {page === 'privacy' && (
          <>
            <section>
              <h2 className="text-xl font-bold text-slate-900 dark:text-white mb-2">{legal.privacy.sections[0].heading}</h2>
              <p>
                {legal.privacy.sections[0].textBeforeUrl}{legal.privacy.sections[0].siteUrl}{legal.privacy.sections[0].textAfterUrl}
              </p>
            </section>
            <section>
              <h2 className="text-xl font-bold text-slate-900 dark:text-white mb-2">{legal.privacy.sections[1].heading}</h2>
              <p>
                {legal.privacy.sections[1].paragraphs[0]}
              </p>
            </section>
            <section>
              <h2 className="text-xl font-bold text-slate-900 dark:text-white mb-2">{legal.privacy.sections[2].heading}</h2>
              <p>
                {legal.privacy.sections[2].paragraphs[0]}
              </p>
            </section>
            <section>
              <h2 className="text-xl font-bold text-slate-900 dark:text-white mb-2">{legal.privacy.sections[3].heading}</h2>
              {legal.privacy.sections[3].hasEmail ? (
                <p>
                  {legal.privacy.sections[3].textBeforeEmail}<strong>{legal.privacy.sections[3].email}</strong>.
                </p>
              ) : (
                <p>
                  {legal.privacy.sections[3].paragraphs[0]}
                </p>
              )}
            </section>
          </>
        )}

        {page === 'terms' && (
          <>
            <section>
              <h2 className="text-xl font-bold text-slate-900 dark:text-white mb-2">{legal.terms.sections[0].heading}</h2>
              <p>
                {legal.terms.sections[0].paragraphs[0]}
              </p>
            </section>
            <section>
              <h2 className="text-xl font-bold text-slate-900 dark:text-white mb-2">{legal.terms.sections[1].heading}</h2>
              <p>
                {legal.terms.sections[1].paragraphs[0]}
              </p>
            </section>
            <section>
              <h2 className="text-xl font-bold text-slate-900 dark:text-white mb-2">{legal.terms.sections[2].heading}</h2>
              <p>
                {legal.terms.sections[2].paragraphs[0]}
              </p>
            </section>
          </>
        )}

        {page === 'editorial' && (
          <>
            <section>
              <h2 className="text-xl font-bold text-slate-900 dark:text-white mb-2">{legal.editorial.sections[0].heading}</h2>
              <p>
                {legal.editorial.sections[0].textBeforeAuthor}<strong>{legal.editorial.sections[0].authorName}</strong>.
              </p>
            </section>
            <section>
              <h2 className="text-xl font-bold text-slate-900 dark:text-white mb-2">{legal.editorial.sections[1].heading}</h2>
              <ul className="list-disc pl-5 space-y-2">
                {legal.editorial.sections[1].bullets?.map((bullet: string, idx: number) => (
                  <li key={idx}>{bullet}</li>
                ))}
              </ul>
            </section>
          </>
        )}

        {page === 'affiliate' && (
          <>
            <section>
              <h2 className="text-xl font-bold text-slate-900 dark:text-white mb-2">{legal.affiliate.sections[0].heading}</h2>
              <p>
                {legal.affiliate.sections[0].paragraphs[0]}
              </p>
            </section>
            <section>
              <h2 className="text-xl font-bold text-slate-900 dark:text-white mb-2">{legal.affiliate.sections[1].heading}</h2>
              <p>
                {legal.affiliate.sections[1].paragraphs[0]}
              </p>
            </section>
          </>
        )}
      </div>
    </div>
  );
};
