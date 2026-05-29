/* ==========================================================
   main.js — La Celeste en los Mundiales · UdelaR
   Lee datos desde data/uruguay_jugadores_mundial.csv
   Jitter en vivo con semilla fija (seededRandom)
   ========================================================== */

const CAMPEONES = [1930, 1950];
const SEDES = {
  1930:"Uruguay", 1950:"Brasil", 1954:"Suiza",
  1962:"Chile",  1966:"Inglaterra", 1970:"México",
  1974:"Alemania Occ.", 1986:"México", 1990:"Italia",
  2002:"Corea/Japón", 2010:"Sudáfrica", 2014:"Brasil",
  2018:"Rusia", 2022:"Catar"
};

/* ── Seeded PRNG (mulberry32) ─────────────────────────── */
function makeRng(seed) {
  let s = seed >>> 0;
  return function() {
    s += 0x6D2B79F5;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ── Jitter en vivo ────────────────────────────────────
   Solo se aplica a jugadores con la misma coordenada exacta.
   Montevideo: radio hasta ~800m.  Resto: radio hasta ~400m.
   La semilla se deriva de un hash del nombre para que sea
   siempre igual aunque se agreguen más jugadores al CSV.
   ─────────────────────────────────────────────────────── */
function strHash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(31, h) + str.charCodeAt(i) | 0;
  }
  return Math.abs(h);
}

function applyJitter(jugadores) {
  // agrupar por coordenada exacta
  const groups = {};
  jugadores.forEach(j => {
    const key = `${j.la}_${j.lo}`;
    if (!groups[key]) groups[key] = [];
    groups[key].push(j);
  });

  return jugadores.map(j => {
    if (j.pa !== 'Uruguay') return { ...j, desplazado: false };
    const key = `${j.la}_${j.lo}`;
    const group = groups[key];
    const isMvd = (j.de === 'Montevideo');

    // Si está solo en esa coordenada y no es Mvd, no se mueve
    if (group.length === 1 && !isMvd) return { ...j, desplazado: false };

    // Radio máximo en grados: Mvd ~800m (~0.008°), resto ~400m (~0.004°)
    const maxR = isMvd ? 0.008 : 0.004;
    const rng = makeRng(strHash(j.n));
    const angle = rng() * 2 * Math.PI;
    const r = maxR * (0.3 + rng() * 0.7);
    return {
      ...j,
      la: j.la + Math.sin(angle) * r,
      lo: j.lo + Math.cos(angle) * r,
      desplazado: true
    };
  });
}

/* ── Estado global ────────────────────────────────────── */
let JUGADORES = [];
let MUNDIALES = [];
let mapMain = null, mapTimeline = null;
let mapInset = null, mapTlInset = null;          // Montevideo inset maps
let insetMarkerLayer = null, tlInsetMarkerLayer = null;
let heatLayer = null, markerLayerMain = null, markerLayerIntl = null;
let tlMarkersAll = [];       // todos los marcadores de la timeline
let tlAnimTimeout = null;
let coropetaLayer = null, coropetaVisible = false;
let chartInstances = {};
let tlSorted = [];           // jugadores ordenados por fecha_iso para la línea del tiempo

/* ── CARGA DEL CSV ────────────────────────────────────── */
window.addEventListener('DOMContentLoaded', () => {
  Papa.parse('data/uruguay_jugadores_mundial.csv', {
    download: true,
    header: true,
    skipEmptyLines: true,
    complete: function(results) {
      JUGADORES = parseCSV(results.data);
      JUGADORES = applyJitter(JUGADORES);
      MUNDIALES = [...new Set(JUGADORES.flatMap(j => j.m))].sort((a,b)=>a-b);
      // Ordenar todos los jugadores por fecha de nacimiento para la línea de tiempo global
      tlSorted = [...JUGADORES].filter(j => j.fechaIso).sort((a,b) => a.fechaIso - b.fechaIso);
      initApp();
    },
    error: function(err) {
      console.error('CSV error:', err);
      document.getElementById('loader').classList.add('hidden');
    }
  });
});

function parseCSV(rows) {
  return rows.map(r => {
    const mundiales = r.lista_mundiales.split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n));
    const clubes    = r.clubes_en_mundiales.split(',').map(s => s.trim());
    const paises    = r.paises_clubes.split(',').map(s => s.trim());
    const la = parseFloat(r.Latitud);
    const lo = parseFloat(r.Longitud);

    // Parsear fecha ISO (formato M/D/YYYY)
    let fechaIso = null;
    if (r.fecha_iso) {
      const parts = r.fecha_iso.split('/');
      if (parts.length === 3) {
        const d = new Date(parseInt(parts[2]), parseInt(parts[0])-1, parseInt(parts[1]));
        if (!isNaN(d)) fechaIso = d;
      }
    }

    return {
      n:  r.nombre,
      pos: r.posicion,
      m:  mundiales,
      cl: clubes,
      pc: paises,
      wiki: r.wiki_enlace || null,
      fn: r.fecha_nacimiento,
      fechaIso,
      lu: r.lugar_nacimiento,
      de: r.depto || null,
      pa: r.pais_nacimiento,
      la, lo,
      fo: r.url_imagen || null,
      desplazado: false
    };
  });
}

