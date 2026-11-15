'use strict';
// services/harmonizer.js — mirrors Python's app/services/harmonizer.py
const h3 = require('h3-js');
const { getDb } = require('../db/database');

function aggregateDateRange(startDate, endDate) {
  const db = getDb();
  const rows = db.prepare(`
    SELECT acquired_date_utc, h3_cell, sensor, frp_mw
    FROM hotspot_observations
    WHERE acquired_date_utc >= ? AND acquired_date_utc <= ?
  `).all(startDate, endDate);

  const buckets = {};
  for (const row of rows) {
    const key = `${row.acquired_date_utc}|${row.h3_cell}`;
    if (!buckets[key]) {
      buckets[key] = { date: row.acquired_date_utc, cell: row.h3_cell, modis: 0, viirs: 0, modis_frp: 0.0, viirs_frp: 0.0 };
    }
    const b = buckets[key];
    if (row.sensor === 'MODIS') { b.modis++; b.modis_frp += row.frp_mw || 0; }
    else if (row.sensor === 'VIIRS') { b.viirs++; b.viirs_frp += row.frp_mw || 0; }
  }

  const upsert = db.prepare(`
    INSERT INTO daily_cell_activity
      (activity_date, h3_cell, center_lat, center_lon, modis_detections, viirs_detections,
       total_observations, modis_frp_mw_sum, viirs_frp_mw_sum, multi_sensor_cell, updated_at_utc)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(activity_date, h3_cell) DO UPDATE SET
      center_lat        = excluded.center_lat,
      center_lon        = excluded.center_lon,
      modis_detections  = excluded.modis_detections,
      viirs_detections  = excluded.viirs_detections,
      total_observations = excluded.total_observations,
      modis_frp_mw_sum  = excluded.modis_frp_mw_sum,
      viirs_frp_mw_sum  = excluded.viirs_frp_mw_sum,
      multi_sensor_cell = excluded.multi_sensor_cell,
      updated_at_utc    = datetime('now')
  `);

  db.exec('BEGIN');
  try {
    for (const b of Object.values(buckets)) {
      const [lat, lon] = h3.cellToLatLng(b.cell);
      const total = b.modis + b.viirs;
      const multiSensor = b.modis > 0 && b.viirs > 0 ? 1 : 0;
      upsert.run(b.date, b.cell, lat, lon, b.modis, b.viirs, total, b.modis_frp, b.viirs_frp, multiSensor);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return Object.keys(buckets).length;
}

module.exports = { aggregateDateRange };
