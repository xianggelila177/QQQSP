// Explicit aliases for the same cash index. Do not infer mappings from partial
// names, ETF tickers, futures, or an arbitrary caret-prefixed provider symbol.
export const INDEX_SYMBOL_ALIASES=Object.freeze({'SPX':'^GSPC','^SPX':'^GSPC'});
export function canonicalSymbol(value) {
  const symbol=typeof value==='string'?value.normalize('NFKC').trim().toUpperCase():'';
  return INDEX_SYMBOL_ALIASES[symbol]||symbol;
}
