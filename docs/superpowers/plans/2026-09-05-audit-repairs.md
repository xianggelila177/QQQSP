# QQQSP audit repairs Implementation Plan

> **For agentic workers:** Implement this plan task-by-task using the user's explicitly requested concurrent GPT-5.6 Luna workers. Preserve other workers' changes. Reviewers are advisory; parent owns integration and release.

**Goal:** Resolve the 40 numbered audit findings, verify behavior, and safely release the repaired panel with rollback material.

**Architecture:** Retain a lightweight Node monolith and static frontend. Isolate domain/caching services, HTTP boundaries, browser state/rendering and process supervision. Keep the public list API consistently an array, and preserve the user's background refresh workflow with bounded scheduling.

**Tech Stack:** Production Node v18.20.8 (all changes must be compatible; local Node v26 requires separate Linux/Node18 staging verification), Node ESM, native HTTP, vanilla browser modules/Canvas, Python relay material, Linux systemd, deterministic Node tests.

**Spec:** [原个人工作路径已移除]
**Project:** [原个人工作路径已移除]

## Ownership and integration contract

- Frontend worker: public/* except no final VERSION bump; tests/_harness.mjs and frontend-focused tests. Q02,Q03,Q05,Q06,Q13,Q14,Q24-Q31,Q33,Q35,Q37 and frontend Q38. Own new public modules.
- Domain worker: server.js, mkt.mjs, sent.mjs, lib/* except lib/http.js; provider/domain tests. Q03-Q05,Q07-Q13,Q15-Q17,Q23,Q28,Q31,Q32,Q36 and domain Q38. Own new domain modules.
- HTTP/operations worker: lib/http.js, log.mjs, ops/*, root shell/service/package files, test runner and operational tests. Q01,Q16 integration,Q18-Q23 HTTP,Q34,Q39,Q40. No live-server operations.
- Parent: integration, regression review, release version/build, staging/live deployment, browser checks, final report and any cross-cutting leftovers. Parent alone uses SSH.

Contracts to coordinate before edits:
1. /api/market and /api/quote always return arrays (including singleton); symbol errors remain array entries. Client defensively normalizes old singleton responses for rollout compatibility.
2. Chart version numbers remain decimal-compatible with cv syntax but reflect OHLCV content, not last timestamp; send full data on revision, same only for identical content. Intraday last-patch compatibility may remain.
3. Quote retains existing fields; add explicit displayName, exchangeName, instrumentType, source/src, quote timestamp, FX timestamp/staleness where feasible. INDEX values are points, never currency-converted.
4. News worker exports a single bounded requestNews(symbol) service with TTL/negative cache/single-flight used by rotator and HTTP. Coordinate its exact export with HTTP owner; no raw shared cache mutation in routes.
5. Frontend modules must be consumable by real browser and updated test harness. No network dependence in deterministic regression tests. Existing valid tests retained; replace tests that assert known-bad behavior or exact source placement with behavior coverage and document why.

## Task 1: Frontend repairs

- [ ] Add regression cases for singleton results, missing FX/index units, out-of-order/inflight refresh, failed manual refresh, same-date chart mutations, empty plots, MA window independence, search dismissal, cap/cleanup, and selected currency state.
- [ ] Run each meaningful new case against baseline to confirm the defect.
- [ ] Implement explicit browser state/client/chart helpers, reliable refresh outcomes and bounded background polling; fix accessible search/labels, responsive text/news, safe URL rendering and SW caching.
- [ ] Run frontend regressions with PATH=/opt/homebrew/bin:/usr/bin:/bin node tests/<file>.mjs; return exact commands/results and unresolved items.

## Task 2: Domain repairs

- [ ] Add deterministic provider/service fixtures for same-day updates, wide candles, calendar/DST, FX failure, matching news securities, sentiment negation, no-cache failure cooling and bounded queue/deadlines.
- [ ] Run baseline red cases; implement domain fixes and modular state ownership, central symbol/instrument metadata, as-of/source quality semantics and bounded provider work.
- [ ] Use exchange official calendars for supported dates or explicitly mark unknown calendar coverage. Never fabricate an authoritative real-time state or currency rate.
- [ ] Verify modified services using fixtures with no external calls; coordinate new exports with HTTP owner; return audit-ID resolution mapping and limitations.

## Task 3: HTTP/operations/testing repairs

- [ ] Add HTTP behavior tests for array schemas, symbols/methods, content revisions, CORS/Vary, body/route/work bounds and meaningful health metrics.
- [ ] Implement unified HTTP contracts with domain worker, bounded observation/logging and secure/static serving behavior.
- [ ] Prepare independent systemd panel/relay-tunnel units, safe legacy wrappers, log/resource limits and validation/rollback documentation. Do not stop/start any real service.
- [ ] Replace false-green verification with reliable exit statuses; hermeticize relay tests and remove requirements to download historical archives for ordinary testing; make version tooling cross-platform.
- [ ] Run applicable local tests and syntax checks. Parent validates Linux-specific services separately before live use.

## Task 4: Parent integration and release

- [ ] Review plan, then coordinate three workers; maintain baseline tarball and Git snapshot, no credentials in source/deliverables.
- [ ] Audit changed code via dedicated code-reviewer (GPT-5.6 Luna per user model request) and python-reviewer when relay changes require it; independently validate findings.
- [ ] Run all meaningful tests, targeted failure/timeout scenarios and isolated modest concurrency tests. Fix failures rather than suppress them.
- [ ] Inspect actual UI (single/multi-symbol flows and chart/search where possible), plus latest static/API behavior; record any device coverage limits.
- [ ] Recheck remote source hashes, create protected rollback backup, upload only intended files, validate Node/systemd syntax, then controlled release. Never overwrite intervening remote edits.
- [ ] Verify public site, fresh resource version, representative market/news/search/health requests and process isolation. Roll back promptly on regressions.
- [ ] Deliver a Markdown repair matrix mapping Q01-Q40 to tests/evidence and any explicitly unfinished residuals. Do not call an unvalidated item fixed.

## Reviewed contract addendum (authoritative)

- All quote endpoints, including `/api/AAPL`, return `QuoteResult[]`. Each element is a full Quote or `{symbol,error,code}`. Explicit empty symbols yields `[]`; malformed nonempty symbols yields 400. Errors never erase successful siblings.
- HTTP owner implements `chartRevision(bars)` as SHA-256 of canonical arrays `[t,o??null,h??null,l??null,c??null,v??null]`, first 12 hex digits parsed to a safe 48-bit decimal integer; empty arrays revision 0. `intradayVer`, `daily30Ver`, and `daily30Version` use this; `same` only for identical revision. Frontend must not infer content equality from timestamp and must redraw for revision/FX changes. Raw domain quote daily30Version will be overwritten at HTTP boundary.
- Domain quotes add `{displayName,exchangeName,instrumentType,quoteAt,src,fxAsOf,fxStale}`; preserve `ts=quoteAt`. `quoteAt` is original quote event time, null if unknown; never replace missing source time with current fetch time. `fetchedAt` remains request completion. Unknown FX is null/empty, never a fictional default. INDEX uses points regardless currency.
- Domain exports `requestNews(symbol)` from lib/news.js -> Promise<{items,updatedAt,stale,error?:string}>. Cache TTL is NEWS_TTL (default 540000ms); negative/failure cooldown 60000ms; max 200 cached entries and 200 active symbols. Cold and background paths share one Promise per symbol. HTTP keeps compatibility `{SYM: items[]}` and adds freshness metadata only through non-breaking response headers or an opt-in metadata format. HTTP owner calls requestNews and domain owns all cache mutation. Rotator uses same service.
- Default resource bounds: Yahoo queued tasks 64; queue-inclusive task deadline 12000ms; total quote request deadline 20000ms; upstream body 2MiB; global active expensive API requests 32; local per-client API quota 120/minute; raw path stats normalized to finite known route labels. Limits configurable with numeric validation. Saturated work returns bounded stale/error/429/503 rather than unbounded queues. Abort/cancellation must remove queued work; timed-out in-flight transports destroyed.
- Ownership of files listed above is exclusive. Parent does not edit worker-owned files while worker active; communicate cross-file requirements instead. Only HTTP owner changes lib/http.js; only domain owner changes server.js. Frontend owns harness; runner uses its updated API. Tests may be new uniquely named files, e.g. _test_audit_frontend, _test_audit_domain, _test_audit_http. Shared legacy tests are assigned by behavior and communicated before edits.
- Explicit new route tests: /api/macro RSS call path, /api/AAPL, 0/1/multiple/partial failures, invalid methods. Domain acceptance also includes session OHLC invariants, 30→130 history cache order, 000001.SS/SZ news distinction, quote time, and rotator/HTTP cold miss overlap. UI acceptance includes 320/375/390px, keyboard-only search and SW 500 responses when supported by browser testing; any untested device stated as such.
- Release identities: `qqqsp-panel.service`, `qqqsp-relay-tunnel.service`; current release symlink `/var/lib/qqqsp/current`, versioned directories `/var/lib/qqqsp/releases/<release>`. User/Group dsh; HOME=/var/lib/dsh. Panel executable /usr/bin/node, port 8567; relay uses existing /var/lib/dsh/.ssh/qpanel_relay and port 8801. Existing token remains protected and is referenced via symlink/environment file, never copied into source or outputs. Logs /var/log/qqqsp with 10MiB/3-file policy or journald plus explicit limits. Disk alert thresholds 85% warning/95% critical. Parent inventories space but never deletes unrelated data.
- Parent alone prepares protected backup `/var/lib/qqqsp/backups`, verifies source hashes, stages/test-runs on Linux Node18.20.8 with a separate loopback port, runs `systemd-analyze verify` plus shell/Python syntax and user/workdir checks. Atomic current symlink switch followed by targeted restart only. Old keeper/panel/tunnel PIDs must be reverified by exact cwd/identity before stopping; never kill dsh.service or broad process patterns. Verify new units independent from dsh cgroup, enable at boot, perform targeted application crash/recovery and tunnel recovery with rollback ready. No machine reboot during this task.
- Runner splits deterministic Node tests, safe operational shell tests and optional browser E2E with explicit status; no silent skipping or false-green. Environment-owned integration tests requiring browser/cloud credentials must report not-run rather than fail silently. No production stress tests.

Plan reviewed and approved. Clarification: any malformed nonempty symbol makes the complete request HTTP 400; valid unavailable symbols remain per-item errors.
