// A saved watchlist is bounded independently from provider/news plan quotas.
export const MAX_WATCHLIST_SYMBOLS = 100;
export const MAX_SAMPLE_SYMBOLS = 200; // Retained removals share a separate, bounded reserve.
export const DEFAULT_SAMPLE_BYTES = 96 * 1024 * 1024;
