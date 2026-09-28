# Taiwan panel repair v111

The Sep 28 report showed `2330.TW` with a valid Sep 24 TWSE close (TWD 2475), an empty intraday chart and no USD/CNY conversion. Sep 25 and Sep 28 were exchange holidays; the quote date itself was correct.

## Reproduction and changes

`node --test tests/v2/v111-taiwan-panel.test.mjs` initially failed all three reproduction cases: MIS `no-history` bypassed independent chart providers; the reference FX source lacked TWD; a missing currency was still marked fresh. The fixes remove that bypass, add the native Taiwan webpage chart, and select a separate coherent Bank of Canada USD/CNY/TWD reference snapshot.

The Yahoo Taiwan page contains a `MarketChartStore` JSON object inside a JavaScript SSR envelope. The adapter parses only JSON, validates symbol, venue, TWD, timezone, timestamps and the exchange calendar, and preserves the real 13:30 close point. It does not execute page code, substitute the USD ADR, or invent minute bars from quote samples. Only the verified 2330.TW listing is enabled. Requests share work, use a bounded cache, respect cooldowns, and reject old sessions after the next market open. The regional HTML service has its own host gate: a global Yahoo chart-API cooldown previously suppressed this independently available service.

The FX reader preserves provider and observation date with each whole snapshot. BOC and ECB currencies cannot contaminate each other during concurrent reads. Missing TWD remains unavailable even when USD is healthy. Reference conversions retain the approximation marker.

Live browser testing then exposed a cold-start gap: a fallback quote returned directly from the enricher without any chart attempt, and the holiday cadence could defer recovery for 15 minutes. A new failing regression reproduces that path. Fallback quotes now continue through chart enrichment before returning.

## Focused verification

- Nine targeted regressions cover the reproduced defects, cold start, identity/date/close rejection, complete provider-to-snapshot-to-panel flow, currency rendering, cooldown, recovery and concurrent FX snapshots.
- Existing TWSE, regular-chart, search, global/reference FX, frontend controller and snapshot tests are run for affected behavior.
- Build and source checks precede the release. The deployment preserves production configuration, API keys, watchlist and tunnel; rollback keeps the preceding release.

Live acceptance on Sep 28: version 111, native Taiwan intraday 266 points through Sep 24 13:30, last price TWD 2475. Browser verification covers native/USD/CNY switches (TWD 2475, approximately USD 77.93 and CNY 523.19), daily/intraday tabs and the distinct USD TSM ADR card. The authenticated market-context response contains quote, intraday and daily data with no missing requested sections, while retaining its partial status and adjustment warning. The overall readiness endpoint reports application ready; global data readiness can remain false for other tracked upstream feeds.

## Data boundaries

The page provides the latest regular-session minute prices. Source volume is not promoted to shares because its unit/session coverage has not been verified. The panel still discloses missing interval volume. Unavailable financial fundamentals remain missing. This change does not promise historical tick data or complete fundamentals.

Sources: [Yahoo Taiwan 2330.TW](https://tw.stock.yahoo.com/quote/2330.TW), [TWSE holidays](https://www.twse.com.tw/holidaySchedule/holidaySchedule?response=html), [Frankfurter providers](https://frankfurter.dev/providers/).
