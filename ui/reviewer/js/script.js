// ============================================================
//  Tax Assessor Review Interface — script.js
//  City of Philadelphia — Office of Property Assessment
//
//  Depends on: Leaflet, ../js/opa-api.js (OPA object)
// ============================================================

'use strict';

// ── State ────────────────────────────────────────────────────

let map;
let markers               = [];
let props                 = [];
let selectedIdx           = null;
let boundaryLayer         = null;
let currentBoundaryType   = 'none';
let selectedBoundaryLayer = null;   // currently highlighted polygon
const boundaryCache       = {};
let boundaryLoadId        = 0;      // incremented on each setBoundary call to cancel stale fetches

// Basemap layers (populated in initMap)
const baseLayers = {};
let currentBasemap = null;

// Property tile layer
const PROPERTY_TILE_URL  = 'https://storage.googleapis.com/musa5090s26-team4-public/tiles/properties/{z}/{x}/{y}.pbf';
const PROPERTY_LAYER_NAME = 'property_tile_info';

let propertyTileLayer      = null;
let propertyLayerVisible   = true;
let selectedTileFeatureId  = null;
let hoverPopup             = null;

// YlOrRd color ramp breakpoints for current_assessed_value
const VALUE_BREAKS = [
  { limit:   50_000, color: '#ffffb2' },
  { limit:  100_000, color: '#fecc5c' },
  { limit:  200_000, color: '#fd8d3c' },
  { limit:  350_000, color: '#f03b20' },
  { limit:  600_000, color: '#bd0026' },
  { limit: Infinity, color: '#67001f' },
];

function getValueColor(value) {
  const v = parseInt(value, 10);
  if (!v || v <= 0) return '#aaaaaa';
  for (const { limit, color } of VALUE_BREAKS) {
    if (v < limit) return color;
  }
  return '#67001f';
}

function tileFeatureStyle(properties) {
  return {
    fill:        true,
    fillColor:   getValueColor(properties.predicted_value),
    fillOpacity: 0.75,
    weight:      0.4,
    color:       '#666',
    opacity:     0.6,
  };
}

// ── Boundary Configuration ────────────────────────────────────

const BOUNDARY_APIS = {
  // Local GeoJSON file (served relative to index.html)
  neighborhood: '../assets/philadelphia-neighborhoods.geojson',
  census:       'https://services.arcgis.com/fLeGjb7u4uXqeF9q/arcgis/rest/services/Census_Tracts_2010/FeatureServer/0/query?outFields=*&where=1%3D1&f=geojson',
  zipcode:      'https://services.arcgis.com/fLeGjb7u4uXqeF9q/arcgis/rest/services/Zipcodes_Poly/FeatureServer/0/query?outFields=*&where=1%3D1&f=geojson',
};

// Primary field for each boundary type's display name (checked first)
const BOUNDARY_NAME_FIELDS = {
  neighborhood: ['MAPNAME', 'NAME', 'name'],
  census:       ['NAMELSAD10', 'NAME10', 'TRACTCE10', 'GEOID10'],
  zipcode:      ['code', 'CODE', 'ZIP_CODE', 'ZIPCODE'],   // service uses lowercase 'code'
};

const BOUNDARY_LABELS = {
  none:         { filter: 'Neighborhood',    allOption: 'All Neighborhoods' },
  neighborhood: { filter: 'Neighborhood',    allOption: 'All Neighborhoods' },
  census:       { filter: 'Census Tract',    allOption: 'All Census Tracts' },
  zipcode:      { filter: 'ZIP Code',        allOption: 'All ZIP Codes' },
};

// ── Utilities ────────────────────────────────────────────────

function fmtMoney(val) {
  const n = parseInt(val, 10);
  if (!n && n !== 0) return '—';
  return (n < 0 ? '-$' : '$') + Math.abs(n).toLocaleString('en-US');
}

