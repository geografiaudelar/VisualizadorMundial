/* ==========================================================
   main.js — La Celeste en los Mundiales · UdelaR
   Versión optimizada: carga rápida, proyección desde CSV
   ========================================================== */

const CAMPEONES = [1930, 1950];
const SEDES = {
  1930:"Uruguay", 1950:"Brasil", 1954:"Suiza",
  1962:"Chile", 1966:"Inglaterra", 1970:"México",
  1974:"Alemania Occ.", 1986:"México", 1990:"Italia",
  2002:"Corea/Japón", 2010:"Sudáfrica", 2014:"Brasil",
  2018:"Rusia", 2022:"Catar", 2026:"EE.UU./Can./Méx."
};
const MUNDIALES_GEOJSON = [1930,1950,1954,1966,1970,1974,1986,1990,2002,2010,2014,2018,2022,2026];
const MUNDIALES_RECIENTES = [2002,2010,2014,2018,2022,2026];
/* ── Tasas históricas por 100.000 hab por depto (del xlsx Prop100K_hab) ── */
const RATES_100K = {
  "Artigas":        { avg_all: 1.981, avg_rec: 1.286 },
  "Canelones":      { avg_all: 0.659, avg_rec: 0.505 },
  "Cerro Largo":    { avg_all: 1.408, avg_rec: 0     },
  "Colonia":        { avg_all: 1.458, avg_rec: 1.701 },
  "Durazno":        { avg_all: 2.582, avg_rec: 1.752 },
  "Flores":         { avg_all: 0,     avg_rec: 0     },
  "Florida":        { avg_all: 1.490, avg_rec: 0     },
  "Lavalleja":      { avg_all: 1.671, avg_rec: 1.671 },
  "Maldonado":      { avg_all: 2.035, avg_rec: 0.939 },
  "Montevideo":     { avg_all: 1.243, avg_rec: 0.821 },
  "Paysandú":       { avg_all: 1.590, avg_rec: 1.736 },
  "Río Negro":      { avg_all: 2.558, avg_rec: 2.663 },
  "Rivera":         { avg_all: 1.575, avg_rec: 0.915 },
  "Rocha":          { avg_all: 1.580, avg_rec: 0     },
  "Salto":          { avg_all: 1.534, avg_rec: 1.537 },
  "San José":       { avg_all: 1.219, avg_rec: 0     },
  "Soriano":        { avg_all: 2.191, avg_rec: 0     },
  "Tacuarembó":     { avg_all: 1.736, avg_rec: 1.105 },
  "Treinta y Tres": { avg_all: 2.155, avg_rec: 2.028 }
};


/* ── Seeded PRNG ─────────────────────────────────────────── */
function makeRng(seed) {
  let s = seed >>> 0;
  return function() {
    s += 0x6D2B79F5;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function strHash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = Math.imul(31, h) + str.charCodeAt(i) | 0;
  return Math.abs(h);
}
function applyJitter(jugadores) {
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
    if (group.length === 1 && !isMvd) return { ...j, desplazado: false };
    const maxR = isMvd ? 0.008 : 0.004;
    const rng = makeRng(strHash(j.n));
    const angle = rng() * 2 * Math.PI;
    const r = maxR * (0.3 + rng() * 0.7);
    return { ...j, la: j.la + Math.sin(angle) * r, lo: j.lo + Math.cos(angle) * r, desplazado: true };
  });
}


/* ── Sanitizar texto para uso seguro en innerHTML ────────── */
function esc(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
/* Encodear URL para uso en atributos href/src ─────────────── */
function safeUrl(url) {
  if (!url) return '';
  try { return encodeURI(decodeURI(url)); } catch(e) { return encodeURI(url); }
}
/* ── Estado global ─────────────────────────────────────── */
let JUGADORES = [];
let MUNDIALES = [];
let PROY_DATA = [];          // datos de proyecciones2030.csv (Germán)
let mapMain = null, mapTimeline = null, mapProy = null;
let heatLayer = null, markerLayerMain = null, markerLayerIntl = null;
let tlMarkersAll = [];
let coropetaLayer = null, coropetaLabelLayer = null, coropetaVisible = true;
let chartInstances = {};
let tlSorted = [];

/* ── Paths de datos — busca en varias rutas para compatibilidad ── */
const DATA_PATHS = ['data/', './data/', ''];

async function fetchWithFallback(filename) {
  for (const prefix of DATA_PATHS) {
    try {
      const resp = await fetch(prefix + filename);
      if (resp.ok) return resp;
    } catch(e) { /* siguiente */ }
  }
  throw new Error(`No se pudo cargar ${filename}`);
}

/* ── CARGA DE DATOS — paralela y con fallback ─────────────── */
window.addEventListener('DOMContentLoaded', () => {
  const pJug = new Promise((res, rej) => {
    // Fetch como ArrayBuffer y decodificar como UTF-8 para preservar tildes y caracteres especiales
    const tryFetch = async (paths) => {
      for (const prefix of paths) {
        try {
          const resp = await fetch(prefix + 'uruguay_jugadores_mundial.csv');
          if (!resp.ok) continue;
          const buf = await resp.arrayBuffer();
          // Detectar encoding: probar UTF-8, si tiene caracteres de reemplazo (latin-1 mal leído) usar windows-1252
          let text = new TextDecoder('utf-8').decode(buf);
          if (text.includes('\uFFFD')) {
            text = new TextDecoder('windows-1252').decode(buf);
          }
          const parsed = Papa.parse(text, { header: true, skipEmptyLines: true });
          if (parsed.data && parsed.data.length > 0) { res(parsed.data); return; }
        } catch(e) { /* siguiente path */ }
      }
      rej(new Error('No se pudo cargar jugadores CSV'));
    };
    tryFetch(DATA_PATHS);
  });

  const pProy = new Promise((res, rej) => {
    const tryFetch = async (paths) => {
      for (const prefix of paths) {
        try {
          const resp = await fetch(prefix + 'proyecciones2030.csv');
          if (!resp.ok) continue;
          const buf = await resp.arrayBuffer();
          const text = new TextDecoder('utf-8').decode(buf);
          const parsed = Papa.parse(text, { header: true, skipEmptyLines: true });
          if (parsed.data && parsed.data.length > 0) { res(parsed.data); return; }
        } catch(e) { /* siguiente path */ }
      }
      rej(new Error('No se pudo cargar proyecciones CSV'));
    };
    tryFetch(DATA_PATHS);
  });

  const pGeo = fetchWithFallback('deptos_uy_simple.geojson').then(r => r.json());

  Promise.all([pJug, pProy, pGeo]).then(([csvJug, csvProy, gj]) => {
    JUGADORES = applyJitter(parseCSV(csvJug));
    MUNDIALES = [...new Set(JUGADORES.flatMap(j => j.m))].sort((a,b)=>a-b);
    tlSorted = [...JUGADORES].filter(j => j.fechaIso).sort((a,b) => a.fechaIso - b.fechaIso);
    PROY_DATA = parseProy(csvProy);
    window.DEPTOS_GEOJSON = gj;
    initApp();
  }).catch(err => {
    console.error('Error cargando datos:', err);
    document.getElementById('loader').innerHTML =
      `<div style="color:#f87171;font-family:DM Mono,monospace;font-size:12px;text-align:center;padding:20px">
        Error cargando datos.<br><small>${err.message}</small>
      </div>`;
  });
});

function parseCSV(rows) {
  return rows.map(r => {
    const mundiales = (r.lista_mundiales || '').split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n));
    const clubes    = (r.clubes_en_mundiales || '').split(',').map(s => s.trim());
    const paises    = (r.paises_clubes || '').split(',').map(s => s.trim());
    // Capitanías y goles vienen paralelos a lista_mundiales (un valor por mundial)
    const capRaw  = (r.capitan || '').split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n));
    const golRaw  = (r.goles   || '').split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n));
    const cap = mundiales.map((_, i) => capRaw[i] || 0);
    const gol = mundiales.map((_, i) => golRaw[i] || 0);
    const la = parseFloat(r.Latitud);
    const lo = parseFloat(r.Longitud);
    if (isNaN(la) || isNaN(lo)) return null;
    let fechaIso = null;
    if (r.fecha_iso) {
      const parts = r.fecha_iso.split('/');
      if (parts.length === 3) {
        const d = new Date(parseInt(parts[2]), parseInt(parts[0])-1, parseInt(parts[1]));
        if (!isNaN(d)) fechaIso = d;
      }
    }
    let depto = r.depto || null;
    const lu = r.lugar_nacimiento || '';
    if (depto === 'Aires Puros' || depto === 'Palermo') depto = 'Montevideo';
    if (!depto && (lu.includes('Aires Puros') || lu.includes('Palermo') || lu.includes('Montevideo'))) depto = 'Montevideo';
    return {
      n: r.nombre, pos: r.posicion, m: mundiales, cl: clubes, pc: paises,
      cap, gol,
      wiki: r.wiki_enlace || null, fn: r.fecha_nacimiento, fechaIso,
      lu, de: depto, pa: r.pais_nacimiento, la, lo,
      fo: r.url_imagen || null, desplazado: false
    };
  }).filter(Boolean);
}