/* ── INICIALIZACIÓN ────────────────────────────────────── */
function initApp() {
  initVistas();
  initMapaPrincipal();
  initInsetMap();
  initTimelineMap();
  initTlInsetMap();
  initDashboard();
  poblarFiltroMundial();
  poblarTimeline();
  setTimeout(() => document.getElementById('loader').classList.add('hidden'), 500);
}

/* ── VISTAS ─────────────────────────────────────────────── */
function initVistas() {
  const vistas = {
    'btn-mapa':      'view-mapa',
    'btn-timeline':  'view-timeline',
    'btn-dashboard': 'view-dashboard'
  };
  Object.entries(vistas).forEach(([btnId, viewId]) => {
    document.getElementById(btnId).addEventListener('click', () => {
      document.querySelectorAll('.view-btn').forEach(b => b.classList.remove('active'));
      document.getElementById(btnId).classList.add('active');
      Object.values(vistas).forEach(v => {
        document.getElementById(v).classList.toggle('hidden', v !== viewId);
      });
      if (viewId === 'view-mapa'      && mapMain)     setTimeout(() => mapMain.invalidateSize(), 120);
      if (viewId === 'view-timeline'  && mapTimeline) {
        setTimeout(() => {
          mapTimeline.invalidateSize();
          if (mapTlInset) mapTlInset.invalidateSize();
          // Auto-start timeline on first visit
          if (tlAnimJugadores.length === 0 && tlSorted.length > 0) {
            prepararAnimacion(tlSorted);
            tlPlay();
          }
        }, 200);
      }
      if (viewId === 'view-dashboard') renderDashboard();
    });
  });
}

/* ── MAPA PRINCIPAL ─────────────────────────────────────── */
function initMapaPrincipal() {
  mapMain = L.map('map', { center: [-32.888, -52.99], zoom: 7, zoomControl: true });
  L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; OpenStreetMap &amp; CARTO', subdomains: 'abcd', maxZoom: 18
  }).addTo(mapMain);

  buildMarkersMain();

  document.getElementById('toggle-heatmap').addEventListener('change', e => {
    if (e.target.checked) { if (!heatLayer) buildHeatmap(); else mapMain.addLayer(heatLayer); }
    else if (heatLayer) mapMain.removeLayer(heatLayer);
  });
  document.getElementById('toggle-markers').addEventListener('change', e => {
    if (e.target.checked) markerLayerMain && mapMain.addLayer(markerLayerMain);
    else markerLayerMain && mapMain.removeLayer(markerLayerMain);
  });
  document.getElementById('toggle-intl').addEventListener('change', e => {
    if (e.target.checked) markerLayerIntl && mapMain.addLayer(markerLayerIntl);
    else markerLayerIntl && mapMain.removeLayer(markerLayerIntl);
  });
  document.getElementById('toggle-coropeta').addEventListener('change', e => {
    coropetaVisible = e.target.checked;
    const sel = document.getElementById('filter-mundial').value;
    const mundial = sel === 'todos' ? null : parseInt(sel);
    if (coropetaVisible) {
      if (window.DEPTOS_GEOJSON) {
        buildCoropeta(mundial);
      } else {
        // GeoJSON still loading — show when ready
        const wait = setInterval(() => {
          if (window.DEPTOS_GEOJSON) { clearInterval(wait); buildCoropeta(mundial); }
        }, 200);
      }
    } else if (coropetaLayer) mapMain.removeLayer(coropetaLayer);
  });
  document.getElementById('filter-mundial').addEventListener('change', e => {
    const val = e.target.value;
    const mundial = val === 'todos' ? null : parseInt(val);
    rebuildMapaFiltrado(mundial);
    if (coropetaVisible || coropetaLayer) buildCoropeta(mundial);
  });
}


/* ── INSET MAP — Montevideo ─────────────────────────────
   Centra en el depto. de Montevideo y muestra solo
   jugadores nacidos allí. Se sincroniza con el filtro
   de mundial del mapa principal.
   ─────────────────────────────────────────────────────── */
const MVD_BOUNDS = [[-35.05, -56.55], [-34.60, -55.90]];
const MVD_CENTER = [-34.8996, -56.1898];

