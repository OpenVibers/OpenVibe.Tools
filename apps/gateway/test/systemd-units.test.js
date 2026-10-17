'use strict';
/**
 * Tools gateway's systemd units (deploy/systemd): the listening socket is systemd's, so a restart queues connections in the
 * kernel instead of refusing them (11 refused connections on 2026-10-17 on openvibe.tools). The rules OpenVibe.Live learned (2026-09-26):
 *   - the socket listens on loopback only (the host firewall is off: 0.0.0.0 would be public);
 *   - NonBlocking= is a [Service] option (in the drop-in); in [Socket] systemd ignores it;
 *   - no PartOf= on the socket, or every restart closes and reopens the listener;
 *   - the process listens on fd 3 only when systemd handed it over (LISTEN_FDS=1 and its own pid), else on the port.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', 'deploy', 'systemd');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');
const section = (text, name) => (text.split(/^\[/m).find((s) => s.startsWith(`${name}]`)) || '');

const socket = read('openvibe-tools.socket');
const listens = [...section(socket, 'Socket').matchAll(/^ListenStream=(.+)$/gm)].map((m) => m[1].trim());
assert.deepStrictEqual(listens, ['127.0.0.1:4001'], 'the socket listens on loopback only, on the service port');
assert.ok(!/^NonBlocking=/m.test(section(socket, 'Socket')), 'NonBlocking= is a [Service] option, not a [Socket] one');
assert.ok(!/^PartOf=/m.test(section(socket, 'Unit')), 'no PartOf=: the socket outlives every restart');

const dropIn = read('openvibe-tools.service.d', 'socket.conf');
assert.match(section(dropIn, 'Unit'), /^Requires=openvibe-tools\.socket$/m);
assert.match(section(dropIn, 'Unit'), /^After=openvibe-tools\.socket$/m);
assert.match(section(dropIn, 'Service'), /^NonBlocking=true$/m);
assert.match(section(read('openvibe-tools.service'), 'Service'), /^ExecStart=.*server\/index\.js$/m, 'the main unit stays usable without the socket');

const index = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
assert.match(index, /process\.env\.LISTEN_FDS === '1' && Number\(process\.env\.LISTEN_PID\) === process\.pid/, 'fd 3 only when handed to this process');
assert.ok(index.includes('const server = app.listen(...(socketActivated ? [{ fd: 3 }] : [config.port, config.host]), () => {'.trim()), 'otherwise the configured port');

// The apps behind the gateway: the same rules, each on its own port.
const APPS = { audio: 4014, docs: 4016, food: 4011, img: 4012, maps: 4010, text: 4015, yt: 4013 };
for (const [app, port] of Object.entries(APPS)) {
    const dir = path.join(__dirname, '..', '..', app, 'deploy', 'systemd');
    const rd = (...p) => fs.readFileSync(path.join(dir, ...p), 'utf8');
    const sock = rd(`openvibe-tools-${app}.socket`);
    assert.deepStrictEqual([...section(sock, 'Socket').matchAll(/^ListenStream=(.+)$/gm)].map((m) => m[1].trim()), [`127.0.0.1:${port}`], `${app}: loopback, its port`);
    assert.ok(!/^NonBlocking=/m.test(section(sock, 'Socket')) && !/^PartOf=/m.test(section(sock, 'Unit')), `${app}: no NonBlocking/PartOf in the socket`);
    const drop = rd(`openvibe-tools-${app}.service.d`, 'socket.conf');
    assert.match(section(drop, 'Unit'), new RegExp(`^Requires=openvibe-tools-${app}\\.socket$`, 'm'), app);
    assert.match(section(drop, 'Unit'), new RegExp(`^After=openvibe-tools-${app}\\.socket$`, 'm'), app);
    assert.match(section(drop, 'Service'), /^NonBlocking=true$/m, app);
    assert.match(rd(`openvibe-tools-${app}.service`), new RegExp(`^Environment=PORT=${port}$`, 'm'), `${app}: the unit's PORT is the socket's`);
    const src = fs.readFileSync(path.join(__dirname, '..', '..', app, 'server', 'index.js'), 'utf8');
    assert.match(src, /process\.env\.LISTEN_FDS === '1' && Number\(process\.env\.LISTEN_PID\) === process\.pid/, `${app}: fd 3 only when handed to this process`);
    assert.match(src, /app\.listen\(\.\.\.\(socketActivated \? \[\{ fd: 3 \}\] : \[/, `${app}: otherwise its port`);
}

console.log('systemd units: all checks passed');
