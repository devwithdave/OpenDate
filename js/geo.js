/**
 * OpenDate - Geographic Privacy & 4-Character Geohash Engine
 * Exact street coordinates are never sent to any relay.
 * Discovery is indexed on a coarse 4-character geohash grid (~25 mi x 12 mi box)
 * with a 9-cell bounding box neighbor query to eliminate border boundary misses.
 */

const BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz';

const OFFLINE_HUBS = [
  { name: 'Charlottesville, VA', lat: 38.0293, lon: -78.4767 },
  { name: 'Richmond, VA', lat: 37.5407, lon: -77.4360 },
  { name: 'Lynchburg, VA', lat: 37.4138, lon: -79.1422 },
  { name: 'Harrisonburg, VA', lat: 38.4496, lon: -78.8689 },
  { name: 'Roanoke, VA', lat: 37.2710, lon: -79.9414 },
  { name: 'Washington, DC', lat: 38.9072, lon: -77.0369 },
  { name: 'Baltimore, MD', lat: 39.2904, lon: -76.6122 },
  { name: 'Raleigh, NC', lat: 35.7796, lon: -78.6382 },
  { name: 'Philadelphia, PA', lat: 39.9526, lon: -75.1652 },
  { name: 'New York, NY', lat: 40.7128, lon: -74.0060 }
];

