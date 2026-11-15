'use strict';
// db/database.js — uses Node.js v22+ built-in node:sqlite with auto-pruning & 100MB limit
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');
const settings = require('../config');

let _db = null;

function getDb() {
  if (!_db) {
    _db = new DatabaseSync(settings.databaseFilePath);
    // SQLite PRAGMA setup for optimal performance and size control
    _db.exec("PRAGMA journal_mode = WAL");
    _db.exec("PRAGMA foreign_keys = ON");
    _db.exec("PRAGMA busy_timeout = 30000");
    _db.exec("PRAGMA synchronous = NORMAL");
    _db.exec("PRAGMA wal_autocheckpoint = 1000"); // checkpoint automatically every 1000 pages
  }
  return _db;
}

function initDb() {
  const db = getDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS hotspot_observations (
      id                      INTEGER PRIMARY KEY AUTOINCREMENT,
      observation_key         TEXT    NOT NULL UNIQUE,
      source_product          TEXT    NOT NULL,
      sensor                  TEXT    NOT NULL,
      satellite               TEXT,
      instrument              TEXT,
      processing_version      TEXT,
      processing_level        TEXT,
      latitude                REAL    NOT NULL,
      longitude               REAL    NOT NULL,
      h3_cell                 TEXT    NOT NULL,
      acquired_at_utc         TEXT    NOT NULL,
      acquired_date_utc       TEXT    NOT NULL,
      acquired_time_utc       TEXT,
      brightness_primary_k    REAL,
      brightness_secondary_k  REAL,
      primary_brightness_band TEXT,
      secondary_brightness_band TEXT,
      scan                    REAL,
      track                   REAL,
      frp_mw                  REAL,
      confidence_raw          TEXT,
      confidence_class        TEXT,
      daynight                TEXT,
      detection_type          TEXT,
      raw_payload_json        TEXT    NOT NULL,
      ingested_at_utc         TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS ix_hotspot_h3_cell       ON hotspot_observations (h3_cell);
    CREATE INDEX IF NOT EXISTS ix_hotspot_acquired_at   ON hotspot_observations (acquired_at_utc);
    CREATE INDEX IF NOT EXISTS ix_hotspot_acquired_date ON hotspot_observations (acquired_date_utc);
    CREATE INDEX IF NOT EXISTS ix_hotspot_sensor        ON hotspot_observations (sensor);
    CREATE INDEX IF NOT EXISTS ix_hotspot_satellite     ON hotspot_observations (satellite);
    CREATE INDEX IF NOT EXISTS ix_hotspot_lat_lon       ON hotspot_observations (latitude, longitude);
    CREATE INDEX IF NOT EXISTS ix_hotspot_date_sensor   ON hotspot_observations (acquired_date_utc, sensor);

    CREATE TABLE IF NOT EXISTS daily_cell_activity (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      activity_date       TEXT    NOT NULL,
      h3_cell             TEXT    NOT NULL,
      center_lat          REAL    NOT NULL,
      center_lon          REAL    NOT NULL,
      modis_detections    INTEGER NOT NULL DEFAULT 0,
      viirs_detections    INTEGER NOT NULL DEFAULT 0,
      total_observations  INTEGER NOT NULL DEFAULT 0,
      modis_frp_mw_sum    REAL    NOT NULL DEFAULT 0.0,
      viirs_frp_mw_sum    REAL    NOT NULL DEFAULT 0.0,
      multi_sensor_cell   INTEGER NOT NULL DEFAULT 0,
      updated_at_utc      TEXT    NOT NULL DEFAULT (datetime('now')),
      UNIQUE (activity_date, h3_cell)
    );
    CREATE INDEX IF NOT EXISTS ix_daily_activity_date ON daily_cell_activity (activity_date);
    CREATE INDEX IF NOT EXISTS ix_daily_activity_cell ON daily_cell_activity (h3_cell);

    CREATE TABLE IF NOT EXISTS sync_runs (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      sources            TEXT    NOT NULL,
      west               REAL    NOT NULL,
      south              REAL    NOT NULL,
      east               REAL    NOT NULL,
      north              REAL    NOT NULL,
      start_date         TEXT,
      end_date           TEXT,
      records_fetched    INTEGER NOT NULL DEFAULT 0,
      records_inserted   INTEGER NOT NULL DEFAULT 0,
      records_updated    INTEGER NOT NULL DEFAULT 0,
      sync_status        TEXT    NOT NULL DEFAULT 'pending',
      error_message      TEXT,
      started_at_utc     TEXT    NOT NULL DEFAULT (datetime('now')),
      completed_at_utc   TEXT
    );
    CREATE INDEX IF NOT EXISTS ix_sync_runs_started ON sync_runs (started_at_utc);

    CREATE TABLE IF NOT EXISTS dataset_availability_cache (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      source_product   TEXT NOT NULL UNIQUE,
      min_date         TEXT,
      max_date         TEXT,
      checked_at_utc   TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  console.log(`[DB] Database initialized at ${settings.databaseFilePath}`);

  // Initial check on database size upon startup
  checkAndPruneDatabase();

  // Periodic automatic size check every 15 minutes
  setInterval(() => {
    checkAndPruneDatabase();
  }, 15 * 60 * 1000).unref(); // unref so it does not keep process alive unnecessarily
}

/**
 * Calculate total disk space consumed by SQLite database + WAL + SHM files.
 */
function getDatabaseDiskSizeBytes() {
  const basePath = settings.databaseFilePath;
  let totalBytes = 0;

  const filesToCheck = [
    basePath,
    `${basePath}-wal`,
    `${basePath}-shm`
  ];

  for (const filePath of filesToCheck) {
    try {
      if (fs.existsSync(filePath)) {
        const stat = fs.statSync(filePath);
        totalBytes += stat.size;
      }
    } catch (err) {
      // Ignore if file was concurrently removed
    }
  }

  return totalBytes;
}

/**
 * Get comprehensive database storage statistics.
 */
function getDbStats() {
  const db = getDb();
  const diskSizeBytes = getDatabaseDiskSizeBytes();
  const diskSizeMb = Math.round((diskSizeBytes / (1024 * 1024)) * 100) / 100;
  const maxMb = settings.maxDbSizeMb;
  const usedPercent = Math.min(100, Math.round((diskSizeMb / maxMb) * 100));

  let totalObservations = 0;
  let totalDailyCells = 0;
  let totalSyncRuns = 0;
  let oldestDate = null;
  let newestDate = null;

  try {
    totalObservations = db.prepare('SELECT COUNT(id) as n FROM hotspot_observations').get().n;
    totalDailyCells = db.prepare('SELECT COUNT(id) as n FROM daily_cell_activity').get().n;
    totalSyncRuns = db.prepare('SELECT COUNT(id) as n FROM sync_runs').get().n;

    const dateRange = db.prepare('SELECT MIN(acquired_date_utc) as oldest, MAX(acquired_date_utc) as newest FROM hotspot_observations').get();
    if (dateRange) {
      oldestDate = dateRange.oldest;
      newestDate = dateRange.newest;
    }
  } catch (err) {
    console.error('[DB Stats Error]', err);
  }

  return {
    database_path: settings.databaseFilePath,
    disk_size_bytes: diskSizeBytes,
    disk_size_mb: diskSizeMb,
    max_size_mb: maxMb,
    prune_target_mb: settings.dbPruneTargetMb,
    used_percent: usedPercent,
    records: {
      hotspots: totalObservations,
      daily_cells: totalDailyCells,
      sync_runs: totalSyncRuns,
    },
    date_coverage: {
      oldest_acquired_date: oldestDate,
      newest_acquired_date: newestDate,
    },
    auto_prune_active: true,
  };
}

/**
 * Prune oldest data until database disk size is below target MB.
 * Guarantees that SQL does not blow past the max limit (100MB).
 */
function pruneDatabase(targetMb = settings.dbPruneTargetMb) {
  const db = getDb();
  let currentBytes = getDatabaseDiskSizeBytes();
  const targetBytes = targetMb * 1024 * 1024;

  if (currentBytes <= targetBytes) {
    return { pruned: false, message: 'Database size is within safe threshold.', stats: getDbStats() };
  }

  console.warn(`[DB Prune] Current size (${(currentBytes / 1024 / 1024).toFixed(2)} MB) exceeds target (${targetMb} MB). Initiating auto-pruning...`);

  let totalObservationsDeleted = 0;
  let totalCellsDeleted = 0;
  let iterations = 0;
  const maxIterations = 50; // safeguard

  while (currentBytes > targetBytes && iterations < maxIterations) {
    iterations++;

    // Find the oldest acquired date in the database
    const oldestRow = db.prepare(`
      SELECT acquired_date_utc, COUNT(id) as cnt
      FROM hotspot_observations
      GROUP BY acquired_date_utc
      ORDER BY acquired_date_utc ASC
      LIMIT 1
    `).get();

    if (!oldestRow) {
      // No more observations to delete
      break;
    }

    const oldestDate = oldestRow.acquired_date_utc;
    console.log(`[DB Prune] Removing oldest date: ${oldestDate} (${oldestRow.cnt} hotspots)`);

    db.exec('BEGIN');
    try {
      db.prepare('DELETE FROM hotspot_observations WHERE acquired_date_utc = ?').run(oldestDate);
      db.prepare('DELETE FROM daily_cell_activity WHERE activity_date = ?').run(oldestDate);
      // Clean up sync runs older than 14 days
      db.prepare("DELETE FROM sync_runs WHERE started_at_utc < datetime('now', '-14 days')").run();
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      console.error('[DB Prune] Failed during batch delete:', err);
      break;
    }

    totalObservationsDeleted += oldestRow.cnt;

    // Checkpoint WAL and VACUUM to reclaim actual disk space
    try {
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      db.exec('VACUUM');
    } catch (vacuumErr) {
      console.error('[DB Prune] Vacuum warning:', vacuumErr.message);
    }

    currentBytes = getDatabaseDiskSizeBytes();
    console.log(`[DB Prune] Post-vacuum size: ${(currentBytes / 1024 / 1024).toFixed(2)} MB`);
  }

  const finalStats = getDbStats();
  console.log(`[DB Prune Complete] Deleted ${totalObservationsDeleted} hotspots across ${iterations} dates. Final size: ${finalStats.disk_size_mb} MB.`);

  return {
    pruned: true,
    observations_deleted: totalObservationsDeleted,
    final_size_mb: finalStats.disk_size_mb,
    stats: finalStats,
  };
}

/**
 * Check size and automatically trigger prune if over limit.
 */
function checkAndPruneDatabase() {
  try {
    const currentBytes = getDatabaseDiskSizeBytes();
    const maxBytes = settings.maxDbSizeMb * 1024 * 1024;

    if (currentBytes > maxBytes) {
      console.warn(`[DB Size Alert] Database size ${(currentBytes / 1024 / 1024).toFixed(2)} MB exceeds limit ${settings.maxDbSizeMb} MB!`);
      return pruneDatabase(settings.dbPruneTargetMb);
    }
  } catch (err) {
    console.error('[DB Auto-Prune Check Error]', err);
  }
  return { pruned: false };
}

function databaseFileExists() {
  return fs.existsSync(settings.databaseFilePath);
}

module.exports = {
  getDb,
  initDb,
  databaseFileExists,
  getDatabaseDiskSizeBytes,
  getDbStats,
  pruneDatabase,
  checkAndPruneDatabase,
};
