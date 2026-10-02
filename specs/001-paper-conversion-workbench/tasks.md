# Tasks: Paper Conversion Workbench

## Phase 1 - Foundation

- [x] T001 Create product context and adapted design tokens in `PRODUCT.md` and `DESIGN.md`.
- [x] T002 Create semantic app shell with navigation, header, main workbench, status rail, and responsive layout.

## Phase 2 - Core Workflow

- [x] T003 Add deterministic demo job model and render functions for queue, intent preview, progress ledger, findings, and outputs.
- [x] T004 Add target selection, upload/dropzone affordance, start conversion action, and stage transitions.
- [x] T005 Add report filtering, finding details, approval/rollback affordances, and accessible live announcements.

## Phase 3 - Verification

- [x] T006 Add browser smoke test checklist and pure state-transition tests.
- [x] T007 Run Impeccable detector and fix mechanical findings.
- [x] T008 Run build, type/lint/test/security verification and converge remaining spec gaps.

## Phase 4 - Real Conversion Backend

- [x] T009 Add bounded DOCX upload validation and real extraction through Mammoth.
- [x] T010 Generate target-specific editable LaTeX and compile through project-local MiKTeX.
- [x] T011 Add validation report, change log, job polling API, and downloadable outputs.
- [x] T012 Add server-side OpenAI-compatible reasoning adapter with explicit no-key fallback.
- [x] T013 Add user-provided bibliography upload and full citation-key reconciliation.
- [x] T014 Add production retention cleanup, authentication, queue isolation, and deploy configuration.

## Phase 5: Convergence

- [x] T015 Add Gemini API adapter to `askReasoning()` (read `GEMINI_API_KEY`; fall back to rule-based when absent) per plan: reasoning adapter (partial).
- [x] T016 Add server-side repair loop with 3-attempt cap, `repairsUsed` tracking, and escalation response in `processJob()` per FR-006, FR-010, Constitution III (missing).
- [x] T017 Add `/api/jobs/:id/approve` endpoint and job-pause/resume mechanism so substantive findings block until user approves per FR-007, Constitution III (missing).
- [x] T018 Replace demo-as-default in `app.js` with an empty upload state that explains limits before a real DOCX is submitted per FR-001, US1/AC1 (partial).
- [x] T019 Add bibliography `.bib` file upload to `/api/jobs` POST and wire citation-key reconciliation into `buildLatex()` per T013, FR-011 (missing).
- [x] T020 Add 24-hour job retention cleanup worker in `server.mjs` per T014, spec §5.2 (missing).
- [x] T021 Add image-heavy DOCX detection and consent gate in upload handler per spec edge case (missing).
- [x] T022 Expand tests: server route integration tests, repair-loop unit tests, approval-gate unit tests, bibliography-reconciliation unit tests per Constitution V (missing).

## Phase 6: Deploy & Production Hardening

- [x] T023 Add SSE (Server-Sent Events) real-time progress stream replacing polling (`GET /api/jobs/:id/events`).
- [x] T024 Add rollback endpoint (`POST /api/jobs/:id/rollback`) and rollback button in UI per FR-010.
- [x] T025 Add cancel/delete endpoint (`DELETE /api/jobs/:id`) and cancel button in UI per Constitution III.
- [x] T026 Add LaTeX diff viewer endpoint (`GET /api/jobs/:id/diff`) and diff panel in UI.
- [x] T027 Add rate limiting (MAX_CONCURRENT_JOBS=5) and 429 response per Constitution IV.
- [x] T028 Add bibliography `.bib` upload UI in upload prompt (was missing from frontend).
- [x] T029 Add agent reasoning summary rail block in job detail view.
- [x] T030 Create `Dockerfile` with TeX Live minimal, non-root user, and health check.
- [x] T031 Create `.github/workflows/ci.yml` with build, test, security audit, and Docker validation.
- [x] T032 Create `railway.toml` deployment manifest and `.env.example` documentation.
- [x] T033 Expand test suite to 19 tests covering citation reconciliation, security, and all pipeline paths.
- [x] T034 Reviewer sign-off: all 19 tests green, constitution compliance verified, GitHub push complete.

## Phase 7: Convergence

- [ ] T035 CRITICAL add per-job capability authorization, remove the public job index, and enforce protected reads, streams, chat, actions, downloads, rollback, approval, consent, and deletion in `src/server.mjs` per Constitution IV and T014 (contradicts).
- [ ] T036 CRITICAL implement typed, allowlisted agent proposals with explicit Apply/Reject controls, deterministic execution, revision checks, recompile/revalidate, audit history, rollback, and a browser source editor/manual recovery path in `src/pipeline.mjs`, `src/server.mjs`, `src/app.js`, and `styles.css` per Constitution III, FR-007, and FR-010 (missing).
- [ ] T037 CRITICAL replace false-positive build/lint gates with source syntax validation and add recorded RED/GREEN integration evidence so broken browser code cannot pass CI in `scripts/`, `package.json`, `.github/workflows/ci.yml`, and `docs/tdd/` per Constitution V, T022, and T034 (contradicts).
- [ ] T038 preserve structured authors, affiliation references, emails, and exact consumed front-matter blocks without duplicating or deleting manuscript content in `src/pipeline.mjs` and fixtures per FR-003 (partial).
- [ ] T039 render wrapped, width-bounded tables with header/caption metadata and explicit merged/nested-table review findings so IEEE/ACM columns cannot overlap surrounding text in `src/pipeline.mjs` and fixtures per FR-003 and Edge Cases (partial).
- [ ] T040 extract every supported embedded DOCX image, validate its type, retain an asset manifest, and deliver a downloadable source ZIP containing `paper.tex`, images, bibliography, report, change log, and available PDF in `src/pipeline.mjs` and `src/server.mjs` per FR-003, FR-009, SC-004, and US3/AC3 (partial).
- [ ] T041 update the Gemini adapter to a supported stable model, provide bounded job context, validate structured responses, and make rule-based fallback state visible without exposing secrets in `src/pipeline.mjs`, `src/server.mjs`, and `.env.example` per plan: reasoning adapter and Constitution III-IV (partial).
- [ ] T042 complete the two-step upload and agent drawer controls, eliminate duplicate state declarations, preserve chat drafts/focus across updates, and expose real Apply/Reject/Edit actions with disabled/loading/error states in `src/app.js` and `styles.css` per US1/AC1-3, SC-002, and SC-005 (partial).
- [ ] T043 add unit and API integration coverage for authorization, agent proposals, metadata mapping, width-bounded tables, image manifests, source ZIP contents, output editing, rollback, and rate limits in `tests/` per Constitution V and T022 (missing).
- [ ] T044 run independent desktop/mobile keyboard browser flows for upload, multi-turn chat, Apply/Reject, manual edit, approvals, downloads, error recovery, and reload/reconnect; record tester and reviewer evidence before push per SC-001, SC-005, Constitution V-VI, and T034 (partial).
