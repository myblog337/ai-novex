import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import './index.css';

// The HTML is pre-rendered at build time (scripts/postbuild.mjs) for crawlers and first paint.
// That markup is generated separately from the React tree, so it is replaced by a fresh client
// render instead of being hydrated (hydrating non-identical markup throws hydration errors).
createRoot(document.getElementById('root')!).render(<App />);
