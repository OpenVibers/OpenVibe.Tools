'use strict';
// /api/v1/openapi.json is generated from the descriptors: every tool with an API has its run path,
// its input schema inline, unique operation ids, and nothing for tools without an API (yt).
const assert = require('assert');
const { openapi } = require('../server/openapi');
const descriptors = require('../server/registry/descriptors');

const snap = descriptors.snapshot();
const doc = openapi(snap, 'https://openvibe.tools');
assert.strictEqual(doc.openapi, '3.1.0');
const withApi = snap.tools.filter((t) => t.api && t.run && t.status !== 'unavailable');
for (const t of withApi) {
    const op = doc.paths[t.run.path] && doc.paths[t.run.path].post;
    assert.ok(op, `${t.id} has ${t.run.path}`);
    assert.ok(op.responses['200'] && op.responses['202'] && op.responses['429'], `${t.id} documents 200/202/429`);
}
for (const t of snap.tools.filter((x) => !x.api)) assert.ok(!doc.paths[`/api/v1/tools/${t.id}/run`], `${t.id} has no API, so no run path`);
const ids = Object.values(doc.paths).flatMap((v) => Object.values(v).map((op) => op.operationId));
assert.strictEqual(ids.length, new Set(ids).size, 'operation ids are unique');
assert.ok(doc.paths['/api/v1/tools'] && doc.paths['/api/v1/jobs/{id}/events'], 'registry and jobs facade are documented');
const json = doc.paths['/api/v1/tools/jsonminify/run'].post.requestBody.content['application/json'];
assert.deepStrictEqual(json.schema.properties.input.required, ['text'], 'the tool input schema is inline');
console.log(`openapi: ${withApi.length} run paths, all checks passed`);
