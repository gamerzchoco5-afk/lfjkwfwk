'use strict';
// config.js — Centralized Environment Configuration for all APIs & DB limits
require('dotenv').config();
const path = require('path');
const fs = require('fs');

const settings = {
  // NASA FIRMS Authenticated API
  firmsMapKey: process.env.FIRMS_MAP_KEY || '',
  firmsAreaBaseUrl: process.env.FIRMS_AREA_BASE_URL || 'https://firms.modaps.eosdis.nasa.gov/api/area/csv',
  firmsAvailabilityUrl: process.env.FIRMS_AVAILABILITY_URL || 'https://firms.modaps.eosdis.nasa.gov/api/data_availability/csv',
  nasaRequestTimeout: parseInt(process.env.NASA_REQUEST_TIMEOUT || '35', 10) * 1000,

  // NASA EOSDIS Public Open Feeds (Configurable via .env)
  nasaOpenFeedModis: process.env.NASA_OPEN_FEED_MODIS || 'https://firms.modaps.eosdis.nasa.gov/data/active_fire/modis-c6.1/csv/MODIS_C6_1_Global_24h.csv',
  nasaOpenFeedViirsNoaa20: process.env.NASA_OPEN_FEED_VIIRS_NOAA20 || 'https://firms.modaps.eosdis.nasa.gov/data/active_fire/noaa-20-viirs-c2/csv/J1_VIIRS_C2_Global_24h.csv',
  nasaOpenFeedViirsSnpp: process.env.NASA_OPEN_FEED_VIIRS_SNPP || 'https://firms.modaps.eosdis.nasa.gov/data/active_fire/suomi-npp-viirs-c2/csv/SUOMI_VIIRS_C2_Global_24h.csv',
  nasaOpenFeedViirsNoaa21: process.env.NASA_OPEN_FEED_VIIRS_NOAA21 || 'https://firms.modaps.eosdis.nasa.gov/data/active_fire/noaa-21-viirs-c2/csv/J2_VIIRS_C2_Global_24h.csv',
  nasaCacheTtlMinutes: parseInt(process.env.NASA_CACHE_TTL_MINUTES || '25', 10),
  maxRowsPerSourceSync: parseInt(process.env.MAX_ROWS_PER_SOURCE_SYNC || '2500', 10),

  // Database & 100MB Auto-Pruning Configuration
  databasePath: process.env.DATABASE_PATH || './data/getfire.db',
  maxDbSizeMb: parseInt(process.env.MAX_DB_SIZE_MB || '100', 10),
  dbPruneTargetMb: parseInt(process.env.DB_PRUNE_TARGET_MB || '80', 10),
  dbRetentionDays: parseInt(process.env.DB_RETENTION_DAYS || '14', 10),

  // Server & Security
  adminSyncToken: process.env.ADMIN_SYNC_TOKEN || '',
  corsOrigins: process.env.CORS_ORIGINS || 'http://localhost:5173,http://localhost:3000,http://127.0.0.1:5173',
  h3Resolution: parseInt(process.env.H3_RESOLUTION || '8', 10),
  maxHotspotLimit: parseInt(process.env.MAX_HOTSPOT_LIMIT || '5000', 10),
  port: parseInt(process.env.PORT || '3000', 10),

  // AI Integration (Google Gemini / OpenAI-compatible API)
  geminiApiKey: process.env.GEMINI_API_KEY || process.env.AI_API_KEY || '',
  geminiApiBaseUrl: process.env.GEMINI_API_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta/models',
  aiModel: process.env.AI_MODEL || 'gemini-2.5-flash',

  get corsOriginList() {
    return this.corsOrigins.split(',').map(o => o.trim()).filter(Boolean);
  },
  get databaseFilePath() {
    return path.resolve(this.databasePath);
  },
  get firmsConfigured() {
    return Boolean(this.firmsMapKey && this.firmsMapKey !== 'YOUR_NASA_MAP_KEY_HERE');
  },
  get adminTokenConfigured() {
    return Boolean(this.adminSyncToken);
  },
  get aiConfigured() {
    return Boolean(this.geminiApiKey);
  },
};

const dbDir = path.dirname(settings.databaseFilePath);
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

module.exports = settings;
