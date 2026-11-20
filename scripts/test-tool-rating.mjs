import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { renderToolDirectoryCard } from './postbuild.mjs';

const baseCategories = [
  {
    id: 'ai-writing',
    name: 'AI Writing',
    slug: 'ai-writing',
    description: 'AI writing tools',
    icon: 'PenTool',
  },
];

function makeTool(overrides = {}) {
  return {
    id: 'test-tool',
    name: 'Test Tool',
    slug: 'test-tool',
    url: 'https://example.com/tool',
    description: 'Tool description',
    category: 'ai-writing',
    categoryName: 'AI Writing',
    tags: ['Writing'],
    pricing: 'Free',
    isFeatured: false,
    icon: '/images/chatgpt.svg',
    ...overrides,
  };
}

test('scripts/postbuild.mjs renderToolDirectoryCard handles 0, undefined, null, and positive ratings', () => {
  const zeroHtml = renderToolDirectoryCard(makeTool({ name: 'Zero Tool', rating: 0 }));
  assert.match(zeroHtml, /&#9733;\s*0\s*&bull;\s*Free/);
  assert.doesNotMatch(zeroHtml, /&#9733;\s*4\.8\s*&bull;/);

  const undefinedHtml = renderToolDirectoryCard(makeTool({ name: 'Missing Rating Tool', rating: undefined }));
  assert.match(undefinedHtml, /&#9733;\s*4\.8\s*&bull;\s*Free/);

  const nullHtml = renderToolDirectoryCard(makeTool({ name: 'Null Rating Tool', rating: null }));
  assert.match(nullHtml, /&#9733;\s*4\.8\s*&bull;\s*Free/);

  const positiveHtml = renderToolDirectoryCard(makeTool({ name: 'Positive Tool', rating: 4.3 }));
  assert.match(positiveHtml, /&#9733;\s*4\.3\s*&bull;\s*Free/);
  assert.doesNotMatch(positiveHtml, /&#9733;\s*4\.8\s*&bull;/);

  const fiveHtml = renderToolDirectoryCard(makeTool({ name: 'Five Tool', rating: 5 }));
  assert.match(fiveHtml, /&#9733;\s*5\s*&bull;\s*Free/);
});

test('src/views/ToolsView.tsx displays 0, undefined->4.8, null->4.8, and positive ratings accurately', async () => {
  const vite = await createServer({
    configFile: false,
    plugins: [react()],
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'silent',
    optimizeDeps: { noDiscovery: true },
  });

  try {
    const { ToolsView } = await vite.ssrLoadModule('/src/views/ToolsView.tsx');

    const renderSingleTool = (tool) =>
      renderToStaticMarkup(
        React.createElement(ToolsView, {
          tools: [tool],
          categories: baseCategories,
          onNavigate: () => {},
          onSelectTool: () => {},
        })
      );

    const zeroMarkup = renderSingleTool(makeTool({ id: 'z', slug: 'z', name: 'Zero Tool', rating: 0 }));
    assert.match(zeroMarkup, /<span>0<\/span>/);
    assert.doesNotMatch(zeroMarkup, /<span>4\.8<\/span>/);

    const undefinedMarkup = renderSingleTool(
      makeTool({ id: 'u', slug: 'u', name: 'Undefined Tool', rating: undefined })
    );
    assert.match(undefinedMarkup, /<span>4\.8<\/span>/);

    const nullMarkup = renderSingleTool(
      makeTool({ id: 'n', slug: 'n', name: 'Null Tool', rating: null })
    );
    assert.match(nullMarkup, /<span>4\.8<\/span>/);

    const positiveMarkup = renderSingleTool(
      makeTool({ id: 'p', slug: 'p', name: 'Positive Tool', rating: 4.3 })
    );
    assert.match(positiveMarkup, /<span>4\.3<\/span>/);
    assert.doesNotMatch(positiveMarkup, /<span>4\.8<\/span>/);
  } finally {
    await vite.close();
  }
});
