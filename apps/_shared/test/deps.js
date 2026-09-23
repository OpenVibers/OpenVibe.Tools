'use strict';
// apps/_shared has no node_modules of its own (the apps require it by relative path), so its tests
// borrow the dependencies of the first app that has them installed.
const path = require('path');
const APPS = ['img', 'docs', 'audio', 'yt', 'gateway'].map(a => path.join(__dirname, '..', '..', a));

function dep(name) {
    for (const dir of APPS) {
        try { return require(require.resolve(name, { paths: [dir] })); } catch { /* next app */ }
    }
    throw new Error(`${name} is not installed in any app (run npm run install:all)`);
}

module.exports = { dep };
