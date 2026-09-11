# QQQSP Audit Remediation Implementation Plan

> For agentic workers: execute the assigned subsystem independently, then integrate and review. The named superpowers execution skills are not installed; use the available collaboration workers and code reviewers. User explicitly authorizes repair, verification and production release.

**Goal:** Resolve all 32 issues in `outputs/QQQSP_全面审计报告_2026-09-05.md`, verify real behavior, and deploy a reversible versioned release.

**Architecture:** Keep Node HTTP and the native JavaScript UI. Consolidate instrument identity and provider contracts, make domain services constructible and deterministic, split frontend controllers and HTTP facilities along behavior boundaries. Preserve multi-provider fallback and background refresh intent.

**Tech Stack:** Node 24 production, native JS/HTML/CSS, Python relay, systemd/Cloudflare. Isolated unit/integration tests plus a reproducible Playwright release suite and native browser review.

## Ownership

- Backend worker owns `server.js`, `mkt.mjs`, `lib/` except `http.js` and files beginning `http-`, plus new backend tests. Owns calendar data/docs.
- Frontend worker owns `public/` except release VERSION stamping coordination, `tests/_harness.mjs`, and new frontend tests. Must preserve user watchlist, currencies and existing readable UI.
- Tooling worker owns cleanup/build/test/verification scripts, `package.json`, lockfile, `tests/_run_all.mjs`, existing test isolation/secret cleanup, E2E suite, service templates and RUNBOOK. Does not modify backend or frontend domain implementations.
- Root owns `lib/http.js`, `lib/http-*`, `log.mjs`, HTTP tests, integration, coverage, production infrastructure capacity, release and final evidence.
- Everyone shares one checkout: do not revert others, avoid bulk formatting or global replacements, coordinate cross-owner changes.
- Existing frontend behavior tests and `_harness.mjs` belong to frontend; existing domain behavior tests belong to backend; HTTP tests belong to root. Tooling proposes isolation changes to those owners rather than overlapping edits. Tooling owns VERSION stamping, invoking it only after frontend has finished changing HTML/SW. Frontend owns Retry-After behavior; root publishes HTTP factory signatures to backend.

## Task 1 — Data correctness and provider ownership (01,03,04,05,06,08,12,16,17,26,28,29)

- [ ] Write failing behavior tests for market-specific Tencent fields, missing enrichment, unsupported provider paths, unknown exchanges, HTTP-news failures, day-aware OHLC, news inactivity and fair enrichment.
- [ ] Run those tests against v58 and retain red evidence.
- [ ] Implement market-aware instruments/provider schemas; invalid ranges become unavailable, never fabricated values. A supported source may fill missing slow fields with provenance.
- [ ] Backend macro service preserves valid cache on upstream errors and exposes source error/stale/updatedAt state consumed by the frontend.
- [ ] Replace mutable domain dependency registration with explicit service factories and per-instance state; composition root wires them. Add a test constructing two independent instances whose caches/dependencies cannot contaminate one another. Coordinate HTTP factory with root.
- [ ] Separate client activation from background refresh. Use fair bounded queues and provider capabilities. Model unknown calendars explicitly.
- [ ] Extract year/version/source calendar data and add coverage expiry gate with documented update procedure. Use official primary sources for additional calendar years only if verified.
- [ ] Run new and affected existing tests. Export tests against public contracts instead of preserving source-position coupling.

## Task 2 — Frontend behavior and boundaries (09,10,11,12,13,14,15,25,27,28,30,31)

- [ ] Add tests which fail for fractional DPR, follow-latest, timeframe state, watchlist/news race, macro failure and stale state.
- [ ] Split card/chart, news/macro and search responsibilities into explicit controller factories; eliminate mutable global current-card formatting context.
- [ ] Preserve independent symbol/timeframe state, integer backing dimensions, cached MA and revision-aware rendering. Skip unnecessary offscreen work without hiding important status.
- [ ] Keep focus and stable DOM identity across macro updates; add keyboard point selection and accessible per-symbol chart descriptions.
- [ ] Display price session separately from current market state. Make ETF identity clear, rely on canonical backend market values.
- [ ] Enlarge mobile text and hit areas; remove permanently hidden bars and dead timer state. Keep manual/background polling semantics and persisted preferences.
- [ ] Verify scenarios with deterministic tests and hand off browser acceptance selectors to tooling worker.
- [ ] Browser matrix includes DPR1/1.25/1.5/2, first load, offline, v58 Service Worker upgrade, preserved watchlist/currencies, keyboard OHLC and focus, plus a measured 12-card long-chart pointer/layout benchmark.

## Task 3 — HTTP, monitoring and quotas (07,18,20,26,30)