function initInsetMap() {
  mapInset = L.map('map-inset', {
    center: MVD_CENTER, zoom: 13,
    zoomControl: false, attributionControl: false,
    dragging: false, scrollWheelZoom: false,
    doubleClickZoom: false, boxZoom: false, keyboard: false
  });
  L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
    subdomains: 'abcd', maxZoom: 18
  }).addTo(mapInset);

  // Draw Montevideo boundary box
  L.rectangle(MVD_BOUNDS, {
    color: 'rgba(85,181,229,.5)', weight: 1.5,
    fill: false, dashArray: '4 3'
  }).addTo(mapInset);

  buildInsetMarkers(null);

  // Toggle button
  document.getElementById('btn-toggle-inset').addEventListener('click', () => {
    document.getElementById('map-inset-wrap').classList.add('hidden');
    document.getElementById('btn-show-inset').classList.remove('hidden');
  });
  document.getElementById('btn-show-inset').addEventListener('click', () => {
    document.getElementById('map-inset-wrap').classList.remove('hidden');
    document.getElementById('btn-show-inset').classList.add('hidden');
    setTimeout(() => mapInset.invalidateSize(), 50);
  });

  // Keep inset in sync with mundial filter
  document.getElementById('filter-mundial').addEventListener('change', e => {
    const val = e.target.value;
    buildInsetMarkers(val === 'todos' ? null : parseInt(val));
  });
}

function buildInsetMarkers(filtroMundial) {
  if (insetMarkerLayer) mapInset.removeLayer(insetMarkerLayer);
  insetMarkerLayer = L.layerGroup();

  const jugs = JUGADORES.filter(j =>
    j.de === 'Montevideo' &&
    (!filtroMundial || j.m.includes(filtroMundial))
  );

  jugs.forEach(j => {
    const mk = L.marker([j.la, j.lo], { icon: buildBallIcon(j, false) });
    mk.bindPopup(buildFichaPopup(j), { maxWidth: 280, minWidth: 260, className: 'ficha-popup' });
    insetMarkerLayer.addLayer(mk);
  });
  insetMarkerLayer.addTo(mapInset);
}

/* ── INSET MAP — Montevideo en Timeline ─────────────── */
function initTlInsetMap() {
  mapTlInset = L.map('map-tl-inset', {
    center: MVD_CENTER, zoom: 13,
    zoomControl: false, attributionControl: false,
    dragging: false, scrollWheelZoom: false,
    doubleClickZoom: false, boxZoom: false, keyboard: false
  });
  L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
    subdomains: 'abcd', maxZoom: 18
  }).addTo(mapTlInset);

  L.rectangle(MVD_BOUNDS, {
    color: 'rgba(85,181,229,.5)', weight: 1.5,
    fill: false, dashArray: '4 3'
  }).addTo(mapTlInset);

  tlInsetMarkerLayer = L.layerGroup().addTo(mapTlInset);

  document.getElementById('btn-toggle-tl-inset').addEventListener('click', () => {
    document.getElementById('map-tl-inset-wrap').classList.add('hidden');
    document.getElementById('btn-show-tl-inset').classList.remove('hidden');
  });
  document.getElementById('btn-show-tl-inset').addEventListener('click', () => {
    document.getElementById('map-tl-inset-wrap').classList.remove('hidden');
    document.getElementById('btn-show-tl-inset').classList.add('hidden');
    setTimeout(() => mapTlInset.invalidateSize(), 50);
  });
}

function addTlInsetMarker(j) {
  if (!mapTlInset || j.de !== 'Montevideo') return;
  if (!tlInsetMarkerLayer) { tlInsetMarkerLayer = L.layerGroup().addTo(mapTlInset); }
  const mk = L.marker([j.la, j.lo], { icon: buildBallIcon(j, false) });
  mk.bindPopup(buildFichaPopup(j), { maxWidth: 280, minWidth: 260, className: 'ficha-popup' });
  tlInsetMarkerLayer.addLayer(mk);
}

function clearTlInsetMarkers() {
  if (tlInsetMarkerLayer) tlInsetMarkerLayer.clearLayers();
}

function buildHeatmap(pts) {
  if (heatLayer) mapMain.removeLayer(heatLayer);
  const points = (pts || JUGADORES.filter(j => j.pa === 'Uruguay')).map(j => [j.la, j.lo, 1]);
  // Peso reducido en Montevideo para no dominar
  const heatPts = points.map(([lat, lng]) => {
    const isMvd = (lat > -35.0 && lat < -34.6 && lng > -56.5 && lng < -55.9);
    return [lat, lng, isMvd ? 0.4 : 1.0];
  });
  heatLayer = L.heatLayer(heatPts, {
    radius: 38, blur: 28, maxZoom: 10, max: 1.0, minOpacity: 0.0,
    gradient: { 0.1:'#cce8f5', 0.35:'#88ccee', 0.6:'#55B5E5', 0.8:'#1a6a9a', 1.0:'#0a3a5a' }
  });
  if (document.getElementById('toggle-heatmap').checked) heatLayer.addTo(mapMain);
}

