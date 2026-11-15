'use strict';
// routes/hotspots.js
const express = require('express');
const { getDb } = require('../db/database');
const settings = require('../config');

const router = express.Router();

function validateBbox(west, south, east, north) {
  if (!(-180 <= west && west < east && east <= 180)) return 'Invalid bounding box: require -180 <= west < east <= 180.';
  if (!(-90 <= south && south < north && north <= 90)) return 'Invalid bounding box: require -90 <= south < north <= 90.';
  return null;
}

router.get('/api/v1/hotspots', (req, res) => {
  const { west = -180, south = -90, east = 180, north = 90, start_date, end_date, sensor, satellite, processing_level, confidence_class, daynight } = req.query;
  let limit = parseInt(req.query.limit || '500', 10);
  const offset = parseInt(req.query.offset || '0', 10);

  const w = parseFloat(west), s = parseFloat(south), e = parseFloat(east), n = parseFloat(north);
  if ([w, s, e, n].some(isNaN)) return res.status(400).json({ detail: 'west, south, east, north are required numbers.' });

  const bboxErr = validateBbox(w, s, e, n);
  if (bboxErr) return res.status(400).json({ detail: bboxErr });

  limit = Math.min(limit, settings.maxHotspotLimit);

  const db = getDb();
  const conditions = ['longitude >= ? AND longitude <= ? AND latitude >= ? AND latitude <= ?'];
  const params = [w, e, s, n];

  if (start_date) { conditions.push('acquired_date_utc >= ?'); params.push(start_date); }
  if (end_date)   { conditions.push('acquired_date_utc <= ?'); params.push(end_date); }
  if (sensor)     { conditions.push('sensor = ?'); params.push(sensor.toUpperCase()); }
  if (satellite)  { conditions.push('satellite = ?'); params.push(satellite); }
  if (processing_level) { conditions.push('processing_level = ?'); params.push(processing_level.toUpperCase()); }
  if (confidence_class) { conditions.push('confidence_class = ?'); params.push(confidence_class.toLowerCase()); }
  if (daynight)   { conditions.push('daynight = ?'); params.push(daynight.toUpperCase()); }

  const whereClause = conditions.join(' AND ');
  const total = db.prepare(`SELECT COUNT(id) as n FROM hotspot_observations WHERE ${whereClause}`).get(...params).n;
  const rows = db.prepare(`SELECT * FROM hotspot_observations WHERE ${whereClause} ORDER BY acquired_at_utc DESC LIMIT ? OFFSET ?`)
    .all(...params, limit + 1, offset);

  const hasMore = rows.length > limit;
  const sliced = rows.slice(0, limit);

  const features = sliced.map(row => ({
    type: 'Feature',
    id: String(row.id),
    geometry: { type: 'Point', coordinates: [row.longitude, row.latitude] },
    properties: {
      observation_id: row.id,
      sensor: row.sensor,
      satellite: row.satellite,
      source_product: row.source_product,
      acquired_at_utc: row.acquired_at_utc,
      frp_mw: row.frp_mw,
      brightness_primary_k: row.brightness_primary_k,
      brightness_secondary_k: row.brightness_secondary_k,
      confidence_raw: row.confidence_raw,
      confidence_class: row.confidence_class,
      daynight: row.daynight,
      h3_cell: row.h3_cell,
    },
  }));

  res.json({
    type: 'FeatureCollection',
    features,
    numberReturned: features.length,
    limit,
    offset,
    hasMore: hasMore || (offset + features.length < total),
  });
});

router.get('/api/v1/hotspots/:observation_id', (req, res) => {
  const id = parseInt(req.params.observation_id, 10);
  if (isNaN(id)) return res.status(400).json({ detail: 'Invalid observation ID.' });

  const db = getDb();
  const row = db.prepare('SELECT * FROM hotspot_observations WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ detail: 'Observation not found.' });

  res.json({
    observation_id: row.id,
    observation_key: row.observation_key,
    source_product: row.source_product,
    sensor: row.sensor,
    satellite: row.satellite,
    instrument: row.instrument,
    processing_version: row.processing_version,
    processing_level: row.processing_level,
    latitude: row.latitude,
    longitude: row.longitude,
    h3_cell: row.h3_cell,
    acquired_at_utc: row.acquired_at_utc,
    acquired_date_utc: row.acquired_date_utc,
    acquired_time_utc: row.acquired_time_utc,
    brightness_primary_k: row.brightness_primary_k,
    brightness_secondary_k: row.brightness_secondary_k,
    primary_brightness_band: row.primary_brightness_band,
    secondary_brightness_band: row.secondary_brightness_band,
    scan: row.scan,
    track: row.track,
    frp_mw: row.frp_mw,
    confidence_raw: row.confidence_raw,
    confidence_class: row.confidence_class,
    daynight: row.daynight,
    detection_type: row.detection_type,
    ingested_at_utc: row.ingested_at_utc,
    raw_payload: JSON.parse(row.raw_payload_json),
  });
});

module.exports = router;
