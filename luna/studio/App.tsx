// Luna Studio — the browser IDE shell.
//
// Design goals (see project brief):
// - The page must load even if the compiler is broken: all compile calls go
//   through bridge.ts which converts every throw into a visible error.
// - No fake results: the preview iframe only ever shows output that the real
//   codegen produced; failures are shown as diagnostics.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { runLuna, formatDiagnostics, type RunResult } from './bridge';
import { EXAMPLES, DEFAULT_SOURCE } from './examples';
import './styles.css';

type PanelTab = 'console' | 'preview';

interface ConsoleLine {
  kind: 'info' | 'error' | 'success';
  text: string;
}

export function App(): React.ReactElement {
  const [source, setSource] = useState<string>(DEFAULT_SOURCE);
  const [activeExample, setActiveExample] = useState<string>(EXAMPLES[0].id);
  const [result, setResult] = useState<RunResult | null>(null);
  const [running, setRunning] = useState(false);
  const [tab, setTab] = useState<PanelTab>('console');
  const [editorReady, setEditorReady] = useState(false);
  const editorRef = useRef<HTMLTextAreaElement | null>(null);
  const lineNoRef = useRef<HTMLDivElement | null>(null);

  // ---- Editor (textarea + highlighted overlay) ------------------------------
  // A lightweight CodeMirror-style setup without extra dependencies:
  // a <pre> highlight layer painted underneath a transparent textarea.
  const highlight = useMemo(() => highlightLuna(source), [source]);

  const syncScroll = useCallback(() => {
    const ta = editorRef.current;
    const gutter = lineNoRef.current;
    if (!ta || !gutter) return;
    const pre = gutter.parentElement?.querySelector('.luna-highlight') as HTMLElement | null;
    if (pre) {
      pre.scrollTop = ta.scrollTop;
      pre.scrollLeft = ta.scrollLeft;
    }
    gutter.scrollTop = ta.scrollTop;
  }, []);

  useEffect(() => {
    // Defer "ready" so any first-paint issue still leaves the app usable.
    setEditorReady(true);
  }, []);

  const lineCount = useMemo(() => source.split('\n').length, [source]);

  // ---- Actions ---------------------------------------------------------------
  const doRun = useCallback(() => {
    setRunning(true);
    // Yield to the browser so the button visibly enters the busy state even
    // on synchronous compiles.
    setTimeout(() => {
      let res: RunResult;
      try {
        res = runLuna(source);
      } catch (err) {
        // Belt & braces: runLuna already catches, but never let UI die.
        res = {
          ok: false,
          html: '',
          diagnostics: [],
          fatal: `Unexpected Studio error:\n${err instanceof Error ? err.message : String(err)}`,
          elapsedMs: 0,
        };
      }
      setResult(res);
      setTab(res.ok ? 'preview' : 'console');
      setRunning(false);
    }, 30);
  }, [source]);

  const loadExample = useCallback((id: string) => {
    const ex = EXAMPLES.find((e) => e.id === id);
    if (!ex) return;
    setActiveExample(id);
    setSource(ex.source);
    setResult(null);
  }, []);

  const resetExample = useCallback(() => {
    loadExample(activeExample);
  }, [activeExample, loadExample]);

  const newDraft = useCallback(() => {
    setActiveExample('');
    setSource(DEFAULT_SOURCE);
    setResult(null);
  }, []);

  // Keyboard: Ctrl/Cmd+Enter runs.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        doRun();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [doRun]);

  // ---- Console lines ---------------------------------------------------------
  const consoleLines: ConsoleLine[] = useMemo(() => {
    if (!result) return [];
    const lines: ConsoleLine[] = [];
    if (result.fatal) {
      lines.push({ kind: 'error', text: result.fatal });
    } else if (result.ok) {
      lines.push({ kind: 'success', text: `Compiled OK in ${result.elapsedMs.toFixed(1)} ms` });
      for (const d of result.diagnostics) {
        lines.push({ kind: d.severity === 'warning' ? 'info' : 'error', text: formatOne(d) });
      }
    } else {
      lines.push({ kind: 'error', text: `Compilation failed (${result.diagnostics.length} diagnostic${result.diagnostics.length === 1 ? '' : 's'}):` });
      lines.push({ kind: 'error', text: formatDiagnostics(result.diagnostics) });
    }
    return lines;
  }, [result]);

  return (
    <div className="studio">
      <header className="topbar">
        <div className="brand">
          <span className="moon" aria-hidden="true">☾</span>
          <h1>Luna Studio</h1>
          <span className="tag">browser IDE · real compiler</span>
        </div>
        <div className="actions">
          <label className="example-picker">
            <span>Example</span>
            <select value={activeExample} onChange={(e) => loadExample(e.target.value)}>
              {activeExample === '' && <option value="">(custom)</option>}
              {EXAMPLES.map((ex) => (
                <option key={ex.id} value={ex.id}>
                  {ex.name} — {ex.description}
                </option>
              ))}
            </select>
          </label>
          <button className="btn ghost" onClick={resetExample} title="Restore this example's original source">Reset</button>
          <button className="btn ghost" onClick={newDraft} title="Start from Hello">New</button>
          <button className="btn primary" onClick={doRun} disabled={running} title="Ctrl/⌘ + Enter">
            {running ? 'Compiling…' : '▶ Run'}
          </button>
        </div>
      </header>

      <main className="workspace">
        <section className="pane editor-pane" aria-label="Luna source editor">
          <div className="editor-wrap">
            <div className="gutter" ref={lineNoRef} aria-hidden="true">
              {Array.from({ length: lineCount }, (_, i) => (
                <div key={i} className="lineno">{i + 1}</div>
              ))}
            </div>
            <div className="editor-stack">
              <pre className="luna-highlight" aria-hidden="true"><code dangerouslySetInnerHTML={{ __html: highlight + '\n' }} /></pre>
              <textarea
                ref={editorRef}
                className="luna-input"
                value={source}
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                onChange={(e) => setSource(e.target.value)}
                onScroll={syncScroll}
                aria-label="Luna code editor"
              />
            </div>
          </div>
          {!editorReady && <div className="loading">Preparing editor…</div>}
        </section>

        <section className="pane output-pane" aria-label="Output panel">
          <div className="tabs" role="tablist">
            <button role="tab" aria-selected={tab === 'console'} className={tab === 'console' ? 'tab active' : 'tab'} onClick={() => setTab('console')}>
              Console
              {result && !result.ok && <span className="badge err">!</span>}
            </button>
            <button role="tab" aria-selected={tab === 'preview'} className={tab === 'preview' ? 'tab active' : 'tab'} onClick={() => setTab('preview')}>
              Preview
              {result?.ok && <span className="badge ok">✓</span>}
            </button>
          </div>

          {tab === 'console' && (
            <div className="console">
              {!result && (
                <p className="hint">
                  Press <kbd>▶ Run</kbd> (or Ctrl/⌘+Enter) to compile your program with the real Luna compiler.
                  Output and errors appear here — nothing is faked.
                </p>
              )}
              {consoleLines.map((l, i) => (
                <pre key={i} className={`line ${l.kind}`}>{l.text}</pre>
              ))}
            </div>
          )}

          {tab === 'preview' && (
            <div className="preview">
              {result?.ok ? (
                <iframe
                  className="preview-frame"
                  title="Luna program preview"
                  sandbox="allow-scripts allow-modals"
                  srcDoc={result.html}
                />
              ) : (
                <div className="preview-empty">
                  {result
                    ? 'Nothing to preview — the last compile did not succeed. Check the Console tab.'
                    : 'Nothing to preview yet. Write some Luna and press Run.'}
                </div>
              )}
            </div>
          )}
        </section>
      </main>

      <footer className="statusbar">
        <span>{lineCount} line{lineCount === 1 ? '' : 's'}</span>
        <span>{source.length} chars</span>
        <span className="spacer" />
        <span>
          {result
            ? result.ok
              ? `last run: OK (${result.elapsedMs.toFixed(1)} ms)`
              : result.fatal
                ? 'last run: compiler crash'
                : 'last run: errors'
            : 'not compiled yet'}
        </span>
      </footer>
    </div>
  );
}

