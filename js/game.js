// World Cities: name as many cities as you can. Each one lights up on the map as a dot
// sized by population, and the score is the share of the world's city population you've named.
(() => {
  'use strict';

  const DATA = window.WORLD_CITIES;
  const WORLD_URL = 'https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/countries-50m.json';
  const STORAGE_KEY = 'world-cities:v1';
  const CONTINENTS = [
    ['AS', 'Asia'], ['AF', 'Africa'], ['EU', 'Europe'],
    ['NA', 'North America'], ['SA', 'South America'], ['OC', 'Oceania'],
  ];
  const MILESTONES = [
    [10e6, 'Cities over 10 million'], [5e6, 'Cities over 5 million'], [1e6, 'Cities over 1 million'],
    [500e3, 'Cities over 500,000'], [100e3, 'Cities over 100,000'],
  ];
  const MAX_ZOOM = 48;
  const PULSE_MS = 1400;
  const MAX_LABELS = 220;
  const LABEL_FONT = '600 12px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
  const fmt = new Intl.NumberFormat('en-US');

  const $ = (id) => document.getElementById(id);
  const feedbackEl = $('feedback');

  if (!DATA || !window.d3 || !window.topojson) {
    feedbackEl.textContent = 'The game could not load. Check your connection and reload the page.';
    feedbackEl.className = 'feedback bad';
    return;
  }

  // ---------- name matching (mirror of normalise() in tools/build_cities.py) ----------

  const SPECIAL = {
    'ß': 'ss', 'æ': 'ae', 'œ': 'oe', 'ø': 'o', 'ł': 'l', 'đ': 'd', 'ð': 'd',
    'þ': 'th', 'ı': 'i', 'ħ': 'h', 'ŧ': 't', 'ŀ': 'l', 'ƒ': 'f',
  };
  const SWAPS = { st: 'saint', ste: 'sainte', mt: 'mount', ft: 'fort' };

  function normalise(text) {
    return text.toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '')
      .replace(/[ßæœøłđðþıħŧŀƒ]/g, (ch) => SPECIAL[ch])
      .replace(/['’‘ʻʼ`´ʿʾ]/g, '')
      .split(/[^a-z0-9]+/).filter(Boolean)
      .map((t) => SWAPS[t] || t).join(' ');
  }

  // ---------- data ----------

  const countries = DATA.countries.map(([code, name, continent, keys]) => ({
    code, name, continent, keys: new Set(keys.split('|')), total: 0,
  }));
  const admins = DATA.admins.map(([name, keys]) => ({ name, keys: new Set(keys.split('|')) }));
  // cities arrive sorted by population, biggest first
  const cities = DATA.cities.map(([id, name, ci, ai, lat, lon, pop, capital, keys]) => ({
    id, name, lat, lon, pop,
    capital: capital === 1,
    country: countries[ci],
    admin: ai >= 0 ? admins[ai] : null,
    keys: keys.split('|'),
    found: false,
    x: 0, y: 0, r0: 0, tw: 0,
  }));

  const byId = new Map(cities.map((c) => [c.id, c]));
  const byKey = new Map();
  for (const c of cities) {
    for (const k of c.keys) {
      const list = byKey.get(k);
      if (list) list.push(c); else byKey.set(k, [c]);
    }
  }

  const maxPop = cities[0].pop;
  let totalPop = 0;
  const continentTotals = {};
  for (const c of cities) {
    totalPop += c.pop;
    c.country.total += c.pop;
    continentTotals[c.country.continent] = (continentTotals[c.country.continent] || 0) + c.pop;
  }
  const capitalsTotal = cities.filter((c) => c.capital).length;
  const milestoneTotals = MILESTONES.map(([min]) => cities.filter((c) => c.pop >= min).length);

  // ---------- state ----------

  const state = { found: [], byPop: [], reveal: false, labels: true, pulses: [] };

  function load() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      if (!saved) return;
      for (const id of saved.found || []) {
        const c = byId.get(id);
        if (c && !c.found) { c.found = true; state.found.push(c); }
      }
      if (typeof saved.labels === 'boolean') state.labels = saved.labels;
    } catch (e) { /* storage blocked or corrupt: start fresh */ }
  }

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        found: state.found.map((c) => c.id), labels: state.labels,
      }));
    } catch (e) { /* storage blocked: progress just won't persist */ }
  }

  // ---------- guessing ----------

  function lookup(key) {
    const alt = key.endsWith(' city') ? key.slice(0, -5) : key + ' city';
    for (const k of [key, alt]) {
      const list = byKey.get(k);
      if (list) return { key: k, list };
    }
    return { key, list: [] };
  }

  // "Kingston" adds the biggest Kingston; again adds the next one; "Kingston, Canada" or a
  // country picked in the dropdown narrows it; "Every country" adds every Kingston at once.
  function guess(raw) {
    const comma = raw.indexOf(',');
    const namePart = comma >= 0 ? raw.slice(0, comma) : raw;
    const qualifierRaw = comma >= 0 ? raw.slice(comma + 1).trim() : '';
    const qualifier = normalise(qualifierRaw);
    const scope = $('scope').value;
    const { key, list } = lookup(normalise(namePart));

    let matches = key ? list : [];
    if (qualifier) {
      matches = matches.filter((c) => c.country.keys.has(qualifier) || (c.admin && c.admin.keys.has(qualifier)));
    }
    let where = qualifierRaw;
    if (scope !== 'any' && scope !== 'every') {
      matches = matches.filter((c) => c.country.code === scope);
      where = where || $('scope').selectedOptions[0].textContent;
    }
    if (!matches.length) return { status: 'missing', name: namePart.trim(), where };

    const isPrimary = (c) => c.keys[0] === key;
    let picks;
    if (scope === 'every') {
      picks = matches.filter((c, i) => (i === 0 || isPrimary(c)) && !c.found);
    } else if (!matches[0].found) {
      picks = [matches[0]];
    } else {
      const next = matches.find((c) => isPrimary(c) && !c.found);
      picks = next ? [next] : [];
    }
    if (!picks.length) return { status: 'repeat', city: matches[0] };

    const now = performance.now();
    for (const c of picks) {
      c.found = true;
      state.found.push(c);
      state.pulses.push({ c, t0: now });
    }
    save();
    update();
    missedLayer.dirty = true;
    requestDraw();
    return { status: 'added', cities: picks, name: namePart.trim() };
  }

  function showFeedback(result) {
    let html;
    let tone = '';
    if (result.status === 'added') {
      const picks = result.cities;
      const pop = picks.reduce((s, c) => s + c.pop, 0);
      tone = 'good';
      html = picks.length === 1
        ? `✓ <b>${esc(picks[0].name)}</b>, ${esc(place(picks[0]))} · ${fmt.format(pop)} people`
        : `✓ <b>${picks.length} cities</b> named ${esc(result.name)} · ${fmt.format(pop)} people`;
    } else if (result.status === 'repeat') {
      html = `You already named <b>${esc(result.city.name)}</b>, ${esc(place(result.city))}`;
    } else {
      tone = 'bad';
      html = `No city called “${esc(result.name)}”${result.where ? ` in ${esc(result.where)}` : ''} with 15,000+ people`;
    }
    feedbackEl.innerHTML = html;
    feedbackEl.className = 'feedback ' + tone;
  }

  // ---------- helpers ----------

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  }

  // "Maine, United States" (skips the region when it just repeats the city name)
  function place(c) {
    const parts = [];
    if (c.admin && normalise(c.admin.name) !== normalise(c.name)) parts.push(c.admin.name);
    parts.push(c.country.name);
    return parts.join(', ');
  }

  function pct(part, whole) {
    const p = whole ? (part / whole) * 100 : 0;
    return (p > 0 && p < 0.01 ? '<0.01' : p.toFixed(2)) + '%';
  }

  function plural(n, one, many) { return `${fmt.format(n)} ${n === 1 ? one : many}`; }

  // ---------- stats panels ----------

  function cityRow(c) {
    const star = c.capital ? '<span class="star" title="Capital">★</span>' : '';
    return `<li><button type="button" class="city-link" data-id="${c.id}">`
      + `<span class="nm">${esc(c.name)}${star}</span><span class="pop">${fmt.format(c.pop)}</span>`
      + `<span class="sub">${esc(place(c))}</span></button></li>`;
  }

  function cityList(list, empty) {
    return list.length ? list.map(cityRow).join('') : `<li class="empty">${empty}</li>`;
  }

  function update() {
    const found = state.found;
    state.byPop = [...found].sort((a, b) => b.pop - a.pop);
    const foundPop = found.reduce((s, c) => s + c.pop, 0);
    const share = pct(foundPop, totalPop);

    $('stat-count').textContent = fmt.format(found.length);
    $('stat-pop').textContent = fmt.format(foundPop);
    $('stat-pct').textContent = share;
    $('progress-bar').style.width = Math.min(100, (foundPop / totalPop) * 100) + '%';
    $('score-line').innerHTML = `You named <b>${plural(found.length, 'city', 'cities')}</b>, with a total population of `
      + `<b>${fmt.format(foundPop)}</b> (<b>${share}</b> of the world's city population).`;

    // continents
    const contFound = {};
    for (const c of found) contFound[c.country.continent] = (contFound[c.country.continent] || 0) + c.pop;
    $('continents').innerHTML = CONTINENTS.map(([code, name]) => {
      const total = continentTotals[code] || 0;
      const p = total ? ((contFound[code] || 0) / total) * 100 : 0;
      return `<li><div class="row"><span>${name}</span><span>${pct(contFound[code] || 0, total)}</span></div>`
        + `<div class="track"><div class="fill" style="width:${Math.min(100, p)}%"></div></div></li>`;
    }).join('');

    // milestones
    const countriesFound = new Set(found.map((c) => c.country)).size;
    const rows = MILESTONES.map(([min, label], i) => [label, found.filter((c) => c.pop >= min).length, milestoneTotals[i]]);
    rows.push(['Capitals', found.filter((c) => c.capital).length, capitalsTotal]);
    rows.push(['Countries & territories', countriesFound, countries.length]);
    $('milestones').innerHTML = rows.map(([label, n, total]) =>
      `<li><span>${label}</span><span>${fmt.format(n)} of ${fmt.format(total)}</span></li>`).join('');

    // city lists
    $('biggest').innerHTML = cityList(state.byPop.slice(0, 10), 'Name a city to get started.');
    $('smallest').innerHTML = cityList(state.byPop.slice(-10).reverse(), 'Nothing yet.');
    $('mine').innerHTML = cityList([...found].reverse(), 'Your cities will appear here.');
    $('mine-count').textContent = found.length ? `(${fmt.format(found.length)})` : '';

    $('missed-panel').hidden = !state.reveal;
    if (state.reveal) {
      const missed = [];
      for (const c of cities) {
        if (!c.found) missed.push(c);
        if (missed.length === 10) break;
      }
      $('missed').innerHTML = cityList(missed, 'You named every city. Wow.');
    }

    // best countries
    const perCountry = new Map();
    for (const c of found) {
      const e = perCountry.get(c.country) || { n: 0, pop: 0 };
      e.n += 1; e.pop += c.pop;
      perCountry.set(c.country, e);
    }
    const best = [...perCountry].sort((a, b) => b[1].n - a[1].n || b[1].pop - a[1].pop).slice(0, 10);
    $('countries').innerHTML = best.length
      ? best.map(([co, e]) => `<li><span class="nm">${esc(co.name)}</span>`
        + `<span class="val">${plural(e.n, 'city', 'cities')} · ${pct(e.pop, co.total)}</span></li>`).join('')
      : '<li class="empty">Nothing yet.</li>';
  }

  // ---------- map ----------

  const wrap = $('map-wrap');
  const canvas = $('map');
  const ctx = canvas.getContext('2d');
  const tooltip = $('tooltip');
  const projection = d3.geoNaturalEarth1();
  // frame the inhabited world: full width at the equator, from the Arctic down to Cape Horn
  const FRAME = { type: 'MultiPoint', coordinates: [[-180, 0], [180, 0], [0, 83.6], [0, -56.5]] };
  const view = { w: 0, h: 0, dpr: 1, dotScale: 1 };
  const paths = { sphere: null, graticule: null, land: null, borders: null };
  let worldGeo = null;
  let transform = d3.zoomIdentity;
  let colors = {};
  // ~30k grey dots are too slow to redraw every frame, so they're rendered to a bitmap that is
  // stretched while a zoom/pan is in progress and redrawn crisply once it ends.
  const missedLayer = { canvas: document.createElement('canvas'), t: null, dirty: true };
  let interacting = false;

  const zoom = d3.zoom()
    .scaleExtent([1, MAX_ZOOM])
    .on('start', () => { interacting = true; })
    .on('zoom', (e) => { transform = e.transform; hideTooltip(); requestDraw(); })
    .on('end', () => { interacting = false; requestDraw(); });
  const canvasSel = d3.select(canvas).call(zoom);

  function readColors() {
    const cs = getComputedStyle(document.documentElement);
    const v = (name) => cs.getPropertyValue(name).trim();
    colors = {
      ocean: v('--map-ocean'), land: v('--map-land'), border: v('--map-border'),
      dot: v('--map-dot'), edge: v('--map-dot-edge'), missed: v('--map-missed'),
      label: v('--map-label'), halo: v('--map-halo'),
    };
    missedLayer.dirty = true;
  }

  function buildPaths() {
    const path = d3.geoPath(projection);
    paths.sphere = new Path2D(path({ type: 'Sphere' }));
    paths.graticule = new Path2D(path(d3.geoGraticule10()));
    if (worldGeo) {
      paths.land = new Path2D(path(worldGeo.land));
      paths.borders = new Path2D(path(worldGeo.borders));
    }
  }

  function resize() {
    const rect = wrap.getBoundingClientRect();
    const w = Math.round(rect.width);
    const h = Math.round(rect.height);
    if (!w || !h) return;
    const sizeChanged = w !== view.w || h !== view.h;
    view.w = w;
    view.h = h;
    view.dpr = window.devicePixelRatio || 1;
    view.dotScale = Math.min(1.3, Math.max(0.6, w / 1000));
    canvas.width = Math.round(w * view.dpr);
    canvas.height = Math.round(h * view.dpr);

    projection.fitExtent([[6, 6], [w - 6, h - 6]], FRAME);
    for (const c of cities) {
      const [x, y] = projection([c.lon, c.lat]);
      c.x = x;
      c.y = y;
      // dot area is proportional to population
      c.r0 = Math.max(1.5, 14 * Math.sqrt(c.pop / maxPop)) * view.dotScale;
    }
    buildPaths();
    missedLayer.dirty = true;
    zoom.extent([[0, 0], [w, h]]).translateExtent([[0, 0], [w, h]]);
    if (sizeChanged) canvasSel.call(zoom.transform, d3.zoomIdentity);
    requestDraw();
  }

  let drawQueued = false;
  function requestDraw() {
    if (drawQueued) return;
    drawQueued = true;
    requestAnimationFrame(draw);
  }

  function draw(now) {
    drawQueued = false;
    const { w, h, dpr } = view;
    const t = transform;
    const zr = Math.sqrt(t.k);

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    // base map, drawn in projected coordinates under the zoom transform
    ctx.setTransform(dpr * t.k, 0, 0, dpr * t.k, dpr * t.x, dpr * t.y);
    ctx.fillStyle = colors.ocean;
    ctx.fill(paths.sphere);
    ctx.globalAlpha = 0.35;
    ctx.strokeStyle = colors.border;
    ctx.lineWidth = 0.5 / t.k;
    ctx.stroke(paths.graticule);
    ctx.globalAlpha = 1;
    if (paths.land) {
      ctx.fillStyle = colors.land;
      ctx.fill(paths.land);
      ctx.lineWidth = 0.7 / t.k;
      ctx.stroke(paths.borders);
      ctx.stroke(paths.land);
    }

    // dots, drawn in screen pixels so they stay round and crisp
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const sx = (c) => t.x + c.x * t.k;
    const sy = (c) => t.y + c.y * t.k;
    const offscreen = (x, y, r) => x + r < 0 || y + r < 0 || x - r > w || y - r > h;

    if (state.reveal) drawMissed(t, zr, sx, sy, offscreen);

    ctx.beginPath();
    for (const c of state.byPop) {
      const x = sx(c), y = sy(c), r = c.r0 * zr;
      if (offscreen(x, y, r)) continue;
      ctx.moveTo(x + r, y);
      ctx.arc(x, y, r, 0, Math.PI * 2);
    }
    ctx.globalAlpha = 0.75;
    ctx.fillStyle = colors.dot;
    ctx.fill();
    ctx.globalAlpha = 0.9;
    ctx.lineWidth = 1;
    ctx.strokeStyle = colors.edge;
    ctx.stroke();
    ctx.globalAlpha = 1;

    if (state.labels) drawLabels(sx, sy, zr);

    // ripple around freshly named cities
    const time = now || performance.now();
    state.pulses = state.pulses.filter((p) => time - p.t0 < PULSE_MS);
    for (const p of state.pulses) {
      const age = (time - p.t0) / PULSE_MS;
      if (age < 0) continue;
      ctx.beginPath();
      ctx.arc(sx(p.c), sy(p.c), p.c.r0 * zr + 3 + age * 28, 0, Math.PI * 2);
      ctx.globalAlpha = 1 - age;
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = colors.dot;
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    if (state.pulses.length) requestDraw();
  }

  function drawMissed(t, zr, sx, sy, offscreen) {
    const L = missedLayer;
    const { w, h, dpr } = view;
    const moved = !L.t || L.t.k !== t.k || L.t.x !== t.x || L.t.y !== t.y;
    if (L.dirty || (moved && !interacting)) {
      if (L.canvas.width !== canvas.width || L.canvas.height !== canvas.height) {
        L.canvas.width = canvas.width;
        L.canvas.height = canvas.height;
      }
      const g = L.canvas.getContext('2d');
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, w, h);
      g.beginPath();
      for (const c of cities) {
        if (c.found) continue;
        const x = sx(c), y = sy(c), r = c.r0 * zr;
        if (offscreen(x, y, r)) continue;
        if (r < 1.8) {
          g.rect(x - r, y - r, r * 2, r * 2); // indistinguishable from a circle at this size, and much cheaper
        } else {
          g.moveTo(x + r, y);
          g.arc(x, y, r, 0, Math.PI * 2);
        }
      }
      g.fillStyle = colors.missed;
      g.globalAlpha = 0.3;
      g.fill();
      g.globalAlpha = 0.55;
      g.lineWidth = 0.75;
      g.strokeStyle = colors.missed;
      g.stroke();
      L.t = t;
      L.dirty = false;
    }
    const s = t.k / L.t.k;
    ctx.setTransform(dpr * s, 0, 0, dpr * s, dpr * (t.x - L.t.x * s), dpr * (t.y - L.t.y * s));
    ctx.drawImage(L.canvas, 0, 0, w, h);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // Name the biggest named cities first, skipping any label that would overlap one already placed.
  function drawLabels(sx, sy, zr) {
    const { w, h } = view;
    const placed = [];
    ctx.font = LABEL_FONT;
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    for (const c of state.byPop) {
      if (placed.length >= MAX_LABELS) break;
      const x = sx(c), y = sy(c);
      if (x < 0 || y < 0 || x > w || y > h) continue;
      if (!c.tw) c.tw = ctx.measureText(c.name).width;
      const lx = x + c.r0 * zr + 3;
      const box = [lx - 1, y - 8, lx + c.tw + 1, y + 8];
      if (box[2] > w) continue;
      if (placed.some((b) => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1])) continue;
      placed.push(box);
      ctx.lineWidth = 3;
      ctx.strokeStyle = colors.halo;
      ctx.strokeText(c.name, lx, y);
      ctx.fillStyle = colors.label;
      ctx.fillText(c.name, lx, y);
    }
  }

  // ---------- hover / tap ----------

  // The smallest dot under the pointer wins, so little cities on top of big ones stay reachable.
  function cityAt(px, py) {
    const t = transform;
    const zr = Math.sqrt(t.k);
    const hit = (c) => {
      const dx = px - (t.x + c.x * t.k);
      const dy = py - (t.y + c.y * t.k);
      const r = Math.max(c.r0 * zr, 4) + 1;
      return dx * dx + dy * dy <= r * r;
    };
    let best = null;
    for (const c of state.found) if (hit(c) && (!best || c.pop < best.pop)) best = c;
    if (best || !state.reveal) return best;
    for (const c of cities) if (!c.found && hit(c) && (!best || c.pop < best.pop)) best = c;
    return best;
  }

  function showTooltip(c, px, py) {
    tooltip.innerHTML = `<div class="tt-name">${esc(c.name)}${c.capital ? ' <span class="star">★</span>' : ''}</div>`
      + `<div class="tt-sub">${esc(place(c))}</div><div>${fmt.format(c.pop)} people</div>`
      + (c.found ? '' : '<div class="tt-missed">Not named yet</div>');
    tooltip.hidden = false;
    const tw = tooltip.offsetWidth;
    const th = tooltip.offsetHeight;
    let left = px + 14;
    let top = py + 14;
    if (left + tw > view.w - 4) left = px - 14 - tw;
    if (top + th > view.h - 4) top = py - 14 - th;
    tooltip.style.left = Math.max(4, left) + 'px';
    tooltip.style.top = Math.max(4, top) + 'px';
  }

  function hideTooltip() { tooltip.hidden = true; }

  function pointerPos(e) {
    const rect = canvas.getBoundingClientRect();
    return [e.clientX - rect.left, e.clientY - rect.top];
  }

  let hoverQueued = null;
  canvas.addEventListener('pointermove', (e) => {
    if (e.buttons || e.pointerType === 'touch') return;
    const first = !hoverQueued;
    hoverQueued = pointerPos(e);
    if (!first) return;
    requestAnimationFrame(() => {
      const [x, y] = hoverQueued;
      hoverQueued = null;
      const c = cityAt(x, y);
      if (c) showTooltip(c, x, y); else hideTooltip();
      canvas.style.cursor = c ? 'pointer' : '';
    });
  });
  canvas.addEventListener('pointerleave', hideTooltip);
  canvas.addEventListener('click', (e) => {
    const [x, y] = pointerPos(e);
    const c = cityAt(x, y);
    if (c) showTooltip(c, x, y); else hideTooltip();
  });

  function focusCity(c) {
    const k = Math.max(transform.k, 6);
    const target = d3.zoomIdentity.translate(view.w / 2 - c.x * k, view.h / 2 - c.y * k).scale(k);
    canvasSel.transition().duration(800).call(zoom.transform, target);
    state.pulses.push({ c, t0: performance.now() + 650 });
    requestDraw();
    wrap.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  // ---------- wiring ----------

  const form = $('guess-form');
  const input = $('guess');
  const scopeEl = $('scope');

  const group = document.createElement('optgroup');
  group.label = 'Only in…';
  for (const co of countries) group.append(new Option(co.name, co.code));
  scopeEl.append(group);

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!input.value.trim()) return;
    const result = guess(input.value);
    showFeedback(result);
    if (result.status === 'missing') {
      input.select();
      input.classList.remove('shake');
      void input.offsetWidth; // restart the animation
      input.classList.add('shake');
    } else {
      input.value = '';
    }
  });
  input.addEventListener('animationend', () => input.classList.remove('shake'));

  $('zoom-in').addEventListener('click', () => canvasSel.transition().duration(300).call(zoom.scaleBy, 2));
  $('zoom-out').addEventListener('click', () => canvasSel.transition().duration(300).call(zoom.scaleBy, 0.5));
  $('zoom-reset').addEventListener('click', () => canvasSel.transition().duration(500).call(zoom.transform, d3.zoomIdentity));

  const revealBtn = $('reveal');
  revealBtn.addEventListener('click', () => {
    state.reveal = !state.reveal;
    revealBtn.textContent = state.reveal ? 'Hide missed cities' : 'Show missed cities';
    revealBtn.setAttribute('aria-pressed', String(state.reveal));
    update();
    missedLayer.dirty = true;
    requestDraw();
  });

  $('clear').addEventListener('click', () => {
    if (!state.found.length) return;
    if (!window.confirm(`Clear all ${plural(state.found.length, 'city', 'cities')} and start over?`)) return;
    for (const c of state.found) c.found = false;
    state.found = [];
    state.pulses = [];
    save();
    update();
    missedLayer.dirty = true;
    requestDraw();
    feedbackEl.innerHTML = '&nbsp;';
    feedbackEl.className = 'feedback';
    input.focus();
  });

  const labelsBox = $('opt-labels');
  labelsBox.addEventListener('change', () => {
    state.labels = labelsBox.checked;
    save();
    requestDraw();
  });

  $('stats').addEventListener('click', (e) => {
    const btn = e.target.closest('.city-link');
    if (btn) focusCity(byId.get(Number(btn.dataset.id)));
  });

  $('stat-pct-label').title = `Share of the combined population of all ${fmt.format(cities.length)} cities in the game `
    + `(every place with 15,000+ people): ${fmt.format(totalPop)} people.`;

  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { readColors(); requestDraw(); });
  new ResizeObserver(resize).observe(wrap);

  load();
  labelsBox.checked = state.labels;
  readColors();
  update();
  resize();
  input.focus();

  fetch(WORLD_URL)
    .then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then((topo) => {
      const geoms = topo.objects.countries.geometries.filter((g) => g.id !== '010'); // drop Antarctica
      worldGeo = {
        land: topojson.merge(topo, geoms),
        borders: topojson.mesh(topo, { type: 'GeometryCollection', geometries: geoms }, (a, b) => a !== b),
      };
      buildPaths();
      requestDraw();
    })
    .catch(() => { $('map-note').hidden = false; });
})();