const OpenDateGeo = {
  /**
   * Encodes latitude and longitude into a geohash of specified length.
   * @param {number} latitude
   * @param {number} longitude
   * @param {number} precision Default 4 chars (~25 mi box)
   * @returns {string}
   */
  encode(latitude, longitude, precision = 4) {
    let latInterval = [-90.0, 90.0];
    let lonInterval = [-180.0, 180.0];
    let isEven = true;
    let bit = 0;
    let ch = 0;
    let geohash = '';

    while (geohash.length < precision) {
      if (isEven) {
        const mid = (lonInterval[0] + lonInterval[1]) / 2;
        if (longitude > mid) {
          ch |= (1 << (4 - bit));
          lonInterval[0] = mid;
        } else {
          lonInterval[1] = mid;
        }
      } else {
        const mid = (latInterval[0] + latInterval[1]) / 2;
        if (latitude > mid) {
          ch |= (1 << (4 - bit));
          latInterval[0] = mid;
        } else {
          latInterval[1] = mid;
        }
      }

      isEven = !isEven;
      if (bit < 4) {
        bit++;
      } else {
        geohash += BASE32[ch];
        bit = 0;
        ch = 0;
      }
    }

    return geohash;
  },

  /**
   * Decodes a geohash to its center lat, lon, and bounding errors.
   * @param {string} geohash
   * @returns {{latitude: number, longitude: number, latErr: number, lonErr: number}}
   */
  decode(geohash) {
    let isEven = true;
    let latInterval = [-90.0, 90.0];
    let lonInterval = [-180.0, 180.0];

    for (let i = 0; i < geohash.length; i++) {
      const cd = BASE32.indexOf(geohash[i]);
      if (cd === -1) continue;

      for (let j = 0; j < 5; j++) {
        const mask = 1 << (4 - j);
        if (isEven) {
          const mid = (lonInterval[0] + lonInterval[1]) / 2;
          if (cd & mask) {
            lonInterval[0] = mid;
          } else {
            lonInterval[1] = mid;
          }
        } else {
          const mid = (latInterval[0] + latInterval[1]) / 2;
          if (cd & mask) {
            latInterval[0] = mid;
          } else {
            latInterval[1] = mid;
          }
        }
        isEven = !isEven;
      }
    }

    const latitude = (latInterval[0] + latInterval[1]) / 2;
    const longitude = (lonInterval[0] + lonInterval[1]) / 2;
    const latErr = (latInterval[1] - latInterval[0]) / 2;
    const lonErr = (lonInterval[1] - lonInterval[0]) / 2;

    return { latitude, longitude, latErr, lonErr };
  },

  /**
   * Calculates the center 4-char geohash and its 8 surrounding perimeter cells (9 cells total).
   * @param {string} centerHash 4-character geohash
   * @returns {string[]} Array of 9 unique 4-character geohashes
   */
  getGeohashWith8Neighbors(centerHash) {
    if (!centerHash || centerHash.length < 4) return [centerHash || 'dqb8'];
    const hash = centerHash.slice(0, 4);
    const { latitude, longitude, latErr, lonErr } = this.decode(hash);

    const latDeltas = [-2 * latErr, 0, 2 * latErr];
    const lonDeltas = [-2 * lonErr, 0, 2 * lonErr];
    const neighbors = new Set();

    for (const dLat of latDeltas) {
      for (const dLon of lonDeltas) {
        const nLat = Math.max(-89.9, Math.min(89.9, latitude + dLat));
        const nLon = Math.max(-179.9, Math.min(179.9, longitude + dLon));
        neighbors.add(this.encode(nLat, nLon, 4));
      }
    }

    return Array.from(neighbors);
  },

  /**
   * Tier 1: Zero-Click IP Geolocation Fallback
   * Uses AbortController with 2-second timeout to prevent UI freezes.
   * @returns {Promise<{label: string, geohash: string}|null>}
   */
  async getIpLocation() {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 2000);
      const res = await fetch('https://get.geojs.io/v1/ip/geo.json', { signal: controller.signal });
      clearTimeout(timeoutId);

      if (!res.ok) return null;
      const data = await res.json();
      const lat = parseFloat(data.latitude);
      const lon = parseFloat(data.longitude);
      const city = data.city || '';
      const region = data.region || '';
      const label = city && region ? `${city}, ${region}` : (city || region || 'Regional Area');
      const geohash = this.encode(lat, lon, 4);
      return { label, geohash };
    } catch (e) {
      // Quietly return null on timeout, CORS, or offline
      return null;
    }
  },

  /**
   * Tier 2: Search by City or 5-Digit US ZIP
   * @param {string} query
   * @returns {Promise<{label: string, geohash: string}|null>}
   */
  async searchLocation(query) {
    const q = (query || '').trim();
    if (!q) return null;

    // A: Check offline hub dictionary
    const hubMatch = OFFLINE_HUBS.find(h => h.name.toLowerCase().includes(q.toLowerCase()));
    if (hubMatch) {
      return {
        label: hubMatch.name,
        geohash: this.encode(hubMatch.lat, hubMatch.lon, 4)
      };
    }

    // B: 5-digit US ZIP Code lookup via Zippopotam
    if (/^\d{5}$/.test(q)) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 2500);
        const res = await fetch(`https://api.zippopotam.us/us/${q}`, { signal: controller.signal });
        clearTimeout(timeoutId);

        if (res.ok) {
          const data = await res.json();
          const place = data.places && data.places[0];
          if (place) {
            const lat = parseFloat(place.latitude);
            const lon = parseFloat(place.longitude);
            const label = `${place['place name']}, ${place['state abbreviation']}`;
            return { label, geohash: this.encode(lat, lon, 4) };
          }
        }
      } catch (err) {
        console.warn('Zippopotam lookup error:', err);
      }
    }

    // C: Live Nationwide City Geocoder via OpenStreetMap Nominatim
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 2500);
      const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(q)}&countrycodes=us&limit=1`;
      const res = await fetch(url, { signal: controller.signal, headers: { 'Accept': 'application/json' } });
      clearTimeout(timeoutId);

      if (res.ok) {
        const items = await res.json();
        if (items && items.length > 0) {
          const item = items[0];
          const lat = parseFloat(item.lat);
          const lon = parseFloat(item.lon);
          const parts = (item.display_name || '').split(',');
          const label = parts.length >= 2 ? `${parts[0].trim()}, ${parts[1].trim()}` : item.display_name;
          return { label, geohash: this.encode(lat, lon, 4) };
        }
      }
    } catch (err) {
      console.warn('Nominatim lookup error:', err);
    }

    return null;
  },

  /**
   * Tier 3: Optional One-Tap Device GPS
   * @returns {Promise<{label: string, geohash: string}>}
   */
  async getDeviceLocation() {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) {
        return reject(new Error('Geolocation is not supported by your browser.'));
      }
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const lat = pos.coords.latitude;
          const lon = pos.coords.longitude;
          const geohash = this.encode(lat, lon, 4);
          resolve({ label: 'Current Device Location', geohash });
        },
        (err) => reject(err),
        { timeout: 6000, enableHighAccuracy: false }
      );
    });
  }
};

window.OpenDateGeo = OpenDateGeo;
window.Geo = OpenDateGeo;