/* ── Helpers: capitanías y goles totales o por mundial ───── */
function golesDe(j, mundial) {
  if (!j.gol) return 0;
  if (mundial) {
    const idx = j.m.indexOf(mundial);
    return idx === -1 ? 0 : (j.gol[idx] || 0);
  }
  return j.gol.reduce((a,b)=>a+b, 0);
}
function fueCapitan(j, mundial) {
  if (!j.cap) return false;
  if (mundial) {
    const idx = j.m.indexOf(mundial);
    return idx !== -1 && j.cap[idx] === 1;
  }
  return j.cap.some(c => c === 1);
}
function cantCapitanias(j, mundial) {
  if (!j.cap) return 0;
  if (mundial) {
    const idx = j.m.indexOf(mundial);
    return idx === -1 ? 0 : (j.cap[idx] || 0);
  }
  return j.cap.reduce((a,b)=>a+b, 0);
}

/* Parsear proyecciones2030.csv (resultados de Germán) */
function parseProy(rows) {
  return rows
    .filter(r => r.Dpto && r.Dpto !== 'Extranjeros')
    .map(r => {
      const nm = r.Dpto.trim();
      const rates = RATES_100K[nm] || { avg_all: 0, avg_rec: 0 };
      return {
        nm,
        pobProy:     parseFloat(r.Pob2030) || 0,
        prob:        parseFloat(r.prob_2030) || 0,
        probBinom:   parseFloat(r.prob_2030_binom) || 0,
        propComb:    parseFloat(r.prop_2030_comb) || 0,
        cant:        parseFloat(r.cant) || 0,
        cantCorreg:  parseInt(r.cant_correg) || 0,
        rate100k:    rates.avg_all,
        rate100kRec: rates.avg_rec
      };
    })
    .sort((a,b) => b.cantCorreg - a.cantCorreg || b.cant - a.cant);
}

/* ── INICIALIZACIÓN ─────────────────────────────────────── */
function initApp() {
  initVistas();
  initMapaPrincipal();
  initTimelineMap();
  initDashboard();
  poblarFiltroMundial();
  poblarFiltroPosicion();
  poblarTimeline();
  requestAnimationFrame(() => {
    setTimeout(() => {
      if (mapMain) mapMain.invalidateSize();
      if (mapTimeline) mapTimeline.invalidateSize();
      const loader = document.getElementById('loader');
      if (loader) { loader.style.opacity = '0'; setTimeout(() => loader.classList.add('hidden'), 400); }
    }, 200);
  });
}

/* ── VISTAS ──────────────────────────────────────────────── */
function initVistas() {
  const vistas = {
    'btn-mapa':      'view-mapa',
    'btn-timeline':  'view-timeline',
    'btn-dashboard': 'view-dashboard',
    'btn-proy':      'view-proy'
  };
  Object.entries(vistas).forEach(([btnId, viewId]) => {
    const btn = document.getElementById(btnId);
    if (!btn) return;
    btn.addEventListener('click', () => {
      document.querySelectorAll('.view-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      Object.values(vistas).forEach(v => {
        const el = document.getElementById(v);
        if (el) el.classList.toggle('hidden', v !== viewId);
      });
      if (viewId === 'view-mapa'     && mapMain)     setTimeout(() => mapMain.invalidateSize(), 120);
      if (viewId === 'view-timeline' && mapTimeline) {
        setTimeout(() => {
          mapTimeline.invalidateSize();
          if (tlAnimJugadores.length === 0 && tlSorted.length > 0) {
            prepararAnimacion(tlSorted); tlPlay();
          }
        }, 200);
      }
      if (viewId === 'view-dashboard') renderDashboard();
      if (viewId === 'view-proy')      renderProyeccion2030();
    });
  });
}

/* ── MAPA PRINCIPAL ─────────────────────────────────────── */
function initMapaPrincipal() {
  const isMobile = window.innerWidth < 768;
  mapMain = L.map('map', {
    center: isMobile ? [-33.7, -56.0] : [-32.5, -56.0],
    zoom: isMobile ? 6 : 7,
    zoomControl: true,
    scrollWheelZoom: !isMobile,
    preferCanvas: true   // más rápido para muchos markers
  });
  L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; OpenStreetMap &amp; CARTO', subdomains: 'abcd', maxZoom: 18
  }).addTo(mapMain);
  // Pane dedicado para las etiquetas del coropleta: siempre por encima de los marcadores
  mapMain.createPane('coropetaLabelPane');
  mapMain.getPane('coropetaLabelPane').style.zIndex = 650;
  mapMain.getPane('coropetaLabelPane').style.pointerEvents = 'none';
  buildMarkersMain();
  buildCoropeta(getFiltroMundial(), getFiltroPosicion());
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
    if (coropetaVisible) buildCoropeta(getFiltroMundial(), getFiltroPosicion());
    else {
      if (coropetaLayer) mapMain.removeLayer(coropetaLayer);
      if (coropetaLabelLayer) mapMain.removeLayer(coropetaLabelLayer);
    }
  });
  document.getElementById('filter-metrica-coropeta').addEventListener('change', () => {
    if (coropetaVisible) buildCoropeta(getFiltroMundial(), getFiltroPosicion());
  });
  document.getElementById('filter-mundial').addEventListener('change', rebuildMapaDesdeControles);
  document.getElementById('filter-posicion').addEventListener('change', rebuildMapaDesdeControles);
}

