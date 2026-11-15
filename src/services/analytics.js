'use strict';
// services/analytics.js — analytics calculations for trends, anomalies, and multi-sensor comparison
const { getDb } = require('../db/database');

const MIN_HISTORY_DAYS = 30;

function dailyTotalsInBbox(west, south, east, north, startDate, endDate) {
  const db = getDb();
  const rows = db.prepare(`
    SELECT activity_date, h3_cell, modis_detections, viirs_detections, modis_frp_mw_sum, viirs_frp_mw_sum
    FROM daily_cell_activity
    WHERE activity_date >= ? AND activity_date <= ?
      AND center_lon >= ? AND center_lon <= ?
      AND center_lat >= ? AND center_lat <= ?
  `).all(startDate, endDate, west, east, south, north);

  const out = {};
  for (const row of rows) {
    const d = row.activity_date;
    if (!out[d]) out[d] = { modis: 0, viirs: 0, modis_frp: 0.0, viirs_frp: 0.0, cells: new Set() };
    out[d].modis += row.modis_detections;
    out[d].viirs += row.viirs_detections;
    out[d].modis_frp += row.modis_frp_mw_sum;
    out[d].viirs_frp += row.viirs_frp_mw_sum;
    out[d].cells.add(row.h3_cell);
  }
  return out;
}

function bucketKey(dateStr, groupBy) {
  const d = new Date(dateStr + 'T00:00:00Z');
  if (groupBy === 'day') return dateStr;
  if (groupBy === 'week') {
    const day = d.getUTCDay(); // 0=Sun
    const monday = new Date(d);
    monday.setUTCDate(d.getUTCDate() - ((day + 6) % 7));
    return monday.toISOString().slice(0, 10);
  }
  if (groupBy === 'month') {
    return dateStr.slice(0, 7) + '-01';
  }
  throw new Error('groupBy must be one of: day, week, month');
}

