'use strict';
// routes/analytics.js — Comprehensive NASA Orbital Analytics Endpoints
const express = require('express');
const { getDb } = require('../db/database');
const {
  computeTrend,
  computeAnomaly,
  computeSensorComparison,
  computeIntensityDistribution,
} = require('../services/analytics');

const router = express.Router();

router.get(['/api/v1/analytics/trend', '/analytics/trend'], (req, res) => {
  const {
    west = -180,
    south = -90,
    east = 180,
    north = 90,
    start_date = '2026-10-15',
    end_date = new Date().toISOString().slice(0, 10),
    sensor,
    group_by = 'day',
  } = req.query;

  const w = parseFloat(west), s = parseFloat(south), e = parseFloat(east), n = parseFloat(north);

  let points = computeTrend(w, s, e, n, start_date, end_date, group_by);

  if (sensor && ['MODIS', 'VIIRS'].includes(sensor.toUpperCase())) {
    const key = sensor.toLowerCase();
    points = points.map(p => ({
      ...p,
      modis_detections: key === 'modis' ? p.modis_detections : 0,
      viirs_detections: key === 'viirs' ? p.viirs_detections : 0,
      total_observations: key === 'modis' ? p.modis_detections : p.viirs_detections,
    }));
  }

  res.json({
    west: w, south: s, east: e, north: n,
    start_date, end_date, group_by,
    sensor_filter: sensor || null,
    points,
  });
});

router.get(['/api/v1/analytics/anomaly', '/analytics/anomaly'], (req, res) => {
  const {
    west = -180,
    south = -90,
    east = 180,
    north = 90,
    target_date = new Date().toISOString().slice(0, 10),
  } = req.query;

  const w = parseFloat(west), s = parseFloat(south), e = parseFloat(east), n = parseFloat(north);
  const anomaly = computeAnomaly(w, s, e, n, target_date);

  res.json({
    current_value: anomaly.observed_total,
    historical_average: anomaly.baseline_median,
    robust_z_score: anomaly.robust_z_score,
    anomaly_status: anomaly.anomaly_status,
    detail: anomaly,
  });
});

router.get(['/api/v1/analytics/sensor-comparison', '/analytics/sensor-comparison'], (req, res) => {
  const {
    west = -180,
    south = -90,
    east = 180,
    north = 90,
  } = req.query;

  const w = parseFloat(west), s = parseFloat(south), e = parseFloat(east), n = parseFloat(north);
  const comparison = computeSensorComparison(w, s, e, n);

  res.json(comparison);
});

router.get(['/api/v1/analytics/intensity', '/analytics/intensity'], (req, res) => {
  const {
    west = -180,
    south = -90,
    east = 180,
    north = 90,
  } = req.query;

  const w = parseFloat(west), s = parseFloat(south), e = parseFloat(east), n = parseFloat(north);
  const intensity = computeIntensityDistribution(w, s, e, n);

  res.json(intensity);
});

/**
 * GET /api/v1/analytics/telemetry-breakdown
 * Returns 24-hour UTC orbital pass distribution, latitude zone distribution,
 * and satellite breakdown directly from real database observations.
 */
router.get(['/api/v1/analytics/telemetry-breakdown', '/analytics/telemetry-breakdown'], (req, res) => {
  const { west = -180, south = -90, east = 180, north = 90 } = req.query;
  const w = parseFloat(west), s = parseFloat(south), e = parseFloat(east), n = parseFloat(north);

  const db = getDb();
  const rows = db.prepare(`
    SELECT sensor, satellite, latitude, longitude, acquired_at_utc, frp_mw, brightness_primary_k, daynight
    FROM hotspot_observations
    WHERE longitude >= ? AND longitude <= ? AND latitude >= ? AND latitude <= ?
  `).all(w, e, s, n);

  const hourly = Array.from({ length: 24 }, (_, h) => ({
    hour: `${String(h).padStart(2, '0')}:00`,
    modis: 0,
    viirs: 0,
    total_frp: 0,
  }));

  const latZones = [
    { zone: 'Boreal / High North (>45°N)', count: 0, frp: 0 },
    { zone: 'Temperate North (23.5°N – 45°N)', count: 0, frp: 0 },
    { zone: 'Tropics (-23.5°S – 23.5°N)', count: 0, frp: 0 },
    { zone: 'Southern Hemisphere (<-23.5°S)', count: 0, frp: 0 },
  ];

  const satellites = {};

  for (const r of rows) {
    const frp = r.frp_mw || 0;
    const hr = r.acquired_at_utc ? parseInt(r.acquired_at_utc.slice(11, 13), 10) : 0;
    if (!isNaN(hr) && hr >= 0 && hr < 24) {
      if (r.sensor === 'MODIS') hourly[hr].modis++;
      else hourly[hr].viirs++;
      hourly[hr].total_frp = Math.round((hourly[hr].total_frp + frp) * 10) / 10;
    }

    const lat = r.latitude;
    if (lat > 45) { latZones[0].count++; latZones[0].frp += frp; }
    else if (lat >= 23.5) { latZones[1].count++; latZones[1].frp += frp; }
    else if (lat >= -23.5) { latZones[2].count++; latZones[2].frp += frp; }
    else { latZones[3].count++; latZones[3].frp += frp; }

    const satKey = r.satellite || r.sensor;
    if (!satellites[satKey]) satellites[satKey] = { satellite: satKey, sensor: r.sensor, count: 0, total_frp: 0 };
    satellites[satKey].count++;
    satellites[satKey].total_frp += frp;
  }

  res.json({
    total_analyzed: rows.length,
    hourly,
    lat_zones: latZones.map(z => ({ ...z, frp: Math.round(z.frp * 10) / 10 })),
    satellites: Object.values(satellites).map(s => ({ ...s, total_frp: Math.round(s.total_frp * 10) / 10 })),
  });
});

module.exports = router;
