'use strict';
// routes/health.js
const express = require('express');
const { getDb, databaseFileExists } = require('../db/database');
const settings = require('../config');

const router = express.Router();

router.get('/health', (req, res) => {
  const db = getDb();
  let dbOk = true;
  try { db.prepare('SELECT 1').get(); } catch { dbOk = false; }

  const latestSync = db.prepare('SELECT * FROM sync_runs ORDER BY started_at_utc DESC LIMIT 1').get();

  res.json({
    status: dbOk ? 'ok' : 'degraded',
    time_utc: new Date().toISOString(),
    database: { connected: dbOk, file_exists: databaseFileExists() },
    nasa_firms: { configured: settings.firmsConfigured },
    latest_sync: latestSync ? {
      started_at_utc: latestSync.started_at_utc,
      completed_at_utc: latestSync.completed_at_utc || null,
      status: latestSync.sync_status,
      records_inserted: latestSync.records_inserted,
    } : null,
  });
});

module.exports = router;