function getFiltroMundial() {
  const v = document.getElementById('filter-mundial').value;
  return v === 'todos' ? null : parseInt(v);
}
function getFiltroPosicion() {
  return document.getElementById('filter-posicion').value;
}
function rebuildMapaDesdeControles() {
  const mundial = getFiltroMundial();
  const posicion = getFiltroPosicion();
  buildMarkersMain(mundial, posicion);
  const pts = JUGADORES.filter(j =>
    j.pa === 'Uruguay' &&
    (!mundial || j.m.includes(mundial)) &&
    (posicion === 'todas' || j.pos === posicion)
  );
  buildHeatmap(pts);
  if (coropetaVisible) buildCoropeta(mundial, posicion);
}

function buildHeatmap(pts) {
  if (heatLayer) mapMain.removeLayer(heatLayer);
  const points = (pts || JUGADORES.filter(j => j.pa === 'Uruguay')).map(j => [j.la, j.lo, 1]);
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

function buildMarkersMain(filtroMundial, filtroPosicion) {
  if (markerLayerMain) mapMain.removeLayer(markerLayerMain);
  if (markerLayerIntl) mapMain.removeLayer(markerLayerIntl);
  markerLayerMain = L.layerGroup();
  markerLayerIntl = L.layerGroup();
  const pos = filtroPosicion || getFiltroPosicion();
  const jugs = JUGADORES.filter(j =>
    (!filtroMundial || j.m.includes(filtroMundial)) &&
    (pos === 'todas' || j.pos === pos)
  );
  // Ordenar para que capitanes y goleadores se dibujen por encima del resto
  const jugsOrdenados = [...jugs].sort((a, b) => {
    const da = (fueCapitan(a, filtroMundial) || golesDe(a, filtroMundial) > 0) ? 1 : 0;
    const db = (fueCapitan(b, filtroMundial) || golesDe(b, filtroMundial) > 0) ? 1 : 0;
    return da - db;
  });
  jugsOrdenados.forEach(j => {
    const isIntl = j.pa !== 'Uruguay';
    const destacado = fueCapitan(j, filtroMundial) || golesDe(j, filtroMundial) > 0;
    const marker = L.marker([j.la, j.lo], {
      icon: buildBallIcon(j, isIntl, filtroMundial),
      zIndexOffset: destacado ? 1000 : 0
    });
    // Popup cargado de forma lazy al primer click
    marker.on('click', function() {
      if (!this._popupBuilt) {
        this.bindPopup(buildFichaPopup(j), { maxWidth: 280, minWidth: 260, className: 'ficha-popup' });
        this._popupBuilt = true;
        this.openPopup();
      }
    });
    if (isIntl) markerLayerIntl.addLayer(marker);
    else markerLayerMain.addLayer(marker);
  });
  if (document.getElementById('toggle-markers').checked) markerLayerMain.addTo(mapMain);
  if (document.getElementById('toggle-intl').checked)    markerLayerIntl.addTo(mapMain);
  const posLabel = pos !== 'todas' ? ` · ${pos}` : '';
  document.getElementById('status-map').textContent =
    filtroMundial
      ? `${jugs.length} jugadores · Mundial ${filtroMundial}${posLabel}`
      : `${jugs.length} jugadores · todos los mundiales${posLabel}`;
}

function buildBallIcon(j, isIntl, filtroMundial) {
  const cls = isIntl ? 'dot-marker dot-marker-intl' : 'dot-marker';
  const esCap = fueCapitan(j, filtroMundial);
  const gol = golesDe(j, filtroMundial);
  const capCls = esCap ? ' dot-marker-capitan' : '';
  const golBadge = gol > 0 ? `<span class="dot-marker-gol">${gol}</span>` : '';
  return L.divIcon({
    className:'', html:`<div class="${cls}${capCls}">${golBadge}</div>`,
    iconSize:[9,9], iconAnchor:[4,4], popupAnchor:[0,-7]
  });
}

function buildFichaPopup(j) {
  const pills = j.m.map((año,i) => {
    const es = CAMPEONES.includes(año);
    const esCap = j.cap && j.cap[i] === 1;
    const golM = j.gol ? (j.gol[i] || 0) : 0;
    const golBadge = golM > 0 ? `<span class="popup-pill-gol">⚽${golM}</span>` : '';
    return `<span class="popup-pill${es?' campeon':''}${esCap?' capitan':''}">${año}${es?' 🏆':''}${esCap?' (C)':''}${golBadge}</span>`;
  }).join('');
  const clubes = j.m.map((año,i) => {
    const club = j.cl[Math.min(i, j.cl.length-1)];
    return `<span class="popup-club-item"><span class="popup-club-año">${año}</span> ${esc(club)}</span>`;
  }).join('');
  const totalCap = cantCapitanias(j);
  const totalGol = golesDe(j);
  const resumen = (totalCap > 0 || totalGol > 0)
    ? `<div class="popup-resumen-row">
        ${totalCap>0?`<span class="popup-resumen-item">🅒 ${totalCap} capitanía${totalCap!==1?'s':''}</span>`:''}
        ${totalGol>0?`<span class="popup-resumen-item">⚽ ${totalGol} gol${totalGol!==1?'es':''}</span>`:''}
       </div>`
    : '';
  const wiki  = j.wiki ? `<a href="${safeUrl(j.wiki)}" target="_blank" class="popup-wiki-btn">🔗 Wikipedia / AUF</a>` : '';
  const coord = j.desplazado ? `<div class="popup-coord-note">📌 Coord. estimada, basada sólo en lugar de nacimiento</div>` : '';
  const foto  = j.fo
    ? `<img class="popup-foto" src="${safeUrl(j.fo)}" loading="lazy" alt="" onerror="this.style.display='none'">`
    : `<div class="popup-foto popup-foto-empty">⚽</div>`;
  return `<div class="popup-ficha">
    <div class="popup-ficha-top">${foto}
      <div class="popup-ficha-info">
        <div class="popup-nombre">${esc(j.n)}</div>
        <div class="popup-pos-badge">${esc(j.pos)}</div>
        <div class="popup-lugar">${esc(j.lu)}${j.de?', '+esc(j.de):''}${j.pa!=='Uruguay'?' · '+esc(j.pa):''}</div>
        <div class="popup-fn">${esc(j.fn)}</div>
      </div>
    </div>
    <div class="popup-mundiales-row">${pills}</div>
    ${resumen}
    <div class="popup-clubes-label">Club en el mundial</div>
    <div class="popup-clubes-list">${clubes}</div>
    ${wiki}${coord}
  </div>`;
}

/* ── FILTROS ─────────────────────────────────────────────── */
function poblarFiltroMundial() {
  ['filter-mundial', 'dash-filter-mundial'].forEach(id => {
    const sel = document.getElementById(id);
    if (!sel) return;
    const frag = document.createDocumentFragment();
    MUNDIALES.forEach(año => {
      const opt = document.createElement('option');
      opt.value = año;
      opt.textContent = `${año} · ${SEDES[año]||''}`;
      frag.appendChild(opt);
    });
    sel.appendChild(frag);
  });
}
function poblarFiltroPosicion() {
  const posiciones = [...new Set(JUGADORES.map(j => j.pos))].filter(Boolean).sort();
  ['filter-posicion', 'dash-filter-posicion'].forEach(id => {
    const sel = document.getElementById(id);
    if (!sel) return;
    const frag = document.createDocumentFragment();
    posiciones.forEach(pos => {
      const opt = document.createElement('option');
      opt.value = pos; opt.textContent = pos;
      frag.appendChild(opt);
    });
    sel.appendChild(frag);
  });
}

/* ── COROPLETA ──────────────────────────────────────────── */
function getFiltroMetricaCoropeta() {
  const el = document.getElementById('filter-metrica-coropeta');
  return el ? el.value : 'jugadores';
}
function getCoropetaVal(props, mundial, posicion, metrica) {
  // Siempre calculado en vivo desde el CSV — el GeoJSON solo tiene polígonos
  const nombre = (props.nam || '').toLowerCase();
  const m = metrica || 'jugadores';
  const jugs = JUGADORES.filter(j =>
    j.pa === 'Uruguay' && j.de &&
    j.de.toLowerCase() === nombre &&
    (!mundial || j.m.includes(mundial)) &&
    (posicion === 'todas' || !posicion || j.pos === posicion)
  );
  if (m === 'capitanes') {
    return jugs.reduce((acc, j) => acc + cantCapitanias(j, mundial), 0);
  }
  if (m === 'goles') {
    return jugs.reduce((acc, j) => acc + golesDe(j, mundial), 0);
  }
  return jugs.length;
}

function buildCoropeta(mundial, posicion) {
  if (!window.DEPTOS_GEOJSON) return;
  if (coropetaLayer) { mapMain.removeLayer(coropetaLayer); coropetaLayer = null; }
  const pos = posicion || getFiltroPosicion();
  const metrica = getFiltroMetricaCoropeta();
  const vals = DEPTOS_GEOJSON.features
    .filter(f => f.properties.nam !== 'Extranjeros')
    .map(f => getCoropetaVal(f.properties, mundial, pos, metrica));
  const maxVal = Math.max(...vals, 1);
  const etiqueta = metrica === 'capitanes' ? 'capitanía' : (metrica === 'goles' ? 'gol' : 'jugador');
  const etiquetaPl = metrica === 'capitanes' ? 'capitanías' : (metrica === 'goles' ? 'goles' : 'jugadores');

  coropetaLayer = L.geoJSON(DEPTOS_GEOJSON, {
    filter: f => f.properties.nam !== 'Extranjeros',
    style: feat => {
      const v = getCoropetaVal(feat.properties, mundial, pos, metrica);
      const t = v / maxVal;
      const r = Math.round(204 + (10 - 204) * t);
      const g = Math.round(232 + (58 - 232) * t);
      const b = Math.round(245 + (90 - 245) * t);
      return {
        fillColor: v === 0 ? 'rgba(230,240,248,0.5)' : `rgba(${r},${g},${b},0.82)`,
        color: '#2299d8', weight: 1.5, opacity: 0.9, fillOpacity: 1
      };
    },
    onEachFeature: (feat, layer) => {
      const v = getCoropetaVal(feat.properties, mundial, pos, metrica);
      const vJug = metrica === 'jugadores' ? v : getCoropetaVal(feat.properties, mundial, pos, 'jugadores');
      const nm = feat.properties.nam || '';
      const totalJugs = mundial
        ? (JUGADORES.filter(j => j.pa === 'Uruguay' && j.m.includes(mundial)).length || 1)
        : (JUGADORES.filter(j => j.pa === 'Uruguay').length || 1);
      const pctJug = (vJug / totalJugs * 100).toFixed(1);
      let extra = '';
      if (metrica !== 'jugadores') {
        const totalMetrica = Math.max(vals.reduce((a,b)=>a+b,0), 1);
        const pctM = (v / totalMetrica * 100).toFixed(1);
        extra = `<br>${v} ${v===1?etiqueta:etiquetaPl} (${pctM}%)`;
      }
      layer.bindTooltip(
        `<b>${nm}</b><br>${vJug} jugador${vJug!==1?'es':''} (${pctJug}%)${extra}${mundial?' · '+mundial:' · total'}`,
        { sticky: true }
      );
    }
  });
  if (coropetaVisible) {
    coropetaLayer.addTo(mapMain);
    if (coropetaLabelLayer) mapMain.removeLayer(coropetaLabelLayer);
    coropetaLabelLayer = L.layerGroup();
    DEPTOS_GEOJSON.features
      .filter(f => f.properties.nam !== 'Extranjeros')
      .forEach(feat => {
        const v = getCoropetaVal(feat.properties, mundial, pos, metrica);
        const vJug = metrica === 'jugadores' ? v : getCoropetaVal(feat.properties, mundial, pos, 'jugadores');
        if (vJug === 0 && v === 0) return;
        const g = feat.geometry;
        const rings = g.type === 'Polygon' ? [g.coordinates[0]] : g.coordinates.map(p=>p[0]);
        const best = rings.reduce((a,b) =>
          (Math.max(...b.map(c=>c[0]))-Math.min(...b.map(c=>c[0]))) > (Math.max(...a.map(c=>c[0]))-Math.min(...a.map(c=>c[0]))) ? b : a
        );
        const cx = best.reduce((s,c)=>s+c[0],0)/best.length;
        const cy = best.reduce((s,c)=>s+c[1],0)/best.length;
        const totalJ = mundial
          ? (JUGADORES.filter(j => j.pa === 'Uruguay' && j.m.includes(mundial)).length || 1)
          : (JUGADORES.filter(j => j.pa === 'Uruguay').length || 1);
        const pctJugLbl = (vJug / totalJ * 100).toFixed(1) + '%';
        let extraLbl = '';
        if (metrica !== 'jugadores') {
          const totalMetrica = Math.max(vals.reduce((a,b)=>a+b,0), 1);
          const pctMLbl = (v / totalMetrica * 100).toFixed(1) + '%';
          extraLbl = `<br><span class="coropeta-lbl-metrica">${v} ${etiquetaPl}<br><span style="font-size:8px;opacity:.75">${pctMLbl}</span></span>`;
        }
        L.marker([cy, cx], {
          pane: 'coropetaLabelPane',
          icon: L.divIcon({
            className: 'proy-label-icon',
            html: `<div class="coropeta-lbl">${vJug}<br><span style="font-size:8px;opacity:.75">${pctJugLbl}</span>${extraLbl}</div>`,
            iconSize: null,
            iconAnchor: null
          })
        }).addTo(coropetaLabelLayer);
      });
    coropetaLabelLayer.addTo(mapMain);
  }
}

/* ── TIMELINE ─────────────────────────────────────────────── */
let tlMundialActivo = null;
let tlAnimPlaying = false;
let tlAnimJugadores = [];
let tlAnimIdx = 0;
let tlAnimIntervalMs = 120;
let tlAnimTimer = null;
let tlDotEls = [];
let tlMiniTimeout = null;

function initTimelineMap() {
  const isMobileTL = window.innerWidth < 768;
  mapTimeline = L.map('map-timeline', {
    center: [-33.0, -54.3],
    zoom: isMobileTL ? 6 : 7,
    scrollWheelZoom: !isMobileTL,
    preferCanvas: true
  });
  L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
    attribution:'', subdomains:'abcd', maxZoom:18
  }).addTo(mapTimeline);
}

