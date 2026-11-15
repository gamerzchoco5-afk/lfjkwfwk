'use strict';
// services/normalizer.js — mirrors Python's app/services/normalizer.py
const crypto = require('crypto');
const h3 = require('h3-js');
const settings = require('../config');

const MODIS_SOURCES = new Set(['MODIS_NRT', 'MODIS_SP']);
const VIIRS_SOURCES = new Set([
  'VIIRS_SNPP_NRT', 'VIIRS_SNPP_SP',
  'VIIRS_NOAA20_NRT', 'VIIRS_NOAA20_SP',
  'VIIRS_NOAA21_NRT', 'VIIRS_NOAA21_SP',
]);

class NormalizationError extends Error {}

function sensorForSource(sourceProduct) {
  if (MODIS_SOURCES.has(sourceProduct)) return 'MODIS';
  if (VIIRS_SOURCES.has(sourceProduct)) return 'VIIRS';
  throw new NormalizationError(`Unknown source product: ${sourceProduct}`);
}

function processingLevel(sourceProduct) {
  return sourceProduct.endsWith('_SP') ? 'SP' : 'NRT';
}

function toFloat(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = parseFloat(value);
  return isNaN(n) ? null : n;
}

function parseAcqDatetime(acqDate, acqTime) {
  // acqDate: YYYY-MM-DD, acqTime: HHMM
  const timeStr = String(acqTime || '0').trim().padStart(4, '0');
  const hour = parseInt(timeStr.slice(0, 2), 10);
  const minute = parseInt(timeStr.slice(2, 4), 10);
  const d = new Date(`${acqDate}T${String(hour).padStart(2,'0')}:${String(minute).padStart(2,'0')}:00Z`);
  return d.toISOString();
}

function confidenceClassModis(confidenceRaw) {
  const val = toFloat(confidenceRaw);
  if (val === null) return null;
  if (val < 30) return 'low';
  if (val < 80) return 'nominal';
  return 'high';
}

function confidenceClassViirs(confidenceRaw) {
  if (!confidenceRaw) return null;
  const key = String(confidenceRaw).trim().toLowerCase();
  const mapping = { l: 'low', n: 'nominal', h: 'high', low: 'low', nominal: 'nominal', high: 'high' };
  return mapping[key] || null;
}

function buildObservationKey(sourceProduct, rawRow) {
  const parts = [
    sourceProduct,
    rawRow.latitude || '',
    rawRow.longitude || '',
    rawRow.acq_date || '',
    rawRow.acq_time || '',
    rawRow.satellite || '',
    rawRow.version || '',
  ];
  const digest = crypto.createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 32);
  return `${sourceProduct}:${digest}`;
}

function normalizeRow(sourceProduct, rawRow) {
  const sensor = sensorForSource(sourceProduct);

  const latitude = parseFloat(rawRow.latitude);
  const longitude = parseFloat(rawRow.longitude);
  if (isNaN(latitude) || isNaN(longitude)) {
    throw new NormalizationError(`Missing/invalid latitude or longitude`);
  }
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
    throw new NormalizationError(`Latitude/longitude out of range: ${latitude}, ${longitude}`);
  }

  const acqDate = rawRow.acq_date;
  const acqTime = rawRow.acq_time;
  if (!acqDate) throw new NormalizationError('Missing acq_date.');

  const acquiredAtUtc = parseAcqDatetime(acqDate, acqTime || '0');
  const h3Cell = h3.latLngToCell(latitude, longitude, settings.h3Resolution);

  const confidenceRaw = rawRow.confidence || null;
  let brightnessPrimary, brightnessSecondary, primaryBand, secondaryBand, confidenceClass, detectionType;

  if (sensor === 'MODIS') {
    brightnessPrimary = toFloat(rawRow.brightness);
    brightnessSecondary = toFloat(rawRow.bright_t31);
    primaryBand = 'MODIS_21/22 (brightness)';
    secondaryBand = 'MODIS_31/32 (bright_t31)';
    confidenceClass = confidenceClassModis(confidenceRaw);
    detectionType = rawRow.type || null;
  } else {
    brightnessPrimary = toFloat(rawRow.bright_ti4);
    brightnessSecondary = toFloat(rawRow.bright_ti5);
    primaryBand = 'VIIRS I4';
    secondaryBand = 'VIIRS I5';
    confidenceClass = confidenceClassViirs(confidenceRaw);
    detectionType = null;
  }

  const observationKey = buildObservationKey(sourceProduct, rawRow);

  return {
    observation_key: observationKey,
    source_product: sourceProduct,
    sensor,
    satellite: rawRow.satellite || null,
    instrument: rawRow.instrument || null,
    processing_version: rawRow.version || null,
    processing_level: processingLevel(sourceProduct),
    latitude,
    longitude,
    h3_cell: h3Cell,
    acquired_at_utc: acquiredAtUtc,
    acquired_date_utc: acqDate,
    acquired_time_utc: acqTime ? String(acqTime).padStart(4, '0') : null,
    brightness_primary_k: brightnessPrimary,
    brightness_secondary_k: brightnessSecondary,
    primary_brightness_band: primaryBand,
    secondary_brightness_band: secondaryBand,
    scan: toFloat(rawRow.scan),
    track: toFloat(rawRow.track),
    frp_mw: toFloat(rawRow.frp),
    confidence_raw: confidenceRaw !== null ? String(confidenceRaw) : null,
    confidence_class: confidenceClass,
    daynight: rawRow.daynight || null,
    detection_type: detectionType,
    raw_payload_json: JSON.stringify(rawRow),
  };
}

function normalizeRows(sourceProduct, rawRows) {
  const normalized = [];
  const errors = [];
  for (const row of rawRows) {
    try {
      normalized.push(normalizeRow(sourceProduct, row));
    } catch (err) {
      errors.push(err.message);
    }
  }
  return { normalized, errors };
}

module.exports = { normalizeRow, normalizeRows, NormalizationError };
