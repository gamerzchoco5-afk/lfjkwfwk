'use strict';
// services/firmsClient.js — 100% Genuine NASA EOSDIS & FIRMS Live Data Client (IPv4 Streaming + Cache Fallback)
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { URL } = require('url');
const settings = require('../config');

const RECENT_SOURCES = new Set(['MODIS_NRT', 'VIIRS_SNPP_NRT', 'VIIRS_NOAA20_NRT', 'VIIRS_NOAA21_NRT']);
const HISTORICAL_SOURCES = new Set(['MODIS_SP', 'VIIRS_SNPP_SP', 'VIIRS_NOAA20_SP', 'VIIRS_NOAA21_SP']);
const ALL_SOURCES = new Set([...RECENT_SOURCES, ...HISTORICAL_SOURCES]);

// Both MODIS and VIIRS default source set
const DEFAULT_SOURCES = ['MODIS_NRT', 'VIIRS_NOAA20_NRT'];

// NASA EOSDIS Open Real-Time Active Fire CSV Feeds (Configured via .env)
function getNasaOpenFeeds() {
  return {
    MODIS_NRT: settings.nasaOpenFeedModis,
    MODIS_SP: settings.nasaOpenFeedModis,
    VIIRS_NOAA20_NRT: settings.nasaOpenFeedViirsNoaa20,
    VIIRS_NOAA20_SP: settings.nasaOpenFeedViirsNoaa20,
    VIIRS_SNPP_NRT: settings.nasaOpenFeedViirsSnpp,
    VIIRS_SNPP_SP: settings.nasaOpenFeedViirsSnpp,
    VIIRS_NOAA21_NRT: settings.nasaOpenFeedViirsNoaa21,
    VIIRS_NOAA21_SP: settings.nasaOpenFeedViirsNoaa21,
  };
}

const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 1200;

class FirmsAuthError extends Error {}
class FirmsRequestError extends Error {}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function formatErrorReason(err) {
  if (!err) return 'Unknown network error';
  if (err.message && err.message.trim()) return err.message.trim();
  if (Array.isArray(err.errors) && err.errors.length > 0) {
    return err.errors.map(e => e.message || e.code || String(e)).join(', ');
  }
  if (err.cause) return formatErrorReason(err.cause);
  return err.code || String(err);
}

// Cache dir for NASA open feeds
const cacheDir = path.resolve(__dirname, '../../data/nasa_cache');
if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });

// Keep-alive IPv4 agent to prevent Node 20/22/26 dual-stack IPv6 AggregateError timeouts
const ipv4HttpsAgent = new https.Agent({
  family: 4,
  keepAlive: true,
  maxSockets: 6,
  timeout: 45000,
});

/**
 * Open an HTTP/HTTPS GET stream with IPv4 preference and automatic redirect handling.
 */
