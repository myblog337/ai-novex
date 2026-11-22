import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const realTools = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, 'content', 'tools.json'), 'utf8')
);
const realCategories = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, 'content', 'categories.json'), 'utf8')
);
const realArticles = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, 'content', 'articles.json'), 'utf8')
);

function decodeEntities(val) {
  return String(val ?? '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;|&apos;/g, "'");
}

function parseAttributes(attrStr) {
  const attrs = {};
  const attrRe = /([a-zA-Z0-9_:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  let m;
  while ((m = attrRe.exec(attrStr)) !== null) {
    const name = m[1].toLowerCase();
    const rawVal = m[2] ?? m[3] ?? m[4] ?? '';
    attrs[name] = decodeEntities(rawVal);
  }
  return attrs;
}

const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

/**
 * Parses HTML markup into a lightweight element tree to verify:
 * - No nested interactive elements (<a> inside <a>, <a> inside <button>/[role=button], <button> inside <a>)
 * - Exact <article> card isolation and link/button attributes
 */
function parseHtmlTree(html) {
  const root = { tag: 'root', attrs: {}, children: [], text: '' };
  const stack = [root];
  const tokenRe = /<(\/?)([a-zA-Z0-9-]+)([^>]*)>|([^<]+)/g;
  let m;
  while ((m = tokenRe.exec(html)) !== null) {
    if (m[4]) {
      stack[stack.length - 1].children.push({ type: 'text', text: decodeEntities(m[4]) });
      continue;
    }
    const isClose = m[1] === '/';
    const tag = m[2].toLowerCase();
    const attrStr = m[3] || '';
    const selfClosing = VOID_TAGS.has(tag) || attrStr.trim().endsWith('/');

    if (isClose) {
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].tag === tag) {
          stack.length = i;
          break;
        }
      }
    } else {
      const node = { tag, attrs: parseAttributes(attrStr), children: [] };
      stack[stack.length - 1].children.push(node);
      if (!selfClosing) {
        stack.push(node);
      }
    }
  }
  return root;
}

function getNodeText(node) {
  if (!node) return '';
  if (node.type === 'text') return node.text;
  return (node.children || []).map(getNodeText).join('');
}

function findAllNodes(node, predicate, results = []) {
  if (!node || node.type === 'text') return results;
  if (predicate(node)) results.push(node);
  for (const child of node.children || []) {
    findAllNodes(child, predicate, results);
  }
  return results;
}

function assertNoNestedInteractiveElements(html, contextLabel) {
  const tree = parseHtmlTree(html);
  const interactivePredicate = (n) =>
    n.tag === 'a' || n.tag === 'button' || n.attrs.role === 'button';

  const interactiveNodes = findAllNodes(tree, interactivePredicate);
  for (const node of interactiveNodes) {
    const nested = findAllNodes(
      { tag: 'wrapper', attrs: {}, children: node.children },
      interactivePredicate
    );
    assert.equal(
      nested.length,
      0,
      `${contextLabel}: Found nested interactive element <${nested[0]?.tag}> inside <${node.tag}${
        node.attrs.role ? ` role="${node.attrs.role}"` : ''
      }>`
    );
  }

  const cardArticles = findAllNodes(tree, (n) => n.tag === 'article');
  for (const card of cardArticles) {
    assert.notEqual(
      card.attrs.role,
      'button',
      `${contextLabel}: Tool card <article> must not have role="button"`
    );
    assert.equal(
      card.attrs.tabindex,
      undefined,
      `${contextLabel}: Non-interactive card <article> must not carry tabIndex`
    );
  }
}

function collectReactElements(node, predicate, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const item of node) collectReactElements(item, predicate, out);
    return out;
  }
  if (predicate(node)) out.push(node);
  if (node.props && node.props.children) {
    collectReactElements(node.props.children, predicate, out);
  }
  return out;
}

function renderWithStatelessHookShim(fn) {
  const internals =
    React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE ||
    React.__SECRET_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  const prevH = internals?.H;
  if (internals) {
    internals.H = {
      useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
      useMemo: (factory) => factory(),
      useCallback: (cb) => cb,
      useEffect: () => {},
      useRef: (init) => ({ current: init }),
      useContext: () => ({}),
    };
  }
  try {
    return fn();
  } finally {
    if (internals) {
      internals.H = prevH;
    }
  }
}

async function createViteSsr() {
  return createServer({
    configFile: false,
    plugins: [react()],
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'silent',
    optimizeDeps: { noDiscovery: true },
  });
}

