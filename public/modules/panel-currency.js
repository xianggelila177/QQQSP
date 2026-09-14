(() => {
  // Preserve source units: uppercasing GBp before this check loses the 1/100 factor.
  const currencyUnit = value => {
    const raw = String(value || 'USD').trim();
    if (raw === 'GBp' || raw.toUpperCase() === 'GBX') return { unit: raw === 'GBp' ? 'GBp' : 'GBX', base: 'GBP', scale: 0.01 };
    if (raw === 'ZAc' || raw.toUpperCase() === 'ZAC') return { unit: raw === 'ZAc' ? 'ZAc' : 'ZAC', base: 'ZAR', scale: 0.01 };
    return { unit: raw.toUpperCase(), base: raw.toUpperCase(), scale: 1 };
  };
  const convert = (value, from, to, rates, options = {}) => {
    if (value == null || options.index) return value;
    if (to === 'NATIVE') return value;
    const source = currencyUnit(from), target = currencyUnit(to);
    if (target.unit === source.unit) return value;
    const amount = Number(value) * source.scale;
    if (!Number.isFinite(amount)) return null;
    if (target.base === source.base) return amount / target.scale;
    if (options.fxStale) return null;
    const rate = code => code === 'USD' ? 1 : Number(rates && rates[code === 'CNY' ? 'USD' : code]);
    const sourceRate = rate(source.base), targetRate = rate(target.base);
    if (!Number.isFinite(sourceRate) || sourceRate <= 0 || !Number.isFinite(targetRate) || targetRate <= 0) return null;
    return amount / sourceRate * targetRate / target.scale;
  };
  window.PANEL_CURRENCY = Object.freeze({ convert, currencyUnit });
})();
