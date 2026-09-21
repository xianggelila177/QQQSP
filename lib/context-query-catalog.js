// Pure request vocabulary shared by runtime validation and documentation builds.
export const CONTEXT_SECTIONS=Object.freeze(['quote','intraday','daily','samples','fundamentals','news','macro']);
export const ALL_CONTEXT_SECTIONS=Object.freeze([...CONTEXT_SECTIONS,'corporate_actions']);
export const EXTRA_QUERY_KEYS=Object.freeze(['adjustment','daily_granularity','intraday_before','intraday_month','intraday_date','aggregate_minutes','aggregate_source','actions_start','actions_end']);
export const CONTEXT_QUERY_KEYS=Object.freeze(['symbol','symbols','daily_bar_count','sample_trading_days','include','max_wait_ms','format','daily_before','daily_series_id',...EXTRA_QUERY_KEYS]);
