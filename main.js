/* ==========================================================
   main.js — La Celeste en los Mundiales · UdelaR
   ========================================================== */

const CAMPEONES = [1930, 1950];
const SEDES = {
  1930:"Uruguay", 1950:"Brasil", 1954:"Suiza",
  1962:"Chile", 1966:"Inglaterra", 1970:"México",
  1974:"Alemania Occ.", 1986:"México", 1990:"Italia",
  2002:"Corea/Japón", 2010:"Sudáfrica", 2014:"Brasil",
  2018:"Rusia", 2022:"Catar", 2026:"EE.UU./Can./Méx."
};
// Mundiales en el GeoJSON (propiedades Mund_XXXX)
const MUNDIALES_GEOJSON = [1930,1950,1954,1966,1970,1974,1986,1990,2002,2010,2014,2018,2022,2026];
const MUNDIALES_RECIENTES = [2002,2010,2014,2018,2022,2026];

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

/* ── Estado global ─────────────────────────────────────── */
let JUGADORES = [];
let MUNDIALES = [];
let POB_LOCALIDADES = {};   // { "Departamento": [ {ciudad, serie:[{año,pob},...]} ] }
let mapMain = null, mapTimeline = null, mapProy = null;
let heatLayer = null, markerLayerMain = null, markerLayerIntl = null;
let tlMarkersAll = [];
let coropetaLayer = null, coropetaLabelLayer = null, coropetaVisible = false;
let chartInstances = {};
let tlSorted = [];

/* ── CARGA DE DATOS ─────────────────────────────────────── */
window.addEventListener('DOMContentLoaded', () => {
  // Cargar CSV de jugadores
  const p1 = new Promise((res, rej) => {
    Papa.parse('data/uruguay_jugadores_mundial.csv', {
      download:true, header:true, skipEmptyLines:true,
      complete: r => res(r.data),
      error: rej
    });
  });
  // Cargar CSV de población
  const p2 = new Promise((res, rej) => {
    Papa.parse('data/evolucion_pob.csv', {
      download:true, header:true, skipEmptyLines:true,
      complete: r => res(r.data),
      error: rej
    });
  });
  // Cargar GeoJSON
  const p3 = fetch('data/jugadores_dptos_mundial_wgs84.geojson').then(r => r.json());

  Promise.all([p1, p2, p3]).then(([csvJug, csvPob, gj]) => {
    JUGADORES = applyJitter(parseCSV(csvJug));
    MUNDIALES = [...new Set(JUGADORES.flatMap(j => j.m))].sort((a,b)=>a-b);
    tlSorted = [...JUGADORES].filter(j => j.fechaIso).sort((a,b) => a.fechaIso - b.fechaIso);
    POB_LOCALIDADES = parsePobCSV(csvPob);
    window.DEPTOS_GEOJSON = gj;
    initApp();
  }).catch(err => {
    console.error('Error cargando datos:', err);
    document.getElementById('loader').classList.add('hidden');
  });
});

function parseCSV(rows) {
  return rows.map(r => {
    const mundiales = r.lista_mundiales.split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n));
    const clubes    = r.clubes_en_mundiales.split(',').map(s => s.trim());
    const paises    = r.paises_clubes.split(',').map(s => s.trim());
    const la = parseFloat(r.Latitud);
    const lo = parseFloat(r.Longitud);
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
      wiki: r.wiki_enlace || null, fn: r.fecha_nacimiento, fechaIso,
      lu, de: depto, pa: r.pais_nacimiento, la, lo,
      fo: r.url_imagen || null, desplazado: false
    };
  });
}

/* Parsear evolucion_pob.csv
   Retorna { "Artigas": [{ciudad:"Artigas", serie:[{año:1963,pob:23429},...]}], ... }
*/
function parsePobCSV(rows) {
  const AÑOS_CENSO = [1963,1975,1985,1996,2004,2011,2023];
  const result = {};
  rows.forEach(r => {
    const ciudad = (r['Ciudad / Localidad'] || '').trim();
    const depto  = (r['Departamento'] || '').trim();
    if (!depto) return;
    const serie = AÑOS_CENSO.map(a => {
      const v = parseFloat(r[String(a)]);
      return isNaN(v) ? null : { año: a, pob: v };
    }).filter(Boolean);
    if (serie.length < 2) return; // necesitamos al menos 2 puntos para tendencia
    if (!result[depto]) result[depto] = [];
    result[depto].push({ ciudad, serie });
  });
  return result;
}