function poblarTimeline() {
  const cont = document.getElementById('tl-mundiales');
  const frag = document.createDocumentFragment();
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
    frag.appendChild(btn);
  });
  cont.appendChild(frag);
  document.getElementById('tl-btn-play').addEventListener('click', tlPlay);
  document.getElementById('tl-btn-pause').addEventListener('click', tlPause);
  document.getElementById('tl-btn-restart').addEventListener('click', tlRestart);
}

function seleccionarMundialTimeline(año) {
  if (tlMundialActivo === año) {
    tlMundialActivo = null;
    document.querySelectorAll('.tl-mundial-btn').forEach(b => b.classList.remove('active'));
    document.getElementById('tl-info').innerHTML = '<div class="tl-info-placeholder">← Seleccioná un mundial</div>';
    document.getElementById('tl-player-list').innerHTML = '';
    prepararAnimacion(tlSorted); tlPlay();
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
  const frag = document.createDocumentFragment();
  [...jugs].sort((a,b)=>(a.fechaIso||0)-(b.fechaIso||0)).forEach(j => {
    const item = document.createElement('div');
    item.className = 'tl-player-item';
    item.dataset.nombre = j.n;
    item.innerHTML = `
      ${j.fo?`<img class="tl-player-foto" src="${safeUrl(j.fo)}" loading="lazy" onerror="this.src=''" alt="">`:'<div class="tl-player-foto"></div>'}
      <div class="tl-player-info">
        <div class="tl-player-nombre">${esc(j.n)}</div>
        <div class="tl-player-pos">${esc(j.pos)}</div>
      </div>
      <span class="tl-player-depto">${esc(j.de||j.pa)}</span>`;
    item.addEventListener('click', () => {
      const mk = tlMarkersAll.find(m => m._jugador && m._jugador.n === j.n);
      if (mk) { mapTimeline.setView(mk.getLatLng(), 10); mk.openPopup(); }
    });
    frag.appendChild(item);
  });
  lista.innerHTML = '';
  lista.appendChild(frag);
  const jugsTL = [...jugs].filter(j=>j.fechaIso).sort((a,b)=>a.fechaIso-b.fechaIso);
  prepararAnimacion(jugsTL); tlPlay();
  const ptsUY = jugs.filter(j=>j.pa==='Uruguay');
  if (ptsUY.length) mapTimeline.fitBounds(L.latLngBounds(ptsUY.map(j=>[j.la,j.lo])),{padding:[40,40],maxZoom:10});
}

function prepararAnimacion(jugadores) {
  tlPause();
  tlMarkersAll.forEach(m => mapTimeline.removeLayer(m));
  tlMarkersAll = [];
  tlAnimJugadores = jugadores;
  tlAnimIdx = 0;
  tlDotEls = [];
  const dotsEl = document.getElementById('tl-birth-dots');
  dotsEl.innerHTML = '<div class="tl-birth-line"></div>';
  if (!jugadores.length) {
    ['tl-year-min','tl-year-max','tl-birth-title'].forEach(id => document.getElementById(id).textContent = '');
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
  const frag = document.createDocumentFragment();
  jugadores.forEach((j, i) => {
    const pct = ((j.fechaIso.getTime() - minD) / range * 88 + 6).toFixed(2);
    const dot = document.createElement('div');
    dot.className = `tl-birth-dot${j.pa !== 'Uruguay'?' intl':''}`;
    dot.style.left = `${pct}%`;
    dot.style.opacity = '0';
    dot.title = `${j.n} · ${j.fn}`;
    dot.addEventListener('click', () => {
      const mk = tlMarkersAll.find(m => m._jugador && m._jugador.n === j.n);
      if (mk) { mapTimeline.setView(mk.getLatLng(), 10); mk.openPopup(); }
    });
    frag.appendChild(dot);
    tlDotEls.push(dot);
  });
  dotsEl.appendChild(frag);
  tlAnimIntervalMs = Math.min(Math.max(4000 / jugadores.length, 60), 200);
}

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
function tlRestart() { prepararAnimacion(tlAnimJugadores); tlPlay(); }

function tlStep() {
  if (!tlAnimPlaying) return;
  if (tlAnimIdx >= tlAnimJugadores.length) {
    tlAnimPlaying = false;
    document.getElementById('tl-btn-play').classList.remove('active');
    document.getElementById('tl-progress').style.width = '100%';
    return;
  }
  const j = tlAnimJugadores[tlAnimIdx];
  const i = tlAnimIdx;
  const dot = tlDotEls[i];
  if (dot) {
    dot.style.opacity = '1';
    dot.style.transition = 'opacity .18s';
    dot.style.transform = 'translate(-50%,-50%) scale(2)';
    setTimeout(() => { if(dot) dot.style.transform = ''; }, 300);
  }
  document.getElementById('tl-progress').style.width = `${((i+1)/tlAnimJugadores.length*100).toFixed(1)}%`;
  const isIntl = j.pa !== 'Uruguay';
  const mk = L.marker([j.la, j.lo], { icon: buildBallIcon(j, isIntl) });
  mk.on('click', function() {
    if (!this._popupBuilt) {
      this.bindPopup(buildFichaPopup(j), { maxWidth:280, minWidth:260, className:'ficha-popup' });
      this._popupBuilt = true;
      this.openPopup();
    }
  });
  mk._jugador = j;
  mk.addTo(mapTimeline);
  tlMarkersAll.push(mk);
  mostrarMiniCard(j);
  document.querySelectorAll('.tl-player-item').forEach(el => {
    el.classList.toggle('tl-item-active', el.dataset.nombre === j.n);
    if (el.dataset.nombre === j.n) el.scrollIntoView({ block:'nearest', behavior:'smooth' });
  });
  tlAnimIdx++;
  tlAnimTimer = setTimeout(tlStep, tlAnimIntervalMs);
}

function mostrarMiniCard(j) {
  const card = document.getElementById('tl-mini-card');
  if (!card) return;
  if (tlMiniTimeout) clearTimeout(tlMiniTimeout);
  card.innerHTML = `
    <div class="mc-foto-wrap">
      ${j.fo ? `<img src="${safeUrl(j.fo)}" loading="lazy" onerror="this.style.display='none'" alt="">` : '<span>⚽</span>'}
    </div>
    <div class="mc-info">
      <div class="mc-nombre">${esc(j.n)}</div>
      <div class="mc-pos">${esc(j.pos)}</div>
      <div class="mc-fn">${esc(j.fn)}</div>
      <div class="mc-lugar">${esc(j.lu)}${j.de?', '+esc(j.de):''}</div>
    </div>`;
  card.classList.add('visible');
  tlMiniTimeout = setTimeout(() => card.classList.remove('visible'), 2500);
}

/* ── DASHBOARD ──────────────────────────────────────────── */
function initDashboard() {
  const ext = JUGADORES.filter(j => j.pa !== 'Uruguay').length;
  const deptoCnt = {};
  JUGADORES.filter(j => j.de).forEach(j => { deptoCnt[j.de] = (deptoCnt[j.de]||0)+1; });
  const topD = Object.entries(deptoCnt).sort((a,b)=>b[1]-a[1])[0];
  const maxM = Math.max(...JUGADORES.map(j => j.m.length));
  const topNames = JUGADORES.filter(j=>j.m.length===maxM).map(j=>j.n.split(' ').pop()).join(', ');
  document.getElementById('kpi-total').textContent     = JUGADORES.length;
  document.getElementById('kpi-mundiales').textContent = MUNDIALES.length;
  document.getElementById('kpi-depto-top').textContent = topD ? `${topD[0]} (${topD[1]})` : 'N/D';
  document.getElementById('kpi-extranacidos').textContent = ext;
  document.getElementById('kpi-extranacidos-pct').textContent = Math.round(ext/JUGADORES.length*100)+'%';
  document.getElementById('kpi-campeones').textContent = CAMPEONES.length;
  document.getElementById('kpi-mas-mundiales').textContent = `${maxM} · ${topNames}`;

  // Máximo goleador histórico
  const goleador = [...JUGADORES].sort((a,b) => golesDe(b) - golesDe(a))[0];
  const golesTop = goleador ? golesDe(goleador) : 0;
  document.getElementById('kpi-goleador').textContent =
    goleador && golesTop > 0 ? `${goleador.n.split(' ').pop()} (${golesTop})` : 'N/D';

  // Departamento con más capitanías acumuladas
  const capCnt = {};
  JUGADORES.filter(j => j.pa === 'Uruguay' && j.de).forEach(j => {
    const c = cantCapitanias(j);
    if (c > 0) capCnt[j.de] = (capCnt[j.de]||0) + c;
  });
  const topCapDepto = Object.entries(capCnt).sort((a,b)=>b[1]-a[1])[0];
  document.getElementById('kpi-depto-capitanes').textContent =
    topCapDepto ? `${topCapDepto[0]} (${topCapDepto[1]})` : 'N/D';

  document.getElementById('dash-filter-mundial').addEventListener('change', () => { dashRendered = false; renderDashboard(); });
  document.getElementById('dash-filter-posicion').addEventListener('change', () => { dashRendered = false; renderDashboard(); });
}

function getDashJugadores() {
  const m = document.getElementById('dash-filter-mundial').value;
  const p = document.getElementById('dash-filter-posicion').value;
  return JUGADORES.filter(j =>
    (m === 'todos' || j.m.includes(parseInt(m))) &&
    (p === 'todas' || j.pos === p)
  );
}

let dashRendered = false;
function renderDashboard() {
  if (dashRendered) return;
  dashRendered = true;
  const jugs = getDashJugadores();
  renderChartPosiciones(jugs);
  renderChartDeptos(jugs);
  renderChartClubes(jugs);
  renderChartPaisesClubes(jugs);
  renderChartCapitanesDepto(jugs);
  renderChartGolesDepto(jugs);
}

const AZULES = ['#0a3a5a','#155a8a','#1a78b8','#2299d8','#55B5E5','#7fcbee','#a5dbf4','#ccedf9'];
const AZ_EXT = [...AZULES,...AZULES];

function destroyChart(id) {
  if (chartInstances[id]) { chartInstances[id].destroy(); delete chartInstances[id]; }
}
function renderChartPosiciones(jugs) {
  destroyChart('pos');
  const cnt = {};
  (jugs||JUGADORES).forEach(j => { cnt[j.pos]=(cnt[j.pos]||0)+1; });
  const s = Object.entries(cnt).sort((a,b)=>b[1]-a[1]);
  chartInstances['pos'] = new Chart(document.getElementById('chart-posiciones'), {
    type:'doughnut',
    data:{ labels:s.map(e=>e[0]), datasets:[{ data:s.map(e=>e[1]), backgroundColor:AZULES.slice(0,s.length), borderWidth:2, borderColor:'#fff' }] },
    options:{ responsive:true, maintainAspectRatio:false, cutout:'60%', plugins:{ legend:{ position:'bottom', labels:{font:{size:9},padding:8,boxWidth:10} } } }
  });
}
function renderChartDeptos(jugs) {
  destroyChart('dp');
  const cnt = {};
  (jugs||JUGADORES).filter(j=>j.de).forEach(j => { cnt[j.de]=(cnt[j.de]||0)+1; });
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
function renderChartCapitanesDepto(jugs) {
  destroyChart('cap');
  const m = document.getElementById('dash-filter-mundial').value;
  const mundial = m === 'todos' ? null : parseInt(m);
  const cnt = {};
  (jugs||JUGADORES).filter(j => j.pa === 'Uruguay' && j.de).forEach(j => {
    const c = cantCapitanias(j, mundial);
    if (c > 0) cnt[j.de] = (cnt[j.de]||0) + c;
  });
  const s = Object.entries(cnt).sort((a,b)=>b[1]-a[1]);
  chartInstances['cap'] = new Chart(document.getElementById('chart-capitanes-depto'), {
    type:'bar',
    data:{ labels:s.map(e=>e[0]), datasets:[{ label:'capitanías', data:s.map(e=>e[1]), backgroundColor:'#0a3a5a', borderRadius:3 }] },
    options:{ indexAxis:'y', responsive:true, maintainAspectRatio:false,
      plugins:{ legend:{display:false}, tooltip:{ callbacks:{ label: ctx => `${ctx.raw} capitanía${ctx.raw!==1?'s':''}` } } },
      scales:{ y:{ticks:{font:{size:9},color:'#5a7d94'},grid:{display:false}}, x:{ticks:{font:{size:9},color:'#5a7d94'},grid:{color:'#e8f0f5'}} }
    }
  });
}
function renderChartGolesDepto(jugs) {
  destroyChart('gol');
  const m = document.getElementById('dash-filter-mundial').value;
  const mundial = m === 'todos' ? null : parseInt(m);
  const cnt = {};
  (jugs||JUGADORES).filter(j => j.pa === 'Uruguay' && j.de).forEach(j => {
    const g = golesDe(j, mundial);
    if (g > 0) cnt[j.de] = (cnt[j.de]||0) + g;
  });
  const s = Object.entries(cnt).sort((a,b)=>b[1]-a[1]);
  chartInstances['gol'] = new Chart(document.getElementById('chart-goles-depto'), {
    type:'bar',
    data:{ labels:s.map(e=>e[0]), datasets:[{ label:'goles', data:s.map(e=>e[1]), backgroundColor:'#c8a84b', borderRadius:3 }] },
    options:{ indexAxis:'y', responsive:true, maintainAspectRatio:false,
      plugins:{ legend:{display:false}, tooltip:{ callbacks:{ label: ctx => `${ctx.raw} gol${ctx.raw!==1?'es':''}` } } },
      scales:{ y:{ticks:{font:{size:9},color:'#5a7d94'},grid:{display:false}}, x:{ticks:{font:{size:9},color:'#5a7d94'},grid:{color:'#e8f0f5'}} }
    }
  });
}
function renderChartClubes(jugs) {
  destroyChart('cl');
  const cnt = {};
  (jugs||JUGADORES).forEach(j => j.cl.forEach(c => { cnt[c]=(cnt[c]||0)+1; }));
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
function renderChartPaisesClubes(jugs) {
  destroyChart('pc');
  const cnt = {};
  (jugs||JUGADORES).forEach(j => j.pc.forEach(p => { cnt[p]=(cnt[p]||0)+1; }));
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

/* ══════════════════════════════════════════════════════════
   PROYECCIÓN 2030 — usa proyecciones2030.csv (Germán Botto)
   Modelo de Germán: Bayes empírico con prior histórico (1930-2026)
   y verosimilitud reciente (2002-2026), normalizado por pob. 2030 del INE.
   Resultado: 1 extranjero + 25 uruguayos distribuidos por departamento.
   ══════════════════════════════════════════════════════════ */

let proyRendered = false;
function renderProyeccion2030() {
  if (proyRendered) return;
  proyRendered = true;

  if (!window.DEPTOS_GEOJSON || !PROY_DATA.length) {
    setTimeout(renderProyeccion2030, 400);
    proyRendered = false;
    return;
  }

  // Construir tabla con datos del modelo del Dpto. de Geografía
  const tbody = document.getElementById('proy-tbody');
  tbody.innerHTML = '';
  const maxCant = Math.max(...PROY_DATA.map(d => d.cant), 0.1);

  // Agregar fila de extranjero al final
  const extranjero = { nm: 'Extranjeros / Nacidos fuera UY', cantCorreg: 1, cant: 1, pobProy: null, prob: null, propComb: null, rate100k: null, rate100kRec: null };
  const filas = [...PROY_DATA, extranjero];

  filas.forEach(d => {
    const barW = d.cant ? Math.round((d.cant / maxCant) * 80) : 0;
    const jugDisp = d.cantCorreg > 0 ? d.cantCorreg : (d.cant < 0.05 ? '<0.1' : d.cant.toFixed(1));
    const pobStr = d.pobProy ? `${(d.pobProy/1000).toFixed(0)}k` : 'N/D';
    const probStr = d.prob !== null ? (d.prob * 100).toFixed(1) + '%' : 'N/D';
    const propStr = d.propComb !== null ? d.propComb.toFixed(2) : 'N/D';
    const rateStr = d.rate100k !== null && d.rate100k !== undefined
      ? `${d.rate100k.toFixed(2)}<span class="rate-sep"> / </span><span class="rate-rec">${d.rate100kRec !== undefined && d.rate100kRec > 0 ? d.rate100kRec.toFixed(2) : '0.00'}</span>`
      : 'N/D';
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><b>${d.nm}</b></td>
      <td class="rate-cell">${rateStr}</td>
      <td>${probStr}</td>
      <td>${pobStr}</td>
      <td>
        ${barW > 0 ? `<div class="proy-score-bar" style="width:${barW}px"></div>` : ''}
        <span class="proy-score-num">${propStr}</span>
      </td>
      <td class="proy-est-val">${jugDisp}</td>`;
    tbody.appendChild(tr);
  });

  // Metodología
  const methodEl = document.getElementById('proy-method-text');
  methodEl.innerHTML = `
    Para cada departamento se calculó cuántos jugadores por cada 100.000 habitantes
    representaron a Uruguay en cada mundial, usando el censo del INE más cercano a ese año.
    Se promedian dos períodos: el histórico completo (1930-2026) y el reciente (2002-2026),
    dándole más peso al reciente porque refleja mejor cómo funciona el fútbol formativo hoy.
    Ese promedio ponderado se multiplica por la población proyectada de cada departamento
    al 2030 (proyecciones INE, revisión 2025) para estimar cuántos mundialistas podría
    aportar cada zona. El resultado distribuye 26 plazas (1 extranjero + 25 uruguayos).
    La columna <i>Jug./100k hab.</i> muestra las dos tasas: histórica completa / reciente.

    <div class="proy-formula-block">
      <span class="proy-formula-label">Distribución estimada del plantel 2030</span>
      <div class="proy-formula" id="f1"></div>
      <div class="proy-formula-vars" id="f1v"></div>
    </div>

    <div class="proy-formula-block">
      <span class="proy-formula-label">Tasa por departamento</span>
      <div class="proy-formula" id="f2"></div>
      <div class="proy-formula-vars" id="f2v"></div>
    </div>

    <b>Resultado:</b> 1 extranjero y, de los 25 uruguayos restantes: Montevideo (16),
    Canelones (3), Salto (2), Artigas (1), Colonia (1), Paysandú (1) y Río Negro (1).

    <b>Limitaciones:</b> el modelo no incorpora academias de formación, migración
    intra-país posterior a 2023 ni la concentración de captación en clubes de la capital.`;

  function renderFormulas() {
    if (typeof katex === 'undefined') { setTimeout(renderFormulas, 200); return; }
    const R = (id, tex, disp) => {
      const el = document.getElementById(id);
      if (el) katex.render(tex, el, { displayMode: disp, throwOnError: false });
    };
    R('f1',
      '\\text{jugadores}_{d}^{\\text{est.}} = 25 \\times \\dfrac{\\text{score}_d}{\\sum_{d^{\\prime}} \\text{score}_{d^{\\prime}}} + 1_{\\text{ext.}}',
      true);
    const el1v = document.getElementById('f1v');
    if (el1v) el1v.innerHTML = 'donde <span id="ia1"></span> es la puntuación del departamento <i>d</i> (tasa ponderada × población 2030), y el extranjero se suma por separado.';
    if (typeof katex !== 'undefined') katex.render('\\text{score}_d', document.getElementById('ia1'), {throwOnError:false});

    R('f2',
      '\\theta_{d,t} = \\dfrac{J_{d,t}}{P_{d,c(t)} / 100{.}000}',
      true);
    const el2v = document.getElementById('f2v');
    if (el2v) el2v.innerHTML =
      '<span id="ib1"></span> = jugadores del depto. en mundial <span id="ib2"></span>; ' +
      '<span id="ib3"></span> = población en el censo más cercano al año <span id="ib4"></span>.';
    if (typeof katex !== 'undefined') {
      katex.render('J_{d,t}', document.getElementById('ib1'), {throwOnError:false});
      katex.render('t', document.getElementById('ib2'), {throwOnError:false});
      katex.render('P_{d,c(t)}', document.getElementById('ib3'), {throwOnError:false});
      katex.render('t', document.getElementById('ib4'), {throwOnError:false});
    }
  }
  renderFormulas();

  // Mapa Leaflet con resultados de Germán
  initProyMap(PROY_DATA);
}

function initProyMap(scores) {
  const container = document.getElementById('proy-map-leaflet');
  if (!container) return;
  if (mapProy) { mapProy.remove(); mapProy = null; }

  mapProy = L.map('proy-map-leaflet', {
    center: [-32.8, -56.2], zoom: 6,
    zoomControl: true, attributionControl: false,
    scrollWheelZoom: false
  });

  L.tileLayer('https://{s}.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}{r}.png', {
    subdomains:'abcd', maxZoom:18
  }).addTo(mapProy);

  const maxJug = Math.max(...scores.map(d => d.cantCorreg), 1);

  const CENTROIDS = {
    'Montevideo':    [-56.2320, -34.8313],
    'Canelones':     [-55.9947, -34.4642],
    'Maldonado':     [-54.7400, -34.4493],
    'San José':      [-56.5970, -34.2938],
    'Colonia':       [-57.7563, -34.1938],
    'Lavalleja':     [-54.8209, -33.9076],
    'Rocha':         [-54.1509, -33.8095],
    'Flores':        [-56.8131, -33.5166],
    'Florida':       [-55.9893, -33.8834],
    'Soriano':       [-57.5687, -33.2871],
    'Treinta y Tres':[-53.9322, -32.9962],
    'Durazno':       [-56.1437, -32.8916],
    'Cerro Largo':   [-54.3235, -32.3784],
    'Paysandú':      [-57.5230, -32.0892],
    'Artigas':       [-56.7237, -30.5113],
    'Rivera':        [-55.2704, -31.6231],
    'Río Negro':     [-57.3058, -32.9037],
    'Tacuarembó':    [-56.0236, -32.4664],
    'Salto':         [-57.4085, -31.3541]
  };

  L.geoJSON(window.DEPTOS_GEOJSON, {
    filter: f => f.properties.nam !== 'Extranjeros',
    style: feat => {
      const nm = feat.properties.nam;
      const s = scores.find(d => d.nm === nm);
      const t = s ? s.cantCorreg / maxJug : 0;
      const r = Math.round(204 + (10 - 204) * t);
      const g = Math.round(232 + (58 - 232) * t);
      const b2= Math.round(245 + (90 - 245) * t);
      return {
        fillColor: t < 0.01 ? '#ddeef8' : `rgb(${r},${g},${b2})`,
        color: '#ffffff', weight: 2, opacity: 1, fillOpacity: 0.92
      };
    },
    onEachFeature: (feat, layer) => {
      const nm = feat.properties.nam;
      const s = scores.find(d => d.nm === nm);
      const jugDisp = s && s.cantCorreg > 0 ? s.cantCorreg : '0';
      const probStr = s && s.prob !== null ? (s.prob * 100).toFixed(1) + '%' : 'N/D';
      layer.bindTooltip(
        `<b>${nm}</b><br>Jugadores est.: <b>${jugDisp}</b><br>Prob. modelo: ${probStr}<br>Pob. 2030 est.: ${s ? (s.pobProy/1000).toFixed(0)+'k' : 'N/D'}`,
        { sticky: true, className: 'proy-tooltip' }
      );
    }
  }).addTo(mapProy);

  window._proyLabelLayer = L.layerGroup().addTo(mapProy);

  function buildLabels(visible) {
    window._proyLabelLayer.clearLayers();
    if (!visible) return;
    scores.forEach(d => {
      const ctr = CENTROIDS[d.nm];
      if (!ctr) return;
      const jugDisp = d.cantCorreg > 0 ? String(d.cantCorreg) : '';
      if (!jugDisp) return;
      const t = d.cantCorreg / maxJug;
      const txtColor = t > 0.55 ? '#fff' : '#0a3a5a';
      const bgColor  = t > 0.55 ? 'rgba(10,58,90,0.68)' : 'rgba(255,255,255,0.78)';
      const isMvd = d.nm === 'Montevideo';

      if (isMvd) {
        const labelLat = -35.30, labelLng = -56.10;
        L.polyline([[ctr[1], ctr[0]], [labelLat, labelLng]], {
          color: '#0a3a5a', weight: 1, dashArray: '3 3', opacity: 0.6
        }).addTo(window._proyLabelLayer);
        L.marker([labelLat, labelLng], {
          icon: L.divIcon({
            className: 'proy-label-icon',
            html: `<div class="proy-map-label mvd-label" style="color:${txtColor};background:${bgColor}">
                     <span class="proy-lbl-nm">Mvd.</span>
                     <span class="proy-lbl-val">${jugDisp}</span>
                   </div>`,
            iconSize: null, iconAnchor: null
          })
        }).addTo(window._proyLabelLayer);
      } else {
        L.marker([ctr[1], ctr[0]], {
          icon: L.divIcon({
            className: 'proy-label-icon',
            html: `<div class="proy-map-label" style="color:${txtColor};background:${bgColor}">
                     <span class="proy-lbl-val">${jugDisp}</span>
                   </div>`,
            iconSize: null, iconAnchor: null
          })
        }).addTo(window._proyLabelLayer);
      }
    });
  }

  buildLabels(true);

  const toggleBtn = document.getElementById('proy-toggle-labels');
  if (toggleBtn) {
    toggleBtn.checked = true;
    toggleBtn.onchange = () => buildLabels(toggleBtn.checked);
  }

  setTimeout(() => mapProy.invalidateSize(), 200);
}
