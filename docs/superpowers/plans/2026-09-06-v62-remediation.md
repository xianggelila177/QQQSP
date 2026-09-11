# QQQSP v62 Audit Remediation Implementation Plan

> For agentic workers: execute the bounded ownership groups below with regression-first fixes and independent review. The user has explicitly selected parallel implementation; no additional execution handoff is needed.

**Goal:** Resolve the 30 v61 audit remediation items, preserve existing market-panel behavior, prove fixes with local and production-compatible validation, deploy a reversible release and report item-by-item acceptance evidence.

**Architecture:** Keep the factory-based Node modular monolith and vanilla JS controllers. Centralize freshness, upstream failure and refresh policies; separate UI network state from market state. Keep independent provider adaptation, versioned chart payloads, recovery safety and immutable releases.

**Tech Stack:** Node 24 production / compatible Node local, native HTTP, JavaScript canvas, Python relay, systemd, Playwright, V8/Istanbul coverage.

## Authoritative baseline and scope

- Audited release: `/var/lib/qqqsp/releases/20260906-v61-5222f7e56afa`; live server.js/app.js fingerprints rechecked on 2026-09-06 before edits.
- Working repository: `[原个人工作路径已移除]`; baseline commit `50f2f23`.
- Specification: `[原个人工作路径已移除]`.
- Deliver the 30 numbered B/F/T/R fixes. Section 8 optional future trading features are not current requirements. No financial actions. No unrelated host changes or destructive cleanup.
- Credentials stay out of source, logs, prompts and artifacts. All workers are concurrent; never revert someone else's work.

## Task 1 — Backend gateway, providers and dependency boundaries (backend worker)

**Owned files:** `server.js`, `lib/yahoo*.js`, `lib/search.js`, `lib/quote-cache.js`, `lib/transport.js`, `lib/providers/nasdaq.js`, `lib/news.js`, `lib/slowcache.js`, `log.mjs`, and uniquely named `tests/_test_v62_backend_*.mjs`.

- [ ] Add regressions for B01 (blocked search and FX429 request fanout), B02 (preserve Nasdaq success/cache status and unique fallback class), B05 (no work after stop), B06 (network auth backoff), B10 (isolated env/clock/logger); run targeted tests and record initial failures.
- [ ] Put breaker policy at Yahoo request gateway with a controlled recovery path. Do not treat 429 as empty search success. No same-source four-chart retry after batch429. Keep quote and public-source redundancy behavior.
- [ ] Preserve last successful Nasdaq bars and timestamp on transport failures; unique assetclass candidates and explicit negative cache for known unsupported results.
- [ ] Add bounded gateway close/cancel and wire application stop; all in-flight and queued promises settle, no new work after stop.
- [ ] Pass validated narrow env/now/logger dependencies through factories. Legacy APIs remain compatible outside production composition.
- [ ] Run all impacted existing tests; report exact ownership changes and tests. No VERSION, build or deploy changes.

## Task 2 — Frontend charts and presentation state (frontend worker)

**Owned files:** `public/modules/panel-chart-engine.js`, `panel-chart-controller.js`, `panel-card-view.js`, `panel-news-controller.js`, `panel-state.js`, `public/app.js`, `public/style.css`, new narrowly scoped frontend helper modules; uniquely named `tests/_test_v62_frontend_*.mjs`.

- [ ] Add regressions F01–F07/F09/F10, R01/R02: minute labels with OHLC; price-axis text fit; MA bounds; persistent network error across currency switch; identical card/header freshness; stable focused news links; text contrast; obsolete rejected requests; reduced motion.
- [ ] Separate interval from plot type; dynamically measure formatted axis values; include enabled MAs in bounds and clip plot geometry. Preserve DPR and keyboard support.
- [ ] Model request status separately from market status; one frontend freshness selector including provider delay and cadence. All render paths preserve error/pending state until an actual successful response.
- [ ] News keyed reconciliation preserving activeElement/scroll. Reuse small shared scroll/theme policies without merging independent controllers.
- [ ] Add clear change baselines and visible interval/source-state details suitable for mobile. Do not change correct POST versus regular OHLC values.
- [ ] Make automatic reading cadence market/visibility aware with explicit continuous-monitoring versus economy preference; closed-market rate should fall by default, explicit monitoring preserves background reads, foreground resumes promptly.
- [ ] Run relevant tests and report. Do not change index.html, sw.js, versions or E2E infrastructure; communicate any new script dependencies to parent.

