// Single source of truth for author slug generation, normalization, profile metadata,
// and author collection across both the browser app and build scripts.

export const DEFAULT_EDITORIAL_TEAM_NAME = 'AINOVEX Editorial Team';

const MD_SHAMIM_SLUG = 'md-shamim';

/**
 * Normalize an author name into a URL-safe lowercase slug.
 * Returns '' for missing, non-string, whitespace-only, or non-alphanumeric values.
 */
export function getAuthorSlug(name) {
  if (typeof name !== 'string') return '';
  const trimmed = name.trim();
  if (!trimmed) return '';
  const normalized = trimmed
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!normalized || !/[a-z0-9]/.test(normalized)) return '';
  return normalized;
}

/**
 * Normalize whitespace in a valid author display name, or return '' if invalid.
 */
export function normalizeAuthorDisplayName(name) {
  if (!getAuthorSlug(name)) return '';
  return name.trim().replace(/\s+/g, ' ');
}

/**
 * Display name for summary cards when no author profile link is rendered.
 */
export function getAuthorDisplayName(name) {
  return normalizeAuthorDisplayName(name) || DEFAULT_EDITORIAL_TEAM_NAME;
}

/**
 * Compute 1-2 character uppercase initials from an author display name.
 */
export function getAuthorInitials(name) {
  if (typeof name !== 'string') return 'AE';
  const words = name
    .trim()
    .split(/\s+/)
    .map((w) => w.replace(/[^a-zA-Z0-9]/g, ''))
    .filter(Boolean);
  if (words.length === 0) return 'AE';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}

/**
 * Build profile metadata for a normalized slug and display name.
 * Preserves the existing Md Shamim profile metadata while supporting arbitrary authors.
 */
export function buildAuthorProfile(slug, displayName) {
  if (!slug || !displayName) return null;
  const isMdShamim = slug === MD_SHAMIM_SLUG;
  const name = isMdShamim ? 'Md Shamim' : displayName;
  const path = `/author/${slug}/`;

  if (isMdShamim) {
    return {
      slug,
      name,
      path,
      initials: 'MS',
      role: 'Lead researcher and editor at AINOVEX',
      cardBadge: 'Author & Lead Researcher',
      shortBio:
        'Lead researcher and editor at AINOVEX. Conducts research, software evaluations, and technical guides published across the platform.',
      bioLead:
        'Md Shamim is the lead researcher and editor at ',
      bioLeadSuffix:
        '. He conducts research, software evaluations, and technical guides published across the platform.',
      bioSecondary:
        'His editorial work focuses on analyzing publicly available software documentation, vendor specifications, and user documentation to produce clear, structured comparisons for readers.',
      standardsPrefix: 'Md Shamim adheres to the ',
      standardsSuffix:
        '. Articles are compiled through independent technical research and official vendor documentation review.',
      schemaDescription:
        'Lead researcher and editor at AINOVEX. Focuses on artificial intelligence software analysis, catalog automation benchmarks, and technical workflows.',
      seoTitle: 'Md Shamim - Lead Researcher & Editor | AINOVEX',
      seoDescription:
        'Read the editorial profile and guides by Md Shamim, lead researcher and editor at AINOVEX specializing in AI tools and catalog enrichment.',
    };
  }

  return {
    slug,
    name,
    path,
    initials: getAuthorInitials(name),
    role: 'Editorial contributor at AINOVEX',
    cardBadge: 'Author & Contributor',
    shortBio:
      'Editorial contributor at AINOVEX. Conducts research, software evaluations, and practical AI guides published across the platform.',
    bioLead: `${name} is an editorial contributor at `,
    bioLeadSuffix:
      '. They conduct research, software evaluations, and practical AI guides published across the platform.',
    bioSecondary:
      'Their editorial work focuses on analyzing publicly available software documentation, vendor specifications, and real-world workflows to produce clear, structured comparisons for readers.',
    standardsPrefix: `${name} adheres to the `,
    standardsSuffix:
      '. Articles are compiled through independent technical research and official vendor documentation review.',
    schemaDescription:
      'Editorial contributor at AINOVEX. Focuses on artificial intelligence software evaluations, practical workflows, and technical guides.',
    seoTitle: `${name} - Editorial Profile | AINOVEX`,
    seoDescription: `Read the editorial profile and published AI guides by ${name} on AINOVEX.`,
  };
}

/**
 * Resolve a single article's author profile from its author field.
 * Returns null if the author name is missing or invalid so callers never emit broken author links.
 */
export function getArticleAuthorProfile(authorName) {
  const slug = getAuthorSlug(authorName);
  if (!slug) return null;
  const displayName = normalizeAuthorDisplayName(authorName);
  return buildAuthorProfile(slug, displayName);
}

/**
 * Collect deduplicated, valid authors who have at least one published article.
 * Equivalent normalized slugs map to a single author entry.
 * Missing or invalid author values are excluded.
 */
export function collectAuthors(articles = []) {
  const bySlug = new Map();

  for (const article of articles || []) {
    if (!article || article.isPublished === false) continue;
    const slug = getAuthorSlug(article.author);
    if (!slug) continue;

    const displayName = normalizeAuthorDisplayName(article.author);
    let entry = bySlug.get(slug);
    if (!entry) {
      entry = {
        slug,
        displayName,
        articles: [],
      };
      bySlug.set(slug, entry);
    } else if (
      entry.displayName === entry.displayName.toLowerCase() &&
      displayName !== displayName.toLowerCase()
    ) {
      entry.displayName = displayName;
    }

    entry.articles.push(article);
  }

  const result = [];
  for (const entry of bySlug.values()) {
    if (entry.articles.length === 0) continue;
    const sortedArticles = [...entry.articles].sort((x, y) =>
      String(y.updatedAt || y.publishedAt || '').localeCompare(
        String(x.updatedAt || x.publishedAt || '')
      )
    );
    const profile = buildAuthorProfile(entry.slug, entry.displayName);
    result.push({
      ...profile,
      articles: sortedArticles,
    });
  }

  return result;
}

/**
 * Find a single author (with their sorted published articles) by normalized author slug.
 * Returns null if the slug is invalid or has no published articles.
 */
export function findAuthorBySlug(slug, articles = []) {
  if (typeof slug !== 'string' || !slug) return null;
  const authors = collectAuthors(articles);
  return authors.find((author) => author.slug === slug) || null;
}

/**
 * Whether an author slug corresponds to a valid author with at least one published article.
 */
export function authorHasContent(slug, articles = []) {
  return Boolean(findAuthorBySlug(slug, articles));
}
