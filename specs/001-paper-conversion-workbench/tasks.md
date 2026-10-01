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