function titleCase(str) {
  return (str || '').toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

// ── Autocomplete ─────────────────────────────────────────────

function setupAutocomplete(inputId, onSelect) {
  const input    = document.getElementById(inputId);
  const wrap     = input.closest('.search-input-wrap');
  const dropdown = document.createElement('ul');
  dropdown.className = 'autocomplete-list';
  wrap.appendChild(dropdown);

  let currentResults = [];

  const suggest = debounce(async (query) => {
    if (query.length < 3) { closeDropdown(); return; }

    dropdown.innerHTML = '<li class="autocomplete-status">Searching…</li>';
    dropdown.classList.add('open');

    try {
      const results = await OPA.searchByAddress(query, 8);
      currentResults = results;

      if (!results.length) {
        dropdown.innerHTML = '<li class="autocomplete-status">No addresses found.</li>';
        return;
      }

      dropdown.innerHTML = results.map((prop, i) => `
        <li class="autocomplete-item" data-idx="${i}" tabindex="0">
          <span class="autocomplete-item-addr">${escHtml(titleCase(prop.location))}</span>
          <span class="autocomplete-item-zip">${escHtml(prop.zip_code || '')}</span>
        </li>`).join('');

      dropdown.querySelectorAll('.autocomplete-item').forEach(li => {
        li.addEventListener('mousedown', e => {
          e.preventDefault();
          const prop = currentResults[parseInt(li.dataset.idx, 10)];
          input.value = titleCase(prop.location);
          closeDropdown();
          onSelect(prop);
        });
      });

    } catch {
      dropdown.innerHTML = '<li class="autocomplete-status">Error loading suggestions.</li>';
    }
  }, 320);

  input.addEventListener('input',   () => suggest(input.value.trim()));
  input.addEventListener('blur',    () => setTimeout(closeDropdown, 150));
  input.addEventListener('keydown', e => { if (e.key === 'Escape') closeDropdown(); });

  function closeDropdown() {
    dropdown.classList.remove('open');
    dropdown.innerHTML = '';
    currentResults = [];
  }
}

// ── Property Tile Layer ───────────────────────────────────────

let legendControl = null;

const LEGEND_HTML = `
  <div class="map-legend-title">Current Assessed Value</div>
  <div class="map-legend-item"><span class="map-legend-swatch" style="background:#aaaaaa"></span>No data</div>
  <div class="map-legend-item"><span class="map-legend-swatch" style="background:#ffffb2"></span>&lt; $50K</div>
  <div class="map-legend-item"><span class="map-legend-swatch" style="background:#fecc5c"></span>$50K – $100K</div>
  <div class="map-legend-item"><span class="map-legend-swatch" style="background:#fd8d3c"></span>$100K – $200K</div>
  <div class="map-legend-item"><span class="map-legend-swatch" style="background:#f03b20"></span>$200K – $350K</div>
  <div class="map-legend-item"><span class="map-legend-swatch" style="background:#bd0026"></span>$350K – $600K</div>
  <div class="map-legend-item"><span class="map-legend-swatch" style="background:#67001f"></span>$600K+</div>
`;

function initPropertyTileLayer() {
  propertyTileLayer = L.vectorGrid.protobuf(PROPERTY_TILE_URL, {
    rendererFactory: L.canvas.tile,
    vectorTileLayerStyles: {
      [PROPERTY_LAYER_NAME]: tileFeatureStyle,
    },
    interactive:     true,
    maxNativeZoom:   16,
    getFeatureId:    f => f.properties.property_id,
  });

  hoverPopup = L.popup({ closeButton: false, autoPan: false, className: 'property-hover-popup' });

  propertyTileLayer.on('mouseover', e => {
    const p = e.layer.properties;
    if (!p) return;
    const predicted = p.predicted_value != null ? fmtMoney(p.predicted_value) : '—';
    const market    = p.market_value    != null ? fmtMoney(parseFloat(p.market_value)) : '—';
    hoverPopup
      .setLatLng(e.latlng)
      .setContent(
        `<div class="phover-id">ID: ${p.property_id}</div>` +
        `<div class="phover-row"><span>Predicted</span><span>${predicted}</span></div>` +
        `<div class="phover-row"><span>Market</span><span>${market}</span></div>`
      )
      .openOn(map);
  });

  propertyTileLayer.on('mouseout', () => {
    if (hoverPopup) map.closePopup(hoverPopup);
  });

  propertyTileLayer.on('click', e => {
    L.DomEvent.stopPropagation(e);
    const tileProps = e.layer.properties;
    if (!tileProps) return;

    if (selectedTileFeatureId !== null) {
      propertyTileLayer.resetFeatureStyle(selectedTileFeatureId);
    }
    selectedTileFeatureId = tileProps.property_id;
    propertyTileLayer.setFeatureStyle(selectedTileFeatureId, {
      fill:        true,
      fillColor:   getValueColor(tileProps.predicted_value),
      fillOpacity: 1.0,
      stroke:      true,
      weight:      2,
      color:       '#0f4d90',
      opacity:     1.0,
    });

    showTilePropertyCard(tileProps);
  });

  propertyTileLayer.addTo(map);

  // Build the legend as a proper Leaflet control so it renders inside
  // Leaflet's control container (immune to overflow:hidden on parent divs)
  legendControl = L.control({ position: 'bottomleft' });
  legendControl.onAdd = function() {
    const div = L.DomUtil.create('div', 'map-legend');
    div.innerHTML = LEGEND_HTML;
    L.DomEvent.disableClickPropagation(div);
    return div;
  };
  legendControl.addTo(map);
}

function showTilePropertyCard(tileProps) {
  const addr = tileProps.address ? titleCase(tileProps.address) : '—';

  document.getElementById('pcAddress').textContent       = addr;
  document.getElementById('pcPropertyId').textContent    = tileProps.property_id || '—';
  document.getElementById('pcAddressDetail').textContent = addr;
  document.getElementById('pcTaxYearValue').textContent  =
    tileProps.predicted_value != null ? fmtMoney(tileProps.predicted_value) : '—';
  document.getElementById('pcCurrentValue').textContent  =
    tileProps.market_value != null ? fmtMoney(tileProps.market_value) : '—';

  let diffDollars = '—', diffPct = '—', diffClass = '';
  const tyv = Number(tileProps.predicted_value);
  const cav = Number(tileProps.market_value);
  if (tyv && cav) {
    const delta = cav - tyv;
    const pct   = tyv !== 0 ? (delta / tyv) * 100 : null;
    diffDollars = (delta >= 0 ? '+' : '') + fmtMoney(delta);
    diffPct     = pct != null ? (pct >= 0 ? '+' : '') + pct.toFixed(1) + '%' : '—';
    diffClass   = delta > 0 ? 'pc-positive' : delta < 0 ? 'pc-negative' : '';
  }

  const diffDolEl = document.getElementById('pcDiffDollars');
  diffDolEl.textContent = diffDollars;
  diffDolEl.className   = 'pc-value pc-change-dollars ' + diffClass;

  const diffPctEl = document.getElementById('pcDiffPct');
  diffPctEl.textContent = diffPct;
  diffPctEl.className   = 'pc-value pc-change-pct ' + diffClass;

  document.getElementById('cityOverviewPanel').style.display = 'none';
  document.getElementById('propertyCardPanel').style.display = '';
}

function togglePropertyLayer(btn) {
  propertyLayerVisible = !propertyLayerVisible;
  if (propertyLayerVisible) {
    propertyTileLayer.addTo(map);
    legendControl.addTo(map);
    btn.classList.add('active');
  } else {
    map.removeLayer(propertyTileLayer);
    map.removeControl(legendControl);
    btn.classList.remove('active');
  }
  if (boundaryLayer) boundaryLayer.bringToFront();
  markers.forEach(m => m.bringToFront && m.bringToFront());
}

// Polyfill: Leaflet 1.7+ removed L.DomEvent.fakeStop, but Leaflet.VectorGrid
// 1.3.0 still calls it on feature click — without this, clicks throw silently.
if (L.DomEvent && !L.DomEvent.fakeStop) {
  L.DomEvent.fakeStop = function (e) {
    L.DomEvent.preventDefault(e);
    L.DomEvent.stopPropagation(e);
  };
}

// ── Map ──────────────────────────────────────────────────────

function initMap() {
  map = L.map('map', { center: [39.9526, -75.1652], zoom: 12, minZoom: 12, maxZoom: 18 });

  baseLayers.light = L.tileLayer(
    'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
    { attribution: '&copy; OpenStreetMap contributors &copy; CARTO | City of Philadelphia OPA', subdomains: 'abcd', maxZoom: 20 }
  );
  baseLayers.dark = L.tileLayer(
    'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
    { attribution: '&copy; OpenStreetMap contributors &copy; CARTO | City of Philadelphia OPA', subdomains: 'abcd', maxZoom: 20 }
  );
  baseLayers.osm = L.tileLayer(
    'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    { attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors | City of Philadelphia OPA', maxZoom: 19 }
  );
  baseLayers.satellite = L.tileLayer(
    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    { attribution: 'Tiles &copy; Esri &mdash; Source: Esri, USGS, NOAA | City of Philadelphia OPA', maxZoom: 19 }
  );
  baseLayers.topo = L.tileLayer(
    'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
    { attribution: '&copy; OpenStreetMap contributors, SRTM | &copy; OpenTopoMap | City of Philadelphia OPA', maxZoom: 17 }
  );

  currentBasemap = baseLayers.light;
  currentBasemap.addTo(map);

  initPropertyTileLayer();
}