function buildMarkersMain(filtroMundial) {
  if (markerLayerMain) mapMain.removeLayer(markerLayerMain);
  if (markerLayerIntl) mapMain.removeLayer(markerLayerIntl);
  markerLayerMain = L.layerGroup();
  markerLayerIntl = L.layerGroup();

  const jugs = filtroMundial
    ? JUGADORES.filter(j => j.m.includes(filtroMundial))
    : JUGADORES;

  jugs.forEach(j => {
    const isIntl = j.pa !== 'Uruguay';
    const marker = L.marker([j.la, j.lo], { icon: buildBallIcon(j, isIntl) });
    marker.bindPopup(buildFichaPopup(j), { maxWidth: 280, minWidth: 260, className: 'ficha-popup' });
    if (isIntl) markerLayerIntl.addLayer(marker);
    else markerLayerMain.addLayer(marker);
  });

  if (document.getElementById('toggle-markers').checked) markerLayerMain.addTo(mapMain);
  if (document.getElementById('toggle-intl').checked)    markerLayerIntl.addTo(mapMain);

  const n = jugs.length;
  document.getElementById('status-map').textContent =
    filtroMundial ? `${n} jugadores · Mundial ${filtroMundial}` : `${n} jugadores · todos los mundiales`;
}

function rebuildMapaFiltrado(mundial) {
  buildMarkersMain(mundial);
  const pts = mundial
    ? JUGADORES.filter(j => j.m.includes(mundial) && j.pa === 'Uruguay')
    : JUGADORES.filter(j => j.pa === 'Uruguay');
  buildHeatmap(pts);
}

/* ── MARKER ICON (punto celeste simple) ─────────────── */
function buildBallIcon(j, isIntl) {
  const cls = isIntl ? 'dot-marker dot-marker-intl' : 'dot-marker';
  return L.divIcon({
    className: '',
    html: `<div class="${cls}"></div>`,
    iconSize: [11,11], iconAnchor: [5,5], popupAnchor: [0,-8]
  });
}

/* ── POPUP FICHA ─────────────────────────────────────── */
function buildFichaPopup(j) {
  const pills = j.m.map(año => {
    const es = CAMPEONES.includes(año);
    return `<span class="popup-pill${es?' campeon':''}">${año}${es?' 🏆':''}</span>`;
  }).join('');
  const clubes = j.m.map((año,i) => {
    const club = j.cl[Math.min(i, j.cl.length-1)];
    return `<span class="popup-club-item"><span class="popup-club-año">${año}</span> ${club}</span>`;
  }).join('');
  const wiki  = j.wiki ? `<a href="${j.wiki}" target="_blank" class="popup-wiki-btn">🔗 Wikipedia / AUF</a>` : '';
  const coord = j.desplazado ? `<div class="popup-coord-note">📍 Coord. desplazada para evitar superposición</div>` : '';
  const foto  = j.fo ? `<img class="popup-foto" src="${j.fo}" alt="" onerror="this.style.display='none'">` : `<div class="popup-foto popup-foto-empty">⚽</div>`;

  return `<div class="popup-ficha">
    <div class="popup-ficha-top">${foto}
      <div class="popup-ficha-info">
        <div class="popup-nombre">${j.n}</div>
        <div class="popup-pos-badge">${j.pos}</div>
        <div class="popup-lugar">${j.lu}${j.de?', '+j.de:''}${j.pa!=='Uruguay'?' · '+j.pa:''}</div>
        <div class="popup-fn">${j.fn}</div>
      </div>
    </div>
    <div class="popup-mundiales-row">${pills}</div>
    <div class="popup-clubes-label">Club en el mundial</div>
    <div class="popup-clubes-list">${clubes}</div>
    ${wiki}${coord}
  </div>`;
}

/* ── FILTRO MUNDIAL ─────────────────────────────────── */
function poblarFiltroMundial() {
  const sel = document.getElementById('filter-mundial');
  MUNDIALES.forEach(año => {
    const opt = document.createElement('option');
    opt.value = año;
    opt.textContent = `${año} · ${SEDES[año]||''}`;
    sel.appendChild(opt);
  });
}

/* ── TIMELINE ─────────────────────────────────────────
   - Barra inferior permanente con play/pausa/repetir
   - Mini-ficha lateral que aparece al nacer cada jugador
   - Panel derecho: filtro por mundial + lista
   ──────────────────────────────────────────────────── */

let tlMundialActivo = null;
let tlAnimTimers = [];
let tlAnimPlaying = false;
let tlAnimJugadores = [];  // set actual a animar
let tlAnimIdx = 0;         // índice del próximo a mostrar
let tlAnimIntervalMs = 120;
let tlAnimTimer = null;
let tlDotEls = [];
let tlMiniTimeout = null;