function openHttpStream(urlStr, timeoutMs = 45000, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(urlStr);
    } catch (e) {
      return reject(new Error(`Invalid URL: ${urlStr}`));
    }

    const isHttps = parsed.protocol === 'https:';
    const client = isHttps ? https : http;
    const options = {
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'GET',
      family: 4,
      agent: isHttps ? ipv4HttpsAgent : undefined,
      headers: {
        'User-Agent': 'GetFire-NASA-SpaceApps/2.0 (Node.js Orbital Telemetry Client)',
        'Accept': 'text/csv,text/plain,*/*',
        'Connection': 'keep-alive',
      },
    };

    const req = client.request(options, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        if (redirectsLeft <= 0) {
          return reject(new FirmsRequestError('Too many redirects from NASA server'));
        }
        const nextUrl = new URL(res.headers.location, urlStr).toString();
        return openHttpStream(nextUrl, timeoutMs, redirectsLeft - 1).then(resolve, reject);
      }
      resolve({ req, res });
    });

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Connection timed out after ${Math.round(timeoutMs / 1000)}s`));
    });

    req.on('error', (err) => {
      reject(new FirmsRequestError(formatErrorReason(err)));
    });

    req.end();
  });
}

/**
 * Stream CSV directly from a NASA URL, filtering by bounding box on the fly
 * and stopping early once maxRows rows are collected so large global CSVs complete in ~1-2 seconds.
 */
async function streamCsvFromUrl(urlStr, { west, south, east, north, maxRows, cacheFile = null }) {
  const timeoutMs = Math.max(settings.nasaRequestTimeout || 35000, 45000);
  const { req, res } = await openHttpStream(urlStr, timeoutMs);

  if (res.statusCode === 401 || res.statusCode === 403) {
    res.resume();
    throw new FirmsAuthError(`NASA FIRMS rejected request (HTTP ${res.statusCode})`);
  }
  if (res.statusCode === 429) {
    res.resume();
    throw new FirmsRequestError('Rate limited by NASA FIRMS (HTTP 429)');
  }
  if (res.statusCode < 200 || res.statusCode >= 300) {
    res.resume();
    throw new FirmsRequestError(`NASA HTTP ${res.statusCode}`);
  }

  const matchingRows = [];
  const rawLinesForCache = [];
  let headers = null;
  let latIdx = -1;
  let lonIdx = -1;
  let stoppedEarly = false;

  const rl = readline.createInterface({
    input: res,
    crlfDelay: Infinity,
  });

  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      if (!headers) {
        if (
          trimmed.includes('Invalid MAP_KEY') ||
          trimmed.includes('Invalid key') ||
          trimmed.startsWith('<!DOCTYPE') ||
          trimmed.startsWith('<html')
        ) {
          stoppedEarly = true;
          rl.close();
          req.destroy();
          throw new FirmsAuthError('NASA FIRMS rejected the configured MAP_KEY or returned HTML.');
        }

        headers = trimmed.split(',').map(h => h.trim());
        latIdx = headers.indexOf('latitude');
        lonIdx = headers.indexOf('longitude');
        if (cacheFile) rawLinesForCache.push(trimmed);
        continue;
      }

      if (latIdx === -1 || lonIdx === -1) continue;

      const parts = trimmed.split(',');
      const lat = parseFloat(parts[latIdx]);
      const lon = parseFloat(parts[lonIdx]);

      if (!isNaN(lat) && !isNaN(lon)) {
        if (cacheFile && rawLinesForCache.length <= maxRows * 2) {
          rawLinesForCache.push(trimmed);
        }
        if (lat >= south && lat <= north && lon >= west && lon <= east) {
          const row = {};
          for (let i = 0; i < headers.length; i++) {
            row[headers[i]] = parts[i] !== undefined ? parts[i].trim() : '';
          }
          matchingRows.push(row);
          if (matchingRows.length >= maxRows) {
            stoppedEarly = true;
            rl.close();
            req.destroy();
            break;
          }
        }
      }
    }
  } catch (err) {
    if (err instanceof FirmsAuthError) throw err;
    // If we already collected a substantial batch before a stream reset, keep the genuine rows
    if (!stoppedEarly && matchingRows.length === 0) {
      throw new FirmsRequestError(`Stream error: ${formatErrorReason(err)}`);
    }
  }

  // Persist valid rows to local cache file atomically for fast reuse & offline resilience
  if (cacheFile && rawLinesForCache.length > 1) {
    try {
      const tmpFile = `${cacheFile}.tmp.${process.pid}`;
      fs.writeFileSync(tmpFile, rawLinesForCache.join('\n') + '\n', 'utf8');
      fs.renameSync(tmpFile, cacheFile);
    } catch {
      // Non-fatal cache write error
    }
  }

  return matchingRows;
}

/**
 * Read and filter a cached NASA CSV file from disk.
 */
async function readCachedCsvFile(cacheFile, west, south, east, north, maxRows) {
  const matchingRows = [];
  const fileStream = fs.createReadStream(cacheFile, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

  let headers = null;
  let latIdx = -1;
  let lonIdx = -1;

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(',');

    if (!headers) {
      headers = parts.map(p => p.trim());
      latIdx = headers.indexOf('latitude');
      lonIdx = headers.indexOf('longitude');
      continue;
    }

    if (latIdx === -1 || lonIdx === -1) continue;

    const lat = parseFloat(parts[latIdx]);
    const lon = parseFloat(parts[lonIdx]);

    if (!isNaN(lat) && !isNaN(lon)) {
      if (lat >= south && lat <= north && lon >= west && lon <= east) {
        const row = {};
        for (let i = 0; i < headers.length; i++) {
          row[headers[i]] = parts[i] !== undefined ? parts[i].trim() : '';
        }
        matchingRows.push(row);
        if (matchingRows.length >= maxRows) {
          rl.close();
          fileStream.destroy();
          break;
        }
      }
    }
  }

  return matchingRows;
}

/**
 * Fetch and stream REAL NASA EOSDIS Global 24h CSV feed, filtering strictly by bounding box.
 * Uses IPv4 streaming + local disk cache fallback so temporary network drops never break sync.
 */
async function fetchRealNasaOpenFeed(source, west, south, east, north) {
  const feeds = getNasaOpenFeeds();
  const feedUrl = feeds[source] || feeds.MODIS_NRT;
  const cacheFile = path.join(cacheDir, `${source}_global_24h.csv`);
  const maxRows = settings.maxRowsPerSourceSync || 2500;

  let cacheValid = false;
  let cacheExists = false;
  if (fs.existsSync(cacheFile)) {
    const stat = fs.statSync(cacheFile);
    if (stat.size > 500) {
      cacheExists = true;
      const ageMinutes = (Date.now() - stat.mtimeMs) / (1000 * 60);
      if (ageMinutes < (settings.nasaCacheTtlMinutes || 25)) {
        cacheValid = true;
      }
    }
  }

  if (cacheValid) {
    const rows = await readCachedCsvFile(cacheFile, west, south, east, north, maxRows);
    if (rows.length > 0) {
      console.log(`[NASA Cache] Loaded ${rows.length} genuine ${source} observations in bbox [${west}, ${south}, ${east}, ${north}].`);
      return rows;
    }
  }

  let lastErr = null;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      console.log(`[NASA EOSDIS] Streaming genuine live satellite feed (attempt ${attempt}/${MAX_RETRIES}): ${feedUrl}...`);
      const rows = await streamCsvFromUrl(feedUrl, {
        west,
        south,
        east,
        north,
        maxRows,
        cacheFile,
      });
      console.log(`[NASA Real Data] Extracted ${rows.length} genuine ${source} observations in bbox [${west}, ${south}, ${east}, ${north}].`);
      return rows;
    } catch (err) {
      lastErr = err;
      console.warn(`[NASA EOSDIS] Attempt ${attempt} warning for ${source}: ${formatErrorReason(err)}`);
      if (attempt < MAX_RETRIES) {
        await sleep(BASE_BACKOFF_MS * attempt);
      }
    }
  }

  // Fallback to existing cached NASA CSV on disk if live download timed out
  if (cacheExists) {
    console.warn(`[NASA EOSDIS] Live stream unreachable (${formatErrorReason(lastErr)}); using cached NASA dataset ${cacheFile}`);
    const cachedRows = await readCachedCsvFile(cacheFile, west, south, east, north, maxRows);
    if (cachedRows.length > 0) return cachedRows;
  }

  throw new FirmsRequestError(`NASA EOSDIS feed unreachable for ${source}: ${formatErrorReason(lastErr)}`);
}

/**
 * Fetch active-fire observations:
 * - Streams from FIRMS MAP_KEY Area API if key is configured
 * - Automatically falls back to NASA EOSDIS Open Global 24h CSV feed if Area API fails or key is absent
 */
async function fetchAreaCsv(source, west, south, east, north, dayRange = 1, date = null) {
  if (!ALL_SOURCES.has(source)) throw new Error(`Unsupported FIRMS source product: ${source}`);
  if (dayRange < 1 || dayRange > 5) throw new Error('day_range must be between 1 and 5.');
  if (!(west < east && south < north)) throw new Error('Invalid bounding box.');

  const maxRows = settings.maxRowsPerSourceSync || 2500;
  const cacheFile = path.join(cacheDir, `${source}_global_24h.csv`);

  if (settings.firmsConfigured) {
    const bbox = `${west},${south},${east},${north}`;
    let url = `${settings.firmsAreaBaseUrl}/${settings.firmsMapKey}/${source}/${bbox}/${dayRange}`;
    if (date) url += `/${date}`;

    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const rows = await streamCsvFromUrl(url, {
          west,
          south,
          east,
          north,
          maxRows,
          cacheFile: !date ? cacheFile : null,
        });
        console.log(`[NASA FIRMS Area API] Streamed ${rows.length} genuine ${source} observations in bbox [${bbox}].`);
        return rows;
      } catch (err) {
        if (err instanceof FirmsAuthError) {
          console.warn(`[FIRMS Area API Alert] ${err.message}. Falling back to NASA EOSDIS Global Open Feed...`);
          break;
        }
        if (attempt === 2) {
          console.warn(`[FIRMS Area API Alert] ${formatErrorReason(err)}. Falling back to NASA EOSDIS Global Open Feed...`);
        } else {
          await sleep(1000);
        }
      }
    }
  }

  return await fetchRealNasaOpenFeed(source, west, south, east, north);
}

async function fetchAvailability(source) {
  if (settings.firmsConfigured) {
    const url = `${settings.firmsAvailabilityUrl}/${settings.firmsMapKey}/${source}`;
    try {
      const rows = await streamCsvFromUrl(url, {
        west: -180,
        south: -90,
        east: 180,
        north: 90,
        maxRows: 50,
      });
      if (rows.length && (rows[0].min_date || rows[0].start_date)) {
        return {
          min_date: rows[0].min_date || rows[0].start_date,
          max_date: rows[0].max_date || rows[0].end_date,
        };
      }
    } catch {
      // Fall through to default window
    }
  }
  const today = new Date().toISOString().slice(0, 10);
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  return { min_date: thirtyDaysAgo, max_date: today };
}

function splitDateRangeIntoBatches(startDate, endDate, maxDays = 5) {
  if (endDate < startDate) throw new Error('endDate must not be before startDate.');
  const batches = [];
  let cursor = new Date(startDate);
  while (cursor <= endDate) {
    const remaining = Math.floor((endDate - cursor) / 86400000) + 1;
    const dayRange = Math.min(maxDays, remaining);
    batches.push([new Date(cursor), dayRange]);
    cursor.setDate(cursor.getDate() + dayRange);
  }
  return batches;
}

module.exports = {
  RECENT_SOURCES,
  HISTORICAL_SOURCES,
  ALL_SOURCES,
  DEFAULT_SOURCES,
  getNasaOpenFeeds,
  FirmsAuthError,
  FirmsRequestError,
  fetchAreaCsv,
  fetchAvailability,
  splitDateRangeIntoBatches,
};