function setBasemap(value) {
  const next = baseLayers[value] || baseLayers.light;
  if (next === currentBasemap) return;
  if (currentBasemap) map.removeLayer(currentBasemap);
  currentBasemap = next;
  currentBasemap.addTo(map);
  // Keep boundary and markers on top
  if (boundaryLayer) boundaryLayer.bringToFront();
  markers.forEach(m => m.bringToFront && m.bringToFront());
}

function clearMarkers() {
  markers.forEach(m => m.remove());
  markers = [];
}

function addMarkers(propList) {
  propList.forEach((prop, idx) => {
    if (!prop.lat || !prop.lng) return;
    const m = L.circleMarker([prop.lat, prop.lng], {
      radius: 7, color: '#fff', weight: 2,
      fillColor: '#0f4d90', fillOpacity: 0.85,
    })
      .bindPopup(buildPopup(prop), { maxWidth: 220 })
      .addTo(map);
    m.on('click', () => selectProperty(idx, true));
    markers.push(m);
  });
}

function buildPopup(prop) {
  return `<div>
    <div class="map-popup-address">${escHtml(titleCase(prop.location))}</div>
    <div class="map-popup-pid">OPA #: ${escHtml(prop.parcel_number || 'N/A')}</div>
    <div class="map-popup-value">Value: ${fmtMoney(prop.market_value)}</div>
  </div>`;
}

