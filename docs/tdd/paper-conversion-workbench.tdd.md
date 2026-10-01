# TDD Evidence: Paper Conversion Workbench

## Source

Journeys derived from `specs/001-paper-conversion-workbench/spec.md`.

## Red and Green Evidence

- RED: `npm test` executed before `src/state.js` existed and failed with `ERR_MODULE_NOT_FOUND` for the intended state module.
- GREEN: `npm test` passed 3 tests after the state machine and report filter were implemented.
- Refactor: no behavior-changing refactor was needed after the green gate.

## Guarantees

| # | What is guaranteed | Test | Result |
|---|---|---|---|
| 1 | A new job starts in intent review with IEEEtran selected and no repairs used. | `tests/state.test.mjs` | PASS |
| 2 | A job advances through Thinking, Converting, Compiling, Validating, Repairing, and Ready without exceeding three repairs. | `tests/state.test.mjs` | PASS |
| 3 | Findings filter by all, severity, and case-insensitive rule/title query. | `tests/state.test.mjs` | PASS |
| 4 | Browser workflow unlocks source, PDF, report, and change log at Ready. | Local browser smoke check | PASS |

## Coverage and Gaps

The dependency-free MVP uses Node's built-in test runner without coverage instrumentation. Browser smoke checks cover the primary workflow; real DOCX parsing, sandboxed LaTeX compilation, and downloads remain service integration work.