describe('Task 114-G1 — Tool Directory Card Navigation to Individual Tool Detail Pages', () => {
  it('1-3. Main Tools directory, Featured Tools, and Category pages link each published tool card to /tools/:slug/ with distinct slugs', async () => {
    const vite = await createViteSsr();
    try {
      const { ToolsView } = await vite.ssrLoadModule('/src/views/ToolsView.tsx');
      const { FeaturedTools } = await vite.ssrLoadModule('/src/components/FeaturedTools.tsx');
      const { HomeView } = await vite.ssrLoadModule('/src/views/HomeView.tsx');
      const { CategoryDetailView } = await vite.ssrLoadModule('/src/views/CategoryDetailView.tsx');

      // 1. Main Tools Directory
      const toolsHtml = renderToStaticMarkup(
        React.createElement(ToolsView, {
          tools: realTools,
          categories: realCategories,
          onNavigate: () => {},
          onSelectTool: () => {},
        })
      );
      assertNoNestedInteractiveElements(toolsHtml, 'ToolsView');
      const toolsTree = parseHtmlTree(toolsHtml);
      const toolsCards = findAllNodes(toolsTree, (n) => n.tag === 'article');
      assert.equal(toolsCards.length, realTools.length);

      for (const tool of realTools) {
        const expectedHref = `/tools/${tool.slug}/`;
        const matchingCard = toolsCards.find((card) =>
          findAllNodes(card, (n) => n.tag === 'h3' && getNodeText(n).trim() === tool.name).length > 0
        );
        assert.ok(matchingCard, `ToolsView missing card for ${tool.name}`);

        const detailLinks = findAllNodes(
          matchingCard,
          (n) => n.tag === 'a' && n.attrs.href === expectedHref
        );
        assert.ok(detailLinks.length >= 1, `ToolsView card for ${tool.name} missing link to ${expectedHref}`);

        const viewDetailsLink = detailLinks.find(
          (n) => n.attrs['aria-label'] === `View Details for ${tool.name}`
        );
        assert.ok(viewDetailsLink, `ToolsView card for ${tool.name} missing meaningful View Details aria-label`);

        // Ensure this card does NOT link to any OTHER tool's detail page
        const allToolDetailLinks = findAllNodes(
          matchingCard,
          (n) => n.tag === 'a' && typeof n.attrs.href === 'string' && n.attrs.href.startsWith('/tools/')
        );
        for (const link of allToolDetailLinks) {
          assert.equal(link.attrs.href, expectedHref, `Card for ${tool.name} leaked wrong tool href ${link.attrs.href}`);
        }
      }

      // 2. Featured Tools & HomeView
      const featuredSubset = realTools.filter((t) => t.isFeatured).slice(0, 5);
      const featuredHtml = renderToStaticMarkup(
        React.createElement(FeaturedTools, {
          tools: featuredSubset,
          onViewAll: () => {},
          onSelectTool: () => {},
          onNavigate: () => {},
        })
      );
      assertNoNestedInteractiveElements(featuredHtml, 'FeaturedTools');
      const featuredTree = parseHtmlTree(featuredHtml);
      const featuredCards = findAllNodes(featuredTree, (n) => n.tag === 'article');
      assert.equal(featuredCards.length, featuredSubset.length);

      for (const tool of featuredSubset) {
        const expectedHref = `/tools/${tool.slug}/`;
        const matchingCard = featuredCards.find((card) =>
          findAllNodes(card, (n) => n.tag === 'h3' && getNodeText(n).trim() === tool.name).length > 0
        );
        assert.ok(matchingCard, `FeaturedTools missing card for ${tool.name}`);
        const detailLinks = findAllNodes(
          matchingCard,
          (n) => n.tag === 'a' && n.attrs.href === expectedHref
        );
        assert.ok(detailLinks.length >= 1, `FeaturedTools card for ${tool.name} missing link to ${expectedHref}`);
      }

      const homeHtml = renderToStaticMarkup(
        React.createElement(HomeView, {
          categories: realCategories,
          tools: realTools,
          articles: realArticles,
          onNavigate: () => {},
          onSelectTool: () => {},
        })
      );
      assertNoNestedInteractiveElements(homeHtml, 'HomeView');
      for (const tool of featuredSubset) {
        assert.match(homeHtml, new RegExp(`href="/tools/${tool.slug}/"`));
      }

      // 3. Category Detail Page (ai-writing contains ChatGPT and Claude)
      const catHtml = renderToStaticMarkup(
        React.createElement(CategoryDetailView, {
          slug: 'ai-writing',
          categories: realCategories,
          tools: realTools,
          articles: realArticles,
          onNavigate: () => {},
          onSelectTool: () => {},
          onSelectArticle: () => {},
        })
      );
      assertNoNestedInteractiveElements(catHtml, 'CategoryDetailView');
      const catTree = parseHtmlTree(catHtml);
      const catCards = findAllNodes(catTree, (n) => n.tag === 'article');
      const writingTools = realTools.filter((t) => t.category === 'ai-writing');
      assert.equal(catCards.length, writingTools.length);

      for (const tool of writingTools) {
        const expectedHref = `/tools/${tool.slug}/`;
        const matchingCard = catCards.find((card) =>
          findAllNodes(card, (n) => n.tag === 'h3' && getNodeText(n).trim() === tool.name).length > 0
        );
        assert.ok(matchingCard, `CategoryDetailView missing card for ${tool.name}`);
        const detailLinks = findAllNodes(
          matchingCard,
          (n) => n.tag === 'a' && n.attrs.href === expectedHref
        );
        assert.ok(detailLinks.length >= 1, `CategoryDetailView card for ${tool.name} missing link to ${expectedHref}`);
      }
    } finally {
      await vite.close();
    }
  });

  it('4-6. Preserves ToolModal Quick View interactions, detail navigation handlers, and external Visit Tool links with security attributes', async () => {
    const vite = await createViteSsr();
    try {
      const { ToolsView } = await vite.ssrLoadModule('/src/views/ToolsView.tsx');
      const { FeaturedTools } = await vite.ssrLoadModule('/src/components/FeaturedTools.tsx');
      const { CategoryDetailView } = await vite.ssrLoadModule('/src/views/CategoryDetailView.tsx');
      const { ToolModal } = await vite.ssrLoadModule('/src/components/ToolModal.tsx');

      const twoTools = [realTools[0], realTools[1]]; // ChatGPT & Midjourney

      // Test FeaturedTools handlers
      const featuredNavCalls = [];
      const featuredModalCalls = [];
      const featuredEl = FeaturedTools({
        tools: twoTools,
        onViewAll: () => {},
        onSelectTool: (tool) => featuredModalCalls.push(tool),
        onNavigate: (p) => featuredNavCalls.push(p),
      });

      const featuredDetailAnchors = collectReactElements(
        featuredEl,
        (el) => el.type === 'a' && typeof el.props?.href === 'string' && el.props.href.startsWith('/tools/') && el.props.href !== '/tools/'
      );
      assert.equal(featuredDetailAnchors.length, 4); // Title link + View Details link per card
      for (const anchor of featuredDetailAnchors) {
        let prevented = false;
        anchor.props.onClick({ preventDefault: () => { prevented = true; } });
        assert.equal(prevented, true);
      }
      assert.deepEqual(featuredNavCalls, [
        '/tools/chatgpt/',
        '/tools/chatgpt/',
        '/tools/midjourney/',
        '/tools/midjourney/',
      ]);

      const featuredQuickViewBtns = collectReactElements(
        featuredEl,
        (el) => el.type === 'button' && String(el.props?.['aria-label'] || '').startsWith('Quick View ')
      );
      assert.equal(featuredQuickViewBtns.length, 2);
      featuredQuickViewBtns.forEach((btn) => btn.props.onClick());
      assert.deepEqual(featuredModalCalls.map((t) => t.slug), ['chatgpt', 'midjourney']);

      // Test CategoryDetailView handlers
      const catNavCalls = [];
      const catModalCalls = [];
      const catEl = CategoryDetailView({
        slug: 'ai-writing',
        categories: realCategories,
        tools: realTools,
        articles: realArticles,
        onNavigate: (p) => catNavCalls.push(p),
        onSelectTool: (tool) => catModalCalls.push(tool),
        onSelectArticle: () => {},
      });
      const catDetailAnchors = collectReactElements(
        catEl,
        (el) => el.type === 'a' && typeof el.props?.href === 'string' && el.props.href.startsWith('/tools/')
      );
      for (const anchor of catDetailAnchors) {
        let prevented = false;
        anchor.props.onClick({ preventDefault: () => { prevented = true; } });
        assert.equal(prevented, true);
      }
      assert.deepEqual(catNavCalls, [
        '/tools/chatgpt/',
        '/tools/chatgpt/',
        '/tools/claude/',
        '/tools/claude/',
      ]);
      const catQuickViewBtns = collectReactElements(
        catEl,
        (el) => el.type === 'button' && String(el.props?.['aria-label'] || '').startsWith('Quick View ')
      );
      assert.equal(catQuickViewBtns.length, 2);
      catQuickViewBtns.forEach((btn) => btn.props.onClick());
      assert.deepEqual(catModalCalls.map((t) => t.slug), ['chatgpt', 'claude']);

      // Test ToolsView handlers via stateless hook shim
      const dirNavCalls = [];
      const dirModalCalls = [];
      const dirEl = renderWithStatelessHookShim(() =>
        ToolsView({
          tools: twoTools,
          categories: realCategories,
          onNavigate: (p) => dirNavCalls.push(p),
          onSelectTool: (tool) => dirModalCalls.push(tool),
        })
      );
      const dirDetailAnchors = collectReactElements(
        dirEl,
        (el) => el.type === 'a' && typeof el.props?.href === 'string' && el.props.href.startsWith('/tools/')
      );
      for (const anchor of dirDetailAnchors) {
        let prevented = false;
        anchor.props.onClick({ preventDefault: () => { prevented = true; } });
        assert.equal(prevented, true);
      }
      assert.deepEqual(dirNavCalls, [
        '/tools/chatgpt/',
        '/tools/chatgpt/',
        '/tools/midjourney/',
        '/tools/midjourney/',
      ]);
      const dirQuickViewBtns = collectReactElements(
        dirEl,
        (el) => el.type === 'button' && String(el.props?.['aria-label'] || '').startsWith('Quick View ')
      );
      assert.equal(dirQuickViewBtns.length, 2);
      dirQuickViewBtns.forEach((btn) => btn.props.onClick());
      assert.deepEqual(dirModalCalls.map((t) => t.slug), ['chatgpt', 'midjourney']);

      // Verify ToolModal renders properly when opened with the selected tool
      const modalHtml = renderToStaticMarkup(
        React.createElement(ToolModal, {
          tool: dirModalCalls[0],
          onClose: () => {},
        })
      );
      assert.match(modalHtml, /role="dialog"/);
      assert.match(modalHtml, /ChatGPT/);
      assert.match(modalHtml, /Visit Official Website/);

      // Verify external Visit Tool links retain target="_blank" and rel="nofollow noopener noreferrer"
      const dirHtml = renderToStaticMarkup(
        React.createElement(ToolsView, {
          tools: realTools,
          categories: realCategories,
          onNavigate: () => {},
          onSelectTool: () => {},
        })
      );
      const dirTree = parseHtmlTree(dirHtml);
      for (const tool of realTools) {
        const extLinks = findAllNodes(
          dirTree,
          (n) => n.tag === 'a' && n.attrs.href === tool.url
        );
        assert.equal(extLinks.length, 1, `Expected 1 external link for ${tool.name}`);
        assert.equal(extLinks[0].attrs.target, '_blank');
        assert.equal(extLinks[0].attrs.rel, 'nofollow noopener noreferrer');
      }
    } finally {
      await vite.close();
    }
  });

  it('7-9. Never exposes or links unpublished/invalid tools, rejects unsafe external URLs, preserves keyboard accessibility, and keeps App.tsx routing intact', async () => {
    const vite = await createViteSsr();
    const origWindow = globalThis.window;
    try {
      const { ToolsView } = await vite.ssrLoadModule('/src/views/ToolsView.tsx');
      const { FeaturedTools } = await vite.ssrLoadModule('/src/components/FeaturedTools.tsx');
      const { CategoryDetailView } = await vite.ssrLoadModule('/src/views/CategoryDetailView.tsx');

      const mixedTools = [
        realTools[0], // valid published ChatGPT
        {
          ...realTools[0],
          id: 'draft-tool',
          name: 'Hidden Draft Tool',
          slug: 'hidden-draft-tool',
          isPublished: false,
          isFeatured: true,
        },
        {
          ...realTools[0],
          id: 'traversal-tool',
          name: 'Traversal Evil Tool',
          slug: '../etc/passwd',
          isFeatured: true,
        },
        {
          ...realTools[0],
          id: 'underscore-tool',
          name: 'Bad Slug Tool',
          slug: 'bad_slug_here',
          isFeatured: true,
        },
        {
          ...realTools[0],
          id: 'short-slug-tool',
          name: 'Short Slug Tool',
          slug: 'a',
          isFeatured: true,
        },
        {
          ...realTools[0],
          id: 'unsafe-url-tool',
          name: 'Unsafe Url Tool',
          slug: 'unsafe-url-tool',
          url: 'javascript:alert(1)',
          icon: 'javascript:alert(2)',
          isFeatured: true,
        },
      ];

      const viewsToCheck = [
        {
          label: 'ToolsView',
          html: renderToStaticMarkup(
            React.createElement(ToolsView, {
              tools: mixedTools,
              categories: realCategories,
              onNavigate: () => {},
              onSelectTool: () => {},
            })
          ),
        },
        {
          label: 'FeaturedTools',
          html: renderToStaticMarkup(
            React.createElement(FeaturedTools, {
              tools: mixedTools,
              onViewAll: () => {},
              onSelectTool: () => {},
              onNavigate: () => {},
            })
          ),
        },
        {
          label: 'CategoryDetailView',
          html: renderToStaticMarkup(
            React.createElement(CategoryDetailView, {
              slug: 'ai-writing',
              categories: realCategories,
              tools: mixedTools,
              articles: realArticles,
              onNavigate: () => {},
              onSelectTool: () => {},
              onSelectArticle: () => {},
            })
          ),
        },
      ];

      for (const { label, html } of viewsToCheck) {
        assertNoNestedInteractiveElements(html, label);

        // Unpublished tool must not be exposed or linked
        assert.doesNotMatch(html, /Hidden Draft Tool/, `${label} exposed unpublished tool`);
        assert.doesNotMatch(html, /hidden-draft-tool/, `${label} linked unpublished tool`);

        // Invalid slugs must NEVER be linked
        assert.doesNotMatch(html, /href="\/tools\/[^"]*etc\/passwd/, `${label} linked traversal slug`);
        assert.doesNotMatch(html, /href="\/tools\/bad_slug_here/, `${label} linked invalid underscore slug`);
        assert.doesNotMatch(html, /href="\/tools\/a\/"/, `${label} linked single-char invalid slug`);

        // Unsafe URLs must not be emitted
        assert.doesNotMatch(html, /javascript:/i, `${label} emitted unsafe javascript: URL`);

        // Valid published tool IS linked
        assert.match(html, /href="\/tools\/chatgpt\/"/, `${label} missing valid ChatGPT link`);
        assert.match(html, /href="\/tools\/unsafe-url-tool\/"/, `${label} missing valid slug link`);

        // Keyboard accessibility: native <a> and <button type="button"> only, no negative tabIndex
        const tree = parseHtmlTree(html);
        const detailLinks = findAllNodes(
          tree,
          (n) => n.tag === 'a' && n.attrs.href === '/tools/chatgpt/'
        );
        assert.ok(detailLinks.length >= 2, `${label}: expected heading + View Details links for ChatGPT`);
        for (const link of detailLinks) {
          assert.notEqual(link.attrs.tabindex, '-1', `${label}: detail link must remain keyboard focusable`);
        }
        const quickViewBtns = findAllNodes(
          tree,
          (n) => n.tag === 'button' && n.attrs['aria-label'] === 'Quick View ChatGPT'
        );
        assert.equal(quickViewBtns.length, 1, `${label}: expected 1 Quick View button for ChatGPT`);
        assert.equal(quickViewBtns[0].attrs.type, 'button');
      }

      // Verify full App.tsx SSR renders detail links on /, /tools/, and /category/ai-writing/
      globalThis.window = {
        location: { pathname: '/', search: '' },
        matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
        addEventListener() {},
        removeEventListener() {},
        history: { pushState() {} },
        scrollTo() {},
      };
      const { default: App } = await vite.ssrLoadModule('/src/App.tsx');

      for (const route of ['/', '/tools/', '/category/ai-writing/']) {
        globalThis.window.location.pathname = route;
        const appHtml = renderToStaticMarkup(React.createElement(App));
        assertNoNestedInteractiveElements(appHtml, `App(${route})`);
        assert.match(appHtml, /href="\/tools\/chatgpt\/"/, `App(${route}) missing /tools/chatgpt/ link`);
      }
    } finally {
      if (origWindow === undefined) {
        delete globalThis.window;
      } else {
        globalThis.window = origWindow;
      }
      await vite.close();
    }
  });
});