function initTimelineMap() {
  mapTimeline = L.map('map-timeline', { center: [-32.888, -52.99], zoom: 7 });
  L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
    attribution: '', subdomains: 'abcd', maxZoom: 18
  }).addTo(mapTimeline);
}

function poblarTimeline() {
  const cont = document.getElementById('tl-mundiales');
  MUNDIALES.forEach(año => {
    const n = JUGADORES.filter(j => j.m.includes(año)).length;
    const esCampeon = CAMPEONES.includes(año);
    const btn = document.createElement('button');
    btn.className = 'tl-mundial-btn';
    btn.dataset.año = año;
    btn.innerHTML = `
      <span class="tl-mundial-año">${año}</span>
      <span class="tl-mundial-sede">${SEDES[año]||''}${esCampeon?' 🏆':''}</span>
      <span class="tl-mundial-count">${n}</span>`;
    btn.addEventListener('click', () => seleccionarMundialTimeline(año));
    cont.appendChild(btn);
  });

  // Botones de control
  document.getElementById('tl-btn-play').addEventListener('click', tlPlay);
  document.getElementById('tl-btn-pause').addEventListener('click', tlPause);
  document.getElementById('tl-btn-restart').addEventListener('click', tlRestart);

  // auto-start handled in initVistas
}

/* ── Selección de mundial ────────────────────────────── */
function seleccionarMundialTimeline(año) {
  if (tlMundialActivo === año) {
    tlMundialActivo = null;
    document.querySelectorAll('.tl-mundial-btn').forEach(b => b.classList.remove('active'));
    document.getElementById('tl-info').innerHTML = '<div class="tl-info-placeholder">← Seleccioná un mundial</div>';
    document.getElementById('tl-player-list').innerHTML = '';
    prepararAnimacion(tlSorted);
    tlPlay();
    return;
  }

  tlMundialActivo = año;
  document.querySelectorAll('.tl-mundial-btn').forEach(b =>
    b.classList.toggle('active', parseInt(b.dataset.año) === año));

  const jugs = JUGADORES.filter(j => j.m.includes(año));
  const esCampeon = CAMPEONES.includes(año);

  document.getElementById('tl-info').innerHTML = `
    <div class="tl-info-nombre">Mundial ${año} · ${SEDES[año]||''}</div>
    <div class="tl-info-stats">
      <div class="tl-stat"><div class="tl-stat-label">Jugadores</div><div class="tl-stat-val">${jugs.length}</div></div>
      <div class="tl-stat"><div class="tl-stat-label">Deptos.</div><div class="tl-stat-val">${new Set(jugs.filter(j=>j.de).map(j=>j.de)).size}</div></div>
    </div>
    ${esCampeon ? `<div class="tl-campeon-badge">🏆 Uruguay campeón</div>` : ''}`;

  const lista = document.getElementById('tl-player-list');
  lista.innerHTML = '';
  [...jugs].sort((a,b)=>(a.fechaIso||0)-(b.fechaIso||0)).forEach((j,idx) => {
    const item = document.createElement('div');
    item.className = 'tl-player-item';
    item.dataset.nombre = j.n;
    item.innerHTML = `
      ${j.fo?`<img class="tl-player-foto" src="${j.fo}" onerror="this.src=''" alt="">`:'<div class="tl-player-foto"></div>'}
      <div class="tl-player-info">
        <div class="tl-player-nombre">${j.n}</div>
        <div class="tl-player-pos">${j.pos}</div>
      </div>
      <span class="tl-player-depto">${j.de||j.pa}</span>`;
    item.addEventListener('click', () => {
      const mk = tlMarkersAll.find(m => m._jugador && m._jugador.n === j.n);
      if (mk) { mapTimeline.setView(mk.getLatLng(), 10); mk.openPopup(); }
    });
    lista.appendChild(item);
  });

  const jugsTL = [...jugs].filter(j=>j.fechaIso).sort((a,b)=>a.fechaIso-b.fechaIso);
  prepararAnimacion(jugsTL);
  tlPlay();

  const ptsUY = jugs.filter(j=>j.pa==='Uruguay');
  if (ptsUY.length) mapTimeline.fitBounds(L.latLngBounds(ptsUY.map(j=>[j.la,j.lo])),{padding:[40,40],maxZoom:10});
}