/* ── Regresión lineal simple ────────────────────────────── */
function linearRegression(xs, ys) {
  const n = xs.length;
  const xm = xs.reduce((a,b)=>a+b,0)/n;
  const ym = ys.reduce((a,b)=>a+b,0)/n;
  const num = xs.reduce((s,x,i)=>s+(x-xm)*(ys[i]-ym),0);
  const den = xs.reduce((s,x)=>s+(x-xm)**2,0);
  const slope = den ? num/den : 0;
  return { slope, intercept: ym - slope*xm };
}

/* Proyectar población de una localidad al año target */
function proyLocalidad(serie, targetAño) {
  const xs = serie.map(p => p.año);
  const ys = serie.map(p => p.pob);
  const { slope, intercept } = linearRegression(xs, ys);
  const proj = slope * targetAño + intercept;
  // no puede ser menor que el 80% del último dato conocido
  const lastKnown = ys[ys.length-1];
  return Math.max(proj, lastKnown * 0.80);
}

/* Proyección poblacional total 2030 por departamento
   Suma las proyecciones individuales de cada localidad del CSV */
function proyPob2030PorDepto() {
  const result = {};
  Object.entries(POB_LOCALIDADES).forEach(([depto, localidades]) => {
    const total = localidades.reduce((sum, loc) => sum + proyLocalidad(loc.serie, 2030), 0);
    result[depto] = total;
  });
  return result;
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
  setTimeout(() => document.getElementById('loader').classList.add('hidden'), 500);
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
  mapMain = L.map('map', { center: [-32.5, -56.0], zoom: 7, zoomControl: true });
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
    if (coropetaVisible) buildCoropeta(getFiltroMundial(), getFiltroPosicion());
    else { if (coropetaLayer) mapMain.removeLayer(coropetaLayer); if (coropetaLabelLayer) mapMain.removeLayer(coropetaLabelLayer); }
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
  jugs.forEach(j => {
    const isIntl = j.pa !== 'Uruguay';
    const marker = L.marker([j.la, j.lo], { icon: buildBallIcon(j, isIntl) });
    marker.bindPopup(buildFichaPopup(j), { maxWidth: 280, minWidth: 260, className: 'ficha-popup' });
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

function buildBallIcon(j, isIntl) {
  const cls = isIntl ? 'dot-marker dot-marker-intl' : 'dot-marker';
  return L.divIcon({ className:'', html:`<div class="${cls}"></div>`, iconSize:[11,11], iconAnchor:[5,5], popupAnchor:[0,-8] });
}

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
  const coord = j.desplazado ? `<div class="popup-coord-note">📌 Coord. estimada, basada sólo en lugar de nacimiento</div>` : '';
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

/* ── FILTROS ─────────────────────────────────────────────── */
function poblarFiltroMundial() {
  ['filter-mundial', 'dash-filter-mundial'].forEach(id => {
    const sel = document.getElementById(id);
    if (!sel) return;
    MUNDIALES.forEach(año => {
      const opt = document.createElement('option');
      opt.value = año;
      opt.textContent = `${año} · ${SEDES[año]||''}`;
      sel.appendChild(opt);
    });
  });
}
function poblarFiltroPosicion() {
  const posiciones = [...new Set(JUGADORES.map(j => j.pos))].filter(Boolean).sort();
  ['filter-posicion', 'dash-filter-posicion'].forEach(id => {
    const sel = document.getElementById(id);
    if (!sel) return;
    posiciones.forEach(pos => {
      const opt = document.createElement('option');
      opt.value = pos; opt.textContent = pos;
      sel.appendChild(opt);
    });
  });
}

/* ── COROPLETA — usa propiedades Mund_XXXX del GeoJSON ──── */
function getCoropetaVal(props, mundial, posicion) {
  // Si hay filtro de posición, contamos desde JUGADORES (el GeoJSON no tiene esa granularidad)
  if (posicion && posicion !== 'todas') {
    const nombre = (props.nam || '').toLowerCase();
    return JUGADORES.filter(j =>
      j.pa === 'Uruguay' && j.de &&
      j.de.toLowerCase() === nombre &&
      j.pos === posicion &&
      (!mundial || j.m.includes(mundial))
    ).length;
  }
  // Sin filtro de posición: usa los datos precalculados del GeoJSON
  if (!mundial) {
    return MUNDIALES_GEOJSON.reduce((s,a) => {
      const v = props[`Mund_${a}`];
      return s + (typeof v === 'number' ? v : 0);
    }, 0);
  }
  const v = props[`Mund_${mundial}`];
  return typeof v === 'number' ? v : 0;
}

function buildCoropeta(mundial, posicion) {
  if (!window.DEPTOS_GEOJSON) return;
  if (coropetaLayer) { mapMain.removeLayer(coropetaLayer); coropetaLayer = null; }
  const pos = posicion || getFiltroPosicion();
  const vals = DEPTOS_GEOJSON.features
    .filter(f => f.properties.nam !== 'Extranjeros')
    .map(f => getCoropetaVal(f.properties, mundial, pos));
  const maxVal = Math.max(...vals, 1);

  coropetaLayer = L.geoJSON(DEPTOS_GEOJSON, {
    filter: f => f.properties.nam !== 'Extranjeros',
    style: feat => {
      const v = getCoropetaVal(feat.properties, mundial, pos);
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
      const v = getCoropetaVal(feat.properties, mundial, pos);
      const nm = feat.properties.nam || '';
      layer.bindTooltip(
        `<b>${nm}</b><br>${v} jugador${v!==1?'es':''}${mundial?' · '+mundial:' · total'}`,
        { sticky: true }
      );
    }
  });
  if (coropetaVisible) {
    coropetaLayer.addTo(mapMain);
    // Etiquetas de conteo sobre cada polígono
    if (coropetaLabelLayer) mapMain.removeLayer(coropetaLabelLayer);
    coropetaLabelLayer = L.layerGroup();
    DEPTOS_GEOJSON.features
      .filter(f => f.properties.nam !== 'Extranjeros')
      .forEach(feat => {
        const v = getCoropetaVal(feat.properties, mundial, pos);
        if (v === 0) return;
        const g = feat.geometry;
        const rings = g.type === 'Polygon' ? [g.coordinates[0]] : g.coordinates.map(p=>p[0]);
        const best = rings.reduce((a,b) =>
          (Math.max(...b.map(c=>c[0]))-Math.min(...b.map(c=>c[0]))) > (Math.max(...a.map(c=>c[0]))-Math.min(...a.map(c=>c[0]))) ? b : a
        );
        const cx = best.reduce((s,c)=>s+c[0],0)/best.length;
        const cy = best.reduce((s,c)=>s+c[1],0)/best.length;
        L.marker([cy, cx], {
          icon: L.divIcon({
            className: 'proy-label-icon',
            html: `<div class="coropeta-lbl">${v}</div>`,
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
  mapTimeline = L.map('map-timeline', { center: [-32.5, -56.0], zoom: 7 });
  L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
    attribution:'', subdomains:'abcd', maxZoom:18
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
  lista.innerHTML = '';
  [...jugs].sort((a,b)=>(a.fechaIso||0)-(b.fechaIso||0)).forEach(j => {
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
    dotsEl.appendChild(dot);
    tlDotEls.push(dot);
  });
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
  mk.bindPopup(buildFichaPopup(j), { maxWidth:280, minWidth:260, className:'ficha-popup' });
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
      ${j.fo ? `<img src="${j.fo}" onerror="this.style.display='none'" alt="">` : '<span>⚽</span>'}
    </div>
    <div class="mc-info">
      <div class="mc-nombre">${j.n}</div>
      <div class="mc-pos">${j.pos}</div>
      <div class="mc-fn">${j.fn}</div>
      <div class="mc-lugar">${j.lu}${j.de?', '+j.de:''}</div>
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
  document.getElementById('kpi-depto-top').textContent = topD ? `${topD[0]} (${topD[1]})` : '–';
  document.getElementById('kpi-extranacidos').textContent = ext;
  document.getElementById('kpi-extranacidos-pct').textContent = Math.round(ext/JUGADORES.length*100)+'%';
  document.getElementById('kpi-campeones').textContent = CAMPEONES.length;
  document.getElementById('kpi-mas-mundiales').textContent = `${maxM} · ${topNames}`;
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
  renderChartPorMundial(jugs);
  renderChartPosiciones(jugs);
  renderChartDeptos(jugs);
  renderChartClubes(jugs);
  renderChartPaisesClubes(jugs);
}

const AZULES = ['#0a3a5a','#155a8a','#1a78b8','#2299d8','#55B5E5','#7fcbee','#a5dbf4','#ccedf9'];
const AZ_EXT = [...AZULES,...AZULES];

function destroyChart(id) {
  if (chartInstances[id]) { chartInstances[id].destroy(); delete chartInstances[id]; }
}
function renderChartPorMundial(jugs) {
  destroyChart('pm');
  const labels = MUNDIALES.map(String);
  const data   = MUNDIALES.map(a => (jugs||JUGADORES).filter(j => j.m.includes(a)).length);
  const bgC    = MUNDIALES.map(a => CAMPEONES.includes(a) ? '#c8a84b' : '#55B5E5');
  chartInstances['pm'] = new Chart(document.getElementById('chart-por-mundial'), {
    type:'bar',
    data:{ labels, datasets:[{ data, backgroundColor:bgC, borderRadius:4 }] },
    options:{ responsive:true, maintainAspectRatio:false,
      plugins:{ legend:{display:false}, tooltip:{ callbacks:{ label: ctx => `${ctx.raw} jugadores${CAMPEONES.includes(MUNDIALES[ctx.dataIndex])?' 🏆':''}` }}},
      scales:{ x:{ticks:{font:{size:9},color:'#5a7d94'},grid:{display:false}}, y:{ticks:{font:{size:9},color:'#5a7d94'},grid:{color:'#e8f0f5'}} }
    }
  });
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
   PROYECCIÓN 2030
   ══════════════════════════════════════════════════════════

   MODELO BAYESIANO — justificación y pasos:

   Sea θ_d = "tasa de producción de mundialistas del depto d".
   Queremos P(θ_d | datos históricos) para proyectarla a 2030.

   Paso 1 — Prior (lo que sabemos antes de ver los últimos mundiales):
     El GeoJSON tiene el recuento exacto por departamento y por mundial
     para todos los torneos 1930-2022. Dividimos entre la población del
     departamento en el censo más cercano a cada mundial para obtener
     una tasa "jugadores por 100.000 hab." por depto y mundial.
     El prior es la media de esas tasas históricas (1930-2022).

   Paso 2 — Likelihood (señal reciente):
     Tomamos solo los últimos 5 mundiales (2002-2022), que son
     más informativos para 2030 porque reflejan el sistema de
     formación actual. Calculamos la misma tasa per-cápita reciente.

   Paso 3 — Posterior (combinación bayesiana):
     θ_posterior = α · θ_prior + (1-α) · θ_likelihood
     Con α = 0.40 (peso al prior histórico) y (1-α) = 0.60 (peso
     al likelihood reciente). Esto es un estimador de Bayes empírico
     (Empirical Bayes) donde los pesos reflejan la incertidumbre:
     cuanto más reciente, más relevante para 2030.

   Paso 4 — Denominador: población 2030 por departamento
     Se proyecta SUMANDO la extrapolación lineal de CADA localidad/ciudad
     del CSV evolucion_pob.csv (tendencia propia por ciudad), y luego
     se agrega por departamento. Esto es más preciso que extrapolar el
     total departamental porque captura que, por ejemplo, Maldonado
     (Punta del Este) crece mucho más rápido que Salto.

   Paso 5 — Score final y distribución de las 26 plazas:
     score_d = θ_posterior_d * pob2030_d   (jugadores esperados si la tasa se mantiene)
     Luego renormalizamos: jugadores_est_d = 26 * score_d / Σ score
*/

const AÑOS_CENSO_POB = [1963,1975,1985,1996,2004,2011,2023];

// Censos más cercanos a cada mundial (para normalizar las tasas históricas)
const CENSO_CERCANO = {
  1930:1908, 1950:1963, 1954:1963, 1966:1963,
  1970:1975, 1974:1975, 1986:1985, 1990:1985,
  2002:1996, 2010:2011, 2014:2011, 2018:2023, 2022:2023, 2026:2023
};

let proyRendered = false;
function renderProyeccion2030() {
  if (proyRendered) return;
  proyRendered = true;

  if (!window.DEPTOS_GEOJSON) {
    setTimeout(renderProyeccion2030, 400);
    proyRendered = false;
    return;
  }

  // ─── Paso 4: Población 2030 por depto (suma de tendencias por localidad) ───
  const pob2030 = proyPob2030PorDepto();

  // ─── Pasos 1-3: Tasas prior y likelihood ───────────────────────────────────
  const features = window.DEPTOS_GEOJSON.features.filter(f => f.properties.nam !== 'Extranjeros');

  // Obtener población por depto en el censo más cercano a un mundial dado
  function pobDeptoEnCenso(deptoNam, censAño) {
    const locs = POB_LOCALIDADES[deptoNam];
    if (!locs || !locs.length) return null;
    // Suma de los valores de ese censo en las localidades que lo tienen
    let total = 0, found = false;
    locs.forEach(loc => {
      const pt = loc.serie.find(p => p.año === censAño);
      if (pt) { total += pt.pob; found = true; }
    });
    return found ? total : null;
  }

  // Construir scores
  const scores = features.map(feat => {
    const nm = feat.properties.nam;
    const props = feat.properties;

    // Prior: tasa media histórica (todos los mundiales en GeoJSON)
    let sumPrior = 0, cntPrior = 0;
    MUNDIALES_GEOJSON.forEach(mundial => {
      const jugadores = typeof props[`Mund_${mundial}`] === 'number' ? props[`Mund_${mundial}`] : 0;
      const censAño = CENSO_CERCANO[mundial] || 1985;
      const pob = pobDeptoEnCenso(nm, censAño);
      if (pob && pob > 0) {
        sumPrior += (jugadores / (pob / 100000));
        cntPrior++;
      }
    });
    const tasaPrior = cntPrior ? sumPrior / cntPrior : 0;

    // Likelihood: tasa reciente (2002-2022)
    let sumLike = 0, cntLike = 0;
    MUNDIALES_RECIENTES.forEach(mundial => {
      const jugadores = typeof props[`Mund_${mundial}`] === 'number' ? props[`Mund_${mundial}`] : 0;
      const censAño = CENSO_CERCANO[mundial] || 2011;
      const pob = pobDeptoEnCenso(nm, censAño);
      if (pob && pob > 0) {
        sumLike += (jugadores / (pob / 100000));
        cntLike++;
      }
    });
    const tasaLike = cntLike ? sumLike / cntLike : 0;

    // Posterior bayesiano empírico
    const tasaPosterior = 0.40 * tasaPrior + 0.60 * tasaLike;

    // Recuentos brutos para la tabla
    const histTotal  = MUNDIALES_GEOJSON.reduce((s,a) => s + (typeof props[`Mund_${a}`]==='number'?props[`Mund_${a}`]:0), 0);
    const histReciente = MUNDIALES_RECIENTES.reduce((s,a) => s + (typeof props[`Mund_${a}`]==='number'?props[`Mund_${a}`]:0), 0);

    // Población 2030 proyectada
    const pobProy = pob2030[nm] || 50000;

    // Score: tasa posterior * población proyectada 2030 / 100.000
    const score = tasaPosterior * (pobProy / 100000);

    return { nm, histTotal, histReciente, pobProy, tasaPrior, tasaLike, tasaPosterior, score };
  }).filter(d => d.score > 0 || d.histTotal > 0);

  // Normalizar y distribuir 26 plazas
  const totalScore = scores.reduce((s,d) => s + d.score, 0);
  scores.forEach(d => {
    d.prob    = totalScore > 0 ? d.score / totalScore : 0;
    d.jugEst  = +(d.prob * 26).toFixed(2);
  });
  scores.sort((a,b) => b.jugEst - a.jugEst);

  // ─── Tabla ────────────────────────────────────────────────────────────────
  const tbody = document.getElementById('proy-tbody');
  tbody.innerHTML = '';
  const maxScore = Math.max(...scores.map(d=>d.score), 0.001);
  scores.forEach(d => {
    const barW = Math.round((d.score / maxScore) * 80);
    const jugDisp = d.jugEst < 0.05 ? '<0.1' : d.jugEst.toFixed(1);
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><b>${d.nm}</b></td>
      <td>${d.histTotal}</td>
      <td>${d.histReciente}</td>
      <td>${(d.pobProy/1000).toFixed(0)}k</td>
      <td>
        <div class="proy-score-bar" style="width:${barW}px"></div>
        <span class="proy-score-num">${d.score.toFixed(3)}</span>
      </td>
      <td class="proy-est-val">${jugDisp}</td>`;
    tbody.appendChild(tr);
  });

  // ─── Metodología con texto completo ──────────────────────────────────────
  // Construir el HTML de metodología con KaTeX
  const methodEl = document.getElementById('proy-method-text');
  methodEl.innerHTML = `
    <b>¿Por qué un modelo bayesiano?</b> En estadística bayesiana, el estimador
    de un parámetro desconocido (aquí: la tasa de producción de mundialistas
    de cada departamento) combina dos fuentes de información mediante la regla
    de Bayes: el <b>conocimiento previo</b> (información histórica acumulada 1930&ndash;2022)
    y la <b>verosimilitud observada</b> (señal empírica reciente, 2002&ndash;2022).
    Usar sólo el promedio histórico daría demasiado peso a décadas muy distintas
    al fútbol actual; usar sólo los datos recientes introduce alta varianza
    (pocos torneos). Bayes equilibra ambas fuentes de forma principiada.

    <div class="proy-formula-block">
      <span class="proy-formula-label">Estimador posterior (Bayes empírico)</span>
      <div class="proy-formula" id="f1"></div>
      <div class="proy-formula-vars" id="f1v"></div>
    </div>

    <b>Conocimiento previo — 40%.</b>
    Para cada departamento <i>d</i> y cada mundial <i>t</i> del GeoJSON:
    <div class="proy-formula-block">
      <div class="proy-formula" id="f2"></div>
      <div class="proy-formula-vars" id="f2v"></div>
    </div>

    <b>Verosimilitud observada — 60%.</b>
    Idéntico cálculo restringido a los mundiales 2002&ndash;2022,
    que reflejan el sistema formativo actual. El mayor peso (60 vs 40) expresa
    que la señal reciente es más informativa para 2030.

    <div class="proy-formula-block">
      <span class="proy-formula-label">Proyección de población 2030 por localidad</span>
      <div class="proy-formula" id="f3"></div>
      <div class="proy-formula-vars" id="f3v"></div>
    </div>

    En lugar de extrapolar el total departamental (que pierde la heterogeneidad interna),
    se ajusta una regresión lineal a la serie censal propia de cada localidad/ciudad
    de <code>evolucion_pob.csv</code> (hasta 6 censos: 1963&ndash;2023) y se suma.
    Así, Punta del Este y Maldonado capital tienen tendencias separadas dentro del
    mismo departamento.

    <div class="proy-formula-block">
      <span class="proy-formula-label">Puntuación final y distribución del plantel</span>
      <div class="proy-formula" id="f4"></div>
      <div class="proy-formula" id="f5"></div>
      <div class="proy-formula-vars" id="f5v"></div>
    </div>

    <b>Limitaciones.</b> El modelo no incorpora academias de formación, migración
    intra-país posterior a 2023 ni la concentración de captación en clubes de la
    capital. No considera ciudades/localidades en las que no haya nacido un jugador previamente.`;

  // Renderizar fórmulas con KaTeX una vez que el DOM esté listo
  function renderFormulas() {
    if (typeof katex === 'undefined') { setTimeout(renderFormulas, 200); return; }
    const R = (id, tex, disp) => {
      const el = document.getElementById(id);
      if (el) katex.render(tex, el, { displayMode: disp, throwOnError: false });
    };
    R('f1',
      '\\hat{\\theta}_d = \\alpha\\,\\bar{\\theta}_{d,\\mathrm{hist}} + (1-\\alpha)\\,\\bar{\\theta}_{d,\\mathrm{rec}}',
      true);
    const el1v = document.getElementById('f1v');
    if (el1v) el1v.innerHTML = 'donde <span id="ia1"></span> (peso al conocimiento previo histórico), ' +
      '<span id="ia2"></span> es la tasa media histórica 1930&ndash;2022 y ' +
      '<span id="ia3"></span> es la tasa media de los últimos 5 mundiales.';
    katex.render('\\alpha = 0{,}40', document.getElementById('ia1'), {throwOnError:false});
    katex.render('\\bar{\\theta}_{d,\\mathrm{hist}}', document.getElementById('ia2'), {throwOnError:false});
    katex.render('\\bar{\\theta}_{d,\\mathrm{rec}}', document.getElementById('ia3'), {throwOnError:false});

    R('f2',
      '\\theta_{d,t} = \\dfrac{J_{d,t}}{P_{d,c(t)} / 100{.}000} \\qquad\\Rightarrow\\qquad \\bar{\\theta}_{d,\\mathrm{hist}} = \\frac{1}{|T|}\\sum_{t\\in T}\\theta_{d,t}',
      true);
    const el2v = document.getElementById('f2v');
    if (el2v) el2v.innerHTML =
      '<span id="ib1"></span> = jugadores del depto. en el mundial <span id="ib2"></span> (dato del GeoJSON); ' +
      '<span id="ib3"></span> = población en el censo más cercano al año <span id="ib4"></span>.';
    katex.render('J_{d,t}', document.getElementById('ib1'), {throwOnError:false});
    katex.render('t', document.getElementById('ib2'), {throwOnError:false});
    katex.render('P_{d,c(t)}', document.getElementById('ib3'), {throwOnError:false});
    katex.render('t', document.getElementById('ib4'), {throwOnError:false});

    R('f3',
      '\\hat{P}_{l,2030} = \\hat{\\beta}_0^{(l)} + \\hat{\\beta}_1^{(l)} \\cdot 2030 \\qquad \\hat{P}_{d,2030} = \\sum_{l\\,\\in\\, d}\\,\\max\\!\\left(\\hat{P}_{l,2030},\\;0{,}8\\cdot P_{l,\\text{últ.}}\\right)',
      true);
    const el3v = document.getElementById('f3v');
    if (el3v) el3v.innerHTML =
      'donde <span id="ic1"></span> son los coeficientes de mínimos cuadrados sobre la serie censal de la localidad <span id="ic2"></span>.';
    katex.render('(\\hat{\\beta}_0, \\hat{\\beta}_1)', document.getElementById('ic1'), {throwOnError:false});
    katex.render('l', document.getElementById('ic2'), {throwOnError:false});

    R('f4',
      '\\text{score}_d = \\hat{\\theta}_d \\times \\dfrac{\\hat{P}_{d,2030}}{100{.}000}',
      true);
    R('f5',
      '\\text{jugadores}_{d}^{\\text{est.}} = 26 \\times \\dfrac{\\text{score}_d}{\\displaystyle\\sum_{d^{\\prime}} \\text{score}_{d^{\\prime}}}',
      true);
    const el5v = document.getElementById('f5v');
    if (el5v) el5v.innerHTML = 'El score refleja los jugadores esperados si la tasa posterior se mantuviese constante hasta 2030. La renormalización distribuye exactamente 26 plazas.';
  }
  renderFormulas();

  // ─── Mapa Leaflet con polígonos reales del GeoJSON ───────────────────────
  initProyMap(scores);
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

  const maxJug = Math.max(...scores.map(d => d.jugEst), 0.1);

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
      const t = s ? s.jugEst / maxJug : 0;
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
      const jugDisp = s ? (s.jugEst < 0.05 ? '<0.1' : s.jugEst.toFixed(1)) : '0';
      layer.bindTooltip(
        `<b>${nm}</b><br>Jugadores est.: <b>${jugDisp}</b><br>` +
        `Con. previo: ${s ? s.tasaPrior.toFixed(3) : '0'} jug./100k<br>` +
        `Verosimilitud: ${s ? s.tasaLike.toFixed(3) : '0'} jug./100k`,
        { sticky: true, className: 'proy-tooltip' }
      );
    }
  }).addTo(mapProy);

  // Grupo de etiquetas con toggle
  window._proyLabelLayer = L.layerGroup().addTo(mapProy);

  function buildLabels(visible) {
    window._proyLabelLayer.clearLayers();
    if (!visible) return;
    scores.forEach(d => {
      const ctr = CENTROIDS[d.nm];
      if (!ctr) return;
      const jugDisp = d.jugEst < 0.05 ? '' : d.jugEst.toFixed(1);
      if (!jugDisp) return;
      const t = d.jugEst / maxJug;
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
            iconSize: null,
            iconAnchor: null
          })
        }).addTo(window._proyLabelLayer);
      } else {
        L.marker([ctr[1], ctr[0]], {
          icon: L.divIcon({
            className: 'proy-label-icon',
            html: `<div class="proy-map-label" style="color:${txtColor};background:${bgColor}">
                     <span class="proy-lbl-val">${jugDisp}</span>
                   </div>`,
            iconSize: null,
            iconAnchor: null
          })
        }).addTo(window._proyLabelLayer);
      }
    });
  }

  buildLabels(true);

  // Botón toggle etiquetas
  const toggleBtn = document.getElementById('proy-toggle-labels');
  if (toggleBtn) {
    toggleBtn.checked = true;
    toggleBtn.onchange = () => buildLabels(toggleBtn.checked);
  }

  setTimeout(() => mapProy.invalidateSize(), 200);
}
