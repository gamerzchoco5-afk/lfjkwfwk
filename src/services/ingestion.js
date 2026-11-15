'use strict';
// services/ingestion.js — handles NASA FIRMS ingestion with auto-pruning safeguard
const { getDb, checkAndPruneDatabase } = require('../db/database');
const harmonizer = require('./harmonizer');
const {
  fetchAreaCsv,
  fetchAvailability,
  splitDateRangeIntoBatches,
  HISTORICAL_SOURCES,
  DEFAULT_SOURCES,
  ALL_SOURCES,
  FirmsAuthError,
  FirmsRequestError,
} = require('./firmsClient');
const { normalizeRows } = require('./normalizer');

const AVAILABILITY_CACHE_TTL_HOURS = 24;

class SyncAlreadyRunningError extends Error {}

let _syncRunning = false;

function upsertObservations(normalizedRows) {
  if (!normalizedRows.length) return { inserted: 0, updated: 0 };

  const db = getDb();
  const keys = normalizedRows.map(r => r.observation_key);
  const placeholders = keys.map(() => '?').join(',');
  const existing = db.prepare(`
    SELECT observation_key FROM hotspot_observations WHERE observation_key IN (${placeholders})
  `).all(...keys);
  const existingSet = new Set(existing.map(r => r.observation_key));

  const insert = db.prepare(`
    INSERT INTO hotspot_observations
      (observation_key, source_product, sensor, satellite, instrument, processing_version,
       processing_level, latitude, longitude, h3_cell, acquired_at_utc, acquired_date_utc,
       acquired_time_utc, brightness_primary_k, brightness_secondary_k, primary_brightness_band,
       secondary_brightness_band, scan, track, frp_mw, confidence_raw, confidence_class,
       daynight, detection_type, raw_payload_json, ingested_at_utc)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))
  `);

  const update = db.prepare(`
    UPDATE hotspot_observations SET
      frp_mw = ?, brightness_primary_k = ?, brightness_secondary_k = ?,
      confidence_raw = ?, confidence_class = ?, raw_payload_json = ?
    WHERE observation_key = ?
  `);

  let inserted = 0, updated = 0;
  const pendingKeys = new Set();

  const nullSafe = v => (v === undefined ? null : v);

  db.exec('BEGIN');
  try {
    for (const row of normalizedRows) {
      if (existingSet.has(row.observation_key) || pendingKeys.has(row.observation_key)) {
        update.run(
          nullSafe(row.frp_mw), nullSafe(row.brightness_primary_k), nullSafe(row.brightness_secondary_k),
          nullSafe(row.confidence_raw), nullSafe(row.confidence_class), nullSafe(row.raw_payload_json),
          row.observation_key
        );
        updated++;
      } else {
        insert.run(
          row.observation_key, row.source_product, row.sensor, nullSafe(row.satellite), nullSafe(row.instrument),
          nullSafe(row.processing_version), row.processing_level, row.latitude, row.longitude, row.h3_cell,
          row.acquired_at_utc, row.acquired_date_utc, nullSafe(row.acquired_time_utc),
          nullSafe(row.brightness_primary_k), nullSafe(row.brightness_secondary_k),
          nullSafe(row.primary_brightness_band), nullSafe(row.secondary_brightness_band),
          nullSafe(row.scan), nullSafe(row.track), nullSafe(row.frp_mw), nullSafe(row.confidence_raw), nullSafe(row.confidence_class),
          nullSafe(row.daynight), nullSafe(row.detection_type), nullSafe(row.raw_payload_json)
        );
        pendingKeys.add(row.observation_key);
        inserted++;
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return { inserted, updated };
}

async function checkSourceAvailability(source) {
  const db = getDb();
  const cached = db.prepare(`
    SELECT min_date, max_date, checked_at_utc FROM dataset_availability_cache WHERE source_product = ?
  `).get(source);

  const now = new Date();
  if (cached) {
    const checkedAt = new Date(cached.checked_at_utc + 'Z');
    const ageHours = (now - checkedAt) / 3600000;
    if (ageHours < AVAILABILITY_CACHE_TTL_HOURS) return { min_date: cached.min_date, max_date: cached.max_date };
  }

  let availability;
  try {
    availability = await fetchAvailability(source);
  } catch (err) {
    console.warn(`[Ingestion] Could not refresh availability for ${source}: ${err.message}`);
    if (cached) return { min_date: cached.min_date, max_date: cached.max_date };
    return null;
  }

  if (!availability) return null;

  if (cached) {
    db.prepare(`UPDATE dataset_availability_cache SET min_date=?, max_date=?, checked_at_utc=datetime('now') WHERE source_product=?`)
      .run(availability.min_date, availability.max_date, source);
  } else {
    db.prepare(`INSERT INTO dataset_availability_cache (source_product, min_date, max_date, checked_at_utc) VALUES (?,?,?,datetime('now'))`)
      .run(source, availability.min_date, availability.max_date);
  }
  return availability;
}

async function runSync({ sources, west, south, east, north, startDate, endDate }) {
  if (_syncRunning) throw new SyncAlreadyRunningError('A synchronization job is already running on this server.');
  _syncRunning = true;

  // Use both MODIS and VIIRS by default if not provided
  const targetSources = (Array.isArray(sources) && sources.length > 0) ? sources : DEFAULT_SOURCES;

  const db = getDb();
  const syncRunId = db.prepare(`
    INSERT INTO sync_runs (sources, west, south, east, north, start_date, end_date, sync_status, started_at_utc)
    VALUES (?,?,?,?,?,?,?,'running',datetime('now'))
  `).run(targetSources.join(','), west, south, east, north, startDate || null, endDate || null).lastInsertRowid;

  let totalFetched = 0, totalInserted = 0, totalUpdated = 0;
  const affectedDates = new Set();
  const errors = [];

  try {
    let batches;
    if (startDate && endDate) {
      batches = splitDateRangeIntoBatches(new Date(startDate), new Date(endDate));
    } else {
      batches = [[null, 1]];
    }

    for (const source of targetSources) {
      if (!ALL_SOURCES.has(source)) continue;

      if (HISTORICAL_SOURCES.has(source) && startDate && endDate) {
        const availability = await checkSourceAvailability(source);
        if (availability) {
          if (endDate < availability.min_date || startDate > availability.max_date) {
            errors.push(`${source}: requested range ${startDate}..${endDate} is outside NASA's available window ${availability.min_date}..${availability.max_date}.`);
            continue;
          }
        }
      }

      for (const [batchStart, dayRange] of batches) {
        const dateStr = batchStart ? batchStart.toISOString().slice(0, 10) : null;
        let rawRows;
        try {
          rawRows = await fetchAreaCsv(source, west, south, east, north, dayRange, dateStr);
        } catch (err) {
          const msg = `${source} ${dateStr || 'latest'}: ${err.message}`;
          errors.push(msg);
          console.error(`[Ingestion] Fetch failed: ${msg}`);
          continue;
        }

        totalFetched += rawRows.length;
        const { normalized, errors: normErrors } = normalizeRows(source, rawRows);
        errors.push(...normErrors);

        const { inserted, updated } = upsertObservations(normalized);
        totalInserted += inserted;
        totalUpdated += updated;
        for (const obs of normalized) affectedDates.add(obs.acquired_date_utc);
      }
    }

    if (affectedDates.size > 0) {
      const sortedDates = [...affectedDates].sort();
      harmonizer.aggregateDateRange(sortedDates[0], sortedDates[sortedDates.length - 1]);
    }

    const status = errors.length === 0 ? 'success' : (totalInserted > 0 ? 'partial_failure' : 'failed');
    db.prepare(`
      UPDATE sync_runs SET records_fetched=?, records_inserted=?, records_updated=?,
        sync_status=?, error_message=?, completed_at_utc=datetime('now') WHERE id=?
    `).run(totalFetched, totalInserted, totalUpdated, status, errors.slice(0, 20).join('; ') || null, syncRunId);

    // CRITICAL: Ensure SQL database does not exceed 100MB by auto-pruning oldest records!
    checkAndPruneDatabase();

  } catch (err) {
    db.prepare(`UPDATE sync_runs SET sync_status='failed', error_message=?, completed_at_utc=datetime('now') WHERE id=?`)
      .run(err.message, syncRunId);
    console.error('[Ingestion] Sync run failed:', err);
  } finally {
    _syncRunning = false;
  }

  return db.prepare('SELECT * FROM sync_runs WHERE id=?').get(syncRunId);
}

module.exports = { runSync, SyncAlreadyRunningError };