/* ── Preparar animación (sin arrancar) ───────────────── */
function prepararAnimacion(jugadores) {
  // Detener lo que corra
  tlPause();
  // Limpiar marcadores
  tlMarkersAll.forEach(m => mapTimeline.removeLayer(m));
  tlMarkersAll = [];
  clearTlInsetMarkers();
  tlAnimJugadores = jugadores;
  tlAnimIdx = 0;
  tlDotEls = [];

  const dotsEl = document.getElementById('tl-birth-dots');
  dotsEl.innerHTML = '<div class="tl-birth-line"></div>';

  if (!jugadores.length) {
    document.getElementById('tl-year-min').textContent = '';
    document.getElementById('tl-year-max').textContent = '';
    document.getElementById('tl-birth-title').textContent = '';
    document.getElementById('tl-progress').style.width = '0%';
    return;
  }

  const minD = jugadores[0].fechaIso.getTime();
  const maxD = jugadores[jugadores.length-1].fechaIso.getTime();
  const range = maxD - minD || 1;

  document.getElementById('tl-year-min').textContent = jugadores[0].fechaIso.getFullYear();
  document.getElementById('tl-year-max').textContent = jugadores[jugadores.length-1].fechaIso.getFullYear();
  document.getElementById('tl-birth-title').textContent = `${jugadores.length} jugadores ordenados por nacimiento`;
  document.getElementById('tl-progress').style.width = '0%';

  jugadores.forEach((j, i) => {
    const pct = ((j.fechaIso.getTime() - minD) / range * 88 + 6).toFixed(2);
    const isIntl = j.pa !== 'Uruguay';
    const dot = document.createElement('div');
    dot.className = `tl-birth-dot${isIntl?' intl':''}`;
    dot.style.left = `${pct}%`;
    dot.style.opacity = '0';
    dot.title = `${j.n} · ${j.fn}`;
    dot.addEventListener('click', () => {
      const mk = tlMarkersAll.find(m => m._jugador && m._jugador.n === j.n);
      if (mk) { mapTimeline.setView(mk.getLatLng(), 10); mk.openPopup(); }
    });
    dotsEl.appendChild(dot);
    tlDotEls.push(dot);
  });

  tlAnimIntervalMs = Math.min(Math.max(4000 / jugadores.length, 60), 200);
}

/* ── Controles play / pause / restart ───────────────── */
function tlPlay() {
  if (tlAnimPlaying) return;
  tlAnimPlaying = true;
  document.getElementById('tl-btn-play').classList.add('active');
  document.getElementById('tl-btn-pause').classList.remove('active');
  tlStep();
}

function tlPause() {
  tlAnimPlaying = false;
  if (tlAnimTimer) { clearTimeout(tlAnimTimer); tlAnimTimer = null; }
  document.getElementById('tl-btn-play').classList.remove('active');
  document.getElementById('tl-btn-pause').classList.add('active');
}

function tlRestart() {
  prepararAnimacion(tlAnimJugadores);
  tlPlay();
}

function tlStep() {
  if (!tlAnimPlaying) return;
  if (tlAnimIdx >= tlAnimJugadores.length) {
    // terminó
    tlAnimPlaying = false;
    document.getElementById('tl-btn-play').classList.remove('active');
    document.getElementById('tl-progress').style.width = '100%';
    return;
  }

  const j = tlAnimJugadores[tlAnimIdx];
  const i = tlAnimIdx;

  // Mostrar dot en barra
  const dot = tlDotEls[i];
  if (dot) {
    dot.style.opacity = '1';
    dot.style.transition = 'opacity .18s';
    dot.style.transform = 'translate(-50%,-50%) scale(2)';
    setTimeout(() => { if(dot) dot.style.transform = ''; }, 300);
  }

  // Barra de progreso
  document.getElementById('tl-progress').style.width =
    `${((i+1)/tlAnimJugadores.length*100).toFixed(1)}%`;

  // Marcador en mapa principal timeline
  const isIntl = j.pa !== 'Uruguay';
  const mk = L.marker([j.la, j.lo], { icon: buildBallIcon(j, isIntl) });
  mk.bindPopup(buildFichaPopup(j), { maxWidth: 280, minWidth: 260, className: 'ficha-popup' });
  mk._jugador = j;
  mk.addTo(mapTimeline);
  tlMarkersAll.push(mk);
  // Marcador en inset Montevideo (si aplica)
  addTlInsetMarker(j);

  // Mini-ficha lateral
  mostrarMiniCard(j);

  // Highlight en lista derecha
  document.querySelectorAll('.tl-player-item').forEach(el => {
    el.classList.toggle('tl-item-active', el.dataset.nombre === j.n);
    if (el.dataset.nombre === j.n) el.scrollIntoView({ block:'nearest', behavior:'smooth' });
  });

  tlAnimIdx++;
  tlAnimTimer = setTimeout(tlStep, tlAnimIntervalMs);
}

