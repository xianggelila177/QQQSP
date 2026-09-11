# Official calendar evidence verified 2026-09-06

Implement only 2026 coverage unless other years separately verified. Explicit special sessions and announced dates with unpublished hours precede ordinary weekend rules. Out-of-coverage calendars remain unknown. No exchange status feed means unexpected emergency closures remain outside published-calendar coverage.

## US equities: NYSE and Nasdaq

Sources: https://www.nyse.com/trade/hours-calendars and https://www.nasdaq.com/market-activity/stock-market-holiday-schedule and https://www.nasdaqtrader.com/trader.aspx?id=calendar

2026 closed: 01-01,01-19,02-16,04-03,05-25,06-19,07-03,09-07,11-26,12-25.
Early close: 11-27 and 12-24 at 13:00 America/New_York. NYSE Arca/related late session ends17:00 on these dates, explicitly on NYSE page. Nasdaq early-close post-hours end needs its trader alert verification; don't invent20:00. Standard equities9:30-16:00 and calendar use DST timezone.

## Shanghai

Source: https://www.sse.com.cn/disclosure/dealinstruc/closed/
2026 closure ranges inclusive: 01-01..01-03,02-15..02-23,04-04..04-06,05-01..05-05,06-19..06-21,09-25..09-27,10-01..10-07. Weekend make-up workdays do NOT open exchange.
Shenzhen/Beijing official corroboration still pending; do not claim Shanghai source independently confirms every venue.

## Japan cash equities

Source: https://www.jpx.co.jp/english/corporate/about-jpx/calendar/
2026 closed: 01-01,01-02,01-03,01-12,02-11,02-23,03-20,04-29,05-03,05-04,05-05,05-06,07-20,08-11,09-21,09-22,09-23,10-12,11-03,11-23,12-31.
Hours: https://www.jpx.co.jp/english/equities/trading/domestic/01.html afternoon ends15:30; closing auction15:25-15:30 according to JPX post-Nov2024 scheme.

## Hong Kong cash securities

Source: https://www.hkex.com.hk/-/media/HKEX-Market/Services/Circulars-and-Notices/Participant-and-Members-Circulars/SEHK/2025/ce_SEHK_CT_075_2025.pdf
2026 closed weekdays: 01-01,02-17,02-18,02-19,04-03,04-06,04-07,05-01,05-25,06-19,07-01,10-01,10-19,12-25.
Half-day:02-16,12-24,12-31. Standard morning continuous session ends12:00, closing auction handling must be explicit (12:00-12:10); don't label continuous13:00-16:00 on half-days.

## Korea

Official rules https://regulation.krx.co.kr/contents/RGL/03/03010100/RGL03010100T1.jsp confirm holidays include statutory public holidays, May1, weekends, Dec31 (previous trading day if holiday/weekend), plus exchange-designated closures. Exact 2026 official closure list not yet retrieved. Keep coverage unknown until evidence added; do not use guessed holiday dates.

## Shenzhen and Beijing corroboration

Shenzhen: https://investor.szse.cn/English/services/trading/calendar/index.html explicitly lists 2026 Jan1-2, Feb16-23, Apr6, May1-5, Jun19, Sep25, Oct1-7 plus all weekends. Same CN closure rule above.
Beijing: https://www.bse.cn/important_news/200027428.html 2025-12-22 notice explicitly lists same closure ranges as Shanghai above.

## Korea 2026 official exchange calendar now retrieved

Source: https://open.krx.co.kr/contents/MKD/01/0110/01100305/MKD01100305.jsp
Retrieved the page-advertised public JSON API with year2026 (normal GenerateOTP form nonce -> OPN99000001.jspx; no account/login needed). Raw evidence krx-holidays-2026.json. Closed weekdays: 01-01,02-16,02-17,02-18,03-02,05-01,05-05,05-25,06-03,07-17,08-17,09-24,09-25,10-05,10-09,12-25,12-31. Weekends also closed perKRXrules. This supersedes the earlier unknown holiday-list note. Special late-open dates/session exceptions still require separate announcement evidence; do not fabricate them.

Runtime verification: the old live Node PID resolves to /opt/dsh-node/bin/node v24.19.0. Production preserves this binary. Node18.20.8 is additionally tested for compatibility, not used as a downgrade.

## Versioned registry and release gate

Runtime dates live in `data/market-calendars.json` (version `2026.09.05.1`), independently of session logic. The release maintainer owns annual updates and source review. `calendarCoverageStatus(now,90)` in `mkt.mjs` fails if any supported market lacks source-backed annual coverage anywhere in the next 90 days. The release gate must stop on `ok:false`; it must not silently shrink the horizon. On 2026-09-05 coverage extends through 2026-12-04. Releases after early October require 2027 calendars before passing the gate. Unknown exchanges report `known:false` and `marketState:UNKNOWN`.

For an update, retrieve each exchange's official cash-equity holiday and shortened-session notice, compare every date against the registry, retain the source URL and verification date, bump `version`, and run calendar boundary and horizon regressions. Have a second reviewer confirm the exchange and instrument scope. Do not derive exchange holidays from civil calendars, copy a prior year, or fabricate unpublished dates. Emergency closures require a separately verified notice. The existing 2026 registry was transcribed from the primary sources above; no 2027 dates have been added in this remediation.