- [ ] Add failing tests for partial news deadline results, normal multi-tab budget, trusted client identity, core readiness and business counters.
- [ ] Extract request admission, response/static helpers and diagnostics into independent `lib/http-*` modules; keep route handlers small.
- [ ] Preserve completed per-symbol news results on deadlines; label only unfinished tasks stale.
- [ ] Separate inexpensive cached reads from expensive upstream admission, budget normal multi-tab traffic and honor Retry-After in the client.
- [ ] Include Naver and provider capability diagnostics, bounded time-based error windows, per-symbol outcomes and enrichment wait ages. Define default core-symbol readiness independent of arbitrary visitors.
- [ ] Cache chart revisions by immutable chart identity/version; test updates invalidate hashes.
- [ ] Verify HTTP protections and behavior with real loopback integration tests.

## Task 4 — Tooling, privacy, delivery gates and docs (02,21,22,23,24,32)

- [ ] Reproduce backup command failure, shell syntax gate failures and polluted test environments before fixes.
- [ ] Retire unsafe obsolete cleanup or replace with verified backup-before-truncate under coordination; failed backup must preserve original.
- [ ] Run checks as independent fatal commands, loop over files, validate systemd units and version/resource synchronization.
- [ ] Remove historical sensitive values from tests/output. No real credential goes into fixtures, repository, logs or release archives.
- [ ] Root assesses historical values against only relevant current credential stores without exposing values, and records any needed revocation/log cleanup outcome. Tooling removes source/output propagation.
- [ ] Isolate test env/temp dirs and clean up; copy only required fixture files. Keep each test status honest.
- [ ] Pin Playwright development dependency and reproducible browser installation. Add critical real-browser E2E and a release gate requiring it. Existing background simulation must be labelled correctly.
- [ ] Update RUNBOOK for current paths, diagnostics, readiness, versioned deployment and atomic rollback.

## Task 5 — Capacity and production release (19 plus all integration requirements)

- [ ] Recheck live deployment and lock state before publishing; abort if another deployment changed the baseline unexpectedly.
- [ ] Attribute disk consumption, identify only safely replaceable caches/expired logs, preserve user data/backups, implement documented retention and warning checks. Verify actual recovered space or mark remaining action explicitly; no blind deletion.
- [ ] Capacity target: root partition below85% and at least9GiB available; owner is the server administrator, with installed daily warning check and visible readiness/stats status. Calendar owner is the release maintainer: coverage horizon90days, with fail-closed release expiry gate and documented annual source verification.
- [ ] Run full deterministic tests, new regressions, isolated E2E, code/security review, and coverage. Coverage threshold is 80% for lines/functions/branches in maintained code; investigate weak coverage rather than claiming a number from file counts.
- [ ] Stage release on server in a unique path/port with restricted files and production-compatible runtime. Run Linux service preflight and controlled live-provider smoke without stressing upstreams.
- [ ] Authoritative deterministic verification also runs on Linux/Node24. Hold an exclusive deployment lock through baseline comparison, switch, grace period and rollback decision. Core readiness is QQQ and SPY; allow120seconds cold-start grace, roll back on failure of core readiness or any critical smoke invariant, unexpected restart loop, or broken static resources.
- [ ] Verify staged frontend and API, immutable release manifest and secret exclusion. Keep previous release and exact rollback command available.
- [ ] Atomically switch current release and restart only qqqsp-panel; preserve relay and Cloudflare settings unless explicitly needed. On failed readiness or critical behavior, roll back immediately.
- [ ] Verify public version, endpoints, primary and fallback market semantics, UI screenshots, service resource/health, logs and low-rate timings. Confirm no business regression.
- [ ] Coverage scope: maintained application JS (server/lib/mkt/sent/log plus public application modules) excluding tests/build scripts and vendor code. Merge native V8 backend and real-browser coverage as applicable; publish actual line/function/branch totals and add meaningful missing scenarios to reach80%, rather than excluding untested application files.
- [ ] Produce `outputs/QQQSP_修复与上线验收_2026-09-05.md` with a 32-item evidence matrix, release identifier, tests, measured limitations and rollback instructions.

## Commands and expected results

From this checkout use a real Node binary, not the user's alternate wrapper: `/opt/homebrew/bin/node` locally; `/opt/dsh-node/bin/node` on production/staging.

- `npm run test:deterministic`: all file results PASS, nonzero on any failing test, no inherited production secrets or URLs.
- `npm run test:e2e`: critical journeys pass against isolated loopback fixtures, including DPR1.25/1.5 and widths320/375/390/430.
- `npm run test:coverage`: report actual instrumented code coverage and unmet thresholds explicitly.
- `npm run check:release`: syntax, contracts, secret scan, version, deterministic, E2E and artifact checks all pass.
- Linux: `systemd-analyze verify ...`, staged `/healthz`, `/readyz`, core `/api/market`, news partial-error tests and public release verification.

## Completion rule

Do not close an item by text assertion alone. Each ID needs implementation path plus a regression/inspection/production evidence entry, or a documented scope correction proven from current state. Do not mark the goal complete until code changes, actual deployed state and all required verification are reconciled.
