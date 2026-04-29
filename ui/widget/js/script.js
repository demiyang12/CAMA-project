// ============================================================
//  Property Owner Widget — script.js
//  City of Philadelphia — Office of Property Assessment
//
//  Depends on: Leaflet, ../js/opa-api.js (OPA object)
// ============================================================

'use strict';

let widgetMap;
let widgetMarker = null;

const ADDRESS_ZOOM = 17;

// ── Property tile layer ──────────────────────────────────────
const PROPERTY_TILE_URL   = 'https://storage.googleapis.com/musa5090s26-team4-public/tiles/properties/{z}/{x}/{y}.pbf';
const PROPERTY_LAYER_NAME = 'property_tile_info';

let propertyTileLayer = null;
let propertyHoverPopup = null;

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

// ── Utilities ────────────────────────────────────────────────

function el(id) { return document.getElementById(id); }

function fmtMoney(val) {
  const n = parseInt(val, 10);
  if (!n && n !== 0) return '—';
  const abs = Math.abs(n);
  return (n < 0 ? '-$' : '$') + abs.toLocaleString('en-US');
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

// ── Map ──────────────────────────────────────────────────────

function initMap() {
  widgetMap = L.map('widget-map', { center: [39.9526, -75.1652], zoom: 12, minZoom: 12, maxZoom: 18 });
  L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; OpenStreetMap contributors &copy; CARTO | City of Philadelphia OPA',
    subdomains: 'abcd',
    maxZoom: 20,
  }).addTo(widgetMap);

  initPropertyTileLayer();
}

function initPropertyTileLayer() {
  propertyTileLayer = L.vectorGrid.protobuf(PROPERTY_TILE_URL, {
    rendererFactory: L.canvas.tile,
    vectorTileLayerStyles: {
      [PROPERTY_LAYER_NAME]: tileFeatureStyle,
    },
    interactive:   true,
    maxNativeZoom: 16,
    getFeatureId:  f => f.properties.property_id,
  });

  propertyHoverPopup = L.popup({ closeButton: false, autoPan: false, className: 'property-hover-popup' });

  propertyTileLayer.on('mouseover', e => {
    const p = e.layer.properties;
    if (!p) return;
    const predicted = p.predicted_value != null ? fmtMoney(p.predicted_value) : '—';
    const market    = p.market_value    != null ? fmtMoney(parseFloat(p.market_value)) : '—';
    propertyHoverPopup
      .setLatLng(e.latlng)
      .setContent(
        `<div class="phover-id">ID: ${p.property_id}</div>` +
        `<div class="phover-row"><span>Predicted</span><span>${predicted}</span></div>` +
        `<div class="phover-row"><span>Market</span><span>${market}</span></div>`
      )
      .openOn(widgetMap);
  });

  propertyTileLayer.on('mouseout', () => {
    if (propertyHoverPopup) widgetMap.closePopup(propertyHoverPopup);
  });

  propertyTileLayer.on('click', e => {
    L.DomEvent.stopPropagation(e);
    const tileProps = e.layer.properties;
    if (!tileProps) return;

    if (propertyHoverPopup) widgetMap.closePopup(propertyHoverPopup);

    const prop = {
      location:        tileProps.address || '',
      lat:             e.latlng.lat,
      lng:             e.latlng.lng,
      parcel_number:   String(tileProps.property_id || ''),
      market_value:    tileProps.market_value    != null ? parseFloat(tileProps.market_value)    : null,
      predicted_value: tileProps.predicted_value != null ? parseFloat(tileProps.predicted_value) : null,
    };

    clearError();
    placeMapMarker(prop);
    populateSummary(prop);
    if (prop.location) el('propertySearch').value = titleCase(prop.location);
  });

  propertyTileLayer.addTo(widgetMap);

  const legendControl = L.control({ position: 'bottomleft' });
  legendControl.onAdd = function() {
    const div = L.DomUtil.create('div', 'map-legend');
    div.innerHTML = LEGEND_HTML;
    L.DomEvent.disableClickPropagation(div);
    return div;
  };
  legendControl.addTo(widgetMap);
}

// ── Autocomplete ─────────────────────────────────────────────