function computeTrend(west, south, east, north, startDate, endDate, groupBy = 'day') {
  const daily = dailyTotalsInBbox(west, south, east, north, startDate, endDate);

  const grouped = {};
  for (const [dateStr, bucket] of Object.entries(daily)) {
    const key = bucketKey(dateStr, groupBy);
    if (!grouped[key]) grouped[key] = { modis: 0, viirs: 0, modis_frp: 0.0, viirs_frp: 0.0, cells: new Set() };
    const g = grouped[key];
    g.modis += bucket.modis;
    g.viirs += bucket.viirs;
    g.modis_frp += bucket.modis_frp;
    g.viirs_frp += bucket.viirs_frp;
    for (const c of bucket.cells) g.cells.add(c);
  }

  return Object.keys(grouped).sort().map(periodStart => {
    const g = grouped[periodStart];
    return {
      period_start: periodStart,
      modis_detections: g.modis,
      viirs_detections: g.viirs,
      total_observations: g.modis + g.viirs,
      modis_frp_mw: Math.round(g.modis_frp * 100) / 100,
      viirs_frp_mw: Math.round(g.viirs_frp * 100) / 100,
      active_h3_cells: g.cells.size,
    };
  });
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function computeAnomaly(west, south, east, north, targetDate) {
  const target = new Date(targetDate + 'T00:00:00Z');
  const historyStart = new Date(target);
  historyStart.setUTCDate(target.getUTCDate() - MIN_HISTORY_DAYS);
  const historyEnd = new Date(target);
  historyEnd.setUTCDate(target.getUTCDate() - 1);

  const daily = dailyTotalsInBbox(west, south, east, north, historyStart.toISOString().slice(0, 10), historyEnd.toISOString().slice(0, 10));
  const targetDaily = dailyTotalsInBbox(west, south, east, north, targetDate, targetDate);

  const historyValues = Object.values(daily).map(b => b.modis + b.viirs);
  const observedTotal = targetDaily[targetDate] ? targetDaily[targetDate].modis + targetDaily[targetDate].viirs : 0;

  if (historyValues.length < MIN_HISTORY_DAYS) {
    const partialMed = historyValues.length ? median(historyValues) : observedTotal;
    return {
      date: targetDate,
      h3_cell: null,
      observed_total: observedTotal,
      baseline_median: partialMed,
      baseline_mad: null,
      robust_z_score: null,
      anomaly_status: 'insufficient_history',
      history_days_used: historyValues.length,
    };
  }

  const med = median(historyValues);
  const absDevs = historyValues.map(v => Math.abs(v - med));
  const mad = median(absDevs);

  let robustZ;
  if (mad === 0) {
    robustZ = observedTotal === med ? 0.0 : observedTotal > med ? Infinity : -Infinity;
  } else {
    robustZ = 0.6745 * (observedTotal - med) / mad;
  }

  let status;
  if (robustZ === Infinity || robustZ > 3.5) status = 'unusual_high';
  else if (robustZ === -Infinity || robustZ < -3.5) status = 'unusual_low';
  else status = 'normal';

  return {
    date: targetDate,
    h3_cell: null,
    observed_total: observedTotal,
    baseline_median: med,
    baseline_mad: mad,
    robust_z_score: isFinite(robustZ) ? Math.round(robustZ * 1000) / 1000 : null,
    anomaly_status: status,
    history_days_used: historyValues.length,
  };
}

/**
 * MODIS vs VIIRS Multi-Sensor Comparison
 */
function computeSensorComparison(west, south, east, north) {
  const db = getDb();
  const rows = db.prepare(`
    SELECT sensor, satellite, daynight, frp_mw, confidence_class, h3_cell
    FROM hotspot_observations
    WHERE longitude >= ? AND longitude <= ? AND latitude >= ? AND latitude <= ?
  `).all(west, east, south, north);

  const modis = rows.filter(r => r.sensor === 'MODIS');
  const viirs = rows.filter(r => r.sensor === 'VIIRS');

  const modisCells = new Set(modis.map(r => r.h3_cell));
  const viirsCells = new Set(viirs.map(r => r.h3_cell));

  let overlapCellCount = 0;
  for (const c of modisCells) {
    if (viirsCells.has(c)) overlapCellCount++;
  }

  const modisFrpTotal = modis.reduce((s, r) => s + (r.frp_mw || 0), 0);
  const viirsFrpTotal = viirs.reduce((s, r) => s + (r.frp_mw || 0), 0);

  const modisAvgFrp = modis.length ? Math.round((modisFrpTotal / modis.length) * 10) / 10 : 0;
  const viirsAvgFrp = viirs.length ? Math.round((viirsFrpTotal / viirs.length) * 10) / 10 : 0;

  const totalCells = new Set([...modisCells, ...viirsCells]).size;
  const crossValidationRate = totalCells ? Math.round((overlapCellCount / totalCells) * 100) : 0;

  return {
    modis: {
      count: modis.length,
      spatial_resolution: '1 km',
      satellites: ['Terra', 'Aqua'],
      total_frp_mw: Math.round(modisFrpTotal * 10) / 10,
      average_frp_mw: modisAvgFrp,
      unique_h3_cells: modisCells.size,
      day_detections: modis.filter(r => r.daynight === 'D').length,
      night_detections: modis.filter(r => r.daynight === 'N').length,
    },
    viirs: {
      count: viirs.length,
      spatial_resolution: '375 m (High-Resolution)',
      satellites: ['Suomi-NPP', 'NOAA-20', 'NOAA-21'],
      total_frp_mw: Math.round(viirsFrpTotal * 10) / 10,
      average_frp_mw: viirsAvgFrp,
      unique_h3_cells: viirsCells.size,
      day_detections: viirs.filter(r => r.daynight === 'D').length,
      night_detections: viirs.filter(r => r.daynight === 'N').length,
    },
    harmonization: {
      total_active_cells: totalCells,
      dual_sensor_confirmed_cells: overlapCellCount,
      cross_sensor_confirmation_percentage: crossValidationRate,
      synergy_note: 'VIIRS provides 3x higher spatial detail for perimeter delineation, while MODIS confirms core thermal saturation.',
    }
  };
}

/**
 * FRP Fire Radiative Power Intensity distribution
 */
function computeIntensityDistribution(west, south, east, north) {
  const db = getDb();
  const rows = db.prepare(`
    SELECT frp_mw, sensor
    FROM hotspot_observations
    WHERE longitude >= ? AND longitude <= ? AND latitude >= ? AND latitude <= ?
  `).all(west, east, south, north);

  const brackets = {
    low: { range: '< 10 MW', count: 0, label: 'Low Intensity (Smoldering/Grass)' },
    moderate: { range: '10 - 50 MW', count: 0, label: 'Moderate Intensity (Surface Fire)' },
    high: { range: '50 - 150 MW', count: 0, label: 'High Intensity (Crown Fire Potential)' },
    extreme: { range: '> 150 MW', count: 0, label: 'Extreme Firestorm (PyroCb Risk)' },
  };

  for (const r of rows) {
    const frp = r.frp_mw || 0;
    if (frp < 10) brackets.low.count++;
    else if (frp < 50) brackets.moderate.count++;
    else if (frp < 150) brackets.high.count++;
    else brackets.extreme.count++;
  }

  return {
    total_analyzed: rows.length,
    brackets,
  };
}

function classifyActivityLevel(totalObservations) {
  if (totalObservations === 0) return 'none';
  if (totalObservations < 10) return 'low';
  if (totalObservations < 50) return 'moderate';
  if (totalObservations < 200) return 'high';
  return 'extreme';
}

module.exports = {
  dailyTotalsInBbox,
  computeTrend,
  computeAnomaly,
  computeSensorComparison,
  computeIntensityDistribution,
  classifyActivityLevel,
};
