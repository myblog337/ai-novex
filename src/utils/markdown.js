// Single markdown pipeline shared by the browser bundle and scripts/postbuild.mjs,
// so the pre-rendered HTML and the client-rendered HTML are identical.
import { Marked } from 'marked';

const escapeHtml = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** Only allow web, mailto and in-site links/images. Blocks javascript:, data:, vbscript: etc. */
export function isSafeUrl(href) {
  if (!href) return false;
  const v = String(href).trim().replace(/[\u0000-\u001F\u007F\s]+/g, '');
  if (v.startsWith('#') || v.startsWith('/') || v.startsWith('./') || v.startsWith('../')) return true;
  return /^(https?:|mailto:)/i.test(v);
}

/** Plain text of an inline token tree (used to build heading ids). */
function plainText(tokens) {
  return (tokens || [])
    .map((t) => (t.tokens ? plainText(t.tokens) : t.text ?? t.raw ?? ''))
    .join('');
}

/** GitHub-style slug, so "[x](#some-heading)" links inside articles resolve. */
export function slugify(text) {
  return String(text)
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s+/g, '-');
}

function createMarked() {
  const used = new Map();
  return new Marked({
    gfm: true,
    breaks: false,
    renderer: {
      // Raw HTML typed into markdown is shown as text, never executed.
      html(token) {
        return escapeHtml(token.text ?? token.raw ?? '');
      },
      // marked v5+ no longer adds heading ids: add them (unique per document).
      // External links open in a new tab with rel="noopener noreferrer" (no window.opener leak).
      // They stay "follow": the guides cite official vendor documentation as sources.
      link({ href, title, tokens }) {
        const text = this.parser.parseInline(tokens);
        const external = /^https?:\/\//i.test(href || '');
        const t = title ? ` title="${escapeHtml(title)}"` : '';
        return `<a href="${escapeHtml(href)}"${t}${external ? ' target="_blank" rel="noopener noreferrer"' : ''}>${text}</a>`;
      },
      heading({ tokens, depth }) {
        const base = slugify(plainText(tokens)) || 'section';
        const n = used.get(base) ?? 0;
        used.set(base, n + 1);
        const id = n === 0 ? base : `${base}-${n}`;
        return `<h${depth} id="${id}">${this.parser.parseInline(tokens)}</h${depth}>\n`;
      },
    },
    walkTokens(token) {
      if (token.type === 'link' || token.type === 'image') {
        if (!isSafeUrl(token.href)) token.href = '#';
      }
    },
  });
}

/** Render markdown to HTML that is safe to put in dangerouslySetInnerHTML. */
export function renderMarkdown(source) {
  // Strip a top-level "# title": the page template holds the only <h1>.
  const clean = String(source || '').replace(/^#\s+[^\n]+\n+/, '');
  return createMarked().parse(clean, { async: false });
}
