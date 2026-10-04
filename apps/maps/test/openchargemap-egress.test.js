'use strict';
// OpenChargeMap leaves the process only through the maps egress adapter
// (apps/maps/server/egress.js): the request carries the configured key, a key-less source still
// works (free tier), and a failed answer resolves empty instead of throwing. Every transport is a
// mock — no DNS, no socket — so any real network use fails the test.
const assert = require('assert');
const { EventEmitter } = require('events');
const { createEgress } = require('../../_shared/egress');

const maps = require('../server/egress');
const { setEgress } = maps;
const openchargemap = require('../server/sources/openchargemap');

const PUBLIC = '93.184.216.34';
const requests = [];
let answer = { status: 200, body: '[]' };

function install() {
  const guard = createEgress({
    lookup: (host, opts, cb) => cb(null, [{ address: PUBLIC, family: 4 }]),
    httpsRequest: (opts, cb) => {
      const rec = { method: opts.method, hostname: opts.hostname, path: opts.path, headers: opts.headers };
      requests.push(rec);
      const req = new EventEmitter();
      req.destroy = () => {};
      req.end = () => {
        process.nextTick(() => {
          const res = new EventEmitter();
          res.statusCode = answer.status;
          res.statusMessage = 'OK';
          res.headers = {};
          res.destroy = () => {};
          cb(res);
          process.nextTick(() => {
            res.emit('data', Buffer.from(answer.body));
            res.emit('end');
          });
        });
      };
      return req;
    },
  });
  setEgress(guard);
}

(async () => {
  install();
  const station = {
    ID: 42,
    AddressInfo: { Title: 'Test charger', Latitude: 47.61, Longitude: -122.33 },
    UsageCost: 'Free',
  };
  const key = 'sentinel-ocm-key-not-a-secret';

  answer = { status: 200, body: JSON.stringify([station]) };
  const configured = await openchargemap.search(47.61, -122.33, 25, key);
  assert.equal(requests.length, 1, 'one request');
  const req = requests[0];
  assert.equal(req.method, 'GET');
  assert.equal(req.hostname, 'api.openchargemap.io');
  const url = new URL(req.path, 'https://api.openchargemap.io');
  assert.equal(url.pathname, '/v3/poi');
  assert.equal(url.searchParams.get('key'), key);
  assert.equal(url.searchParams.get('latitude'), '47.61');
  assert.equal(url.searchParams.get('longitude'), '-122.33');
  assert.equal(url.searchParams.get('distance'), '25');
  assert.equal(url.searchParams.get('maxresults'), '50');
  assert.equal(req.headers['User-Agent'], 'OpenVibeApp/2.0');
  assert.ok(req.headers['Accept-Encoding'], 'the adapter asks for identity encoding');
  assert.equal(configured[0].id, 'ocm-42');
  assert.ok(!JSON.stringify(configured).includes(key));

  // Free tier: no key configured still sends (without a key) and still maps.
  requests.length = 0;
  const unconfigured = await openchargemap.search(47.61, -122.33, 25, '');
  assert.equal(requests.length, 1);
  assert.equal(new URL(requests[0].path, 'https://api.openchargemap.io').searchParams.has('key'), false);
  assert.equal(unconfigured[0].id, 'ocm-42');

  // A failed upstream resolves empty: the adapter throws, the source catches.
  for (const status of [401, 503]) {
    requests.length = 0;
    answer = { status, body: '[]' };
    assert.deepEqual(await openchargemap.search(47.61, -122.33, 25, key), []);
  }

  console.log('OpenChargeMap egress: configured, key-less and failed responses passed');
})().catch(err => { console.error(err); process.exitCode = 1; });
