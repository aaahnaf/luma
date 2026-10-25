# LUMA — Implementation Status

Working document. Updated after each phase. Statuses use PASS / FAIL / NOT VERIFIED with evidence.

## Recovered state (session 2, 2026-10-25)

- Branch: `qwen-code-40b661b0-d752-482d-a329-bcbe05f37077` (off `main` @ `f8819f2`). Nothing was committed by session 1.
- Staged working-tree changes from session 1 (preserved, not reverted):
  - `luna/src/language/lexer.ts`: brace/context rewrite (`interp` context, `renderBraceCount`, RBRACE vs DIRECTIVE_END rules). Token-level verified for simple render + interpolation cases.
  - `luna/tests/dump.test.ts`: scratch token-dump test (temporary; will be replaced by real lexer tests).

## Baseline test results (this session, before new fixes)

Command: `npx vitest run` in `/workspace/luna` (node_modules present, jsdom env configured).

Result: **Tests 9 failed | 7 passed (16)**. `npm test` is a placeholder (`echo "Error: no test specified" && exit 1`) — FAIL.

Failing tests and root causes reproduced:
1. `accepts state, fn, events and loops` — `8:27 Invalid attribute in tag "<on>"`. Cause: `scanTag`'s raw-brace capture for `<on>` headers is dead code because the attr-name scan loop consumes `{` as part of an "attribute name".
2. `renders static markup` — `1:8 Unterminated render block`. Cause: `isTagStart('<')` returns false when previous token ends an expression (`render` KEYWORD), so `render { <h1 ...` lexes `<h1>` as LT/GT comparisons outside any tag.
3. `interpolation/events` test — same `<on>` defect.
4. `components with props` — `Expected "," or ")" in parameter list`. Same `prevExprEnd` issue inside tag headers (`(` after ident treated oddly? actually caused by `<em>[{label}]</em>` chain / header mis-scan — recheck after fixes).
5. `for-in lists and conditionals` — `Unexpected keyword "for" where a value was expected`. Cause: `{for ...}` emitted plain LBRACE+KEYWORD instead of a DIRECTIVE token (directive path requires `inMarkup()`, which fails while the brace stack is non-empty).
6. `builtins len/push/log` — `"xs" is already declared in this scope`. Cause: analyzer pre-collects top-level names into `globalScope.vars`, then re-declares them while walking.
7-9. Examples `counter.luna` / `todo.luna` / `landing.luna` — `<on>` defect, `key` not a recognized builtin, inline `on keyup { ... }` attribute unsupported, `☾` unexpected-character (markup-context bug), undeclared `email` in landing signup flow.

Additional defects found by inspection (to fix + test):
- Runtime `_build()` has no case for `spec.k === 'frag'` → fragments collapse to empty text nodes.
- Codegen `AssignExpr` emits `_get(obj,"prop") = ...` for member targets → invalid JS.
- Analyzer `checkContent` ignores `ForDirective`, `IfDirective`, `OnWrapper`, `Fragment` children.
- Analyzer/codegen/runtime builtin sets diverge (`key`, `targetValue` only in runtime; `escapeHtml`/`range` missing from analyzer).
- `renderBraceCount` heuristic breaks nested `render {}` inside `{if}` bodies (will replace with a proper brace-frame stack).
- `npm test` placeholder; no typecheck/build scripts; no CI; no README; no Studio app.

## Acceptance criteria status (updated as evidence arrives)

| Criterion | Status | Evidence |
|---|---|---|
| Test script runs real tests | FAIL | `npm test` echoes error, exit 1 |
| Original baseline failures resolved | FAIL | 9 failing tests above |
| Lexer/parser regression tests | NOT VERIFIED | none exist yet |
| Analyzer scope & fragment traversal | FAIL | duplicate-decl + untraversed content kinds |
| Builtin definitions consistent | FAIL | three divergent lists |
| Member assignment valid codegen | FAIL | `_get(...) = x` |
| Fragment rendering recursive | FAIL | no `frag` case in `_build` |
| Runtime events/reactivity tests | FAIL | blocked by compile errors |
| Three examples work | FAIL | all three fail to compile |
| Export security tests | NOT VERIFIED | exporter naive, no tests |
| Studio exists & works | FAIL | no studio app in repo |
| CI configured | FAIL | no workflows |
| README | FAIL | none at root |
| Production build | NOT VERIFIED | no build script |
| Deployment | NOT VERIFIED | no vercel config found yet |

## Remaining phases
B(lexer/parser) → C(analyzer) → D(codegen/runtime) → E(examples) → F(export) → G(studio) → H(tests/scripts/CI/docs) → I(deployment) → final verification + commits.
