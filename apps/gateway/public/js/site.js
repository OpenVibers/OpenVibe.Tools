/* openvibe.tools — progressive enhancement for the server-rendered pages.
 * Without this file every page still works: search is a plain GET form. With it: shared navbar and
 * footer, instant search from the cached catalog, and the query kept in the URL (?q=) so results
 * can be shared, reloaded and reached with Back. */
(function () {
    'use strict';
    var cookie = function (n) { var m = document.cookie.match(new RegExp('(?:^|; )' + n + '=([^;]*)')); return m ? decodeURIComponent(m[1]) : null; };
    var token = null; try { token = cookie('ov_token') || localStorage.getItem('ov_token'); } catch (e) { token = cookie('ov_token'); }
    try { if (window.OpenVibeNavbar) OpenVibeNavbar.init({ service: 'tools', apiBase: 'https://openvibe.network', token: token, history: { type: 'tool', title: document.title }, silentLogin: 'https://openvibe.tools/auth/login?silent=1&next={url}' }); } catch (e) { /* non-critical */ }
    try { if (window.OpenVibeFooter) OpenVibeFooter.init({ service: 'tools', variant: 'full', mount: '#ov-footer', apiBase: 'https://openvibe.network', updates: '/updates' }); } catch (e) { /* */ }

    // Cards link to the search-friendly host; people go straight to the short one (no redirect hop).
    document.addEventListener('click', function (e) {
        var a = e.target.closest && e.target.closest('a[data-go]');
        if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault(); location.href = a.getAttribute('data-go');
    });

    var input = document.getElementById('q'), results = document.getElementById('results');
    if (!input || !results) return;
    var grid = document.getElementById('results-grid'), empty = document.getElementById('results-empty');
    var catalog = null, loading = null, others = [].slice.call(document.querySelectorAll('main > section:not(#results):not(#recent)'));
    var recentSec = document.getElementById('recent'), recentReady = false;

    function load() {
        if (catalog) return Promise.resolve(catalog);
        if (loading) return loading;
        loading = fetch('/api/catalog.json').then(function (r) { return r.json(); }).then(function (j) {
            catalog = j.tools.map(function (t) { return { t: t, name: t.name.toLowerCase(), kw: (t.keywords || []).join(' ').toLowerCase(), hay: [t.tagline, t.description, t.id].join(' ').toLowerCase() }; });
            return catalog;
        }).catch(function () { loading = null; return []; });
        return loading;
    }
    function find(q) {
        var terms = q.toLowerCase().split(/[^a-z0-9.+#]+/).filter(Boolean).slice(0, 8);
        return catalog.map(function (c) {
            var s = 0;
            for (var i = 0; i < terms.length; i++) { var w = terms[i]; var hit = 0; if (c.name.indexOf(w) >= 0) hit += 5; if (c.t.id === w) hit += 4; if (c.kw.indexOf(w) >= 0) hit += 3; else if (c.hay.indexOf(w) >= 0) hit += 1; if (!hit) return null; s += hit; }
            return { s: s, t: c.t };
        }).filter(Boolean).sort(function (a, b) { return b.s - a.s || a.t.name.localeCompare(b.t.name); }).slice(0, 24).map(function (x) { return x.t; });
    }
    function card(t) {
        var a = document.createElement('a'); a.className = 'tool'; a.href = t.url; if (t.hosts.short) a.setAttribute('data-go', 'https://' + t.hosts.short + '/');
        var ic = document.createElement('span'); ic.className = 'ov-icon'; ic.dataset.icon = t.icon; ic.dataset.fx = 'none'; ic.style.setProperty('--ovi-size', '36px');
        var box = document.createElement('span'); box.className = 'tool-t';
        var b = document.createElement('b'); b.textContent = t.name; var s = document.createElement('small'); s.textContent = t.tagline; var i = document.createElement('i'); i.textContent = t.hosts.short || t.hosts.canonical;
        box.appendChild(b); box.appendChild(s); box.appendChild(i); a.appendChild(ic); a.appendChild(box); return a;
    }
    // Favourites (signed in: the account's, on every device and my.openvibe.network; otherwise this
    // browser's). Each card can be starred wherever it is shown; every star for a tool stays in step.
    var favs = [], favReady = null, heading = results.querySelector('h2');
    function isFav(id) { return favs.indexOf(id) >= 0; }
    function starred(t) {
        var w = document.createElement('div'); w.className = 'tool-wrap';
        var b = document.createElement('button'); b.type = 'button'; b.className = 'fav'; b.setAttribute('data-tool', t.id);
        paint(b, t.name, isFav(t.id));
        b.addEventListener('click', function () {
            var on = b.getAttribute('aria-pressed') !== 'true'; b.disabled = true;
            fetch('/api/v1/me/favorites/' + encodeURIComponent(t.id), { method: on ? 'PUT' : 'DELETE', credentials: 'same-origin' })
                .then(function (r) { return r.ok ? r.json() : null; })
                .then(function (res) { if (res && res.favorites) { favs = res.favorites; syncStars(); } })
                .catch(function () { /* unchanged */ })
                .then(function () { b.disabled = false; });
        });
        w.appendChild(card(t)); w.appendChild(b); return w;
    }
    function paint(b, name, on) { b.setAttribute('aria-pressed', on ? 'true' : 'false'); b.textContent = on ? '\u2605' : '\u2606'; b.setAttribute('aria-label', (on ? 'Remove ' : 'Add ') + name + (on ? ' from' : ' to') + ' favourites'); }
    function syncStars() {
        [].forEach.call(document.querySelectorAll('button.fav[data-tool]'), function (b) {
            var id = b.getAttribute('data-tool'), c = catalog && catalog.filter(function (x) { return x.t.id === id; })[0];
            paint(b, c ? c.t.name : id, isFav(id));
        });
    }
    // Ctrl+K (or /) on an empty search: your favourites, ready to open with the keyboard.
    function showFavorites() {
        if (input.value.trim()) return;
        (favReady || Promise.resolve()).then(load).then(function () {
            if (input.value.trim() || !favs.length) return;
            var byId = {}; catalog.forEach(function (c) { byId[c.t.id] = c.t; });
            var list = favs.map(function (id) { return byId[id]; }).filter(Boolean);
            if (!list.length) return;
            heading.textContent = 'Your favourites'; empty.hidden = true;
            grid.replaceChildren.apply(grid, list.map(starred));
            results.hidden = false; others.forEach(function (x) { x.hidden = true; }); if (recentSec) recentSec.hidden = true;
            mountIcons(grid);
        });
    }
    function show(q, push) {
        q = q.trim();
        heading.textContent = 'Results';
        var url = new URL(location.href); if (q) url.searchParams.set('q', q); else url.searchParams.delete('q');
        if (url.href !== location.href) history[push ? 'pushState' : 'replaceState']({ q: q }, '', url);
        if (!q) { results.hidden = true; others.forEach(function (s) { s.hidden = false; }); if (recentSec) recentSec.hidden = !recentReady; return; }
        load().then(function () {
            if (input.value.trim() !== q) return;
            var hits = find(q);
            hits = hits.filter(function (t) { return isFav(t.id); }).concat(hits.filter(function (t) { return !isFav(t.id); }));
            grid.replaceChildren.apply(grid, hits.map(starred)); empty.hidden = hits.length > 0;
            results.hidden = false; others.forEach(function (s) { s.hidden = true; }); if (recentSec) recentSec.hidden = true;
            mountIcons(grid);
        });
    }
    var timer = null;
    input.addEventListener('focus', load, { once: true });
    input.addEventListener('input', function () { clearTimeout(timer); timer = setTimeout(function () { show(input.value, false); }, 90); });
    input.form.addEventListener('submit', function (e) { e.preventDefault(); show(input.value, true); var first = grid.querySelector('a'); if (first && input.value.trim()) first.focus(); });
    window.addEventListener('popstate', function () { var q = new URL(location.href).searchParams.get('q') || ''; input.value = q; show(q, false); });
    document.addEventListener('keydown', function (e) {
        var k = (e.key || '').toLowerCase();
        if ((k === 'k' && (e.ctrlKey || e.metaKey) && !e.altKey) || (e.key === '/' && document.activeElement !== input && !/input|textarea|select/i.test(document.activeElement.tagName))) { e.preventDefault(); input.focus(); input.select(); showFavorites(); }
        else if (e.key === 'Escape' && !input.value.trim() && !results.hidden) show('', false);
    });

    // Your tools: favourites first (signed in: starred here or on my.openvibe.network), then recent tools,
    // this person's (every device they sign in to) or this browser's. Filled in after load.
    function mountIcons(el) { if (window.OpenVibeIcons) OpenVibeIcons.mount(el); else if (!document.getElementById('ov-icons-loader')) { var sc = document.createElement('script'); sc.id = 'ov-icons-loader'; sc.src = 'https://openvibe.network/shared/ov-icons.js'; document.head.appendChild(sc); } }
    favReady = fetch('/api/v1/me/recent-tools', { credentials: 'same-origin' }).then(function (r) { return r.ok ? r.json() : null; })
        .then(function (d) { favs = (d && d.favorites) || []; if (catalog) syncStars(); return d; }).catch(function () { return null; });
    if (recentSec) favReady.then(function (d) {
        if (!d || ((!d.recent || !d.recent.length) && !favs.length)) return null;
        return load().then(function () {
            var byId = {}; catalog.forEach(function (c) { byId[c.t.id] = c.t; });
            var ids = favs.concat(d.recent.map(function (e) { return e.tool; }).filter(function (id) { return favs.indexOf(id) < 0; }));
            var list = ids.map(function (id) { return byId[id]; }).filter(Boolean).slice(0, Math.max(8, favs.length));
            if (!list.length) return;
            var g = document.getElementById('recent-grid');
            g.replaceChildren.apply(g, list.map(starred));
            document.getElementById('recent-note').textContent = d.mode === 'account' ? 'On every device you sign in to' : 'On this browser';
            recentReady = true; if (!input.value.trim()) recentSec.hidden = false;
            mountIcons(g);
        });
    }).catch(function () { /* optional */ });
    var q0 = new URL(location.href).searchParams.get('q'); if (q0) { input.value = q0; show(q0, false); }
})();
