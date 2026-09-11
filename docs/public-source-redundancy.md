# Public data redundancy

Enable with `PUBLIC_SOURCE_REDUNDANCY=1`. Set `RECOVERY_PATH` to a private writable JSON file, for example `/var/lib/qqqsp/recovery/last-good.json`. With the flag absent, the existing provider graph is unchanged. Without a recovery path, reference FX and official news work but no quote file is read or written. Parent directory creation belongs to deployment; use owner `dsh`, mode `750`, persisted file mode `600`.

## Selected sources

- Yahoo FX remains preferred. A complete four-currency set is required. On failure, use ECB daily reference XML; if that path fails, use Frankfurter v2 explicitly pinned to ECB. The mirror is a second transport for the same underlying rates. Cross conversion is derived from published rates and marked approximately, with ECB's original date and “非实时汇率”. No date/provider mixing is permitted.
- Federal Reserve monetary policy, ECB press releases and BEA RSS supply official macro announcement titles, publication dates and original links. Official announcements can be up to 30 days old; ordinary news remains within 48 hours. Errors in ordinary sources remain visible when official announcements fill the list. No full articles or logos are copied.
- No new equity quote vendor is enabled. Existing providers and their limitations remain. Free tiers requiring a key, restricted display rights, challenges and undocumented adjustment/reuse semantics are recorded in the source research report.

## Limits and failure behavior

- FX coordinator: one refresh per minute, one concurrent refresh; ECB reference cache one hour, failed transport retry five minutes, maximum observation age seven days. Each direct reference request has a 4.5 second deadline; response parser limit 256 KiB. In-date reference data can remain available if transport refresh fails; transport failure is reported separately in diagnostics.
- Official feeds: fetch three sources concurrently at most once per 30 minutes after success; failed sources retry after five minutes. HTTP responses are bounded by the common transport and a 2 MiB parser limit. Each source supplies at most eight items, combined official feed at most 18. Macro list has at most 20 items with a three-item official reservation when ordinary items fill the list.
- Recovery: at most 50 securities, seven-day quote age, 8 MiB JSON, 1,500 bars per retained chart. Accepted quote snapshots are sampled at most every 30 seconds per symbol and flushed every 60 seconds, on the first accepted snapshot and on graceful stop. Sudden termination can lose recent unflushed observations. This is a bounded fallback, not a historical database or off-host backup.
- Load and write validate schema, timestamps and regular-file identity; symlinks, FIFOs, oversized files and malformed JSON are rejected. Atomic replacement keeps the previous file intact on a failed write. Multiple instances sharing a path inside one process serialize writes; separate processes must use separate recovery paths.
- Old recovery quotes keep original `quoteAt`, `fetchedAt`, source and delay metadata. They carry `recovery=true`, `stale=true`, `staleInfo.reason=offline-cache` and `fxStale=true`. Current market-calendar status is recalculated independently. Recovery never makes readiness healthy. A valid live quote replaces recovery; a newer stale live observation is never rolled back to an older disk quote. Where live calls are slow, an existing recovery quote can be returned after 150 milliseconds while the live request continues under the existing transport limits.

## Operations

Existing private diagnostics include `caches.redundancy`, `caches.referenceFx` and `caches.officialNews`, plus provider request metrics. Monitor recovery error/bytes/entry counts, original FX date, last successful feed refresh and ordinary-source errors. Public market JSON carries source/freshness metadata; the frontend marks reference conversions and offline quotes.

Disabling `PUBLIC_SOURCE_REDUNDANCY` and restarting the app returns to the prior graph. Code rollback to v60 ignores the new settings and preserves the private recovery file. Never use the production recovery path for a staging process. Corrupt or invalid files fail closed and remain available for inspection; repair by moving the failed file aside, then let fresh quotes create a new file.

Source references: [ECB reference rates](https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml), [ECB reuse notice](https://www.ecb.europa.eu/services/using-our-site/disclaimer/html/index.en.html), [Frankfurter v2](https://frankfurter.dev/), [Fed RSS](https://www.federalreserve.gov/feeds/feeds.htm), [Fed disclaimer](https://www.federalreserve.gov/disclaimer.htm), [BEA developer resources](https://www.bea.gov/resources/for-developers), [BEA reuse FAQ](https://www.bea.gov/help/faq/147).
