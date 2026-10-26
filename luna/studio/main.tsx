import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';

// Fatal-error guard: if anything below throws during initial render, show a
// plain error card instead of a blank white page.
try {
  const rootEl = document.getElementById('root');
  if (!rootEl) throw new Error('#root element missing');
  createRoot(rootEl).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
} catch (err) {
  const el = document.getElementById('root');
  if (el) {
    el.innerHTML =
      '<div style="font-family:system-ui;padding:2rem;color:#f87171;background:#0b0a12;min-height:100vh">' +
      '<h1>Luna Studio failed to start</h1><pre style="white-space:pre-wrap;color:#e6e6e6">' +
      String(err instanceof Error && err.stack ? err.stack : err) +
      '</pre></div>';
  }
}
