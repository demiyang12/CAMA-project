/* ============================================================
   Philadelphia OPA API Layer — opa-api.js
   Shared by widget (property owner) and reviewer (assessor).

   Address search:    ArcGIS World Geocoder (no key required)
   Property detail:   Philadelphia Open Data Socrata API (no key required)
   City distribution: GCS public bucket tax_year_assessment_bins.json
   ============================================================ */

/* global OPA */
'use strict';

// eslint-disable-next-line no-unused-vars
const OPA = (() => {
  const GEOCODER_BASE =
    'https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/findAddressCandidates';
  const PHILA_CENTER = '-75.1652,39.9526';

  const OPA_SOCRATA_BASE = 'https://data.phila.gov/resource/w7rb-qrn8.json';
  const GCS_PUBLIC_BASE  = 'https://storage.googleapis.com/musa5090s26-team4-public';

  const DIRECTIONS = new Set(['N', 'S', 'E', 'W', 'NE', 'NW', 'SE', 'SW']);

  // Parse "1500 Market St" → { houseNum: "1500", streetName: "MARKET" }
  function parseStreetAddr(str) {
    const tokens = str.trim().split(/\s+/);
    if (!tokens.length) return null;
    let houseNum = '', parts = tokens;
    if (/^\d/.test(tokens[0])) { houseNum = tokens[0]; parts = tokens.slice(1); }
    if (parts.length > 1) parts = parts.slice(0, -1); // drop designation (St/Ave/Rd…)
    const named = parts.filter(t => !DIRECTIONS.has(t.toUpperCase()));
    return { houseNum, streetName: (named.length ? named : parts).join(' ').toUpperCase() };
  }

  // Map a raw Socrata OPA row to our internal property shape
  function rowToProp(r, base = {}) {
    return {
      ...base,
      parcel_number:             r.parcel_number             || base.parcel_number || '',
      location:                  r.location                  || base.location      || '',
      market_value:              r.market_value   != null    ? parseInt(r.market_value,   10) : base.market_value   ?? null,
      zip_code:                  r.zip_code                  || base.zip_code      || '',
      owner_1:                   r.owner_1                   || base.owner_1       || '',
      owner_2:                   r.owner_2                   || base.owner_2       || '',
      sale_price:                r.sale_price     != null    ? parseInt(r.sale_price,     10) : base.sale_price     ?? null,
      sale_date:                 r.sale_date                 || base.sale_date     || null,
      year_built:                r.year_built                || base.year_built    || null,
      building_code_description: r.building_code_description || base.building_code_description || '',
    };
  }

  // Look up an OPA property and merge into a geocoder result object.
  async function enrichWithOPA(geocodeResult) {
    try {
      const parsed = parseStreetAddr(geocodeResult.location);
      if (!parsed || !parsed.houseNum || !parsed.streetName) return geocodeResult;

      const params = new URLSearchParams({
        '$where': `house_number='${parsed.houseNum}' AND location LIKE '%${parsed.streetName}%'`,
        '$select': 'parcel_number,location,market_value,zip_code,owner_1,owner_2,sale_price,sale_date,year_built,building_code_description',
        '$limit': '5',
      });
      const res = await fetch(`${OPA_SOCRATA_BASE}?${params}`);
      if (!res.ok) return geocodeResult;
      const rows = await res.json();
      if (!rows.length) return geocodeResult;

      // Prefer a row whose zip matches the geocoded zip; fall back to first result
      const best = rows.find(r => r.zip_code === geocodeResult.zip_code) || rows[0];
      return rowToProp(best, geocodeResult);
    } catch {
      return geocodeResult;
    }
  }

  return {
    /**
     * Address autocomplete / geocoding.
     * Geocodes via ArcGIS, then enriches the first 3 candidates with live OPA data.
     */
    async searchByAddress(query, limit = 8) {
      if (!query || query.length < 2) return [];
      try {
        const params = new URLSearchParams({
          f:            'json',
          singleLine:   query + ', Philadelphia, PA',
          maxLocations: String(limit),
          outFields:    'StAddr,City,Region,Postal,PlaceName',
          location:     PHILA_CENTER,
          distance:     '50000',
          countryCode:  'USA',
        });
        const res = await fetch(`${GEOCODER_BASE}?${params}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();

        const candidates = (data.candidates || [])
          .filter(c => c.score >= 50 && c.location)
          .map(c => ({
            location:                  c.attributes.StAddr || c.address.split(',')[0] || c.address,
            zip_code:                  c.attributes.Postal || '',
            lat:                       c.location.y,
            lng:                       c.location.x,
            parcel_number:             '',
            market_value:              null,
            building_code_description: '',
            owner_1:                   '',
            owner_2:                   '',
            zoning:                    '',
            year_built:                null,
            total_livable_area:        null,
            total_area:                null,
            number_of_bedrooms:        null,
            number_of_bathrooms:       null,
            sale_price:                null,
            sale_date:                 null,
          }));

        // Enrich first 3 with live OPA data; leave the rest geocoded-only
        const toEnrich = candidates.slice(0, 3);
        const rest     = candidates.slice(3);
        const enriched = await Promise.all(toEnrich.map(enrichWithOPA));
        return [...enriched, ...rest];
      } catch (err) {
        console.error('[OPA] searchByAddress:', err);
        return [];
      }
    },

    /**
     * Fetch full property detail by OPA parcel number.
     * Used by the map tile click handler.
     */
    async getByParcelNumber(parcel_number) {
      if (!parcel_number) return null;
      try {
        const params = new URLSearchParams({
          '$where': `parcel_number='${parcel_number}'`,
          '$select': 'parcel_number,location,market_value,zip_code,owner_1,owner_2,sale_price,sale_date,year_built,building_code_description',
          '$limit': '1',
        });
        const res = await fetch(`${OPA_SOCRATA_BASE}?${params}`);
        if (!res.ok) return null;
        const rows = await res.json();
        if (!rows.length) return null;
        return rowToProp(rows[0]);
      } catch (err) {
        console.error('[OPA] getByParcelNumber:', err);
        return null;
      }
    },

    /**
     * Per-property assessment history from GCS.
     * Populated by tasks/Export Property History/main.py.
     * Returns [{year, market_value}, …] sorted ascending by year, or [] if unavailable.
     */
    async getHistory(parcel_number) {
      if (!parcel_number) return [];
      try {
        const res = await fetch(`${GCS_PUBLIC_BASE}/property_history/${parcel_number}.json`);
        if (!res.ok) return [];   // 404 = no history file yet
        return await res.json();
      } catch (err) {
        console.error('[OPA] getHistory:', err);
        return [];
      }
    },

    /**
     * Properties in the same ZIP code, excluding the current parcel.
     * Uses the Philadelphia OPA Socrata endpoint.
     */
    async getNearby(zip_code, parcel_number, limit = 5) {
      if (!zip_code) return [];
      try {
        const where = parcel_number
          ? `zip_code='${zip_code}' AND parcel_number!='${parcel_number}'`
          : `zip_code='${zip_code}'`;
        const params = new URLSearchParams({
          '$where':  where,
          '$select': 'parcel_number,location,market_value,zip_code',
          '$limit':  String(limit * 4),
          '$order':  'market_value DESC',
        });
        const res = await fetch(`${OPA_SOCRATA_BASE}?${params}`);
        if (!res.ok) return [];
        const rows = await res.json();
        return rows
          .filter(r => r.market_value && parseInt(r.market_value, 10) > 0)
          .slice(0, limit);
      } catch (err) {
        console.error('[OPA] getNearby:', err);
        return [];
      }
    },

    /**
     * City-wide assessed-value distribution for the most recent tax year.
     * Reads tax_year_assessment_bins.json from the public GCS bucket and
     * aggregates the 50 K-increment bins into 8 chart buckets.
     */
    async getCityDistribution() {
      try {
        const res = await fetch(`${GCS_PUBLIC_BASE}/configs/tax_year_assessment_bins.json`);
        if (!res.ok) return [];
        const bins = await res.json();

        // Use the year with the most properties (may not be the latest if data is partial)
        const yearTotals = {};
        bins.forEach(b => {
          if (b.lower_bound >= 0)
            yearTotals[b.tax_year] = (yearTotals[b.tax_year] || 0) + parseInt(b.property_count, 10);
        });
        const bestYear = parseInt(
          Object.entries(yearTotals).sort((a, b) => b[1] - a[1])[0][0], 10
        );
        const yearBins = bins.filter(b => b.tax_year === bestYear && b.lower_bound >= 0);

        // 8 chart buckets: [0, 125K, 250K, 375K, 500K, 625K, 750K, 875K, ∞]
        const BREAKS = [0, 125000, 250000, 375000, 500000, 625000, 750000, 875000, Infinity];
        const counts  = new Array(8).fill(0);
        yearBins.forEach(bin => {
          const lb  = parseFloat(bin.lower_bound);
          const cnt = parseInt(bin.property_count, 10) || 0;
          const idx = BREAKS.findIndex((b, i) => lb >= b && lb < BREAKS[i + 1]);
          if (idx >= 0 && idx < 8) counts[idx] += cnt;
        });
        return counts.map((cnt, i) => ({ bucket: i + 1, cnt }));
      } catch (err) {
        console.error('[OPA] getCityDistribution:', err);
        return [];
      }
    },

    async filterProperties() {
      // TODO: implement via property-data backend
      return [];
    },
  };
})();
