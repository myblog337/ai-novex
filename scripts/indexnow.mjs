// Submit every INDEXABLE url (articles + categories) to IndexNow (Bing, Yandex, ...).
// Run AFTER `npm run build` and after the Netlify deploy has finished:  npm run indexnow
// The URL list comes from dist/sitemap.xml, which only contains indexable pages.
import fs from 'node:fs';
import { isValidHttpOriginUrl } from './lib/validators.mjs';

const settings = JSON.parse(fs.readFileSync('content/settings.json', 'utf-8'));
if (
  !settings ||
  typeof settings !== 'object' ||
  Array.isArray(settings) ||
  typeof settings.productionUrl !== 'string' ||
  !settings.productionUrl.trim() ||
  !isValidHttpOriginUrl(settings.productionUrl)
) {
  console.error(
    '[indexnow] Invalid or missing productionUrl in content/settings.json: must be a valid HTTP or HTTPS origin URL without a path, query, or fragment (e.g., https://example.com)'
  );
  process.exit(1);
}

const productionUrl = settings.productionUrl.replace(/\/$/, '');
const expectedOrigin = new URL(productionUrl).origin;
const HOST = new URL(productionUrl).hostname;
const KEY = 'c49a629b37c0411eb31a896d8e20791d';

function validateSitemapUrl(rawValue, origin) {
  if (typeof rawValue !== 'string') {
    return null;
  }

  const trimmed = rawValue.trim();
  if (!trimmed) {
    return null;
  }

  if (/[\u0000-\u001F\u007F\s\p{White_Space}]/u.test(trimmed)) {
    return null;
  }
  if (trimmed.includes('\\')) {
    return null;
  }
  if (!/^https?:\/\/[^/]/i.test(trimmed)) {
    return null;
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(trimmed);
  } catch {
    return null;
  }

  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    return null;
  }

  if (parsedUrl.username !== '' || parsedUrl.password !== '') {
    return null;
  }

  const schemeSepIdx = trimmed.indexOf('://');
  const afterScheme = trimmed.slice(schemeSepIdx + 3);
  const authorityEndIdx = afterScheme.search(/[/?#]/);
  const rawAuthority =
    authorityEndIdx === -1 ? afterScheme : afterScheme.slice(0, authorityEndIdx);

  if (!rawAuthority || rawAuthority.includes('@')) {
    return null;
  }

  if (!parsedUrl.origin || parsedUrl.origin === 'null' || parsedUrl.origin !== origin) {
    return null;
  }

  return trimmed;
}

if (!fs.existsSync('dist/sitemap.xml')) {
  console.error('dist/sitemap.xml not found - run `npm run build` first.');
  process.exit(1);
}
const sitemap = fs.readFileSync('dist/sitemap.xml', 'utf-8');
const rawLocs = [...sitemap.matchAll(/<loc>([^<]*)<\/loc>/g)].map((m) => m[1]);

if (!rawLocs.length) {
  console.error('No URLs found in dist/sitemap.xml');
  process.exit(1);
}

const seenUrls = new Set();
const urlList = [];
for (const rawLoc of rawLocs) {
  const validatedUrl = validateSitemapUrl(rawLoc, expectedOrigin);
  if (validatedUrl === null) {
    console.error(
      '[indexnow] Invalid or cross-origin URL detected in dist/sitemap.xml; aborting submission.'
    );
    process.exit(1);
  }
  if (!seenUrls.has(validatedUrl)) {
    seenUrls.add(validatedUrl);
    urlList.push(validatedUrl);
  }
}

if (!urlList.length) {
  console.error('No URLs found in dist/sitemap.xml');
  process.exit(1);
}

const res = await fetch('https://api.indexnow.org/indexnow', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json; charset=utf-8' },
  body: JSON.stringify({
    host: HOST,
    key: KEY,
    keyLocation: `${productionUrl}/${KEY}.txt`,
    urlList,
  }),
});

console.log(`IndexNow responded ${res.status} for ${urlList.length} URLs`);
if (res.status !== 200 && res.status !== 202) {
  console.log(await res.text());
  process.exit(1);
}
