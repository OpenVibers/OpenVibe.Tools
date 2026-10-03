'use strict';
const assert = require('assert');
const Module = require('module');

const requests = [];
let response = { status: 200, truncated: false, body: Buffer.from('[]') };
const egress = {
  follow: async (url, options) => {
    requests.push({ url, options });
    return response;
  },
};

// Keep the upstream offline. utils loads axios for other sources, but this source must use egress.
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === '../../../_shared/egress') return { createEgress: () => egress };
  if (request === 'axios') return {};
  return originalLoad.call(this, request, parent, isMain);
};
let openchargemap;
try {
  openchargemap = require('../server/sources/openchargemap');
} finally {
  Module._load = originalLoad;
}

(async () => {
  const station = {
    ID: 42,
    AddressInfo: { Title: 'Test charger', Latitude: 47.61, Longitude: -122.33 },
    UsageCost: 'Free',
  };
  response = { status: 200, truncated: false, body: Buffer.from(JSON.stringify([station])) };
  const key = 'sentinel-ocm-key-not-a-secret';
  const configured = await openchargemap.search(47.61, -122.33, 25, key);
  assert.equal(requests.length, 1);
  const url = new URL(requests[0].url);
  assert.equal(url.origin, 'https://api.openchargemap.io');
  assert.equal(url.pathname, '/v3/poi');
  assert.equal(url.searchParams.get('key'), key);
  assert.equal(url.searchParams.get('latitude'), '47.61');
  assert.equal(url.searchParams.get('longitude'), '-122.33');
  assert.equal(url.searchParams.get('distance'), '25');
  assert.equal(url.searchParams.get('maxresults'), '50');
  assert.equal(requests[0].options.timeoutMs, 12000);
  assert.ok(requests[0].options.maxBytes > 0);
  assert.equal(requests[0].options.headers['User-Agent'], 'OpenVibeApp/2.0');
  assert.equal(configured[0].id, 'ocm-42');
  assert.ok(!JSON.stringify(configured).includes(key));

  requests.length = 0;
  const unconfigured = await openchargemap.search(47.61, -122.33, 25, '');
  assert.equal(requests.length, 1);
  assert.equal(new URL(requests[0].url).searchParams.has('key'), false);
  assert.equal(unconfigured[0].id, 'ocm-42');

  response = { status: 503, truncated: false, body: Buffer.from('[]') };
  assert.deepEqual(await openchargemap.search(47.61, -122.33, 25, key), []);
  response = { status: 200, truncated: true, body: Buffer.from('[]') };
  assert.deepEqual(await openchargemap.search(47.61, -122.33, 25, key), []);
  console.log('OpenChargeMap egress: configured, unconfigured, and failed responses passed');
})().catch(err => { console.error(err); process.exitCode = 1; });