function setupAutocomplete(inputId, onSelect) {
  const input    = el(inputId);
  const wrap     = input.closest('.search-input-wrap');
  const dropdown = document.createElement('ul');
  dropdown.className = 'autocomplete-list';
  wrap.appendChild(dropdown);

  let currentResults = [];

  const suggest = debounce(async (query) => {
    if (query.length < 6) { closeDropdown(); return; }

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
          // mousedown fires before blur, so preventDefault keeps focus
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

  input.addEventListener('input', () => suggest(input.value.trim()));

  input.addEventListener('blur', () => {
    // Slight delay so mousedown on item fires first
    setTimeout(closeDropdown, 150);
  });

  // Close on Escape
  input.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeDropdown();
  });

  function closeDropdown() {
    dropdown.classList.remove('open');
    dropdown.innerHTML = '';
    currentResults = [];
  }
}

// ── Search ───────────────────────────────────────────────────

// Called when user types and hits Enter, or clicks Search button.
// Search is just a navigation aid — values populate when the user
// clicks the property's tile on the map.
async function lookupProperty(preloadedProp) {
  if (preloadedProp) {
    processProp(preloadedProp);
    return;
  }

  const address = el('propertySearch').value.trim();
  if (!address) return;

  setSearchState(true);
  clearError();

  try {
    const results = await OPA.searchByAddress(address, 1);
    if (!results.length) {
      showError('No property found. Try a different format, e.g. "1500 Market St".');
      setSearchState(false);
      return;
    }
    processProp(results[0]);
  } catch (err) {
    showError('Could not load property data. Please try again.');
    console.error('[widget] lookupProperty:', err);
    setSearchState(false);
  }
}

// Core flow once we have a property record
function processProp(prop) {
  placeMapMarker(prop);
  populateSummary(prop);
  setSearchState(false);
}

// ── Map marker ───────────────────────────────────────────────

function placeMapMarker(prop) {
  if (widgetMarker) widgetMarker.remove();
  const owner = prop.owner_1 ? `<div class="map-popup-owner">${escHtml(titleCase(prop.owner_1))}</div>` : '';
  const value = prop.market_value ? `<div class="map-popup-value">Assessed: ${fmtMoney(prop.market_value)}</div>` : '';
  widgetMarker = L.marker([prop.lat, prop.lng])
    .bindPopup(
      `<div class="map-popup-address">${escHtml(titleCase(prop.location))}</div>${owner}${value}`,
      { maxWidth: 260 }
    )
    .addTo(widgetMap)
    .openPopup();
  widgetMap.flyTo([prop.lat, prop.lng], ADDRESS_ZOOM, { duration: 0.8 });
  el('clearMarkerBtn').style.display = 'inline-block';
}

function clearMarker() {
  if (widgetMarker) {
    widgetMarker.remove();
    widgetMarker = null;
  }
  el('clearMarkerBtn').style.display = 'none';
}

// ── Summary card ─────────────────────────────────────────────

function populateSummary(prop) {
  el('summaryAddress').textContent =
    (titleCase(prop.location) || '—') + (prop.zip_code ? ', Philadelphia PA ' + prop.zip_code : '');

  el('summaryPid').textContent = 'Property ID: ' + (prop.parcel_number || '—');

  const assessed = prop.predicted_value != null ? parseFloat(prop.predicted_value) : null;
  const market   = prop.market_value    != null ? parseFloat(prop.market_value)    : null;

  el('summaryAssessedValue').textContent = assessed != null ? fmtMoney(assessed) : '—';
  el('summaryMarketValue').textContent   = market   != null ? fmtMoney(market)   : '—';

  const insight = el('summaryInsight');
  if (assessed != null && market != null && market > 0) {
    const diff = assessed - market;
    const pct  = Math.round((diff / market) * 100);
    const tag  = diff >= 0
      ? '<span class="insight-tag above">above</span>'
      : '<span class="insight-tag below">below</span>';
    insight.innerHTML =
      `Predicted assessed value is ${tag} market by <strong>${fmtMoney(Math.abs(diff))}</strong> (${Math.abs(pct)}%).`;
  } else {
    insight.textContent = 'Click any property on the map to see its predicted and market values.';
  }
}

// ── UI state helpers ──────────────────────────────────────────

function setSearchState(loading) {
  const btn = el('searchBtn');
  btn.textContent = loading ? 'Searching…' : 'Search';
  btn.disabled    = loading;
}

function showError(msg) {
  const div = el('searchError');
  div.textContent   = msg;
  div.style.display = 'block';
}

function clearError() {
  const div = el('searchError');
  div.textContent   = '';
  div.style.display = 'none';
}

// ── Init ─────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  initMap();

  // Wire up autocomplete: on selection immediately run the full lookup
  setupAutocomplete('propertySearch', prop => {
    clearError();
    processProp(prop);
  });

  el('propertySearch').addEventListener('keydown', e => {
    if (e.key === 'Enter') lookupProperty();
  });
});