/* ── Mini-card lateral ───────────────────────────────── */
function mostrarMiniCard(j) {
  const card = document.getElementById('tl-mini-card');
  if (!card) return;
  if (tlMiniTimeout) clearTimeout(tlMiniTimeout);

  card.innerHTML = `
    <div class="mc-foto-wrap">
      ${j.fo ? `<img src="${j.fo}" onerror="this.style.display='none'" alt="">` : '<span>⚽</span>'}
    </div>
    <div class="mc-info">
      <div class="mc-nombre">${j.n}</div>
      <div class="mc-pos">${j.pos}</div>
      <div class="mc-fn">${j.fn}</div>
      <div class="mc-lugar">${j.lu}${j.de?', '+j.de:''}</div>
    </div>`;
  card.classList.add('visible');

  // Ocultar tras 2.5s si no llega el siguiente pronto
  tlMiniTimeout = setTimeout(() => card.classList.remove('visible'), 2500);
}

/* ── COROPLETA ────────────────────────────────────────── */
function getCoropetaVal(props, mundial) {
  if (!mundial) return MUNDIALES.reduce((s,a) => s + (typeof props[`Mund_${a}`]==='number'?props[`Mund_${a}`]:0), 0);
  const v = props[`Mund_${mundial}`];
  return typeof v === 'number' ? v : 0;
}

function buildCoropeta(mundial) {
  if (!window.DEPTOS_GEOJSON) return;
  if (coropetaLayer) { mapMain.removeLayer(coropetaLayer); coropetaLayer = null; }
  const vals = DEPTOS_GEOJSON.features.map(f => getCoropetaVal(f.properties, mundial));
  const maxVal = Math.max(...vals, 1);
  coropetaLayer = L.geoJSON(DEPTOS_GEOJSON, {
    style: feat => {
      const v = getCoropetaVal(feat.properties, mundial);
      const t = v / maxVal;
      let fill;
      if (v === 0) fill = 'rgba(204,232,245,0.4)';
      else if (t < 0.5) {
        const f = t/0.5;
        fill = `rgba(${Math.round(204+(85-204)*f)},${Math.round(232+(181-232)*f)},${Math.round(245+(229-245)*f)},0.72)`;
      } else {
        const f = (t-0.5)/0.5;
        fill = `rgba(${Math.round(85+(10-85)*f)},${Math.round(181+(58-181)*f)},${Math.round(229+(90-229)*f)},0.80)`;
      }
      return { fillColor: fill, color: '#55B5E5', weight: 1, opacity: 0.6, fillOpacity: 1 };
    },
    onEachFeature: (feat, layer) => {
      const v = getCoropetaVal(feat.properties, mundial);
      layer.bindTooltip(`<b>${feat.properties.nam}</b><br>${v} jugador${v!==1?'es':''} · ${mundial||'total'}`, { sticky: true });
    }
  });
  if (coropetaVisible) coropetaLayer.addTo(mapMain);
}
// Cargar GeoJSON de departamentos desde data/ y preparar coropleta
fetch('data/jugadores_dptos_mundial.geojson')
  .then(r => r.json())
  .then(gj => {
    window.DEPTOS_GEOJSON = gj;
    buildCoropeta(null); // prepara layer sin mostrarlo
  })
  .catch(err => console.warn('GeoJSON deptos no cargado:', err));

/* ── DASHBOARD ─────────────────────────────────────────── */
function initDashboard() {
  // KPIs estáticos que no dependen de render
  const ext = JUGADORES.filter(j => j.pa !== 'Uruguay').length;
  const deptoCnt = {};
  JUGADORES.filter(j => j.de).forEach(j => { deptoCnt[j.de] = (deptoCnt[j.de]||0)+1; });
  const topD = Object.entries(deptoCnt).sort((a,b)=>b[1]-a[1])[0];
  const maxM = Math.max(...JUGADORES.map(j => j.m.length));
  const topNames = JUGADORES.filter(j=>j.m.length===maxM).map(j=>j.n.split(' ').pop()).join(', ');

  document.getElementById('kpi-total').textContent      = JUGADORES.length;
  document.getElementById('kpi-mundiales').textContent  = MUNDIALES.length;
  document.getElementById('kpi-depto-top').textContent  = topD ? `${topD[0]} (${topD[1]})` : '–';
  document.getElementById('kpi-extranacidos').textContent = ext;
  document.getElementById('kpi-extranacidos-pct').textContent = Math.round(ext/JUGADORES.length*100)+'%';
  document.getElementById('kpi-campeones').textContent  = CAMPEONES.length;
  document.getElementById('kpi-mas-mundiales').textContent = `${maxM} · ${topNames}`;
}

let dashRendered = false;
function renderDashboard() {
  if (dashRendered) return;
  dashRendered = true;
  renderChartPorMundial();
  renderChartPosiciones();
  renderChartDeptos();
  renderChartClubes();
  renderChartPaisesClubes();
}

const AZULES = ['#0a3a5a','#155a8a','#1a78b8','#2299d8','#55B5E5','#7fcbee','#a5dbf4','#ccedf9'];
const AZ_EXT = [...AZULES,...AZULES.map(c=>c)];

function destroyChart(id) {
  if (chartInstances[id]) { chartInstances[id].destroy(); delete chartInstances[id]; }
}

