# AINOVEX

AI tools directory + blog. React 19 + Vite + Tailwind 4, **pre-rendered to static HTML** and hosted on Netlify.

- Production: https://ai-novex.netlify.app

## How it works

```
content/*.json + content/articles/*.md   (edit by hand, commit)
        │  git push origin main
        ▼
Netlify:  npm run build  =  vite build  →  node scripts/postbuild.mjs → node scripts/finalize-sitemap.mjs   (publish: dist/)
```

- `src/` – React app (client-side navigation). Content is bundled at build time; article markdown is
  loaded lazily with `import.meta.glob`. There is no server and no API.
- `scripts/postbuild.mjs` – writes real HTML for every route (title, meta, canonical, JSON-LD,
  content) plus `sitemap.xml`, `rss.xml`, `robots.txt`, `ads.txt` (only when AdSense is configured).
- `scripts/finalize-sitemap.mjs` – writes the final sitemap using the same indexability rules as page metadata.
- `src/utils/markdown.js` – the single markdown renderer used by both the browser and postbuild.
- `netlify.toml` – redirects, security/cache headers, 404 handling.

## Indexing policy

The rule lives in **one file**: `src/config/indexing.js`. It is imported by both the browser app
(`src/App.tsx`) and the build scripts, so pre-rendered HTML, client-side meta tags and `sitemap.xml` can never disagree.

- `index, follow` (and listed in `sitemap.xml`): home, `/blog/`, `/tools/`, `/categories/`, `/privacy/`,
  `/terms/`, `/affiliate-disclosure/`, every published article, and every category route.
- `noindex, follow` (and excluded from `sitemap.xml`): `/about/`, `/contact/`, `/author/md-shamim/`,
  `/editorial-policy/`, unknown URLs and 404.
- `rss.xml`, `llms.txt`, the sitemap and the IndexNow key file are sent with `X-Robots-Tag: noindex`.
- `robots.txt` deliberately does **not** disallow anything - crawlers must be able to fetch a page to see its `noindex`.

To change what is indexable, edit `INDEXABLE_STATIC_PATHS` / `isIndexable()` in `src/config/indexing.js` only.

## Adding content

1. Article: add `content/articles/<slug>.md`, add its entry to `content/articles.json`
   (`isPublished: true`), put images in `public/images/articles/` (`<slug>.webp`, `-600w`, `-900w`).
2. Category: add to `content/categories.json`. Tool: add to `content/tools.json` (`category` = category slug).
3. Contact e-mail is read from `content/settings.json` -> `contactEmail`.
4. Push to `main` (commit `package-lock.json` too, so Netlify builds are reproducible). Optional: `npm run build && npm run indexnow` after deploy to ping IndexNow.

## Scripts

`npm run dev` · `npm run build` · `npm run preview` · `npm run lint` · `npm run indexnow`