function formatOne(d: { severity: string; message: string; line: number; column: number; hint?: string }): string {
  return `${d.severity}: line ${d.line}:${d.column} — ${d.message}${d.hint ? ` (hint: ${d.hint})` : ''}`;
}

// ---- Tiny Luna syntax highlighter --------------------------------------------
// Works on raw text; produces HTML with spans. Escapes everything except token
// classes it deliberately wraps. Deliberately simple and total: whatever the
// input, it returns *some* safe HTML, so the editor can never blank-screen.
const KEYWORDS = new Set([
  'page', 'state', 'fn', 'component', 'render', 'on', 'if', 'else', 'for', 'while',
  'return', 'true', 'false', 'null', 'in',
]);

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function highlightLuna(src: string): string {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i];
    // strings
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < n && src[j] !== ch) {
        if (src[j] === '\\') j++;
        j++;
      }
      j = Math.min(j + 1, n);
      out += `<span class="tok-str">${escHtml(src.slice(i, j))}</span>`;
      i = j;
      continue;
    }
    // line comments
    if (ch === '/' && src[i + 1] === '/') {
      let j = i;
      while (j < n && src[j] !== '\n') j++;
      out += `<span class="tok-com">${escHtml(src.slice(i, j))}</span>`;
      i = j;
      continue;
    }
    // markup tags like <button …>
    if (ch === '<' && /[a-zA-Z/]/.test(src[i + 1] || '')) {
      let j = i + 1;
      while (j < n && src[j] !== '>' && src[j] !== '\n') j++;
      out += `<span class="tok-tag">${escHtml(src.slice(i, Math.min(j + 1, n)))}</span>`;
      i = j + 1 <= n ? j + 1 : j;
      continue;
    }
    // numbers
    if (/[0-9]/.test(ch)) {
      let j = i;
      while (j < n && /[0-9._]/.test(src[j])) j++;
      out += `<span class="tok-num">${escHtml(src.slice(i, j))}</span>`;
      i = j;
      continue;
    }
    // identifiers / keywords
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_]/.test(src[j])) j++;
      const word = src.slice(i, j);
      const cls = KEYWORDS.has(word) ? 'tok-kw' : 'tok-id';
      out += `<span class="${cls}">${escHtml(word)}</span>`;
      i = j;
      continue;
    }
    out += escHtml(ch);
    i++;
  }
  return out;
}