function renderChartPorMundial() {
  destroyChart('pm');
  const labels = MUNDIALES.map(String);
  const data   = MUNDIALES.map(a => JUGADORES.filter(j => j.m.includes(a)).length);
  const bgC    = MUNDIALES.map(a => CAMPEONES.includes(a) ? '#c8a84b' : '#55B5E5');
  chartInstances['pm'] = new Chart(document.getElementById('chart-por-mundial'), {
    type:'bar',
    data:{ labels, datasets:[{ data, backgroundColor:bgC, borderRadius:4 }] },
    options:{
      responsive:true, maintainAspectRatio:false,
      plugins:{ legend:{display:false}, tooltip:{ callbacks:{ label: ctx => `${ctx.raw} jugadores${CAMPEONES.includes(MUNDIALES[ctx.dataIndex])?' 🏆':''}` }}},
      scales:{ x:{ticks:{font:{size:9},color:'#5a7d94'},grid:{display:false}}, y:{ticks:{font:{size:9},color:'#5a7d94'},grid:{color:'#e8f0f5'}} }
    }
  });
}
function renderChartPosiciones() {
  destroyChart('pos');
  const cnt = {};
  JUGADORES.forEach(j => { cnt[j.pos]=(cnt[j.pos]||0)+1; });
  const s = Object.entries(cnt).sort((a,b)=>b[1]-a[1]);
  chartInstances['pos'] = new Chart(document.getElementById('chart-posiciones'), {
    type:'doughnut',
    data:{ labels:s.map(e=>e[0]), datasets:[{ data:s.map(e=>e[1]), backgroundColor:AZULES.slice(0,s.length), borderWidth:2, borderColor:'#fff' }] },
    options:{ responsive:true, maintainAspectRatio:false, cutout:'60%', plugins:{ legend:{ position:'bottom', labels:{font:{size:9},padding:8,boxWidth:10} } } }
  });
}
function renderChartDeptos() {
  destroyChart('dp');
  const cnt = {};
  JUGADORES.filter(j=>j.de).forEach(j => { cnt[j.de]=(cnt[j.de]||0)+1; });
  const s = Object.entries(cnt).sort((a,b)=>b[1]-a[1]);
  chartInstances['dp'] = new Chart(document.getElementById('chart-deptos'), {
    type:'bar',
    data:{ labels:s.map(e=>e[0]), datasets:[{ data:s.map(e=>e[1]), backgroundColor:AZ_EXT.slice(0,s.length), borderRadius:3 }] },
    options:{ indexAxis:'y', responsive:true, maintainAspectRatio:false,
      plugins:{legend:{display:false}},
      scales:{ y:{ticks:{font:{size:8.5},color:'#5a7d94'},grid:{display:false}}, x:{ticks:{font:{size:8},color:'#5a7d94'},grid:{color:'#e8f0f5'}} }
    }
  });
}
function renderChartClubes() {
  destroyChart('cl');
  const cnt = {};
  JUGADORES.forEach(j => j.cl.forEach(c => { cnt[c]=(cnt[c]||0)+1; }));
  const s = Object.entries(cnt).sort((a,b)=>b[1]-a[1]).slice(0,12);
  chartInstances['cl'] = new Chart(document.getElementById('chart-clubes'), {
    type:'bar',
    data:{ labels:s.map(e=>e[0]), datasets:[{ data:s.map(e=>e[1]), backgroundColor:'#55B5E5', borderRadius:3 }] },
    options:{ indexAxis:'y', responsive:true, maintainAspectRatio:false,
      plugins:{legend:{display:false}},
      scales:{ y:{ticks:{font:{size:8},color:'#5a7d94'},grid:{display:false}}, x:{ticks:{font:{size:8},color:'#5a7d94'},grid:{color:'#e8f0f5'}} }
    }
  });
}
function renderChartPaisesClubes() {
  destroyChart('pc');
  const cnt = {};
  JUGADORES.forEach(j => j.pc.forEach(p => { cnt[p]=(cnt[p]||0)+1; }));
  const s = Object.entries(cnt).sort((a,b)=>b[1]-a[1]);
  chartInstances['pc'] = new Chart(document.getElementById('chart-paises-clubes'), {
    type:'bar',
    data:{ labels:s.map(e=>e[0]), datasets:[{ data:s.map(e=>e[1]), backgroundColor:AZ_EXT.slice(0,s.length), borderRadius:3 }] },
    options:{ responsive:true, maintainAspectRatio:false,
      plugins:{legend:{display:false}},
      scales:{ x:{ticks:{font:{size:8},color:'#5a7d94',maxRotation:40},grid:{display:false}}, y:{ticks:{font:{size:9},color:'#5a7d94'},grid:{color:'#e8f0f5'}} }
    }
  });
}
