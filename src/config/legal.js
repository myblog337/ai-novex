/**
 * Centralized Single Source of Truth for Legal, Privacy, Terms, and Editorial Policies.
 * Imported by both the client (src/views/LegalView.tsx) and pre-renderer (scripts/postbuild.mjs).
 */

export const LEGAL_UPDATED = '2026-11-05';

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/**
 * Formats an ISO date string (YYYY-MM-DD) into "Month D, YYYY" deterministically
 * without timezone drift from new Date().
 */
export function formatLegalDate(isoDate = LEGAL_UPDATED) {
  const parts = String(isoDate || '').split('-');
  if (parts.length !== 3) return String(isoDate || '');
  const year = parts[0];
  const monthIdx = parseInt(parts[1], 10) - 1;
  const day = parseInt(parts[2], 10);
  if (monthIdx < 0 || monthIdx > 11 || Number.isNaN(day)) {
    return String(isoDate || '');
  }
  return `${MONTH_NAMES[monthIdx]} ${day}, ${year}`;
}

export const LEGAL_TITLES = {
  privacy: 'Privacy Policy',
  terms: 'Terms of Service',
  editorial: 'Editorial Policy',
  affiliate: 'Affiliate & Monetization Disclosure',
};

export const LEGAL_BREADCRUMBS = {
  privacy: 'Privacy Policy',
  terms: 'Terms of Service',
  editorial: 'Editorial Policy',
  affiliate: 'Affiliate Disclosure',
};

/**
 * Generates structured content for legal routes.
 * In strict mode (postbuild), missing siteUrl or contactEmail throws an Error.
 * In non-strict mode (React client), missing values log an error and degrade gracefully.
 *
 * @param {{ siteUrl?: string, contactEmail?: string, strict?: boolean }} [options]
 */
export function getLegalContent({ siteUrl = '', contactEmail = '', strict = false } = {}) {
  const hasSiteUrl = Boolean(siteUrl && typeof siteUrl === 'string' && siteUrl.trim());
  const hasEmail = Boolean(contactEmail && typeof contactEmail === 'string' && contactEmail.trim());

  if (strict) {
    if (!hasSiteUrl) {
      throw new Error('[getLegalContent] "siteUrl" is required and cannot be empty in build mode.');
    }
    if (!hasEmail) {
      throw new Error('[getLegalContent] "contactEmail" is required and cannot be empty in build mode.');
    }
  }

  const cleanSiteUrl = hasSiteUrl ? siteUrl.replace(/\/+$/, '') : '';
  const cleanEmail = hasEmail ? contactEmail.trim() : '';

  return {
    privacy: {
      sections: [
        {
          id: 'introduction',
          heading: '1. Introduction',
          siteUrl: cleanSiteUrl,
          textBeforeUrl: 'At AINOVEX (accessible from ',
          textAfterUrl: '), the privacy of our visitors is of paramount importance. This Privacy Policy document outlines the types of information collected and how it is used.',
          paragraphs: [
            `At AINOVEX (accessible from ${cleanSiteUrl || 'our website'}), the privacy of our visitors is of paramount importance. This Privacy Policy document outlines the types of information collected and how it is used.`,
          ],
        },
        {
          id: 'log-files',
          heading: '2. Log Files',
          paragraphs: [
            'AINOVEX follows a standard procedure of utilizing log files. These files log visitors when they access websites. The information collected includes internet protocol (IP) addresses, browser type, Internet Service Provider (ISP), date and time stamp, referring/exit pages, and number of clicks.',
          ],
        },
        {
          id: 'cookies',
          heading: '3. Cookies & Local Storage',
          paragraphs: [
            'AINOVEX uses local storage to save your user interface preferences (such as light or dark theme choices). We do not use intrusive third-party cross-site behavioral tracking cookies.',
          ],
        },
        {
          id: 'contact',
          heading: '4. Contact Information',
          email: cleanEmail,
          hasEmail: Boolean(cleanEmail),
          textBeforeEmail: 'If you have questions about our privacy practices, contact us via email at ',
          paragraphs: [
            cleanEmail
              ? `If you have questions about our privacy practices, contact us via email at ${cleanEmail}.`
              : 'If you have questions about our privacy practices, please contact our editorial team.',
          ],
        },
      ],
    },

    terms: {
      sections: [
        {
          id: 'acceptance',
          heading: '1. Terms Acceptance',
          paragraphs: [
            'By accessing this website, you agree to be bound by these Terms and Conditions of Use and agree that you are responsible for compliance with any applicable local laws.',
          ],
        },
        {
          id: 'informational',
          heading: '2. Informational Purpose',
          paragraphs: [
            'All content, comparisons, prompt examples, and software directories provided on AINOVEX are for informational and educational purposes only. While we research the tools we review, external artificial intelligence software changes rapidly and without notice.',
          ],
        },
        {
          id: 'ip',
          heading: '3. Intellectual Property',
          paragraphs: [
            'The materials contained in this website are protected by applicable copyright and trademark law. Brand logos and trademarks of external AI tools (such as ChatGPT, Midjourney, Canva) belong to their respective corporate owners.',
          ],
        },
      ],
    },

    editorial: {
      sections: [
        {
          id: 'standards',
          heading: 'Our Editorial Standards',
          authorName: 'Md Shamim',
          textBeforeAuthor: 'At AINOVEX, our mission is to publish accurate, trustworthy, and actionable artificial intelligence guides. Every tutorial, comparison, and tool listing is authored or vetted by lead editor ',
          paragraphs: [
            'At AINOVEX, our mission is to publish accurate, trustworthy, and actionable artificial intelligence guides. Every tutorial, comparison, and tool listing is authored or vetted by lead editor Md Shamim.',
          ],
        },
        {
          id: 'methodology',
          heading: 'Testing Methodology',
          bullets: [
            'Where we have tested a tool hands-on we say so. Otherwise, our reviews are based on official vendor documentation, and each article states its methodology.',
            'We independently verify pricing models (Free vs. Freemium vs. Paid) to prevent deceptive advertising.',
            'We highlight potential limitations, hallucination risks, and data privacy policies.',
          ],
        },
      ],
    },

    affiliate: {
      sections: [
        {
          id: 'transparency',
          heading: 'Affiliate & Advertising Transparency',
          paragraphs: [
            'We aim to be transparent about any monetization on AINOVEX.',
          ],
        },
        {
          id: 'status',
          heading: 'Current Monetization Status',
          paragraphs: [
            'Google AdSense is currently not active, and affiliate tracking links are not currently active on the site. If in the future we include affiliate links for software we recommend, we will explicitly disclose it at the top of that specific guide. Our editorial reviews remain completely independent.',
          ],
        },
      ],
    },
  };
}
