# Global market data contracts, verified 2026-09-06

The directory covers 20 primary cash-equity markets. The parent agent checked one index, stock and ETF per market against Yahoo chart metadata, positive prices, nonempty six-month daily history and five-day five-minute history. `data/market-instruments.json` retains each symbol, source type and verification timestamp. Directory discovery does not activate quotes. New foreign markets use Yahoo; Nasdaq and Tencent US fallback remain restricted to their supported market.

Five listed funds were incorrectly labelled EQUITY by Yahoo. The instrument catalogue retains the provider type and the primary issuer/exchange URLs, and overrides them to ETF with `instrumentTypeSource:catalog`: 510300.SS, NIFTYBEES.NS, BOVA11.SA, NAFTRACISHRS.MX and STX40.JO. The FTSEMIB.MI benchmark is an index even without a caret.

## Trading calendars

`data/market-calendars.json` contains 2026 date bounds, closures, date overrides, unpublished-session warnings and profile source URLs. Profiles select ordinary and ETF sessions and effective date ranges independently from IANA timezone offsets. Ordinary weekends close only after checking explicit special dates. Unknown calendar years, unpublished dates and unverified segment windows remain unknown.

LSE uses the published SETS schedule and England/Wales holidays expressly incorporated by the exchange; SGX similarly incorporates the MOM calendar and names its half-days. Euronext Paris/Amsterdam/Milan ETF continuous trading starts at 09:04 in the July 2026 workbook, while ordinary equities start at 09:00. SIX and BME have different ETF and stock closing schedules. ASX opening is represented conservatively as an auction until 10:00 because actual uncrossing has random seconds.

Brazil profiles distinguish the March 9 timetable change, equity/ETF closing auctions and the February 18 late opening. Generic ETFs retain only common verified trading intervals where equity and fixed-income ETFs differ. Expiry-day aftermarket dates have not been fully enumerated, so uncertain aftermarket intervals return UNKNOWN rather than advertising a daily session.

Mexico City retains its own timezone. Exchange-local trading hours change over the documented US summer period through effective date profiles; the timezone is not changed to New York. The official operation manual/current cash schedule and express temporary-period evidence are identified in the profile.

South Africa holidays are derived from official JSE business-day rules plus government holiday dates, as explicitly recorded in `coverageStatus` and `derivation`; the blocked JSE annual PDF is not claimed as read. The election date November 4 and year-end December 24/31 remain pending with visible notes. Generic equities have an unknown 12:00–12:15 interval where JSE segments differ; ETF sessions use the documented ZA06 schedule. Instrument-specific FCO cycles are not claimed as fully enumerated.

Known pending dates are explicit data, not missing records: Euronext December 24/31 half-day times, Xetra December 30, Indian Muhurat Sunday November 8, and the South African dates above. The 90-day gate requires a source-backed date span and standard profile for every market and reports these pending exceptions separately. It must fail on absent profiles or uncovered dates/years. No 2027 calendar has been invented.

## Prices, units and FX

Prices, changes, OHLC, chart arrays and historical recovery values retain the provider's raw units. GBp/GBX are hundredths of GBP; ZAc/ZAC are hundredths of ZAR. GBP and ZAR themselves are not scaled. The shared backend conversion helper returns a factor; percentages and volume are unaffected. Indices always use points and have no currency conversion factor.

`fxMap.USD` is CNY per USD; other keys are currency units per USD. Yahoo has one batch attempt and at most four chart fallbacks. Missing currencies stay absent from that attempt rather than retaining an old rate. ECB XML and Frankfurter are two transports of the same ECB daily source, with strict one-date validation. TWD is not available from ECB and is never synthesized.

FX service selection is per quote currency: a GBP quote can use a complete ECB snapshot while a simultaneous USD quote keeps Yahoo. `getFxSnapshot(currency)` binds the rates and all source/date/staleness fields atomically. No source/date sets are merged. Missing TWD disables that conversion only; native prices remain usable.

Yahoo nominal delays are retained with the official help URL and verification date in `data/yahoo-delays.json`. Explicit numeric quote metadata takes precedence; otherwise a documented supported suffix or exact index identity supplies the nominal delay, marked `feedDelaySource:yahoo-documentation`. This rule never applies to Naver/Tencent quotes. Unlisted indices retain unknown delay rather than claiming realtime.