function fitAllMarkers() {
  if (!markers.length) return;
  map.fitBounds(L.featureGroup(markers).getBounds().pad(0.15));
}

function locateUser() {
  map.locate({ setView: true, maxZoom: 16 });
}

// ── Boundary Layers ───────────────────────────────────────────

function getBoundaryDisplayName(properties, type) {
  const fields = BOUNDARY_NAME_FIELDS[type] || [];
  for (const f of fields) {
    if (properties[f] != null && String(properties[f]).trim() !== '') {
      return String(properties[f]).trim();
    }
  }
  // Fallback: first non-null primitive value
  for (const [, v] of Object.entries(properties)) {
    if (v != null && typeof v !== 'object' && String(v).trim() !== '') {
      return String(v).trim();
    }
  }
  return 'Unknown';
}

// ── Boundary highlight ────────────────────────────────────────

const STYLE_DEFAULT  = { color: '#0f4d90', weight: 1.5, fillOpacity: 0.04, fillColor: '#0f4d90', opacity: 0.65 };
const STYLE_SELECTED = { color: '#0f4d90', weight: 2.5, fillOpacity: 0.18, fillColor: '#0f4d90', opacity: 0.9 };

function selectBoundaryPolygon(layer, name) {
  // Reset previous highlight
  if (selectedBoundaryLayer) selectedBoundaryLayer.setStyle(STYLE_DEFAULT);
  layer.setStyle(STYLE_SELECTED);
  layer.bringToFront();
  selectedBoundaryLayer = layer;

  // Auto-fill the sidebar filter
  const select = document.getElementById('filterBoundary');
  for (const opt of select.options) {
    if (opt.value === name) { select.value = name; break; }
  }
}

async function setBoundary(type, btn) {
  // Increment the load ID — any in-flight fetch for a previous call will see
  // its ID is stale and bail out, preventing layer overlap.
  const myLoadId = ++boundaryLoadId;

  currentBoundaryType   = type;
  selectedBoundaryLayer = null;
  document.querySelectorAll('.boundary-btn').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');

  // Remove existing boundary layer immediately (synchronous — no race here)
  if (boundaryLayer) { map.removeLayer(boundaryLayer); boundaryLayer = null; }

  const conf = BOUNDARY_LABELS[type] || BOUNDARY_LABELS.none;
  document.getElementById('boundaryFilterLabel').textContent = conf.filter;

  if (type === 'none') {
    document.getElementById('filterBoundary').innerHTML =
      `<option value="">${conf.allOption}</option>`;
    return;
  }

  // Show loading indicator in the dropdown while fetching
  document.getElementById('filterBoundary').innerHTML = '<option>Loading…</option>';

  try {
    if (!boundaryCache[type]) {
      const res = await fetch(BOUNDARY_APIS[type]);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      boundaryCache[type] = await res.json();
    }

    // Another setBoundary call was made while we were awaiting — discard this result
    if (myLoadId !== boundaryLoadId) return;

    const geojson = boundaryCache[type];

    // Render boundary polygons on the map
    boundaryLayer = L.geoJSON(geojson, {
      style: STYLE_DEFAULT,
      onEachFeature: (feature, layer) => {
        const name = getBoundaryDisplayName(feature.properties, type);
        layer.bindTooltip(escHtml(name), {
          sticky:    true,
          className: 'boundary-tooltip',
          direction: 'top',
        });
        // Click polygon → highlight + auto-fill sidebar filter
        layer.on('click', () => selectBoundaryPolygon(layer, name));
      },
    }).addTo(map);

    // Build sorted, deduplicated list of area names for the filter dropdown
    const names = [
      ...new Set(
        geojson.features
          .map(f => getBoundaryDisplayName(f.properties, type))
          .filter(n => n && n !== 'Unknown')
      ),
    ].sort((a, b) => {
      const na = parseFloat(a), nb = parseFloat(b);
      if (!isNaN(na) && !isNaN(nb)) return na - nb;
      return a.localeCompare(b);
    });

    document.getElementById('filterBoundary').innerHTML =
      `<option value="">${conf.allOption}</option>` +
      names.map(n => `<option value="${escHtml(n)}">${escHtml(n)}</option>`).join('');

  } catch (err) {
    if (myLoadId !== boundaryLoadId) return;
    console.error('[reviewer] setBoundary failed:', err);
    document.getElementById('filterBoundary').innerHTML =
      `<option value="">${conf.allOption}</option>`;
  }
}