## Task 3 — Release and browser acceptance (tooling worker, after plan review)

**Owned files:** `scripts/{release,coverage,gate-state,check,e2e,version,files}.mjs`, `verify_all.sh`, `tests/e2e/**`, `playwright.config.mjs`, uniquely named `tests/_test_v62_tooling_*.mjs`.

- [ ] Fix T01: never include old generated manifest as source; add exactly one manifest; validate unpacked archive paths, bytes/digests and reproducibility.
- [ ] Fix T02: final createRelease requires fresh source-matched evidence for syntax/calendar/native service validation AND tests/coverage. Direct build cannot bypass stages; time-sensitive calendar checked again. Avoid recursive gate/build calls.
- [ ] Fix T03: backend/browser gates independently >=80% lines/functions/branches, plus agreed critical-module floors; include unexecuted files. No denominator deletion to make green.
- [ ] Fix T04/F08: add browser fixture running real createApplication with injected fake providers and local routes, valid intradayVer/cv/same paths, news headers and 429 recovery. Keep hermetic network guard.
- [ ] Fix T05: touch-enabled Chromium project tests horizontal drag, vertical scroll/pointercancel. Distinguish responsive versus actual touch and WebKit coverage.
- [ ] Keep existing behavior tests. Coordinate dependencies/new asset names with parent. No service deployment or unrelated public edits.

## Task 4 — Parent-owned domain fixes, assets and operations

**Owned files:** `lib/snapshot-service.js`, `lib/http-diagnostics.js`, `lib/recovery-store.js`, `sent.mjs`, `lib/http-capacity.js`, `public/index.html`, `public/sw.js`, `VERSION`, systemd unit files, `ops/**`, README/acceptance documentation and parent-specific tests.

- [ ] B03: response-time field freshness by kind/session; preserve original successful timestamps; queue delay is not success. Existing FX outer freshness remains authoritative.
- [ ] B04: BREAK permits last morning-session quote only while upstream checks are fresh; resumes stricter policy after lunch.
- [ ] B07: configurable session-aware enrichment budgets and no-user core probes retain readiness without every-minute full history work. Coordinate factory options with backend worker.
- [ ] B08: reuse negation span semantics for topic override; positive/negative paired corpus, not arbitrary market predictions.
- [ ] B09: safely quarantine a bounded ordinary corrupt cache file and rebuild from fresh validated data, while symlink/permission/schema safety remains closed.
- [ ] R03: preserve code modules but ship a compact deterministic static bundle; match SW cache keys to versioned page resources; cold/warm/upgrade/offline checks. Coordinate version gate with tooling worker before edits.
- [ ] T06: independently owned service users/credentials, immutable release/current; panel writable only logs/recovery/health and cannot read tunnel or SSH secrets. Verify actual unit context and service functions before/after.
- [ ] R04: bounded capacity history, appropriate check cadence and actionable alarm route; inspect usage before proposing reversible scoped retention, no blind deletion.

## Task 5 — Integration, review and acceptance

