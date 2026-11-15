'use strict';
// routes/datasets.js
const express = require('express');
const { getDb } = require('../db/database');

const router = express.Router();

router.get('/api/v1/datasets', (req, res) => {
  const db = getDb();
  const rows = db.prepare(`
    SELECT source_product, sensor, processing_level,
           MIN(acquired_date_utc) as min_date,
           MAX(acquired_date_utc) as max_date,
           COUNT(id) as observation_count
    FROM hotspot_observations
    GROUP BY source_product, sensor, processing_level
  `).all();

  const latestSync = db.prepare('SELECT started_at_utc FROM sync_runs ORDER BY started_at_utc DESC LIMIT 1').get();

  res.json({
    datasets: rows,
    latest_synchronization: latestSync ? latestSync.started_at_utc : null,
  });
});

router.get('/api/v1/summary', (req, res) => {
  const db = getDb();
  const total = db.prepare('SELECT COUNT(id) as n FROM hotspot_observations').get().n;
  const modisCount = db.prepare("SELECT COUNT(id) as n FROM hotspot_observations WHERE sensor='MODIS'").get().n;
  const viirsCount = db.prepare("SELECT COUNT(id) as n FROM hotspot_observations WHERE sensor='VIIRS'").get().n;
  const activeCells = db.prepare('SELECT COUNT(DISTINCT h3_cell) as n FROM daily_cell_activity').get().n;
  const modisFrep = db.prepare("SELECT COALESCE(SUM(frp_mw),0.0) as s FROM hotspot_observations WHERE sensor='MODIS'").get().s;
  const viirsFrep = db.prepare("SELECT COALESCE(SUM(frp_mw),0.0) as s FROM hotspot_observations WHERE sensor='VIIRS'").get().s;
  const latestObs = db.prepare('SELECT MAX(acquired_at_utc) as m FROM hotspot_observations').get().m;
  const latestSync = db.prepare('SELECT * FROM sync_runs ORDER BY started_at_utc DESC LIMIT 1').get();

  res.json({
    total_observations: total,
    modis_observations: modisCount,
    viirs_observations: viirsCount,
    active_h3_cells: activeCells,
    modis_frp_mw_total: Math.round(modisFrep * 100) / 100,
    viirs_frp_mw_total: Math.round(viirsFrep * 100) / 100,
    latest_observation_time_utc: latestObs || null,
    latest_successful_sync_utc: (latestSync && latestSync.completed_at_utc && latestSync.sync_status === 'success') ? latestSync.completed_at_utc : null,
    dataset_freshness_note: 'Statistics reflect data currently stored in the local database, updated via /api/v1/admin/sync.',
  });
});

module.exports = router;
