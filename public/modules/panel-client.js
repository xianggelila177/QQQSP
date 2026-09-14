(() => {
  const safeURL = (value) => {
    if (!value) return '';
    try { const u = new URL(String(value), window.location && window.location.origin || 'https://panel.invalid'); return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : ''; } catch { return ''; }
  };
  const normalizeList = (value) => Array.isArray(value) ? value : (value == null ? [] : [value]);
  const decodeNewsMetadata = (headers) => {
    try {
      if (headers?.get('X-News-Meta-Encoding') !== 'base64url-json') return {};
      const encoded = headers.get('X-News-Meta');
      if (!encoded || encoded.length > 16000) return {};
      const bytes = Uint8Array.from(atob(encoded.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
      const value = JSON.parse(new TextDecoder().decode(bytes));
      return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    } catch { return {}; }
  };
  window.PANEL_CLIENT = Object.freeze({ safeURL, normalizeList, decodeNewsMetadata });
})();
