import assert from 'node:assert/strict';
import { createRealServer } from './e2e/real-fixtures.mjs';
const fixture = await createRealServer();
const url = fixture.url;
// A forgotten fake must fail the fixture, even if application error handling
// would otherwise convert its upstream error into successful degraded JSON.
await assert.rejects(() => fixture.app.services.transport.httpsGet('https://unconfigured.invalid/provider'), /Unstubbed/);
assert.deepEqual(fixture.state.unexpectedUpstream, ['unconfigured.invalid/provider']);
await assert.rejects(() => fixture.close(), /Every application upstream/);
assert.equal(fixture.app.httpServer.listening, false);
await assert.rejects(() => fetch(url + '/healthz'));
console.log('PASS unstubbed provider fails real application fixture and server closes');
