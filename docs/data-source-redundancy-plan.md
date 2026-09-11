# Public-source redundancy implementation plan

Goal: research public free sources, validate actual responses, integrate suitable redundancy and report the outcome. Two GPT-5.6 Luna agents researched US/global and Asian markets in parallel; a follow-up covered official FX/news. Parent validates suitability and owns integration/release.

## Decisions

1. Keep the existing quote/history providers. Do not treat provider aliases or mirrors as independent underlying data.
2. Add ECB daily reference FX, with Frankfurter v2 pinned to ECB as an alternative transport. Both are separate from Yahoo; they share the same underlying ECB reference data. Preserve provider observation date and label reference conversion.
3. Add Fed monetary-policy, ECB and BEA official feeds as low-frequency macro redundancy. Show titles, source, publication date and original links, not full articles or invented event timestamps.
4. Add a bounded, atomic, validated last-good quote store for restart plus total-source outage. Cached data remains explicitly stale, with original source/quote timestamps; it must not make readiness healthy.
5. FRED index series need display permission, commercial free plans need keys or limit display, Stooq returns verification, and undocumented Sohu/Naver history has uncertain redistribution/adjustment semantics. Record them as evaluated candidates instead of enabling them blindly on a public site.

## Ownership

- Luna US agent: `lib/providers/official-feeds.js`, macro integration, tests and fixtures. No deployment.
- Luna Asia agent: `lib/recovery-store.js`, its tests only. No integration edits or deployment.
- Parent: FX provider and Yahoo integration, macro/snapshot/application wiring, frontend source/freshness labels, diagnostics, documentation, fault injection, reviews and release.
- Shared checkout: accommodate other edits, stage only owned files, never revert others.

## Acceptance

- New adapters validate identity, finite rates, dates, XML shape and links; reject HTML challenge pages, DTDs and malformed data. Respect transport timeout/body limits and cache/negative cooldowns.
- Yahoo FX failure can fall back to complete ECB reference data; ECB direct failure can use its mirror. Mixed dates/invalid or too-old rates cannot masquerade as fresh.
- Primary macro sources can fail while official dated items remain usable; failures and partial coverage stay explicit.
- Restart with live sources blocked can recover persisted quotes as stale; successful live data replaces the fallback; no credential or arbitrarily supplied extra field is persisted.
- Unit/integration failure cases, full deterministic and real-browser gate, >=80% maintained-code coverage, independent code/security review, Linux Node24 verification, staged live smoke, locked release and rollback.
- Report includes tested URLs, free/key/permission boundaries, independence, data delay, installed sources, failures, test evidence and remaining market coverage gaps.

Research evidence is retained in the calling task's `work/redundancy/` directory. No provider key/account is created and no access challenge or TLS validation is bypassed.
