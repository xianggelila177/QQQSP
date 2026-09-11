// Composition root: each browser responsibility is implemented in a separate
// module and exposed through one stable contract consumed by app.js.
(() => {
  const client = window.PANEL_CLIENT, currency = window.PANEL_CURRENCY;
  const chart = window.PANEL_CHART, engine = window.PANEL_CHART_ENGINE, scheduler = window.PANEL_SCHEDULER, network = window.PANEL_NETWORK, state = window.PANEL_STATE;
  if (!client || !currency || !chart || !engine || !scheduler || !network || !state) throw new Error('panel helper modules missing');
  window.PANEL_UTILS = Object.freeze({ ...client, ...currency, ...chart, ...engine, ...scheduler, ...network, ...state });
})();