- [ ] Run regression-first tests per owner, then independent code-reviewer across combined diff. Review all input handling / request and credential boundaries with security-reviewer. Python review if Python modified.
- [ ] Parent cross-checks all B01–B10, F01–F10, T01–T06, R01–R04 against behavior evidence; fixes incomplete/weak evidence instead of checking off intent.
- [ ] Install locked deps; source/version/calendar gates; deterministic suite; real Chromium/touch E2E; per-section coverage; repeatable artifact with per-file manifest verification. Preserve stable fingerprint during full gate.
- [ ] Execute native Linux Node24/unit validation in isolated staging on correct host. Any stale or failing gate blocks production switch.
- [ ] Use deployment lock; save exact old target; deploy new immutable version and credentials outside source; atomic current switch; bounded readiness and real API/UI checks; rollback automatically if core acceptance fails.
- [ ] Verify production version and hashes, health+business readiness, representative markets and errors, source request cadence, dynamic axes, no console errors, service identity isolation/capacity monitoring. Do not claim native touch or broad load capacity without corresponding tests.
- [ ] Deliver final MD acceptance matrix with each item, code location, test/runtime evidence, residual limitations and rollback reference, plus reproducible source release. Only mark goal complete when all 30 scoped items and deployment acceptance are proven.

## Commands and expected results

From repository root, with real Node runtime first in PATH:

1. `node tests/_run_all.mjs` — all files PASS; no unexpected external requests.
2. `node scripts/check.mjs` and `node scripts/calendar-check.mjs` — syntax/secrets/resources and future90days PASS; native Linux service evidence required for release.
3. `node scripts/e2e.mjs` — actual browser runs, no skips/flaky cases, real-server conditional contracts and touch interactions pass.
4. `node scripts/coverage.mjs` — backend/browser/critical gates pass; source fingerprint unchanged.
5. `bash verify_all.sh` and `node scripts/release.mjs --check` — complete stage-bound gate and unpacked archive invariants PASS.
6. Production: readyz200, exact version/fingerprints, bounded resource usage; old target retained for rollback.

Tests and gate commands will be adjusted only to reflect stronger, valid requirements—not to bypass failures. Work log and status go in the acceptance document; plans are not completion evidence.

## Plan review amendments (approved for execution)

- Nonrecursive stage order: deterministic assets → immutable source fingerprint → syntax/calendar/deterministic/browser/coverage → Linux validation → final archive. `createRelease()` consumes evidence and rechecks calendar; never invokes full verification. Stage evidence lives in `.verification/` (excluded from sources), not a directory deleted by coverage. Test fixtures use explicit synthetic evidence without granting production validity.
- Root generated `release-manifest.json` is excluded from both source fingerprint and release input. Generated shipped bundle is included and built before fingerprint. Archive inspection requires unique paths, one manifest, exact file set, and matching bytes/size/hash; no regeneration after gates.
- Node side of real-server E2E loads no-network before server import, autostart disabled, fail-closed injected transport/providers. Browser external routing guard remains. Each fixture closes app; missed provider network attempt explicitly fails a regression.
- Rollback includes deployment-owned unit files, credential locations/ownership and runtime-directory permission migration as well as current target. Retain original credentials outside artifacts. Test actual panel user denial and working relay/Cloudflare after migration.
- Parent owns `lib/http.js` core-probe integration. Backend worker additionally owns narrow dependency fixes in `lib/quote.js` and `providers/{tx,sina,em}.js`. Tooling owns `scripts/calendar-check.mjs` and `tests/support/*`. Frontend owns corresponding existing deterministic frontend tests where old string/behavior assertions must migrate, preserving intended regressions.
- Snapshot contract: `createSnapshotService({env,sessionFor,now,...})`; env controls bounded ENRICH_OPEN_MS (60s), CLOSED (15m), BREAK (5m). Application injects current market calendar state to detect reopening; direct fixtures may use explicit quote states. Slow metadata gets original updatedAt plus ageMs/maxAgeMs/expired/refreshState. Current external FX layer remains authoritative.
- Coverage floors: overall, backend and browser each >=80% lines/functions/branches. Critical `lib/http-admission.js`, `lib/quote-contract.js`, `lib/recovery-store.js`, `public/modules/panel-market-store.js` each >=80% lines/functions/branches. Missing file is zero, not omitted. Add actual behavior tests if floors reveal gaps; do not lower gate or exclude difficult code.
