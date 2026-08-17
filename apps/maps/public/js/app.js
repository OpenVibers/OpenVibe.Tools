/**
 * Maps.OpenVibe — Survival Map for North America
 * Frontend application — Leaflet map + 17 data sources
 */
(() => {
  'use strict';

  const API = '';
  const NA_CENTER = [44.0, -103.0];

  // ═══ State ═══
  const state = {
    map: null, markers: null, markerCache: new Map(),
    heatLayer: null, crimeHeatLayer: null,
    userMarker: null, searchCenter: null,
    locations: [], filtered: [], bridges: [], crimeHeatData: [],
    activeFilter: 'all', sortBy: 'distance',
    favorites: JSON.parse(localStorage.getItem('hm_favorites') || '[]'),
    notes: JSON.parse(localStorage.getItem('hm_notes') || '{}'),
    customSpots: JSON.parse(localStorage.getItem('hm_custom_spots') || '[]'),
    darkTiles: null, lightTiles: null, satelliteTiles: null,
    heatmapOn: false, crimeHeatmapOn: false, satelliteOn: false,
    queryTime: 0, charts: {},
    foodBankMarkers: [], storeMarkers: [],
  };

  const $ = s => document.querySelector(s);
  const $$ = s => document.querySelectorAll(s);
  const show = el => el && el.classList.remove('hidden');
  const hide = el => el && el.classList.add('hidden');

  function toast(msg, type = 'info') {
    const bg = { info: '#22c55e', success: '#059669', error: '#ef4444', warn: '#f59e0b', warning: '#f59e0b' };
    Toastify({ text: msg, duration: 3500, gravity: 'bottom', position: 'right',
      style: { background: bg[type] || bg.info, borderRadius: '10px', fontFamily: "'Outfit',sans-serif", fontSize: '12px', padding: '8px 16px' }
    }).showToast();
  }

  function makeId(loc) { return loc.id || `${loc.source}-${loc.name}-${(loc.lat||0).toFixed(4)}-${(loc.lon||0).toFixed(4)}`; }

  function haversine(lat1, lon1, lat2, lon2) {
    const R = 3958.8, dLat = (lat2-lat1)*Math.PI/180, dLon = (lon2-lon1)*Math.PI/180;
    const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  }

  function typeClass(loc) {
    const t = (loc.type||'').toLowerCase(), s = (loc.source||'').toLowerCase();
    if (s === 'crime intel') return 'sketch';
    if (t.includes('sketch')||t.includes('crime')||t.includes('shady')) return 'sketch';
    if (s === 'woods') return 'woods';
    if (s === 'waterways') return 'water';
    if (t.includes('ev charg')||t.includes('charging')) return 'urban';
    if (t.includes('bridge')) return 'bridge';
    if (t.includes('cave')||t.includes('pavilion')||t.includes('gazebo')||t.includes('covered')||
        t.includes('bus shelter')||t.includes('lean-to')||t.includes('awning')||t.includes('carport')||
        t.includes('porch')||t.includes('canopy')||t.includes('pergola')) return 'cover';
    if (t.includes('restroom')||t.includes('shower facility')||(t.includes('toilet')&&!t.includes('camp'))) return 'restroom';
    if (t.includes('dispers')||t.includes('blm')||t.includes('boondock')) return 'dispersed';
    if (t.includes('campground')||t.includes('camp')) return 'campground';
    if (t.includes('shelter')||t.includes('hut')||t.includes('alpine')) return 'shelter';
    if (t.includes('forest')||t.includes('trail')||t.includes('nature')||t.includes('wilderness')||t.includes('national park')) return 'forest';
    if (t.includes('urban')||t.includes('stealth')||t.includes('parking')||t.includes('walmart')||t.includes('rest area')) return 'urban';
    if (t.includes('water')||t.includes('river')||t.includes('lake')||t.includes('spring')||t.includes('creek')||t.includes('fishing')) return 'water';
    return 'default';
  }
  function typeIcon(tc) {
    return { dispersed:'fa-tree',campground:'fa-campground',forest:'fa-leaf',urban:'fa-city',services:'fa-hands-helping',
      water:'fa-faucet-drip',bridge:'fa-bridge',cover:'fa-umbrella',shelter:'fa-house-chimney',restroom:'fa-restroom',
      woods:'fa-tree',sketch:'fa-skull-crossbones',default:'fa-map-pin' }[tc]||'fa-map-pin';
  }
  function markerColor(tc) {
    return { dispersed:'#22c55e',campground:'#3b82f6',forest:'#eab308',urban:'#ef4444',services:'#a855f7',
      water:'#06b6d4',bridge:'#818cf8',cover:'#fb923c',shelter:'#ec4899',restroom:'#2dd4bf',
      woods:'#15803d',sketch:'#f87171',default:'#94a3b8' }[tc]||'#94a3b8';
  }
  function distText(d) { return d == null ? '' : d < 0.1 ? '< 0.1 mi' : d.toFixed(1)+' mi'; }
  function truncate(s, n=120) { return s && s.length > n ? s.slice(0,n)+'…' : s||''; }
  function stealthStars(r) {
    r = Math.min(5, Math.max(0, Math.round(r||0)));
    return Array.from({length:5},(_,i)=>`<i class="fa-solid fa-person-shelter stealth-star ${i<r?'filled':''}"></i>`).join('');
  }
  function stealthBars(r) {
    r = Math.min(5, Math.max(0, Math.round(r||0)));
    const cls = r<=2?'low':r<=3?'medium':'';
    return Array.from({length:5},(_,i)=>`<div class="stealth-bar ${i<r?`filled ${cls}`:''}"></div>`).join('');
  }
  function enrichLoc(loc) { loc._id = loc._id || makeId(loc); loc._typeClass = typeClass(loc); return loc; }
  function setStatus(html) { const el = $('#footer-status'); if (el) el.innerHTML = html; }

  // ═══ Splash ═══
  function initSplash() {
    const fill = $('#loader-fill'), status = $('#splash-status');
    const stages = [
      {pct:15,text:'<i class="fa-solid fa-person-shelter"></i> Hitching a ride...'},
      {pct:35,text:'<i class="fa-solid fa-database"></i> Connecting sources...'},
      {pct:55,text:'<i class="fa-solid fa-map"></i> Rendering map...'},
      {pct:75,text:'<i class="fa-solid fa-mountain"></i> Loading terrain...'},
      {pct:95,text:'<i class="fa-solid fa-check"></i> Ready to vanish!'},
    ];
    let i = 0;
    const iv = setInterval(() => {
      if (i >= stages.length) { clearInterval(iv); setTimeout(dismissSplash, 400); return; }
      fill.style.width = stages[i].pct + '%'; status.innerHTML = stages[i].text; i++;
    }, 350);
  }

  function dismissSplash() {
    const s = $('#splash-screen'); s.classList.add('fade-out');
    setTimeout(() => {
      s.style.display = 'none';
      if (localStorage.getItem('hm_disclaimer') === 'true') enterApp();
      else showDisclaimer();
    }, 500);
  }

  function showDisclaimer() {
    const overlay = $('#disclaimer-overlay'), cb = $('#disclaimer-check'), btn = $('#btn-disclaimer-agree');
    show(overlay);
    cb.checked = false; btn.disabled = true;
    cb.addEventListener('change', () => btn.disabled = !cb.checked);
    btn.addEventListener('click', () => {
      if (!cb.checked) return;
      localStorage.setItem('hm_disclaimer', 'true');
      overlay.classList.add('fade-out');
      setTimeout(() => { hide(overlay); enterApp(); }, 400);
    });
  }

  function enterApp() { show($('#app')); initMap(); }

  // ═══ Map ═══
  function initMap() {
    state.darkTiles = L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', { attribution:'&copy; CARTO', maxZoom:19 });
    state.lightTiles = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution:'&copy; OSM', maxZoom:19 });
    state.satelliteTiles = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { attribution:'&copy; Esri', maxZoom:19 });

    const theme = document.documentElement.getAttribute('data-theme');
    state.map = L.map('map', {
      center: NA_CENTER, zoom: 4, zoomControl: true,
      layers: [isLightTheme() ? state.lightTiles : state.darkTiles],
      preferCanvas: true, zoomSnap: 0.5, zoomDelta: 0.5,
    });

    state.markers = L.markerClusterGroup({
      chunkedLoading: true, maxClusterRadius: 55, spiderfyOnMaxZoom: true,
      showCoverageOnHover: false, disableClusteringAtZoom: 16, animate: false,
      removeOutsideVisibleBounds: true,
      iconCreateFunction(cluster) {
        const children = cluster.getAllChildMarkers(), count = children.length;
        const tally = {};
        children.forEach(m => { const tc = m._typeClass||'default'; tally[tc]=(tally[tc]||0)+1; });
        let dominant = 'default', maxC = 0;
        for (const [tc,n] of Object.entries(tally)) if (n > maxC) { maxC = n; dominant = tc; }
        const size = count < 10 ? 36 : count < 50 ? 42 : 50, half = size/2;
        const types = Object.entries(tally).sort((a,b)=>b[1]-a[1]);
        let ring;
        if (types.length > 1) {
          let cum = 0;
          const segs = types.map(([tc,n]) => { const p = (n/count)*100; const s = `${markerColor(tc)} ${cum}% ${cum+p}%`; cum += p; return s; });
          ring = `background:conic-gradient(${segs.join(',')});`;
        } else ring = `background:${markerColor(dominant)};`;
        return L.divIcon({
          html:`<div class="cluster-ring" style="width:${size}px;height:${size}px;${ring}"><div class="cluster-inner">${count}</div></div>`,
          className:'', iconSize:[size,size], iconAnchor:[half,half]
        });
      }
    });
    state.map.addLayer(state.markers);

    // Locate
    let locateActive = false, locMarker = null;
    $('#btn-map-locate').addEventListener('click', () => {
      if (locateActive) { locateActive = false; $('#btn-map-locate').classList.remove('active');
        if (locMarker) { state.map.removeLayer(locMarker); locMarker = null; } return;
      }
      locateActive = true; $('#btn-map-locate').classList.add('active');
      navigator.geolocation.getCurrentPosition(pos => {
        const {latitude:lat,longitude:lng} = pos.coords;
        state.map.flyTo([lat,lng], 13, {duration:0.8});
        if (locMarker) state.map.removeLayer(locMarker);
        locMarker = L.marker([lat,lng], { icon: L.divIcon({className:'locate-pulse-icon',iconSize:[18,18],iconAnchor:[9,9]}), zIndexOffset:2000 }).addTo(state.map).bindPopup('<b>You are here</b>');
      }, () => { locateActive = false; $('#btn-map-locate').classList.remove('active'); toast('Could not get location','error'); },
      {enableHighAccuracy:true,timeout:10000});
    });

    // Fullscreen
    $('#btn-map-fullscreen').addEventListener('click', () => {
      const c = $('#map-container');
      if (!document.fullscreenElement) c.requestFullscreen().then(()=>{ state.map.invalidateSize(); }).catch(()=>{});
      else document.exitFullscreen();
    });
    document.addEventListener('fullscreenchange', () => {
      $('#btn-map-fullscreen').querySelector('i').className = document.fullscreenElement ? 'fa-solid fa-compress' : 'fa-solid fa-expand';
      state.map.invalidateSize();
    });

    // Coords in footer
    state.map.on('mousemove', e => { $('#footer-coords').textContent = `${e.latlng.lat.toFixed(4)}, ${e.latlng.lng.toFixed(4)}`; });

    // Right click → add spot
    state.map.on('contextmenu', e => {
      $('#spot-lat').value = e.latlng.lat.toFixed(6);
      $('#spot-lon').value = e.latlng.lng.toFixed(6);
      show($('#add-spot-modal'));
    });

    // Search this area
    state.map.on('moveend', () => {
      if (!state.searchCenter) return;
      const c = state.map.getCenter();
      const d = haversine(state.searchCenter.lat, state.searchCenter.lon, c.lat, c.lng);
      if (d > 5) show($('#btn-search-area')); else hide($('#btn-search-area'));
    });
    $('#btn-search-area').addEventListener('click', () => {
      hide($('#btn-search-area'));
      const c = state.map.getCenter();
      $('#search-input').value = `${c.lat.toFixed(5)}, ${c.lng.toFixed(5)}`;
      performSearch(`${c.lat.toFixed(5)}, ${c.lng.toFixed(5)}`);
    });

    toast('Map ready — search a location or click a quick search to begin');
  }

  // ═══ Search ═══
  function buildSourceProgressHTML(sources) {
    return `<div class="source-progress">
      <div class="sp-header">
        <div class="sp-bar"><div class="sp-fill" id="sp-fill"></div></div>
        <span class="sp-count" id="sp-count">0 / ${sources.length}</span>
      </div>
      <div class="sp-grid">${sources.map(s =>
        `<div class="sp-item" data-source="${s.name}" id="sp-${s.name.replace(/[^a-zA-Z0-9]/g, '')}">
          <i class="fa-solid fa-spinner fa-spin sp-icon"></i>
          <span class="sp-name">${s.name}</span>
          <span class="sp-result"></span>
        </div>`
      ).join('')}</div>
    </div>`;
  }

  function markSourceDone(name, status, count) {
    const id = 'sp-' + name.replace(/[^a-zA-Z0-9]/g, '');
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.remove('loading');
    el.classList.add(status === 'done' ? 'done' : 'error');
    const icon = el.querySelector('.sp-icon');
    if (icon) {
      icon.classList.remove('fa-spinner', 'fa-spin');
      icon.classList.add(status === 'done' ? 'fa-check' : 'fa-xmark');
    }
    const res = el.querySelector('.sp-result');
    if (res) res.textContent = status === 'done' ? (count > 0 ? count : '–') : '✗';
  }

  function updateSourceProgress(completed, total) {
    const fill = document.getElementById('sp-fill');
    const cnt = document.getElementById('sp-count');
    if (fill) fill.style.width = `${(completed / total) * 100}%`;
    if (cnt) cnt.textContent = `${completed} / ${total}`;
  }

  /** Incrementally add locations to map as they stream in */
  function addStreamedLocations(newLocs, newBridges, newCrimeHeatmap) {
    let added = 0;
    if (newLocs && newLocs.length) {
      for (const loc of newLocs) {
        const enriched = enrichLoc(loc);
        if (enriched.lat && enriched.lon && state.searchCenter) {
          if (!enriched.distanceMiles) enriched.distanceMiles = haversine(state.searchCenter.lat, state.searchCenter.lon, enriched.lat, enriched.lon);
        }
        state.locations.push(enriched);
        added++;
      }
    }
    if (newBridges && newBridges.length) {
      for (const b of newBridges) {
        state.bridges.push(enrichLoc({ ...b, source: 'Bridges', type: `Bridge (${b.serviceUnder || 'Unknown'})` }));
      }
    }
    if (newCrimeHeatmap && newCrimeHeatmap.length) {
      state.crimeHeatData.push(...newCrimeHeatmap);
    }
    return added;
  }

  async function performSearch(query) {
    if (!query?.trim()) return;
    query = query.trim();
    const btn = $('#btn-search');
    btn.classList.add('loading');
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i><span>Searching...</span>';
    setStatus(`<i class="fa-solid fa-spinner fa-spin"></i> Searching "${query}"...`);
    hide($('#welcome-card'));
    $('#results-list').innerHTML = '<div class="search-progress"><div class="spinner"></div><p>Geocoding location...</p></div>';

    // Reset state
    state.locations = [];
    state.bridges = [];
    state.crimeHeatData = [];
    state.markerCache.clear();
    state.sourceMeta = {};

    try {
      // Geocode
      const geoRes = await fetch(`${API}/api/geocode?q=${encodeURIComponent(query)}`);
      const geoData = await geoRes.json();
      if (!geoData.length) throw new Error('Location not found');
      const { lat, lon, name: displayName } = geoData[0];
      const radius = parseInt($('#search-radius').value) || 15;

      state.searchCenter = { lat, lon };

      // User marker
      if (state.userMarker) state.map.removeLayer(state.userMarker);
      state.userMarker = L.marker([lat, lon], {
        icon: L.divIcon({ className: 'user-marker', iconSize: [20, 20], iconAnchor: [10, 10] }), zIndexOffset: 1000
      }).addTo(state.map).bindPopup(`<b>Search Center</b><br>${displayName}`);
      state.map.setView([lat, lon], 11, { animate: false });

      // Placeholder for source progress — will be replaced once sources manifest arrives
      $('#results-list').innerHTML = '<div class="search-progress"><div class="spinner"></div><p>Connecting to sources...</p></div>';

      const t0 = Date.now();

      // Use SSE streaming endpoint
      await new Promise((resolve, reject) => {
        const es = new EventSource(`${API}/api/search/stream?lat=${lat}&lon=${lon}&radius=${radius}`);
        let totalSources = 17;
        let refreshTimer = null;

        function scheduleRefresh() {
          if (refreshTimer) return;
          refreshTimer = setTimeout(() => {
            refreshTimer = null;
            applyFilters();
          }, 300);
        }

        es.addEventListener('sources', (e) => {
          const sourceDefs = JSON.parse(e.data);
          totalSources = sourceDefs.length;
          $('#results-list').innerHTML = buildSourceProgressHTML(sourceDefs);
        });

        es.addEventListener('cached', (e) => {
          const data = JSON.parse(e.data);
          // Full cached result — load everything at once
          state.locations = (data.locations || []).map(enrichLoc);
          state.bridges = (data.bridges || []).map(b => enrichLoc({ ...b, source: 'Bridges', type: `Bridge (${b.serviceUnder || 'Unknown'})` }));
          state.crimeHeatData = data.crimeHeatmap || [];
          state.sourceMeta = data.sourceMeta || {};
          state.queryTime = ((Date.now() - t0) / 1000).toFixed(1);
        });

        es.addEventListener('source', (e) => {
          const msg = JSON.parse(e.data);
          markSourceDone(msg.name, msg.status, msg.count);
          updateSourceProgress(msg.completed, msg.total);
          if (msg.status === 'done') {
            const added = addStreamedLocations(msg.locations, msg.bridges, msg.crimeHeatmap);
            state.sourceMeta[msg.name] = { count: msg.count };
            if (added > 0 || msg.bridges?.length || msg.crimeHeatmap?.length) scheduleRefresh();
          }
        });

        es.addEventListener('done', (e) => {
          const msg = JSON.parse(e.data);
          es.close();
          state.queryTime = ((Date.now() - t0) / 1000).toFixed(1);
          if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null; }
          resolve(msg);
        });

        es.addEventListener('error', () => {
          es.close();
          if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null; }
          reject(new Error('Connection lost during search'));
        });
      });

      // Merge in custom spots within radius
      const radius2 = parseInt($('#search-radius').value) || 15;
      for (const c of state.customSpots) {
        if (c.lat && c.lon) {
          const d = haversine(lat, lon, c.lat, c.lon);
          if (d <= radius2) state.locations.push(enrichLoc({ ...c, distanceMiles: Math.round(d * 10) / 10, source: 'Custom' }));
        }
      }

      // Compute distances for anything missing
      state.locations.forEach(l => {
        if (l.lat && l.lon && !l.distanceMiles) l.distanceMiles = haversine(lat, lon, l.lat, l.lon);
      });

      applyFilters();
      show($('#sort-by'));
      $('#results-summary').innerHTML = `<strong>${state.locations.length}</strong> spots found`;

      // Fit bounds
      if (state.locations.length) {
        const bounds = L.latLngBounds(state.locations.map(l => [l.lat, l.lon]));
        bounds.extend([lat, lon]);
        state.map.flyToBounds(bounds, { padding: [50, 50], maxZoom: 13, duration: 0.6 });
      }

      fetchWeather(lat, lon);

      setStatus(`<i class="fa-solid fa-check-circle"></i> ${state.locations.length} spots near "${query}" in ${state.queryTime}s`);
      toast(`Found ${state.locations.length} locations near ${query}`);

    } catch (err) {
      setStatus(`<i class="fa-solid fa-exclamation-triangle"></i> ${err.message}`);
      toast(err.message, 'error');
      $('#results-list').innerHTML = `<div class="muted-text"><i class="fa-solid fa-triangle-exclamation"></i> ${err.message}</div>`;
    } finally {
      btn.classList.remove('loading');
      btn.innerHTML = '<i class="fa-solid fa-person-shelter"></i><span>Search</span>';
    }
  }

  // ═══ Filters ═══
  function applyFilters() {
    let list = [...state.locations];
    if (state.activeFilter === 'favorites') list = list.filter(l => state.favorites.includes(l._id));
    else if (state.activeFilter === 'free') list = list.filter(l => !l.fee || l.fee === 'Free' || l.fee === 'No');
    else if (state.activeFilter === 'cover') list = list.filter(l => {const tc=l._typeClass; return tc==='cover'||tc==='bridge'||tc==='shelter';});
    else if (state.activeFilter !== 'all') list = list.filter(l => l._typeClass === state.activeFilter);

    switch (state.sortBy) {
      case 'distance': list.sort((a,b)=>(a.distanceMiles||999)-(b.distanceMiles||999)); break;
      case 'stealth': list.sort((a,b)=>(b.stealthRating||0)-(a.stealthRating||0)); break;
      case 'name': list.sort((a,b)=>(a.name||'').localeCompare(b.name||'')); break;
    }
    state.filtered = list;
    renderResults();
    updateMap();
    $('#results-summary').innerHTML = `<strong>${list.length}</strong> of ${state.locations.length}`;
  }

  // ═══ Results ═══
  function renderResults() {
    const c = $('#results-list');
    if (!state.filtered.length) { c.innerHTML = '<div class="muted-text"><i class="fa-solid fa-person-shelter"></i> No matching spots.</div>'; return; }
    const limit = 200;
    const visible = state.filtered.slice(0, limit);
    c.innerHTML = visible.map((loc,i) => {
      const tc = loc._typeClass, isFav = state.favorites.includes(loc._id);
      return `<div class="result-card" data-idx="${i}" data-id="${loc._id}">
        <button class="result-fav-btn ${isFav?'favorited':''}" data-fav="${loc._id}"><i class="fa-${isFav?'solid':'regular'} fa-heart"></i></button>
        <div class="result-card-header">
          <div class="result-type-icon ${tc}"><i class="fa-solid ${typeIcon(tc)}"></i></div>
          <div style="flex:1;min-width:0">
            <div class="result-name">${loc.name||'Unknown'}</div>
            <div class="result-meta">
              <span class="result-type-label">${loc.type||'Unknown'}</span>
              <span><i class="fa-solid ${loc.sourceIcon||'fa-database'}"></i> ${loc.source||''}</span>
              ${loc.fee&&loc.fee!=='Free'?`<span><i class="fa-solid fa-dollar-sign"></i> ${loc.fee}</span>`:''}
            </div>
          </div>
          <div style="text-align:right;flex-shrink:0">
            ${loc.distanceMiles?`<div class="result-distance">${distText(loc.distanceMiles)}</div>`:''}
            <div class="stealth-rating">${stealthStars(loc.stealthRating)}</div>
          </div>
        </div>
        ${loc.description?`<div class="result-description">${truncate(loc.description,100)}</div>`:''}
        <div class="result-tags">${(loc.amenities||[]).slice(0,4).map(a=>`<span class="result-tag"><i class="fa-solid fa-check"></i> ${a}</span>`).join('')}</div>
      </div>`;
    }).join('') + (state.filtered.length > limit ? `<div class="muted-text">${state.filtered.length-limit} more results hidden. Zoom in or filter.</div>` : '');
  }

  // ═══ Map Markers ═══
  function updateMap() {
    state.markers.clearLayers();
    const batch = [];
    state.filtered.forEach(loc => {
      if (!loc.lat || !loc.lon) return;
      const tc = loc._typeClass;
      let marker = state.markerCache.get(loc._id);
      if (!marker) {
        marker = L.marker([loc.lat,loc.lon], {
          icon: L.divIcon({
            html:`<div class="custom-marker ${tc}"><i class="fa-solid ${typeIcon(tc)}"></i></div>`,
            className:'', iconSize:[28,28], iconAnchor:[14,28], popupAnchor:[0,-28]
          })
        });
        marker._typeClass = tc;
        const dist = loc.distanceMiles ? `<br><span class="popup-distance">${distText(loc.distanceMiles)}</span>` : '';
        marker.bindPopup(`<div class="popup-name">${loc.name||'Unknown'}</div><div class="popup-type">${loc.type||''} – ${loc.source||''}</div>${dist}<a href="#" class="popup-link" data-loc-id="${loc._id}">View details →</a>`);
        marker.on('click', () => selectLocation(loc));
        state.markerCache.set(loc._id, marker);
      }
      batch.push(marker);
    });
    state.markers.addLayers(batch);
    updateHeatLayer();
    updateCrimeHeatLayer();
  }

  function updateHeatLayer() {
    if (state.heatLayer) state.map.removeLayer(state.heatLayer);
    state.heatLayer = null;
    if (!state.heatmapOn || !state.filtered.length) return;
    const pts = state.filtered.filter(l=>l.lat&&l.lon).map(l=>[l.lat,l.lon,(l.stealthRating||3)/5]);
    state.heatLayer = L.heatLayer(pts, {radius:30, blur:20, maxZoom:13,
      gradient:{0.2:'#064e3b',0.5:'#22c55e',0.8:'#f59e0b',1.0:'#ef4444'}}).addTo(state.map);
  }

  function updateCrimeHeatLayer() {
    if (state.crimeHeatLayer) state.map.removeLayer(state.crimeHeatLayer);
    state.crimeHeatLayer = null;
    if (!state.crimeHeatmapOn || !state.crimeHeatData.length) return;
    state.crimeHeatLayer = L.heatLayer(state.crimeHeatData, {radius:35, blur:25, maxZoom:14, minOpacity:0.35,
      gradient:{0.2:'#312e81',0.4:'#6d28d9',0.6:'#dc2626',0.8:'#f97316',1.0:'#fbbf24'}}).addTo(state.map);
  }

  // ═══ Detail Panel ═══
  function selectLocation(loc) {
    const panel = $('#detail-panel'), isFav = state.favorites.includes(loc._id);
    $('#detail-name').textContent = loc.name||'Unknown';
    $('#detail-type').innerHTML = `<i class="fa-solid ${typeIcon(loc._typeClass)}"></i> ${loc.type||'Unknown'} – ${loc.source||''}`;
    const favBtn = $('#btn-favorite-detail');
    favBtn.className = `detail-fav-btn ${isFav?'favorited':''}`;
    favBtn.innerHTML = `<i class="fa-${isFav?'solid':'regular'} fa-heart"></i>`;
    favBtn.onclick = () => toggleFavorite(loc._id);

    const dist = loc.distanceMiles ? distText(loc.distanceMiles) : 'N/A';
    const noteText = state.notes[loc._id] || '';
    $('#detail-body').innerHTML = `
      <div class="detail-section"><h3><i class="fa-solid fa-eye-slash"></i> Stealth Rating</h3>
        <div class="stealth-meter">${stealthBars(loc.stealthRating)}<span style="margin-left:8px;font-size:13px;font-weight:700;color:var(--green)">${loc.stealthRating||'?'}/5</span></div>
      </div>
      <div class="detail-section"><h3><i class="fa-solid fa-circle-info"></i> Information</h3>
        <div class="detail-info-row"><span class="label"><i class="fa-solid fa-route"></i> Distance</span><span class="value">${dist}</span></div>
        <div class="detail-info-row"><span class="label"><i class="fa-solid fa-map-pin"></i> Coords</span><span class="value" style="font-family:var(--font-mono);font-size:11px">${loc.lat?.toFixed(5)}, ${loc.lon?.toFixed(5)}</span></div>
        ${loc.fee?`<div class="detail-info-row"><span class="label"><i class="fa-solid fa-dollar-sign"></i> Fee</span><span class="value">${loc.fee}</span></div>`:''}
        ${loc.elevation?`<div class="detail-info-row"><span class="label"><i class="fa-solid fa-mountain"></i> Elevation</span><span class="value">${loc.elevation}ft</span></div>`:''}
        <div class="detail-info-row"><span class="label"><i class="fa-solid fa-database"></i> Source</span><span class="value">${loc.source||'Unknown'}</span></div>
      </div>
      ${loc.description?`<div class="detail-section"><h3><i class="fa-solid fa-align-left"></i> Description</h3><p style="font-size:12px;line-height:1.6">${loc.description}</p></div>`:''}
      ${loc.amenities?.length?`<div class="detail-section"><h3><i class="fa-solid fa-list-check"></i> Amenities</h3><div class="result-tags">${loc.amenities.map(a=>`<span class="result-tag"><i class="fa-solid fa-check"></i> ${a}</span>`).join('')}</div></div>`:''}
      <div class="detail-section"><h3><i class="fa-solid fa-link"></i> Actions</h3>
        <div class="detail-actions">
          <a class="detail-btn" href="https://www.google.com/maps/dir/?api=1&destination=${loc.lat},${loc.lon}" target="_blank"><i class="fa-solid fa-diamond-turn-right"></i> Directions</a>
          <a class="detail-btn" href="https://www.google.com/maps/@${loc.lat},${loc.lon},15z" target="_blank"><i class="fa-solid fa-map"></i> Google Maps</a>
          <button class="detail-btn" id="btn-copy-coords"><i class="fa-solid fa-copy"></i> Copy Coords</button>
        </div>
      </div>
      <div class="detail-section"><h3><i class="fa-solid fa-note-sticky"></i> Notes</h3>
        <div class="detail-note-area">
          <textarea id="detail-note" placeholder="Your notes...">${noteText}</textarea>
          <button class="detail-btn primary" id="btn-save-note"><i class="fa-solid fa-floppy-disk"></i> Save</button>
        </div>
      </div>`;
    show(panel);

    // Actions
    $('#btn-copy-coords')?.addEventListener('click', () => {
      navigator.clipboard.writeText(`${loc.lat},${loc.lon}`).then(() => toast('Coords copied!','success'));
    });
    $('#btn-save-note')?.addEventListener('click', () => {
      state.notes[loc._id] = $('#detail-note').value;
      localStorage.setItem('hm_notes', JSON.stringify(state.notes));
      toast('Note saved!');
    });

    // Highlight card
    $$('.result-card').forEach(c => c.classList.remove('active'));
    document.querySelector(`.result-card[data-id="${loc._id}"]`)?.classList.add('active');
    state.map.flyTo([loc.lat,loc.lon], 14, {animate:true});

    // Terrain
    fetchTerrain(loc);
  }

  async function fetchTerrain(loc) {
    try {
      const res = await fetch(`${API}/api/terrain?lat=${loc.lat}&lon=${loc.lon}`);
      const data = await res.json();
      if (data.error) return;
      const sec = document.createElement('div');
      sec.className = 'detail-section';
      let html = '<h3><i class="fa-solid fa-mountain-sun"></i> Terrain</h3>';
      if (data.elevation != null) html += `<div class="detail-info-row"><span class="label"><i class="fa-solid fa-mountain"></i> Elevation</span><span class="value">${data.elevation}m (${Math.round(data.elevation*3.281)}ft)</span></div>`;
      if (data.landUse?.coverScore != null) html += `<div class="detail-info-row"><span class="label"><i class="fa-solid fa-tree"></i> Forest Cover</span><span class="value">${Math.round(data.landUse.coverScore*100)}%</span></div>`;
      if (data.landUse?.isUrban) html += `<div class="detail-info-row"><span class="label"><i class="fa-solid fa-city"></i> Urban</span><span class="value">Yes</span></div>`;
      sec.innerHTML = html;
      $('#detail-body')?.appendChild(sec);
    } catch(e) {}
  }

  // ═══ Weather ═══
  async function fetchWeather(lat, lon) {
    try {
      const res = await fetch(`${API}/api/weather?lat=${lat}&lon=${lon}`);
      const w = await res.json();
      if (w.error) return;
      let footer = '';
      if (w.current?.temperature != null) footer += `${Math.round(w.current.temperature)}°F `;
      if (w.current?.description) footer += w.current.description;
      $('#footer-weather').textContent = footer;
      state._weather = w;
    } catch(e) {}
  }

  function showWeatherModal() {
    const w = state._weather;
    const c = $('#weather-content');
    if (!w || !state.searchCenter) { c.innerHTML = '<p class="muted-text">Search for a location first.</p>'; show($('#weather-modal')); return; }
    let html = '<div class="detail-section">';
    if (w.current) {
      html += `<h3><i class="fa-solid fa-temperature-half"></i> Current Conditions</h3>`;
      if (w.current.temperature != null) html += `<div class="detail-info-row"><span class="label">Temperature</span><span class="value">${Math.round(w.current.temperature)}°F</span></div>`;
      if (w.current.description) html += `<div class="detail-info-row"><span class="label">Conditions</span><span class="value">${w.current.description}</span></div>`;
      if (w.current.windSpeed != null) html += `<div class="detail-info-row"><span class="label">Wind</span><span class="value">${w.current.windSpeed} mph</span></div>`;
      if (w.current.humidity != null) html += `<div class="detail-info-row"><span class="label">Humidity</span><span class="value">${w.current.humidity}%</span></div>`;
    }
    if (w.sun) {
      if (w.sun.sunrise) html += `<div class="detail-info-row"><span class="label"><i class="fa-solid fa-sun"></i> Sunrise</span><span class="value">${new Date(w.sun.sunrise).toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'})}</span></div>`;
      if (w.sun.sunset) html += `<div class="detail-info-row"><span class="label"><i class="fa-solid fa-moon"></i> Sunset</span><span class="value">${new Date(w.sun.sunset).toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'})}</span></div>`;
    }
    if (w.moon) html += `<div class="detail-info-row"><span class="label">Moon</span><span class="value">${w.moon.emoji||''} ${w.moon.name||''} — ${w.moon.stealthRating||''}</span></div>`;
    html += '</div>';
    if (w.forecast?.detailedForecast) html += `<div class="detail-section"><h3><i class="fa-solid fa-calendar-days"></i> Forecast</h3><p style="font-size:12px;line-height:1.6">${w.forecast.detailedForecast}</p></div>`;
    if (w.campingAdvice) html += `<div class="detail-section"><h3><i class="fa-solid fa-person-shelter"></i> Camping Advice</h3><p style="font-size:12px;line-height:1.6;color:var(--green)">${w.campingAdvice}</p></div>`;
    c.innerHTML = html;
    show($('#weather-modal'));
  }

  // ═══ Favorites ═══
  function toggleFavorite(id) {
    const idx = state.favorites.indexOf(id);
    if (idx >= 0) state.favorites.splice(idx, 1); else state.favorites.push(id);
    localStorage.setItem('hm_favorites', JSON.stringify(state.favorites));
    applyFilters();
    toast(idx >= 0 ? 'Removed from favorites' : 'Added to favorites!');
  }

  function showFavoritesModal() {
    const c = $('#favorites-content');
    const favLocs = state.locations.filter(l => state.favorites.includes(l._id));
    if (!favLocs.length) { c.innerHTML = '<p class="muted-text"><i class="fa-regular fa-heart"></i> No favorites yet.</p>'; show($('#favorites-modal')); return; }
    c.innerHTML = favLocs.map(loc => {
      const tc = loc._typeClass;
      return `<div class="food-card" style="cursor:pointer" data-fav-id="${loc._id}">
        <div class="food-card-title"><i class="fa-solid ${typeIcon(tc)}" style="color:${markerColor(tc)}"></i> ${loc.name}</div>
        <div class="food-card-meta"><span>${loc.type||''}</span><span>${loc.source||''}</span>${loc.distanceMiles?`<span>${distText(loc.distanceMiles)}</span>`:''}</div>
      </div>`;
    }).join('');
    c.querySelectorAll('[data-fav-id]').forEach(el => el.addEventListener('click', () => {
      const loc = state.locations.find(l => l._id === el.dataset.favId);
      if (loc) { hide($('#favorites-modal')); selectLocation(loc); }
    }));
    show($('#favorites-modal'));
  }

  // ═══ Custom Spot ═══
  function saveCustomSpot() {
    const name = $('#spot-name').value.trim();
    const lat = parseFloat($('#spot-lat').value);
    const lon = parseFloat($('#spot-lon').value);
    if (!name || !isFinite(lat) || !isFinite(lon)) { toast('Fill in name and valid coordinates','error'); return; }
    const spot = {
      id: `custom-${Date.now()}`, name, lat, lon,
      type: $('#spot-type').value, stealthRating: parseInt($('#spot-stealth').value),
      description: $('#spot-description').value.trim(), source: 'Custom',
    };
    state.customSpots.push(spot);
    localStorage.setItem('hm_custom_spots', JSON.stringify(state.customSpots));
    hide($('#add-spot-modal'));
    toast(`Saved "${name}"!`, 'success');
    // Reset form
    $('#spot-name').value = ''; $('#spot-description').value = '';
  }

  // ═══ Food ═══
  function showFoodModal() {
    show($('#food-modal'));
    if (state.searchCenter) loadFoodBanks(); else $('#food-banks').innerHTML = '<p class="muted-text">Search a location first to find nearby food resources.</p>';
  }

  async function loadFoodBanks() {
    const c = $('#food-banks');
    c.innerHTML = '<div class="search-progress"><div class="spinner"></div><p>Finding food banks...</p></div>';
    try {
      const {lat,lon} = state.searchCenter;
      const res = await fetch(`${API}/api/food-banks?lat=${lat}&lon=${lon}&radius=10`);
      const data = await res.json();
      if (!data?.length && !data?.locations?.length) { c.innerHTML = '<p class="muted-text">No food banks found nearby.</p>'; return; }
      const banks = data.locations || data;
      c.innerHTML = banks.map(b => `<div class="food-card">
        <div class="food-card-title"><i class="fa-solid fa-hand-holding-heart" style="color:var(--green)"></i> ${b.name||'Food Bank'}</div>
        <div class="food-card-meta">
          ${b.address?`<span><i class="fa-solid fa-location-dot"></i> ${b.address}</span>`:''}
          ${b.phone?`<span><i class="fa-solid fa-phone"></i> ${b.phone}</span>`:''}
          ${b.hours?`<span><i class="fa-solid fa-clock"></i> ${b.hours}</span>`:''}
        </div>
        ${b.description?`<div style="font-size:11px;color:var(--text-muted);margin-top:6px">${truncate(b.description,200)}</div>`:''}
      </div>`).join('');
    } catch(e) { c.innerHTML = '<p class="muted-text">Failed to load food banks.</p>'; }
  }

  async function loadStores() {
    const c = $('#stores');
    if (!state.searchCenter) { c.innerHTML = '<p class="muted-text">Search a location first.</p>'; return; }
    c.innerHTML = '<div class="search-progress"><div class="spinner"></div><p>Finding stores...</p></div>';
    try {
      const {lat,lon} = state.searchCenter;
      const res = await fetch(`${API}/api/stores?lat=${lat}&lon=${lon}`);
      const data = await res.json();
      if (!data?.length && !data?.stores?.length) { c.innerHTML = '<p class="muted-text">No stores found nearby.</p>'; return; }
      const stores = data.stores || data;
      c.innerHTML = stores.map(s => `<div class="food-card">
        <div class="food-card-title"><i class="fa-solid fa-cart-shopping" style="color:var(--blue)"></i> ${s.name||'Store'}</div>
        <div class="food-card-meta">
          ${s.address?`<span><i class="fa-solid fa-location-dot"></i> ${s.address}</span>`:''}
          ${s.distance?`<span><i class="fa-solid fa-route"></i> ${s.distance}</span>`:''}
        </div>
      </div>`).join('');
    } catch(e) { c.innerHTML = '<p class="muted-text">Failed to load stores.</p>'; }
  }

  async function loadMealPlan() {
    const c = $('#meal-plan');
    c.innerHTML = `<div class="meal-plan-controls">
      <label>Budget: $<input type="number" id="mp-budget" value="20" min="5" max="100" step="5"></label>
      <label>Days: <input type="number" id="mp-days" value="3" min="1" max="7"></label>
      <label><input type="checkbox" id="mp-camp" checked> Camp-friendly</label>
      <button class="btn-primary" id="btn-generate-meal"><i class="fa-solid fa-dice"></i> Generate</button>
    </div><div id="meal-plan-results"></div>`;
    $('#btn-generate-meal').addEventListener('click', generateMealPlan);
  }

  async function generateMealPlan() {
    const budget = parseFloat($('#mp-budget')?.value) || 20;
    const days = parseInt($('#mp-days')?.value) || 3;
    const camp = $('#mp-camp')?.checked;
    const rc = $('#meal-plan-results');
    rc.innerHTML = '<div class="search-progress"><div class="spinner"></div><p>Optimizing meals...</p></div>';
    try {
      const res = await fetch(`${API}/api/meal-plan?budget=${budget}&days=${days}&campFriendly=${camp}&randomize=true`);
      const plan = await res.json();
      if (plan.error) { rc.innerHTML = `<p class="muted-text">${plan.error}</p>`; return; }
      let html = '';
      if (plan.plan) {
        plan.plan.forEach((day, i) => {
          html += `<div class="meal-day"><h4>Day ${i+1}</h4>`;
          ['breakfast','lunch','dinner','snack'].forEach(meal => {
            if (day[meal]) {
              const items = Array.isArray(day[meal]) ? day[meal] : [day[meal]];
              items.forEach(item => {
                html += `<div class="meal-item"><span>${item.name||item}</span><span style="color:var(--green)">${item.price?'$'+item.price.toFixed(2):''}</span></div>`;
              });
            }
          });
          html += '</div>';
        });
      }
      if (plan.totalCost != null) html += `<div class="meal-summary"><strong>Total: $${plan.totalCost.toFixed(2)}</strong> for ${days} days — ${plan.totalCalories||'~?'} cal/day avg</div>`;
      rc.innerHTML = html || '<p class="muted-text">No meal plan generated.</p>';
    } catch(e) { rc.innerHTML = '<p class="muted-text">Failed to generate meal plan.</p>'; }
  }

  async function loadFoodDb() {
    const c = $('#food-db');
    c.innerHTML = '<div class="search-progress"><div class="spinner"></div><p>Loading food database...</p></div>';
    try {
      const res = await fetch(`${API}/api/foods`);
      const foods = await res.json();
      if (!foods?.length) { c.innerHTML = '<p class="muted-text">No food data available.</p>'; return; }
      c.innerHTML = `<div style="margin-bottom:8px"><input type="text" id="food-search" placeholder="Search foods..." style="width:100%;padding:8px;background:var(--bg-input);border:1px solid var(--border);border-radius:6px;color:var(--text);font-family:var(--font);font-size:12px"></div>
      <div id="food-list">${renderFoodList(foods.slice(0,50))}</div>`;
      $('#food-search').addEventListener('input', async (e) => {
        const q = e.target.value.trim().toLowerCase();
        const filtered = foods.filter(f => (f.name||'').toLowerCase().includes(q) || (f.group||'').toLowerCase().includes(q));
        $('#food-list').innerHTML = renderFoodList(filtered.slice(0,50));
      });
    } catch(e) { c.innerHTML = '<p class="muted-text">Failed to load food database.</p>'; }
  }

  function renderFoodList(foods) {
    return foods.map(f => `<div class="food-card">
      <div class="food-card-title">${f.name||'?'}</div>
      <div class="food-card-meta">
        ${f.group?`<span><i class="fa-solid fa-tag"></i> ${f.group}</span>`:''}
        ${f.calories?`<span><i class="fa-solid fa-fire"></i> ${f.calories} cal</span>`:''}
        ${f.price?`<span><i class="fa-solid fa-dollar-sign"></i> $${f.price.toFixed(2)}</span>`:''}
        ${f.campFriendly?'<span><i class="fa-solid fa-campground"></i> Camp-friendly</span>':''}
        ${f.shelfStable?'<span><i class="fa-solid fa-box"></i> Shelf-stable</span>':''}
      </div>
    </div>`).join('');
  }

  // ═══ Stats ═══
  function showStatsModal() {
    $('#stat-total').textContent = state.locations.length;
    $('#stat-dispersed').textContent = state.locations.filter(l=>l._typeClass==='dispersed').length;
    $('#stat-free').textContent = state.locations.filter(l=>!l.fee||l.fee==='Free'||l.fee==='No').length;
    $('#stat-stealth').textContent = state.locations.filter(l=>(l.stealthRating||0)>=4).length;
    $('#stat-time').textContent = state.queryTime+'s';
    $('#stat-favs').textContent = state.favorites.length;

    // Type chart
    const tc = {}; state.locations.forEach(l => { const t = l._typeClass; tc[t]=(tc[t]||0)+1; });
    const labels = Object.keys(tc), data = Object.values(tc), colors = labels.map(markerColor);
    if (state.charts.types) state.charts.types.destroy();
    try {
      state.charts.types = new Chart($('#stats-chart'), {
        type:'doughnut', data:{ labels:labels.map(l=>l.charAt(0).toUpperCase()+l.slice(1)), datasets:[{data, backgroundColor:colors, borderWidth:0}] },
        options:{responsive:true, plugins:{legend:{position:'bottom',labels:{color:'#94a3b8',font:{family:'Outfit',size:11}}}}}
      });
    } catch(e){}

    // Source chart
    const sc = {}; state.locations.forEach(l => { const s = l.source||'?'; sc[s]=(sc[s]||0)+1; });
    const sl = Object.keys(sc), sd = Object.values(sc);
    if (state.charts.sources) state.charts.sources.destroy();
    try {
      state.charts.sources = new Chart($('#sources-chart'), {
        type:'bar', data:{ labels:sl, datasets:[{label:'Locations',data:sd,backgroundColor:['#22c55e','#3b82f6','#f59e0b','#a855f7','#06b6d4','#ef4444','#ec4899','#64748b'],borderWidth:0,borderRadius:6}] },
        options:{responsive:true, scales:{x:{ticks:{color:'#94a3b8',font:{family:'Outfit',size:9}},grid:{display:false}},y:{ticks:{color:'#94a3b8'},grid:{color:'rgba(34,197,94,0.06)'}}}, plugins:{legend:{display:false}}}
      });
    } catch(e){}

    show($('#stats-modal'));
  }

  // ═══ Guide ═══
  const GUIDE = {
    stealth: `<div class="detail-section"><h3><i class="fa-solid fa-eye-slash"></i> Stealth Camping Fundamentals</h3><ul>
      <li><strong>Arrive after dark</strong> — after 9 PM summer, 6 PM winter</li>
      <li><strong>Leave at first light</strong> — pack up by sunrise</li>
      <li><strong>No fire, no lights</strong> — red headlamp only</li>
      <li><strong>Dark gear</strong> — green, brown, black tents & tarps</li>
      <li><strong>Scout by day, camp by night</strong></li>
      <li><strong>Single-night stays only</strong></li>
      <li><strong>Pack out everything</strong> — leave no trace</li>
      <li><strong>Have an exit strategy</strong></li>
      <li><strong>Check moon phase</strong> — new moon = darkest = best stealth</li></ul></div>`,
    rules: `<div class="detail-section"><h3><i class="fa-solid fa-gavel"></i> Rules by Land Type</h3><ul>
      <li><strong>National Forest (USFS)</strong> — Dispersed camping allowed. 14-day limit. Free.</li>
      <li><strong>BLM Land</strong> — Dispersed camping allowed. 14-day limit.</li>
      <li><strong>DNR Land</strong> — Some dispersed camping. Check unit rules.</li>
      <li><strong>National Parks</strong> — Backcountry permits required.</li>
      <li><strong>State Parks</strong> — Designated sites only. Reservations needed.</li>
      <li><strong>City/County Parks</strong> — Camping usually prohibited.</li>
      <li><strong>Private Land</strong> — Need owner permission.</li>
      <li><strong>Walmart/Rest Stops</strong> — Varies by location.</li></ul></div>`,
    gear: `<div class="detail-section"><h3><i class="fa-solid fa-backpack"></i> Gear Checklist</h3><ul>
      <li><strong>Shelter:</strong> Dark bivy/tarp/tent</li>
      <li><strong>Sleep:</strong> 20°F bag + insulated pad</li>
      <li><strong>Light:</strong> Red headlamp</li>
      <li><strong>Water:</strong> Filter + 2L capacity</li>
      <li><strong>Food:</strong> No-cook or small stove</li>
      <li><strong>Navigation:</strong> Map + compass</li>
      <li><strong>Layers:</strong> Rain shell, insulation, base layer</li>
      <li><strong>First Aid:</strong> Kit + emergency blanket + whistle</li>
      <li><strong>Tools:</strong> Multi-tool, paracord 50ft, trash bags</li>
      <li><strong>Comms:</strong> Charged phone + battery. PLB for remote</li></ul></div>`,
    safety: `<div class="detail-section"><h3><i class="fa-solid fa-shield-heart"></i> Safety</h3><ul>
      <li><strong>Tell someone</strong> your plans</li>
      <li><strong>Wildlife:</strong> Hang food 200ft from camp in bear country</li>
      <li><strong>Rivers</strong> rise fast with rain</li>
      <li><strong>Hypothermia</strong> is #1 outdoor killer. Wet+wind+cold = danger</li>
      <li><strong>Fire safety</strong> — check burn ban status</li>
      <li><strong>Leave No Trace</strong></li>
      <li><strong>Trust your gut</strong> — if a spot feels wrong, move on</li></ul></div>
      <div class="detail-section"><h3><i class="fa-solid fa-triangle-exclamation"></i> Danger Zones</h3><ul>
      <li><strong>Flood zones</strong> — Avoid riverbanks during rain</li>
      <li><strong>Landslide areas</strong> — Steep hillsides after rain</li>
      <li><strong>Railroad right-of-way</strong> — Trains are silent until close</li>
      <li><strong>Abandoned structures</strong> — Collapse, asbestos, squatters</li></ul></div>`,
    fire: `<div class="detail-section"><h3><i class="fa-solid fa-fire"></i> Fire Starting</h3>
      <p style="color:var(--red);font-size:11px;margin-bottom:8px"><i class="fa-solid fa-triangle-exclamation"></i> Always check burn bans before making fire.</p>
      <div class="guide-card"><h4>Ferro Rod</h4><p>Prepare tinder bundle → hold rod close → push rod back (not striker forward) → sparks hit tinder → blow gently → add sticks</p></div>
      <div class="guide-card"><h4>Dakota Fire Hole (Stealth!)</h4><p>Dig two holes 12" deep, 8" apart, connected by tunnel. Fire in one, air feeds from other. <strong>Almost invisible at night.</strong></p></div>
      <div class="guide-card"><h4>Finding Dry Fuel</h4><ul>
        <li>Standing dead wood — drier than ground wood</li>
        <li>Fatwood — resinous heartwood, burns even wet</li>
        <li>Birch bark — oils ignite readily even damp</li>
        <li>Bring vaseline cotton balls — waterproof, 3+ min burn</li></ul></div></div>`,
    firstaid: `<div class="detail-section"><h3><i class="fa-solid fa-kit-medical"></i> First Aid</h3>
      <div class="guide-card"><h4>Cuts</h4><p>Stop bleeding (direct pressure 10+ min) → Clean (flush with water) → Close (butterfly strips) → Cover (antibiotic + gauze) → Monitor for infection</p></div>
      <div class="guide-card"><h4>Hypothermia (#1 Killer)</h4><ul>
        <li><strong>Mild:</strong> Shivering, cold hands — self-rescue possible</li>
        <li><strong>Moderate:</strong> Confusion, slurred speech — need help NOW</li>
        <li><strong>Severe:</strong> Shivering stops — 911 emergency</li></ul>
        <p>Treatment: Get shelter → Remove wet clothes → Warm core (armpits, groin, neck) → Warm drinks if conscious → Handle gently</p></div>
      <div class="guide-card"><h4>RICE for Sprains</h4><p><strong>R</strong>est, <strong>I</strong>ce, <strong>C</strong>ompression, <strong>E</strong>levation. Splint suspected fractures with sticks/poles.</p></div></div>`
  };

  function showGuide(section='stealth') {
    $('#guide-content').innerHTML = GUIDE[section] || GUIDE.stealth;
    $$('.guide-tab').forEach(t => t.classList.toggle('active', t.dataset.guide === section));
    show($('#guide-modal'));
  }

  // ═══ Theme ═══
  function isLightTheme() {
    if (typeof OpenVibeThemeLoader !== 'undefined') {
      const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg-primary').trim();
      if (bg && bg.startsWith('#') && bg.length >= 7) {
        const r = parseInt(bg.substr(1, 2), 16), g = parseInt(bg.substr(3, 2), 16), b = parseInt(bg.substr(5, 2), 16);
        return (r * 299 + g * 587 + b * 114) / 1000 > 128;
      }
    }
    return false;
  }

  function toggleTheme() {
    const wasLight = isLightTheme();
    if (typeof OpenVibeThemeLoader !== 'undefined') {
      const next = wasLight ? 'campfire' : 'daylight';
      OpenVibeThemeLoader.apply(next);
      OpenVibeThemeLoader.save(next);
    }
    const nowLight = isLightTheme();
    if (state.map && !state.satelliteOn) {
      state.map.removeLayer(wasLight ? state.lightTiles : state.darkTiles);
      state.map.addLayer(nowLight ? state.lightTiles : state.darkTiles);
    }
    $('#btn-theme').querySelector('i').className = nowLight ? 'fa-solid fa-sun' : 'fa-solid fa-moon';
  }

  // ═══ Event Binding ═══
  function bindEvents() {
    // Search
    $('#btn-search').addEventListener('click', () => performSearch($('#search-input').value));
    $('#search-input').addEventListener('keydown', e => { if (e.key === 'Enter') performSearch($('#search-input').value); });
    $('#btn-my-location').addEventListener('click', () => {
      navigator.geolocation.getCurrentPosition(pos => {
        const c = `${pos.coords.latitude.toFixed(5)}, ${pos.coords.longitude.toFixed(5)}`;
        $('#search-input').value = c; performSearch(c);
      }, () => toast('Could not get location','error'), {enableHighAccuracy:true,timeout:10000});
    });

    // Quick searches
    $$('.quick-btn').forEach(btn => btn.addEventListener('click', () => {
      const q = btn.dataset.query; $('#search-input').value = q; performSearch(q);
    }));

    // Filters
    $$('.filter-chip').forEach(chip => chip.addEventListener('click', () => {
      $$('.filter-chip').forEach(c=>c.classList.remove('active')); chip.classList.add('active');
      state.activeFilter = chip.dataset.filter; applyFilters();
    }));
    $('#sort-by').addEventListener('change', e => { state.sortBy = e.target.value; applyFilters(); });

    // Heatmap toggles
    $('#btn-heatmap').addEventListener('click', () => {
      state.heatmapOn = !state.heatmapOn; $('#btn-heatmap').classList.toggle('active'); updateHeatLayer();
    });
    $('#btn-crime-heatmap').addEventListener('click', () => {
      state.crimeHeatmapOn = !state.crimeHeatmapOn; $('#btn-crime-heatmap').classList.toggle('active'); updateCrimeHeatLayer();
    });
    $('#btn-satellite').addEventListener('click', () => {
      state.satelliteOn = !state.satelliteOn; $('#btn-satellite').classList.toggle('active');
      const light = isLightTheme();
      if (state.satelliteOn) {
        state.map.removeLayer(light?state.lightTiles:state.darkTiles);
        state.map.addLayer(state.satelliteTiles);
      } else {
        state.map.removeLayer(state.satelliteTiles);
        state.map.addLayer(light?state.lightTiles:state.darkTiles);
      }
    });

    // Header buttons
    $('#btn-weather').addEventListener('click', showWeatherModal);
    $('#btn-food').addEventListener('click', showFoodModal);
    $('#btn-favorites').addEventListener('click', showFavoritesModal);
    $('#btn-add-spot').addEventListener('click', () => show($('#add-spot-modal')));
    $('#btn-save-spot').addEventListener('click', saveCustomSpot);
    $('#btn-guide').addEventListener('click', () => showGuide());
    $('#btn-stats').addEventListener('click', showStatsModal);
    $('#btn-theme').addEventListener('click', toggleTheme);

    // Detail panel close
    $('#btn-detail-close').addEventListener('click', () => {
      hide($('#detail-panel'));
      $$('.result-card').forEach(c=>c.classList.remove('active'));
    });

    // Modal close (generic)
    $$('.modal-close').forEach(btn => btn.addEventListener('click', () => {
      btn.closest('.modal').classList.add('hidden');
    }));
    $$('.modal').forEach(modal => modal.addEventListener('click', e => {
      if (e.target === modal) modal.classList.add('hidden');
    }));

    // Food tabs
    $$('.food-tab').forEach(tab => tab.addEventListener('click', () => {
      $$('.food-tab').forEach(t=>t.classList.remove('active')); tab.classList.add('active');
      $$('.food-panel').forEach(p=>p.classList.add('hidden'));
      const panel = $(`#${tab.dataset.tab}`); if (panel) panel.classList.remove('hidden');
      // Lazy load
      if (tab.dataset.tab === 'stores') loadStores();
      if (tab.dataset.tab === 'meal-plan') loadMealPlan();
      if (tab.dataset.tab === 'food-db') loadFoodDb();
      if (tab.dataset.tab === 'food-banks' && state.searchCenter) loadFoodBanks();
    }));

    // Guide tabs
    $$('.guide-tab').forEach(tab => tab.addEventListener('click', () => showGuide(tab.dataset.guide)));

    // Result card clicks (delegated)
    $('#results-list').addEventListener('click', e => {
      const card = e.target.closest('.result-card');
      const favBtn = e.target.closest('.result-fav-btn');
      if (favBtn) { e.stopPropagation(); toggleFavorite(favBtn.dataset.fav); return; }
      if (card) {
        const idx = parseInt(card.dataset.idx);
        if (state.filtered[idx]) selectLocation(state.filtered[idx]);
      }
    });
  }

  // ═══ Init ═══
  function init() {
    // Theme icon reflects current theme-loader state
    if (isLightTheme()) {
      const icon = $('#btn-theme')?.querySelector('i');
      if (icon) icon.className = 'fa-solid fa-sun';
    }
    bindEvents();
    initSplash();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
