'use strict';
// Domain & IP reputation (checks.reputation): each public signal becomes a finding with what was seen and what it
// cost, and the score is 100 minus the costs. A well-kept domain scores 100; one with a blacklist listing, a
// "+all" SPF, no DMARC, an expired certificate and a week-old registration loses exactly those points; an address
// gets reverse DNS (forward-confirmed or not); a private address is refused and an IPv6 address skips the
// IPv4-only blacklists. DNS, TLS and RDAP are fakes: nothing here touches a real network.
const assert = require('assert');
const { TargetRefused } = require('../../_shared/egress');
const { createChecks } = require('../server/net/checks');

const A = { 'good.example': ['93.184.216.10'], 'bad.example': ['93.184.216.20'], 'www.bad.example': ['93.184.216.20'], 'mail.good.example': ['93.184.216.10'], 'host.isp.example': ['93.184.216.31'], 'lan.example': ['192.168.1.5'] };
const LISTED = { '20.216.184.93.zen.spamhaus.org': ['127.0.0.2'], 'bad.example.dbl.spamhaus.org': ['127.0.1.2'] };
const TXT = {
    'good.example': [['v=spf1 include:_spf.mail.example -all'], ['google-site-verification=abc']],
    '_dmarc.good.example': [['v=DMARC1; p=reject; rua=mailto:d@good.example']],
    'bad.example': [['v=spf1 +all']],
};
const MX = { 'good.example': [{ exchange: 'mail.good.example', priority: 10 }], 'nomail.example': [{ exchange: '', priority: 0 }] };
const fail = (code) => Promise.reject(Object.assign(new Error(code), { code }));
const resolverFor = () => ({
    resolve4: (q) => (LISTED[q] ? Promise.resolve(LISTED[q]) : A[q] ? Promise.resolve(A[q]) : fail('ENOTFOUND')),
    resolve6: () => fail('ENODATA'),
    resolveTxt: (q) => (TXT[q] ? Promise.resolve(TXT[q]) : fail('ENODATA')),
    resolveMx: (q) => (MX[q] ? Promise.resolve(MX[q]) : fail('ENODATA')),
});
const PRIVATE = /^(10\.|127\.|192\.168\.|169\.254\.|::1$|fd)/;
const daysFromNow = (d) => new Date(Date.now() + d * 86400000).toUTCString();
const egress = {
    isAllowed: (ip) => !PRIVATE.test(ip),
    async resolve(host) {
        const a = A[host];
        if (!a) throw Object.assign(new Error('not found'), { status: 400 });
        if (PRIVATE.test(a[0])) throw new TargetRefused(`${host} resolves to a private address`);
        return { host, address: a[0], family: 4 };
    },
    async tlsHandshake(dest) {
        if (dest.host === 'good.example') return { cert: { valid_to: daysFromNow(60), issuer: { O: "Let's Encrypt" } }, protocol: 'TLSv1.3' };
        return { cert: { valid_to: daysFromNow(-3), issuer: { O: 'Old CA' } }, protocol: 'TLSv1.2' };
    },
};
const REG = { 'good.example': '2009-04-01T00:00:00Z', 'bad.example': new Date(Date.now() - 7 * 86400000).toISOString() };
const rdap = async (_type, name) => (REG[name] ? { ok: true, data: { events: [{ eventAction: 'registration', eventDate: REG[name] }] } } : { ok: false, status: 404 });
const reverse = async (ip) => ({ '93.184.216.31': ['host.isp.example'], '93.184.216.32': ['elsewhere.example'] }[ip] || []);

(async () => {
    const checks = createChecks({ egress, resolverFor });
    const byCheck = (r) => Object.fromEntries(r.findings.map(f => [f.check, f]));

    // A well-kept domain: nothing to take off.
    let r = await checks.reputation('good.example', { rdap, reverse });
    let f = byCheck(r);
    assert.strictEqual(r.kind, 'domain');
    assert.strictEqual(r.score, 100, JSON.stringify(r.findings));
    assert.strictEqual(r.grade, 'good');
    assert.deepStrictEqual(['Blacklists', 'Mail servers (MX)', 'SPF', 'DMARC', 'HTTPS', 'Domain age'].map(k => f[k].status), ['good', 'good', 'good', 'good', 'good', 'good']);
    assert.match(f.SPF.detail, /"-all"/);
    assert.match(f['Domain age'].detail, /2009-04-01/);

    // A neglected one: each problem costs what it says.
    r = await checks.reputation('www.bad.example', { rdap, reverse });
    f = byCheck(r);
    assert.strictEqual(r.domain, 'bad.example', 'www. is the same domain');
    assert.strictEqual(f.Blacklists.status, 'bad');
    assert.strictEqual(f.Blacklists.cost, 50, 'two listings (the IP on ZEN, the domain on DBL)');
    assert.strictEqual(f.SPF.cost, 25, '+all');
    assert.strictEqual(f.DMARC.cost, 15, 'no DMARC');
    assert.strictEqual(f['Mail servers (MX)'].status, 'info');
    assert.strictEqual(f.HTTPS.cost, 15, 'expired certificate');
    assert.strictEqual(f['Domain age'].cost, 20, 'a week old');
    assert.strictEqual(r.score, 0, 'never below zero');
    assert.strictEqual(r.grade, 'poor');
    assert.strictEqual(r.score, Math.max(0, 100 - r.findings.reduce((s, x) => s + x.cost, 0)));

    // A null MX (RFC 7505: "0 ." comes back as an empty exchange) says the domain takes no mail.
    A['nomail.example'] = ['93.184.216.40'];
    f = byCheck(await checks.reputation('nomail.example', { rdap, reverse }));
    assert.strictEqual(f['Mail servers (MX)'].status, 'good');
    assert.match(f['Mail servers (MX)'].detail, /null MX/);

    // An address: blacklists and reverse DNS.
    r = await checks.reputation('93.184.216.31', { rdap, reverse });
    f = byCheck(r);
    assert.strictEqual(r.kind, 'ip');
    assert.strictEqual(f['Reverse DNS'].status, 'good');
    assert.match(f['Reverse DNS'].detail, /forward-confirmed/);
    assert.strictEqual(r.score, 100);
    r = await checks.reputation('93.184.216.32', { rdap, reverse });
    assert.strictEqual(byCheck(r)['Reverse DNS'].cost, 5, 'a PTR name that does not point back');
    r = await checks.reputation('93.184.216.33', { rdap, reverse });
    assert.strictEqual(byCheck(r)['Reverse DNS'].cost, 10, 'no PTR name');
    r = await checks.reputation('2606:4700:4700::1111', { rdap, reverse });
    assert.strictEqual(byCheck(r).Blacklists.status, 'info', 'IPv6: the blacklists are not asked');
    assert.strictEqual(r.blacklist, null);

    // Refused: private addresses, and names that resolve to them.
    await assert.rejects(checks.reputation('192.168.1.1', { rdap, reverse }), (e) => e instanceof TargetRefused && /private or reserved/.test(e.message));
    await assert.rejects(checks.reputation('lan.example', { rdap, reverse }), (e) => e instanceof TargetRefused);
    console.log('net-reputation: ok');
})().catch((e) => { console.error(e); process.exit(1); });
