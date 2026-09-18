/**
 * Food.OpenVibe — Budget Grocery & Meal Planning App
 */
(() => {
  'use strict';

  const API = '';
  const $ = s => document.querySelector(s);
  const $$ = s => document.querySelectorAll(s);

  const state = {
    location: null, // {lat, lon, name}
    foods: [],
    foodMap: null,
    foodBankMarkers: [],
    storeMarkers: [],
  };

  function toast(msg, type = 'info') {
    const bg = { info: '#22c55e', error: '#ef4444', warn: '#f59e0b' };
    Toastify({ text: msg, duration: 3000, gravity: 'bottom', position: 'right',
      style: { background: bg[type] || bg.info, borderRadius: '10px', fontFamily: "'Outfit',sans-serif", fontSize: '12px', padding: '8px 16px' }
    }).showToast();
  }

  // ═══ Location ═══
  async function searchLocation(query) {
    if (!query?.trim()) return;
    try {
      const res = await fetch(`${API}/api/geocode?q=${encodeURIComponent(query.trim())}`);
      const data = await res.json();
      if (!data?.length) { toast('Location not found', 'error'); return; }
      state.location = { lat: data[0].lat, lon: data[0].lon, name: data[0].name };
      toast(`Location: ${state.location.name}`);
      // Auto-load current tab
      const activeTab = $('.tab.active')?.dataset.tab;
      if (activeTab === 'food-banks') loadFoodBanks();
      else if (activeTab === 'stores') loadStores();
      else if (activeTab === 'map') loadMap();
      else loadFoodBanks(); // default
    } catch (e) { toast('Geocode failed', 'error'); }
  }

  // ═══ Food Banks ═══
  async function loadFoodBanks() {
    if (!state.location) { $('#food-banks-list').innerHTML = '<div class="empty-state"><i class="fa-solid fa-location-dot fa-3x"></i><p>Enter your location above to find nearby food banks</p></div>'; return; }
    const c = $('#food-banks-list');
    c.innerHTML = '<div class="loading-state"><div class="spinner"></div><p>Finding food banks...</p></div>';
    try {
      const { lat, lon } = state.location;
      const res = await fetch(`${API}/api/food-banks?lat=${lat}&lon=${lon}&radius=10`);
      const data = await res.json();
      const banks = data?.locations || data || [];
      if (!banks.length) { c.innerHTML = '<div class="empty-state"><i class="fa-solid fa-hand-holding-heart fa-3x"></i><p>No food banks found within 10 miles. Try a different location.</p></div>'; return; }
      c.innerHTML = banks.map(b => `<div class="card">
        <div class="card-title"><i class="fa-solid fa-hand-holding-heart" style="color:var(--green)"></i> ${b.name || 'Food Bank'}</div>
        <div class="card-meta">
          ${b.address ? `<span><i class="fa-solid fa-location-dot"></i> ${b.address}</span>` : ''}
          ${b.phone ? `<span><i class="fa-solid fa-phone"></i> ${b.phone}</span>` : ''}
          ${b.hours ? `<span><i class="fa-solid fa-clock"></i> ${b.hours}</span>` : ''}
          ${b.distanceMiles ? `<span><i class="fa-solid fa-route"></i> ${b.distanceMiles.toFixed(1)} mi</span>` : ''}
        </div>
        ${b.description ? `<div class="card-desc">${b.description}</div>` : ''}
        <div class="card-actions">
          ${b.lat && b.lon ? `<a class="card-btn" href="https://www.google.com/maps/dir/?api=1&destination=${b.lat},${b.lon}" target="_blank"><i class="fa-solid fa-diamond-turn-right"></i> Directions</a>` : ''}
          ${b.website ? `<a class="card-btn" href="${b.website}" target="_blank"><i class="fa-solid fa-globe"></i> Website</a>` : ''}
        </div>
      </div>`).join('');
    } catch (e) { c.innerHTML = '<div class="empty-state"><p>Failed to load food banks.</p></div>'; }
  }

  // ═══ Stores ═══
  async function loadStores() {
    if (!state.location) { $('#stores-list').innerHTML = '<div class="empty-state"><i class="fa-solid fa-cart-shopping fa-3x"></i><p>Enter your location to find nearby stores</p></div>'; return; }
    const c = $('#stores-list');
    c.innerHTML = '<div class="loading-state"><div class="spinner"></div><p>Finding stores...</p></div>';
    try {
      const { lat, lon } = state.location;
      const res = await fetch(`${API}/api/stores?lat=${lat}&lon=${lon}`);
      const data = await res.json();
      const stores = data?.stores || data || [];
      if (!stores.length) { c.innerHTML = '<div class="empty-state"><p>No stores found nearby.</p></div>'; return; }
      const storeColors = { walmart: '#0071dc', 'fred meyer': '#e21836', fredmeyer: '#e21836', safeway: '#e8351e', 'dollar tree': '#00a651', dollartree: '#00a651', 'grocery outlet': '#ff6600', groceryoutlet: '#ff6600' };
      c.innerHTML = stores.map(s => {
        const key = (s.chain || s.name || '').toLowerCase().replace(/\s+/g, '');
        const color = storeColors[key] || 'var(--text-muted)';
        return `<div class="card">
          <div class="card-title"><i class="fa-solid fa-store" style="color:${color}"></i> ${s.name || 'Store'}</div>
          <div class="card-meta">
            ${s.address ? `<span><i class="fa-solid fa-location-dot"></i> ${s.address}</span>` : ''}
            ${s.distance ? `<span><i class="fa-solid fa-route"></i> ${s.distance}</span>` : ''}
            ${s.phone ? `<span><i class="fa-solid fa-phone"></i> ${s.phone}</span>` : ''}
          </div>
          <div class="card-actions">
            ${s.lat && s.lon ? `<a class="card-btn" href="https://www.google.com/maps/dir/?api=1&destination=${s.lat},${s.lon}" target="_blank"><i class="fa-solid fa-diamond-turn-right"></i> Directions</a>` : ''}
          </div>
        </div>`;
      }).join('');
    } catch (e) { c.innerHTML = '<div class="empty-state"><p>Failed to load stores.</p></div>'; }
  }

  // ═══ Meal Planner ═══
  async function generateMealPlan() {
    const budget = parseFloat($('#mp-budget')?.value) || 20;
    const days = parseInt($('#mp-days')?.value) || 3;
    const camp = $('#mp-camp')?.checked;
    const shelf = $('#mp-shelf')?.checked;
    const rc = $('#meal-results');
    rc.innerHTML = '<div class="loading-state"><div class="spinner"></div><p>Optimizing meals...</p></div>';
    try {
      const res = await fetch(`${API}/api/meal-plan?budget=${budget}&days=${days}&campFriendly=${camp}&shelfStable=${shelf}&randomize=true`);
      const plan = await res.json();
      if (plan.error) { rc.innerHTML = `<div class="empty-state"><p>${plan.error}</p></div>`; return; }
      let html = '';
      if (plan.plan) {
        plan.plan.forEach((day, i) => {
          html += `<div class="meal-day-card"><h3><i class="fa-solid fa-sun"></i> Day ${i + 1}</h3>`;
          for (const [meal, items] of Object.entries(day)) {
            const arr = Array.isArray(items) ? items : [items];
            arr.forEach(item => {
              const name = typeof item === 'string' ? item : item.name;
              const price = item?.price ? `$${item.price.toFixed(2)}` : '';
              const cal = item?.calories ? `${item.calories} cal` : '';
              html += `<div class="meal-row">
                <span class="meal-name"><strong>${meal}:</strong> ${name}</span>
                <span class="meal-meta"><span class="meal-price">${price}</span><span>${cal}</span></span>
              </div>`;
            });
          }
          html += '</div>';
        });
      }
      if (plan.totalCost != null) {
        html += `<div class="meal-summary-bar">
          <span><span class="meal-label">Total Cost:</span> $${plan.totalCost.toFixed(2)}</span>
          <span>${days} days</span>
          ${plan.totalCalories ? `<span>~${Math.round(plan.totalCalories / days)} cal/day</span>` : ''}
          <span>Budget: <span class="meal-label">$${budget}</span></span>
        </div>`;
      }
      rc.innerHTML = html || '<div class="empty-state"><p>No meal plan generated.</p></div>';
    } catch (e) { rc.innerHTML = '<div class="empty-state"><p>Failed to generate meal plan.</p></div>'; }
  }

  // ═══ Food Database ═══
  let allFoods = [];
  let activeGroup = 'all';

  async function loadFoodDb() {
    const c = $('#food-list');
    c.innerHTML = '<div class="loading-state"><div class="spinner"></div><p>Loading food database...</p></div>';
    try {
      const res = await fetch(`${API}/api/foods`);
      allFoods = await res.json();
      renderFoodTable(allFoods);
    } catch (e) { c.innerHTML = '<div class="empty-state"><p>Failed to load food database.</p></div>'; }
  }

  function filterFoods() {
    const q = ($('#food-search')?.value || '').toLowerCase();
    const campOnly = $('#db-camp')?.checked;
    const shelfOnly = $('#db-shelf')?.checked;
    let list = allFoods;
    if (activeGroup !== 'all') list = list.filter(f => f.group === activeGroup);
    if (q) list = list.filter(f => (f.name || '').toLowerCase().includes(q) || (f.group || '').toLowerCase().includes(q) || (f.tags || []).some(t => t.includes(q)));
    if (campOnly) list = list.filter(f => f.campFriendly >= 3);
    if (shelfOnly) list = list.filter(f => f.shelfStable);
    renderFoodTable(list);
  }

  function renderFoodTable(foods) {
    const stores = ['walmart', 'fredmeyer', 'safeway', 'dollartree', 'groceryoutlet'];
    const storeNames = ['Walmart', 'Fred M.', 'Safeway', 'Dollar T.', 'Groc. Out.'];
    let html = `<table class="food-table"><thead><tr>
      <th>Food</th><th>Group</th><th>Cal</th><th>Protein</th><th>Servings</th>
      ${storeNames.map(n => `<th>${n}</th>`).join('')}
      <th>Camp</th><th>Shelf</th>
    </tr></thead><tbody>`;
    foods.forEach(f => {
      const prices = f.prices || {};
      const validPrices = stores.map(s => prices[s]).filter(p => p != null && p > 0);
      const bestPrice = validPrices.length ? Math.min(...validPrices) : null;
      const campStars = (f.campFriendly || 0);
      html += `<tr>
        <td><strong>${f.name || '?'}</strong>${f.servingSize ? `<br><span style="color:var(--text-muted);font-size:10px">${f.servingSize}</span>` : ''}</td>
        <td><span class="food-group-badge ${f.group || ''}">${f.group || '?'}</span></td>
        <td>${f.calories || '-'}</td>
        <td>${f.proteinG ? f.proteinG + 'g' : '-'}</td>
        <td>${f.servings || '-'}</td>
        ${stores.map(s => {
          const p = prices[s];
          if (p == null) return '<td class="price-cell price-na">—</td>';
          const isBest = p === bestPrice;
          return `<td class="price-cell ${isBest ? 'price-best' : ''}">$${p.toFixed(2)}</td>`;
        }).join('')}
        <td>${Array.from({length:5},(_,i)=>`<i class="fa-solid fa-campground camp-stars ${i<campStars?'':'dim'}"></i>`).join('')}</td>
        <td>${f.shelfStable ? '<i class="fa-solid fa-check" style="color:var(--green)"></i>' : '<i class="fa-solid fa-xmark" style="color:var(--border-light)"></i>'}</td>
      </tr>`;
    });
    html += '</tbody></table>';
    $('#food-list').innerHTML = html;
  }

  // ═══ Map ═══
  function loadMap() {
    if (!state.foodMap) {
      const tiles = isLightTheme()
        ? L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution:'&copy; OSM' })
        : L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', { attribution:'&copy; CARTO' });
      state.foodMap = L.map('food-map', { center: [44, -103], zoom: 4, layers: [tiles] });
    }
    if (state.location) {
      state.foodMap.setView([state.location.lat, state.location.lon], 12);
      // Add marker
      L.marker([state.location.lat, state.location.lon]).addTo(state.foodMap).bindPopup(`<b>${state.location.name}</b>`).openPopup();
    }
    setTimeout(() => state.foodMap.invalidateSize(), 200);
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
    if (typeof OpenVibeThemeLoader !== 'undefined') {
      const next = isLightTheme() ? 'campfire' : 'daylight';
      OpenVibeThemeLoader.apply(next);
      OpenVibeThemeLoader.save(next);
    }
    const icon = $('#btn-theme')?.querySelector('i');
    if (icon) icon.className = isLightTheme() ? 'fa-solid fa-sun' : 'fa-solid fa-moon';
  }

  // ═══ Events ═══
  function bindEvents() {
    // Location search
    $('#btn-loc-search').addEventListener('click', () => searchLocation($('#loc-input').value));
    $('#loc-input').addEventListener('keydown', e => { if (e.key === 'Enter') searchLocation($('#loc-input').value); });
    $('#btn-gps').addEventListener('click', () => {
      navigator.geolocation.getCurrentPosition(pos => {
        const c = `${pos.coords.latitude.toFixed(5)}, ${pos.coords.longitude.toFixed(5)}`;
        $('#loc-input').value = c; searchLocation(c);
      }, () => toast('Could not get location', 'error'), { enableHighAccuracy: true, timeout: 10000 });
    });

    // Tabs
    $$('.tab').forEach(tab => tab.addEventListener('click', () => {
      $$('.tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      $$('.panel').forEach(p => p.classList.remove('active'));
      const panel = $(`#${tab.dataset.tab}`);
      if (panel) panel.classList.add('active');
      // Lazy load
      if (tab.dataset.tab === 'food-banks') loadFoodBanks();
      if (tab.dataset.tab === 'stores') loadStores();
      if (tab.dataset.tab === 'food-db' && !allFoods.length) loadFoodDb();
      if (tab.dataset.tab === 'map') loadMap();
    }));

    // Meal planner
    $('#btn-generate').addEventListener('click', generateMealPlan);

    // Food DB filters
    $$('.chip[data-group]').forEach(c => c.addEventListener('click', () => {
      $$('.chip[data-group]').forEach(x => x.classList.remove('active'));
      c.classList.add('active');
      activeGroup = c.dataset.group;
      filterFoods();
    }));
    $('#food-search')?.addEventListener('input', filterFoods);
    $('#db-camp')?.addEventListener('change', filterFoods);
    $('#db-shelf')?.addEventListener('change', filterFoods);

    // Theme
    $('#btn-theme')?.addEventListener('click', toggleTheme); // theme switching lives in the shared navbar now
  }

  // ═══ Init ═══
  function init() {
    // Theme icon reflects current theme-loader state
    if (isLightTheme()) {
      const icon = $('#btn-theme')?.querySelector('i');
      if (icon) icon.className = 'fa-solid fa-sun';
    }
    bindEvents();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
