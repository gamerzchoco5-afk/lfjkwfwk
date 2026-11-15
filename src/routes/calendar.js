'use strict';
// routes/calendar.js — 100% Real NASA Hotspot Counts by Date
const express = require('express');
const { getDb } = require('../db/database');

const router = express.Router();

router.get(['/api/v1/calendar', '/calendar'], (req, res) => {
  try {
    const db = getDb();

    const dbRows = db.prepare(`
      SELECT acquired_date_utc as date, COUNT(id) as count
      FROM hotspot_observations
      GROUP BY acquired_date_utc
      ORDER BY acquired_date_utc ASC
    `).all();

    const countsByDate = {};
    for (const r of dbRows) {
      countsByDate[r.date] = r.count;
    }

    let startDateStr = req.query.start_date;
    let endDateStr = req.query.end_date;

    const todayStr = new Date().toISOString().slice(0, 10);

    if (!startDateStr || !endDateStr) {
      const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
      startDateStr = thirtyDaysAgo;
      endDateStr = todayStr;
    }

    const startD = new Date(startDateStr + 'T00:00:00Z');
    const endD = new Date(endDateStr + 'T00:00:00Z');

    const days = [];
    for (let d = new Date(startD); d <= endD; d.setUTCDate(d.getUTCDate() + 1)) {
      const dateStr = d.toISOString().slice(0, 10);
      days.push({
        date: dateStr,
        hotspot_count: countsByDate[dateStr] || 0,
      });
    }

    return res.json({ days });
  } catch (err) {
    console.error('[Calendar Error]', err);
    return res.status(500).json({ detail: 'Failed to retrieve calendar activity.', days: [] });
  }
});

module.exports = router;