// ── Load properties ──────────────────────────────────────────

async function loadProperties(filters) {
  setLoadingState(true);
  try {
    // Fly to geocoded location immediately if coordinates were provided
    if (filters._lat && filters._lng) {
      map.flyTo([filters._lat, filters._lng], 16, { duration: 0.8 });
    }

    const results = await OPA.filterProperties(filters, 100);
    props = results;
    clearMarkers();
    addMarkers(props);
    updateStats(props);
    if (props.length) fitAllMarkers();
    document.getElementById('mapCenter').textContent =
      props.length ? `${props.length} result${props.length !== 1 ? 's' : ''}` : 'No results';
  } catch (err) {
    console.error('[reviewer] loadProperties:', err);
  }
  setLoadingState(false);
}

// ── Search & Filters ─────────────────────────────────────────

function searchAddress() {
  const address = document.getElementById('addressSearch').value.trim();
  if (!address) return;
  loadProperties({ address });
}


// ── Property list ─────────────────────────────────────────────

function renderList(propList) {
  const ul = document.getElementById('propList');
  if (!propList.length) {
    ul.innerHTML = `
      <li style="padding:1.5rem;text-align:center;color:var(--phila-text-muted);font-size:13px;">
        No properties to display.<br>Use the search or filters to load results.
      </li>`;
    return;
  }
  ul.innerHTML = propList.map((p, i) => {
    const typeShort = (p.building_code_description || 'Unknown').split(/[(/]/)[0].trim();
    return `
      <li class="prop-item" onclick="selectProperty(${i})">
        <div class="prop-addr">${escHtml(titleCase(p.location))}</div>
        <div class="prop-meta">
          <span>OPA ${escHtml(p.parcel_number || 'N/A')}</span>
          <span>${fmtMoney(p.market_value)}</span>
        </div>
        <div class="prop-tags">
          <span class="badge badge-blue">${escHtml(typeShort)}</span>
          ${p.zip_code ? `<span class="badge badge-gray">${escHtml(p.zip_code)}</span>` : ''}
        </div>
      </li>`;
  }).join('');
}

function renderListError(msg) {
  document.getElementById('propList').innerHTML =
    `<li style="padding:1rem;color:var(--phila-red);font-size:13px;">${escHtml(msg)}</li>`;
}

// ── Property selection ───────────────────────────────────────

function selectProperty(idx, fromMap = false) {
  selectedIdx = idx;
  const prop = props[idx];
  if (!prop) return;

  if (!fromMap && markers[idx]) {
    map.flyTo(markers[idx].getLatLng(), 17, { duration: 0.8 });
    markers[idx].openPopup();
  }

  renderPropertyCard(prop);
}

// ── Property card (right panel, replaces City Overview on selection) ──

function renderPropertyCard(prop) {
  // -- Values to display (all sourced from real data; shown as — until backend provides them)
  const addr          = prop.location        ? titleCase(prop.location)          : '—';
  const propertyId    = prop.parcel_number   || '—';
  const taxYearVal    = prop.tax_year_assessed_value  != null
                          ? fmtMoney(prop.tax_year_assessed_value)  : '—';
  const currentVal    = prop.current_assessed_value   != null
                          ? fmtMoney(prop.current_assessed_value)   : '—';

  // Difference and percent change (computed when both values available)
  let diffDollars = '—';
  let diffPct     = '—';
  let diffClass   = '';
  if (prop.tax_year_assessed_value != null && prop.current_assessed_value != null) {
    const delta = prop.current_assessed_value - prop.tax_year_assessed_value;
    const pct   = prop.tax_year_assessed_value !== 0
                    ? (delta / prop.tax_year_assessed_value) * 100 : null;
    diffDollars = (delta >= 0 ? '+' : '') + fmtMoney(delta);
    diffPct     = pct != null ? (pct >= 0 ? '+' : '') + pct.toFixed(1) + '%' : '—';
    diffClass   = delta > 0 ? 'pc-positive' : delta < 0 ? 'pc-negative' : '';
  }

  // Update DOM
  document.getElementById('pcAddress').textContent       = addr;
  document.getElementById('pcPropertyId').textContent    = propertyId;
  document.getElementById('pcAddressDetail').textContent = addr;
  document.getElementById('pcTaxYearValue').textContent  = taxYearVal;
  document.getElementById('pcCurrentValue').textContent  = currentVal;

  const diffDolEl = document.getElementById('pcDiffDollars');
  diffDolEl.textContent = diffDollars;
  diffDolEl.className   = 'pc-value pc-change-dollars ' + diffClass;

  const diffPctEl = document.getElementById('pcDiffPct');
  diffPctEl.textContent = diffPct;
  diffPctEl.className   = 'pc-value pc-change-pct ' + diffClass;

  // Toggle panels
  document.getElementById('cityOverviewPanel').style.display   = 'none';
  document.getElementById('propertyCardPanel').style.display   = '';
}

function deselectProperty() {
  if (selectedTileFeatureId !== null && propertyTileLayer) {
    propertyTileLayer.resetFeatureStyle(selectedTileFeatureId);
    selectedTileFeatureId = null;
  }
  selectedIdx = null;
  document.getElementById('propertyCardPanel').style.display = 'none';
  document.getElementById('cityOverviewPanel').style.display = '';
}

// ── Stats bar ─────────────────────────────────────────────────

function updateStats(propList) {
  const count = propList.length;
  const avg   = count
    ? Math.round(propList.reduce((s, p) => s + (parseInt(p.market_value, 10) || 0), 0) / count)
    : 0;
  document.getElementById('mapCount').textContent  = count;
  document.getElementById('statCount').textContent = count;
  document.getElementById('statAvg').textContent   = count ? fmtMoney(avg) : '—';
}

// ── Loading state ─────────────────────────────────────────────

function setLoadingState(on) {
  const btn = document.querySelector('.sidebar-body button.btn-primary');
  if (btn) { btn.textContent = on ? 'Loading…' : 'Apply Filters'; btn.disabled = on; }
}

// ── Assessment Distribution Chart ────────────────────────────

const DIST_DATA_URL = 'https://storage.googleapis.com/musa5090s26-team4-public/configs/tax_year_assessment_bins.json';
const DISPLAY_CAP   = 1_500_000;
const TAIL_LABEL    = '≥$1.5M';

let distChartInstance = null;
let distAllData       = null;   // cached raw data
let distActiveYear    = null;   // currently displayed year
let predAllData       = null;   // cached prediction-delta raw data

// Build {labels, counts} for a given year from raw data
function buildChartData(rawData, year) {
  const rows = rawData
    .filter(r => r.tax_year === year)
    .sort((a, b) => a.lower_bound - b.lower_bound);

  const labels = [];
  const counts = [];
  let tailCount = 0;

  for (const row of rows) {
    if (row.lower_bound >= DISPLAY_CAP) {
      tailCount += row.property_count;
    } else {
      const lo = row.lower_bound;
      const hi = row.upper_bound;
      labels.push(lo === 0 ? `<$${(hi / 1000).toFixed(0)}K` : `$${(lo / 1000).toFixed(0)}K`);
      counts.push(row.property_count);
    }
  }
  if (tailCount > 0) { labels.push(TAIL_LABEL); counts.push(tailCount); }
  return { labels, counts };
}

// Compute and display the 4 City Overview KPIs from cached bin data
function updateOverviewKPIs(year) {
  // --- Total properties + avg assessed value from distribution bins ---
  const rows = (distAllData || []).filter(r => r.tax_year === year);
  let totalProps  = 0;
  let sumAssessed = 0;
  for (const row of rows) {
    const mid = (row.lower_bound + row.upper_bound) / 2;
    totalProps  += row.property_count;
    sumAssessed += mid * row.property_count;
  }
  const avgAssessed = totalProps > 0 ? Math.round(sumAssessed / totalProps) : null;

  // --- Avg (current − predicted) from prediction delta bins ---
  let avgChange = null;
  if (predAllData && predAllData.length) {
    let sumChange      = 0;
    let totalPredProps = 0;
    for (const row of predAllData) {
      const mid = (row.lower_bound + row.upper_bound) / 2;
      totalPredProps += row.property_count;
      sumChange      += mid * row.property_count;
    }
    if (totalPredProps > 0) avgChange = Math.round(sumChange / totalPredProps);
  }

  // --- Avg predicted = avg assessed − avg change ---
  const avgPredicted = (avgAssessed !== null && avgChange !== null)
    ? avgAssessed - avgChange : null;

  // --- Update DOM ---
  document.getElementById('ovTotalProps').textContent =
    totalProps > 0 ? totalProps.toLocaleString('en-US') : '—';
  document.getElementById('ovAvgAssessed').textContent =
    avgAssessed !== null ? fmtMoney(avgAssessed) : '—';
  document.getElementById('ovAvgPredicted').textContent =
    avgPredicted !== null ? fmtMoney(avgPredicted) : '—';

  const changeEl = document.getElementById('ovAvgChange');
  if (avgChange !== null) {
    changeEl.textContent  = (avgChange >= 0 ? '+' : '') + fmtMoney(avgChange);
    changeEl.style.color  = avgChange > 0
      ? 'var(--phila-red)' : avgChange < 0 ? 'var(--phila-green)' : '';
  } else {
    changeEl.textContent = '—';
    changeEl.style.color = '';
  }
}

// Switch the chart to a different year (data already loaded)
function switchDistYear(year) {
  distActiveYear = year;

  // Update button active state
  document.querySelectorAll('.year-btn').forEach(b => {
    b.classList.toggle('active', Number(b.dataset.year) === year);
  });

  const { labels, counts } = buildChartData(distAllData, year);

  if (distChartInstance) {
    distChartInstance.updateOptions({
      series:  [{ name: 'Properties', data: counts }],
      xaxis:   { categories: labels },
    }, false, true);
  }

  updateOverviewKPIs(year);
}

// Initial load: fetch data, build year buttons, render default year
async function loadTaxYearDistribution() {
  const msgEl = document.getElementById('ovDistMsg');
  try {
    const res = await fetch(DIST_DATA_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    distAllData = await res.json();

    // Collect years sorted ascending; exclude years with incomplete data
    const EXCLUDED_YEARS = new Set([2021, 2023]);
    const countByYear = {};
    for (const row of distAllData) {
      if (EXCLUDED_YEARS.has(row.tax_year)) continue;
      countByYear[row.tax_year] = (countByYear[row.tax_year] || 0) + row.property_count;
    }
    const sortedYears = Object.keys(countByYear).map(Number).sort((a, b) => a - b);
    const defaultYear = sortedYears.reduce((best, y) =>
      countByYear[y] > countByYear[best] ? y : best, sortedYears[0]);

    // Build year selector buttons
    const selectorEl = document.getElementById('yearSelector');
    if (selectorEl) {
      selectorEl.innerHTML = sortedYears.map(y => `
        <button type="button"
          class="year-btn${y === defaultYear ? ' active' : ''}"
          data-year="${y}"
          onclick="switchDistYear(${y})"
          title="${countByYear[y].toLocaleString()} properties"
        >${y}</button>`).join('');
    }

    // Remove loading placeholder and create chart
    if (msgEl) msgEl.remove();
    if (distChartInstance) { distChartInstance.destroy(); distChartInstance = null; }

    distActiveYear = defaultYear;
    updateOverviewKPIs(defaultYear);
    const { labels, counts } = buildChartData(distAllData, defaultYear);

    const el = document.getElementById('ovDistChart');
    distChartInstance = new ApexCharts(el, {
      chart: {
        type:       'bar',
        height:     200,
        toolbar:    { show: false },
        animations: { enabled: false },
        fontFamily: 'Open Sans, sans-serif',
      },
      series: [{ name: 'Properties', data: counts }],
      xaxis: {
        categories: labels,
        tickAmount: 10,
        labels: {
          rotate: -45,
          style:  { fontSize: '9px', colors: '#555' },
        },
        axisBorder: { show: false },
        axisTicks:  { show: false },
      },
      yaxis: {
        labels: {
          style:     { fontSize: '9px', colors: '#555' },
          formatter: v => v >= 1000 ? `${(v / 1000).toFixed(0)}K` : v,
        },
      },
      plotOptions: {
        bar: { borderRadius: 1, columnWidth: '95%' },
      },
      dataLabels: { enabled: false },
      colors:     ['#0f4d90'],
      grid: {
        borderColor:     '#e8e8e8',
        strokeDashArray: 3,
        xaxis:           { lines: { show: false } },
      },
      tooltip: {
        followCursor: true,
        y: { formatter: v => v.toLocaleString('en-US') + ' properties' },
      },
    });
    distChartInstance.render();

  } catch (err) {
    console.error('[reviewer] loadTaxYearDistribution:', err);
    if (msgEl) msgEl.textContent = 'Failed to load distribution data.';
  }
}

// ── Current − Predicted Distribution Chart ───────────────────

const PRED_DATA_URL  = 'https://storage.googleapis.com/musa5090s26-team4-public/prediction_bins/current_assessment_bins.json';
const PRED_CAP_POS   =  1_500_000;   // cap positive tail at $1.5M
const PRED_CAP_NEG   = -1_000_000;   // cap negative tail at -$1M
const PRED_TAIL_POS  = '≥$1.5M';
const PRED_TAIL_NEG  = '≤-$1M';

let predChartInstance = null;

async function loadPredDistribution() {
  const msgEl = document.getElementById('ovPredMsg');
  try {
    const res = await fetch(PRED_DATA_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const raw = await res.json();

    predAllData = raw;
    updateOverviewKPIs(distActiveYear);

    // Sort bins lowest to highest
    const sorted = raw.slice().sort((a, b) => a.lower_bound - b.lower_bound);

    const labels = [];
    const colors = [];   // per-bar color
    const counts = [];
    let tailNegCount = 0;
    let tailPosCount = 0;

    for (const row of sorted) {
      const lo = row.lower_bound;

      // Merge extreme tails
      if (lo < PRED_CAP_NEG)  { tailNegCount += row.property_count; continue; }
      if (lo >= PRED_CAP_POS) { tailPosCount += row.property_count; continue; }

      // Label: "$-50K" style for negatives, "$50K" for positives, "$0" for zero
      let label;
      if (lo < 0)       label = `-$${Math.abs(lo / 1000).toFixed(0)}K`;
      else if (lo === 0) label = '$0';
      else               label = `$${(lo / 1000).toFixed(0)}K`;

      labels.push(label);
      counts.push(row.property_count);
      // Negative difference → current < predicted → property is under-predicted → orange/red
      // Positive difference → current > predicted → property is over-predicted → blue
      colors.push(lo < 0 ? '#f03b20' : '#0f4d90');
    }

    // Prepend negative tail bucket, append positive tail bucket
    if (tailNegCount > 0) { labels.unshift(PRED_TAIL_NEG); counts.unshift(tailNegCount); colors.unshift('#f03b20'); }
    if (tailPosCount > 0) { labels.push(PRED_TAIL_POS);    counts.push(tailPosCount);    colors.push('#0f4d90'); }

    if (msgEl) msgEl.remove();
    if (predChartInstance) { predChartInstance.destroy(); predChartInstance = null; }

    const el = document.getElementById('ovPredChart');
    predChartInstance = new ApexCharts(el, {
      chart: {
        type:       'bar',
        height:     200,
        toolbar:    { show: false },
        animations: { enabled: false },
        fontFamily: 'Open Sans, sans-serif',
      },
      series: [{ name: 'Properties', data: counts }],
      xaxis: {
        categories: labels,
        tickAmount: 10,
        labels: {
          rotate: -45,
          style:  { fontSize: '9px', colors: '#555' },
        },
        axisBorder: { show: false },
        axisTicks:  { show: false },
      },
      yaxis: {
        labels: {
          style:     { fontSize: '9px', colors: '#555' },
          formatter: v => v >= 1000 ? `${(v / 1000).toFixed(0)}K` : v,
        },
      },
      plotOptions: {
        bar: {
          borderRadius:  1,
          columnWidth:   '95%',
          distributed:   true,   // enables per-bar color via colors array
        },
      },
      colors:     colors,
      legend:     { show: false },
      dataLabels: { enabled: false },
      grid: {
        borderColor:     '#e8e8e8',
        strokeDashArray: 3,
        xaxis:           { lines: { show: false } },
      },
      tooltip: {
        followCursor: true,
        y: { formatter: v => v.toLocaleString('en-US') + ' properties' },
      },
    });
    predChartInstance.render();

  } catch (err) {
    console.error('[reviewer] loadPredDistribution:', err);
    if (msgEl) msgEl.textContent = 'Failed to load data.';
  }
}

// ── Zoom to selected boundary from dropdown ───────────────────

function zoomToSelectedBoundary(name) {
  if (!boundaryLayer || !name) return;
  let match = null;
  boundaryLayer.eachLayer(layer => {
    if (match) return;
    const layerName = getBoundaryDisplayName(layer.feature.properties, currentBoundaryType);
    if (layerName === name) match = layer;
  });
  if (!match) return;
  map.fitBounds(match.getBounds(), { padding: [30, 30] });
  selectBoundaryPolygon(match, name);
}

// ── Init ─────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  initMap();
  loadTaxYearDistribution();
  loadPredDistribution();

  // Autocomplete: geocode the address and fly map to result, then attempt property search
  setupAutocomplete('addressSearch', prop => {
    if (prop.lat && prop.lng) {
      map.flyTo([prop.lat, prop.lng], 16, { duration: 0.8 });
    }
    loadProperties({ address: prop.location, _lat: prop.lat, _lng: prop.lng });
  });

  document.getElementById('addressSearch').addEventListener('keydown', e => {
    if (e.key === 'Enter') searchAddress();
  });

  document.getElementById('filterBoundary').addEventListener('change', e => {
    zoomToSelectedBoundary(e.target.value);
  });
});
