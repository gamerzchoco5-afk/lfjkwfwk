'use strict';
// routes/ai.js — NASA Hackathon AI Endpoints (Stateless, no DB storage for chat messages)
const express = require('express');
const { processAiChat, generateIncidentBriefing, clusterHotspots } = require('../services/aiService');
const { getDb } = require('../db/database');

const router = express.Router();

/**
 * POST /api/v1/ai/chat
 * Stateless AI Assistant endpoint — does NOT persist messages to SQL DB.
 * Direct forwarding to AI engine / Gemini API.
 */
router.post(['/api/v1/ai/chat', '/ai/chat'], async (req, res) => {
  const { message, context = {} } = req.body;

  if (!message || typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ detail: 'A non-empty string message is required.' });
  }

  try {
    const result = await processAiChat(message.trim(), context);
    return res.json(result);
  } catch (err) {
    console.error('[AI Chat Error]', err);
    return res.status(500).json({ detail: 'AI analysis encountered a temporary error: ' + err.message });
  }
});

/**
 * POST /api/v1/ai/briefing
 * Automated NASA Incident Commander situation report.
 */
router.post(['/api/v1/ai/briefing', '/ai/briefing'], async (req, res) => {
  const { west = -180, south = -90, east = 180, north = 90 } = req.body || {};
  const w = parseFloat(west), s = parseFloat(south), e = parseFloat(east), n = parseFloat(north);

  try {
    const briefing = await generateIncidentBriefing(w, s, e, n);
    return res.json(briefing);
  } catch (err) {
    console.error('[AI Briefing Error]', err);
    return res.status(500).json({ detail: err.message });
  }
});

/**
 * GET /api/v1/ai/clusters
 * Identifies unified Wildfire Complexes from scattered hotspot points.
 */
router.get(['/api/v1/ai/clusters', '/ai/clusters'], (req, res) => {
  const { west = -180, south = -90, east = 180, north = 90, date } = req.query;
  const w = parseFloat(west), s = parseFloat(south), e = parseFloat(east), n = parseFloat(north);

  const db = getDb();
  let query = 'SELECT * FROM hotspot_observations WHERE longitude >= ? AND longitude <= ? AND latitude >= ? AND latitude <= ?';
  const params = [w, e, s, n];

  if (date) {
    query += ' AND acquired_date_utc = ?';
    params.push(date);
  }

  query += ' ORDER BY frp_mw DESC LIMIT 500';

  const rows = db.prepare(query).all(...params);
  const clusters = clusterHotspots(rows);

  return res.json({
    total_observations_analyzed: rows.length,
    clusters_detected: clusters.length,
    clusters,
  });
});

/**
 * POST /api/v1/ai/predict
 * Wildfire Spread & Threat Risk Score.
 */
router.post(['/api/v1/ai/predict', '/ai/predict'], (req, res) => {
  const { hotspot_count = 0, peak_frp = 0, average_frp = 0, multi_sensor_ratio = 0.5, night_detections = 0 } = req.body || {};

  // Heuristic wildfire risk index (0 - 100)
  let riskScore = 20;

  // Peak FRP weight
  if (peak_frp > 150) riskScore += 35;
  else if (peak_frp > 50) riskScore += 20;
  else if (peak_frp > 20) riskScore += 10;

  // Active count weight
  if (hotspot_count > 100) riskScore += 25;
  else if (hotspot_count > 30) riskScore += 15;
  else if (hotspot_count > 5) riskScore += 8;

  // Night-time persistence indicates high fuel load and lack of self-extinguishment
  if (night_detections > 5) riskScore += 15;

  riskScore = Math.min(99, Math.max(10, Math.round(riskScore)));

  let riskTier = 'Low';
  if (riskScore >= 80) riskTier = 'Extreme';
  else if (riskScore >= 60) riskTier = 'High';
  else if (riskScore >= 40) riskTier = 'Moderate';

  return res.json({
    spread_risk_score: riskScore,
    risk_tier: riskTier,
    spread_velocity_estimate: riskScore > 75 ? 'Rapid (1.5 - 3.0 km/h)' : (riskScore > 50 ? 'Moderate (0.5 - 1.5 km/h)' : 'Slow (< 0.5 km/h)'),
    primary_threat_vector: night_detections > 5 ? 'High fuel density & overnight flame front persistence' : 'Direct thermal radiation & ember spot fires',
    containment_difficulty: riskScore > 75 ? 'Severe — Aerial and heavy machinery response mandatory' : 'Standard ground suppression feasible',
    recommended_safety_radius_km: riskScore > 75 ? 15 : (riskScore > 50 ? 8 : 3),
  });
});

module.exports = router;
