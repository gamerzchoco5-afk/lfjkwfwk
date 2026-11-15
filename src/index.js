'use strict';
// src/index.js — GetFire API Entry point with AI and Multi-Sensor Harmonization
const express = require('express');
const cors = require('cors');
const { initDb } = require('./db/database');
const settings = require('./config');

// Routes
const healthRouter    = require('./routes/health');
const datasetsRouter  = require('./routes/datasets');
const hotspotsRouter  = require('./routes/hotspots');
const calendarRouter  = require('./routes/calendar');
const analyticsRouter = require('./routes/analytics');
const adminRouter     = require('./routes/admin');
const aiRouter        = require('./routes/ai');

// Initialize database & size safeguard on startup
initDb();

const app = express();

// CORS — permissive for all origins so any UI/web client can connect
app.use(cors({
  origin: true,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH', 'HEAD'],
  allowedHeaders: ['*'],
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Root overview
app.get('/', (req, res) => {
  res.json({
    name: 'GetFire API',
    tagline: 'NASA FIRMS active-fire multi-sensor harmonization & orbital AI intelligence',
    health: '/health',
    endpoints: {
      hotspots: '/api/v1/hotspots',
      sync: '/api/v1/sync',
      calendar: '/api/v1/calendar',
      analytics: {
        trend: '/api/v1/analytics/trend',
        anomaly: '/api/v1/analytics/anomaly',
        sensor_comparison: '/api/v1/analytics/sensor-comparison',
        intensity: '/api/v1/analytics/intensity',
        telemetry_breakdown: '/api/v1/analytics/telemetry-breakdown',
      },
      ai: {
        chat: '/api/v1/ai/chat',
        briefing: '/api/v1/ai/briefing',
        clusters: '/api/v1/ai/clusters',
        predict: '/api/v1/ai/predict',
      },
      system: {
        db_stats: '/api/v1/system/db-stats',
        prune: '/api/v1/system/prune',
      }
    },
    database_limit_mb: settings.maxDbSizeMb,
  });
});

// Mount routers
app.use(healthRouter);
app.use(datasetsRouter);
app.use(hotspotsRouter);
app.use(calendarRouter);
app.use(analyticsRouter);
app.use(adminRouter);
app.use(aiRouter);

// Global 404 handler returning JSON (never HTML)
app.use((req, res) => {
  res.status(404).json({ detail: `Not found: ${req.method} ${req.url}` });
});

// Global error handler returning JSON (never HTML)
app.use((err, req, res, next) => {
  console.error('[GetFire Error]', err);
  res.status(500).json({ detail: err.message || 'Internal server error.' });
});

app.listen(settings.port, () => {
  console.log(`[GetFire] Server running on http://localhost:${settings.port}`);
  console.log(`[GetFire] NASA FIRMS live feed: ${settings.firmsConfigured ? 'FIRMS AREA API CONNECTED' : 'NASA EOSDIS REAL-TIME 24H OPEN FEED (MODIS C6.1 + VIIRS C2)'}`);
  console.log(`[GetFire] AI Intelligence: ${settings.aiConfigured ? 'GEMINI ACTIVE' : 'LOCAL NASA HEURISTIC ENGINE'}`);
  console.log(`[GetFire] Database Max Size Cap: ${settings.maxDbSizeMb} MB (Auto-pruning active)`);
});

module.exports = app;
