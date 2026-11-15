'use strict';
// routes/admin.js — seamless sync endpoints (no forced admin token required)
const express = require('express');
const crypto = require('crypto');
const { getDb, getDbStats, pruneDatabase } = require('../db/database');
const { runSync, SyncAlreadyRunningError } = require('../services/ingestion');
const { ALL_SOURCES, DEFAULT_SOURCES } = require('../services/firmsClient');
const settings = require('../config');

const router = express.Router();

// Optional Admin token middleware: validates if provided, but DOES NOT block users if omitted!
function optionalAdminToken(req, res, next) {
  const token = req.headers['x-admin-token'];
  // If admin token is configured and user supplied one, verify it
  if (settings.adminTokenConfigured && token) {
    const tokenBuf = Buffer.from(token);
    const expectedBuf = Buffer.from(settings.adminSyncToken);
    if (tokenBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(tokenBuf, expectedBuf)) {
      return res.status(401).json({ detail: 'Invalid X-Admin-Token provided.' });
    }
  }
  // Otherwise proceed seamlessly without requiring friction
  next();
}

/**
 * Handle sync execution for both /api/v1/admin/sync and /api/v1/sync
 */
async function handleSyncRequest(req, res) {
  let { west, south, east, north, start_date, end_date, sources, days } = req.body || {};

  // If query params are used instead of body
  if (west === undefined && req.query.west !== undefined) {
    west = req.query.west;
    south = req.query.south;
    east = req.query.east;
    north = req.query.north;
    start_date = req.query.start_date;
    end_date = req.query.end_date;
    sources = req.query.sources ? req.query.sources.split(',') : undefined;
    days = req.query.days;
  }

  // Default to both MODIS and VIIRS if sources not specified
  if (!Array.isArray(sources) || sources.length === 0) {
    sources = DEFAULT_SOURCES;
  }

  const invalid = sources.filter(s => !ALL_SOURCES.has(s));
  if (invalid.length) {
    return res.status(400).json({ detail: `Unsupported source product(s): ${JSON.stringify(invalid)}` });
  }

  // Default bounding box if omitted (Global coverage)
  const w = parseFloat(west !== undefined ? west : -180);
  const s = parseFloat(south !== undefined ? south : -90);
  const e = parseFloat(east !== undefined ? east : 180);
  const n = parseFloat(north !== undefined ? north : 90);

  if (!(-180 <= w && w < e && e <= 180 && -90 <= s && s < n && n <= 90)) {
    return res.status(400).json({ detail: 'Invalid bounding box: require -180 <= west < east <= 180 and -90 <= south < north <= 90.' });
  }

  if (Boolean(start_date) !== Boolean(end_date)) {
    return res.status(400).json({ detail: 'start_date and end_date must be provided together.' });
  }

  try {
    const syncRun = await runSync({
      sources,
      west: w,
      south: s,
      east: e,
      north: n,
      startDate: start_date || null,
      endDate: end_date || null
    });

    return res.json({
      sync_run_id: syncRun.id,
      status: syncRun.sync_status,
      sources,
      bbox: { west: w, south: s, east: e, north: n },
      records_fetched: syncRun.records_fetched,
      records_inserted: syncRun.records_inserted,
      records_updated: syncRun.records_updated,
      error_message: syncRun.error_message || null,
      started_at_utc: syncRun.started_at_utc,
      completed_at_utc: syncRun.completed_at_utc || null,
    });
  } catch (err) {
    if (err instanceof SyncAlreadyRunningError) {
      return res.status(409).json({ detail: err.message });
    }
    throw err;
  }
}

// User-friendly direct sync endpoints (NO admin token required)
router.post('/api/v1/sync', optionalAdminToken, handleSyncRequest);
router.get('/api/v1/sync', optionalAdminToken, handleSyncRequest);
router.get('/api/v1/sync/quick', optionalAdminToken, handleSyncRequest);

// Backwards-compatible admin sync endpoint
router.post('/api/v1/admin/sync', optionalAdminToken, handleSyncRequest);

// System database statistics endpoint (monitor 100MB threshold)
router.get('/api/v1/system/db-stats', (req, res) => {
  const stats = getDbStats();
  res.json(stats);
});

// Manual database prune endpoint
router.post('/api/v1/system/prune', optionalAdminToken, (req, res) => {
  const targetMb = parseInt(req.body?.target_mb || settings.dbPruneTargetMb, 10);
  const result = pruneDatabase(targetMb);
  res.json(result);
});

module.exports = router;
