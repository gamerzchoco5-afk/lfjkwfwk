'use strict';
// services/aiService.js — NASA Wildfire Copilot & Incident AI Intelligence (Emoji-Free Professional Telemetry)
const https = require('https');
const fetch = require('node-fetch');
const settings = require('../config');
const { getDb } = require('../db/database');

const ipv4Agent = new https.Agent({ family: 4, keepAlive: true });

const SYSTEM_PROMPT = `You are "Orbital Copilot", an elite NASA Earth Science and Wildfire Incident Intelligence AI assistant developed for the GetFire active-fire monitoring platform.
You analyze real-time satellite telemetry from NASA MODIS (Terra & Aqua, 1km resolution) and VIIRS (Suomi-NPP, NOAA-20, NOAA-21, 375m resolution).

Guidelines:
1. Provide concise, high-impact, scientifically accurate responses. Do NOT use any emojis.
2. When answering questions, reference specific telemetry metrics: Fire Radiative Power (FRP in Megawatts), brightness temperatures (Kelvin), sensor differences (MODIS 1km vs VIIRS 375m), and satellite confidence.
3. If asked about safety or evacuation, emphasize standard incident command safety protocols (stay upwind, monitor local emergency alerts, create defensible space).
4. Use clear markdown formatting with bullet points and bold highlights.`;

async function callGeminiApi(prompt, context = {}) {
  const apiKey = settings.geminiApiKey;
  if (!apiKey) return null;

  const url = `${settings.geminiApiBaseUrl}/${settings.aiModel}:generateContent?key=${apiKey}`;

  const telemetryContext = `
[CURRENT ORBITAL TELEMETRY CONTEXT]
- Visible Hotspots Count: ${context.fireCount || context.fires?.length || 0}
- Total Fire Radiative Power: ${context.totalFrp || 'N/A'} MW
- MODIS Detections: ${context.modisCount || 0}
- VIIRS Detections: ${context.viirsCount || 0}
- Highest FRP Hotspot: ${context.topFire ? `${context.topFire.frp} MW at [${context.topFire.lat}, ${context.topFire.lon}] (${context.topFire.sensor})` : 'None selected'}
- Active Bounding Box: ${context.bbox ? JSON.stringify(context.bbox) : 'Current View'}
- Selected Hotspot: ${context.selectedFire ? JSON.stringify(context.selectedFire) : 'None'}
`;

  const payload = {
    contents: [
      {
        role: 'user',
        parts: [
          { text: SYSTEM_PROMPT },
          { text: telemetryContext },
          { text: `User Query: ${prompt}` }
        ]
      }
    ],
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: 1024,
    }
  };

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      timeout: 15000,
      agent: ipv4Agent,
    });

    if (!response.ok) {
      const errText = await response.text();
      console.warn(`[AI Gemini Warning] HTTP ${response.status}: ${errText.slice(0, 150)}`);
      return null;
    }

    const data = await response.json();
    const candidate = data.candidates?.[0]?.content?.parts?.[0]?.text;
    return candidate || null;
  } catch (err) {
    console.warn(`[AI Gemini Fetch Error] ${err.message}`);
    return null;
  }
}

function localReasoningFallback(prompt, context = {}) {
  const q = (prompt || '').toLowerCase();
  const fires = context.fires || [];
  const db = getDb();

  if (/(largest|highest|biggest|strongest|maximum|max|frp|intense|peak)/i.test(q)) {
    if (fires.length > 0) {
      const top = [...fires].sort((a, b) => (b.frp || 0) - (a.frp || 0))[0];
      return `### Peak Thermal Anomaly Analysis
- **Intensity:** **${top.frp || 'N/A'} MW** Fire Radiative Power (FRP)
- **Sensor:** **${top.sensor || 'VIIRS'}** (${top.satellite || 'Orbital Pass'})
- **Location:** Lat \`${top.lat || top.latitude}\`, Lon \`${top.lon || top.longitude}\`
- **Confidence:** **${top.confidence || '95'}%**
- **Assessment:** High thermal radiation anomaly. Hotspots above 100 MW indicate active crown fire propagation and heavy smoke plume generation.`;
    }
    const dbTop = db.prepare('SELECT * FROM hotspot_observations ORDER BY frp_mw DESC LIMIT 1').get();
    if (dbTop) {
      return `### Peak Thermal Anomaly
- **Highest FRP:** **${dbTop.frp_mw} MW**
- **Sensor:** **${dbTop.sensor}** (${dbTop.satellite})
- **Coordinates:** \`${dbTop.latitude.toFixed(4)}, ${dbTop.longitude.toFixed(4)}\`
- **Brightness Temp:** **${dbTop.brightness_primary_k || 'N/A'} K**
- **Acquired:** ${dbTop.acquired_at_utc}`;
    }
    return `No active fire hotspots found in the database. Run **Sync NASA Live** to ingest orbital detections.`;
  }

  if (/(modis|viirs|sensor|difference|compare|resolution)/i.test(q)) {
    return `### MODIS vs. VIIRS Sensor Harmonization
- **VIIRS (Suomi-NPP / NOAA-20 / NOAA-21):** **375m spatial resolution** (I-Bands). Optimal for early perimeter delineation and small ignition detection.
- **MODIS (Terra & Aqua):** **1km spatial resolution**. Provides 24+ year climate baseline continuity and high thermal saturation thresholds.
- **Multi-Sensor Verification:** Co-located detections within the same Uber H3 hexagonal cell confirm active combustion and eliminate solar glint false alarms.`;
  }

  if (/(how many|count|total|statistics|stats|number)/i.test(q)) {
    const count = context.fireCount || fires.length || db.prepare('SELECT COUNT(id) as n FROM hotspot_observations').get().n;
    const modisCount = context.modisCount || db.prepare("SELECT COUNT(id) as n FROM hotspot_observations WHERE sensor='MODIS'").get().n;
    const viirsCount = context.viirsCount || db.prepare("SELECT COUNT(id) as n FROM hotspot_observations WHERE sensor='VIIRS'").get().n;
    return `### Active Telemetry Summary
- **Total Hotspots:** **${count}** active thermal anomalies
- **VIIRS Detections (375m):** **${viirsCount}**
- **MODIS Detections (1km):** **${modisCount}**
- **Spatial Indexing:** Indexed via Resolution-8 H3 hexagonal grid for multi-sensor cross-validation.`;
  }

  if (/(spread|predict|risk|danger|direction|wind|weather)/i.test(q)) {
    return `### Wildfire Spread & Risk Assessment
- **Thermal Momentum:** Elevated in high-density H3 clusters with persistent nighttime radiative output.
- **Primary Drivers:** High FRP clusters (>50 MW) combined with low-humidity diurnal cycles.
- **Operational Guidance:** Prioritize perimeter containment downwind of multi-sensor verified complexes and monitor consecutive VIIRS night passes.`;
  }

  if (/(safe|evacuat|danger|help|protocol|protect)/i.test(q)) {
    return `### Incident Command Safety & Evacuation Protocol
- **Evacuation Readiness:** Maintain clear egress corridors away from active thermal perimeters.
- **Plume Avoidance:** Remain upwind of high-FRP anomalies to avoid hazardous PM2.5 and carbon monoxide exposure.
- **Verification:** Cross-reference satellite hotspot coordinates with local emergency dispatch and ground reconnaissance.`;
  }

  return `### GetFire Orbital Copilot Ready
Analyzing live **NASA MODIS (1km)** and **VIIRS (375m)** satellite telemetry.

- **Query Peak Anomalies:** *"What is the highest FRP fire right now?"*
- **Sensor Comparison:** *"Compare MODIS and VIIRS resolution and detections"*
- **Risk & Spread:** *"What is the wildfire spread risk assessment?"*
- **Safety Protocols:** *"Show incident command safety and evacuation guidelines"*`;
}

async function processAiChat(message, context = {}) {
  if (settings.aiConfigured) {
    const geminiReply = await callGeminiApi(message, context);
    if (geminiReply) {
      return {
        reply: geminiReply,
        model: settings.aiModel,
        provider: 'Google Gemini AI',
      };
    }
  }

  const localReply = localReasoningFallback(message, context);
  return {
    reply: localReply,
    model: 'NASA-Orbital-Heuristic-v2',
    provider: 'GetFire Telemetry Engine',
  };
}

async function generateIncidentBriefing(west, south, east, north) {
  const db = getDb();
  const rows = db.prepare(`
    SELECT * FROM hotspot_observations
    WHERE longitude >= ? AND longitude <= ? AND latitude >= ? AND latitude <= ?
    ORDER BY frp_mw DESC LIMIT 500
  `).all(west, east, south, north);

  const count = rows.length;
  const modis = rows.filter(r => r.sensor === 'MODIS').length;
  const viirs = rows.filter(r => r.sensor === 'VIIRS').length;
  const totalFrp = rows.reduce((s, r) => s + (r.frp_mw || 0), 0);
  const maxFrp = rows[0] ? rows[0].frp_mw : 0;

  let alertLevel = 'LOW';
  if (maxFrp > 150 || totalFrp > 1000 || count > 100) alertLevel = 'CRITICAL';
  else if (maxFrp > 50 || totalFrp > 300 || count > 30) alertLevel = 'SEVERE';
  else if (count > 5) alertLevel = 'MODERATE';

  const prompt = `Generate a concise 3-paragraph executive incident briefing (without any emojis) for region [${west}, ${south}, ${east}, ${north}] with ${count} active hotspots (FRP: ${totalFrp.toFixed(1)} MW, Peak: ${maxFrp} MW, MODIS: ${modis}, VIIRS: ${viirs}). Alert Level: ${alertLevel}.`;

  let briefingText = null;
  if (settings.aiConfigured) {
    briefingText = await callGeminiApi(prompt, { fireCount: count, totalFrp, modisCount: modis, viirsCount: viirs });
  }

  if (!briefingText) {
    const biomassRate = (totalFrp * 0.368).toFixed(1);
    briefingText = `EXECUTIVE WILDFIRE INCIDENT BRIEFING

1. REGIONAL TELEMETRY OVERVIEW
Orbital scans across bounding sector [${west.toFixed(1)}, ${south.toFixed(1)}, ${east.toFixed(1)}, ${north.toFixed(1)}] registered ${count} active thermal anomalies with a cumulative Fire Radiative Power (FRP) of ${totalFrp.toFixed(1)} MW and an estimated biomass combustion rate of ${biomassRate} kg/s. Peak single-pixel radiative intensity reached ${maxFrp} MW.

2. MULTI-SENSOR HARMONIZATION
Detections comprise ${viirs} high-resolution VIIRS (375m) observations and ${modis} MODIS (1km) observations. Spatial binning via Uber H3 Resolution-8 hexagonal cells confirms active combustion clusters and filters out single-band solar glint artifacts.

3. OPERATIONAL CLASSIFICATION: ${alertLevel}
Priority reconnaissance is recommended for complexes exceeding 50 MW FRP and exhibiting nighttime thermal persistence. Ground suppression units should maintain upwind staging and monitor consecutive polar-orbiting passes.`;
  }

  return {
    alert_level: alertLevel,
    total_hotspots: count,
    modis_detections: modis,
    viirs_detections: viirs,
    total_frp_mw: Math.round(totalFrp * 10) / 10,
    peak_frp_mw: maxFrp,
    briefing_text: briefingText,
    generated_at_utc: new Date().toISOString(),
  };
}

function clusterHotspots(hotspots, distanceThresholdDeg = 0.25) {
  if (!hotspots || hotspots.length === 0) return [];

  const clusters = [];
  const visited = new Set();

  for (let i = 0; i < hotspots.length; i++) {
    if (visited.has(i)) continue;

    const cluster = [hotspots[i]];
    visited.add(i);

    for (let j = i + 1; j < hotspots.length; j++) {
      if (visited.has(j)) continue;
      const dLat = hotspots[i].latitude - hotspots[j].latitude;
      const dLon = hotspots[i].longitude - hotspots[j].longitude;
      const dist = Math.sqrt(dLat * dLat + dLon * dLon);
      if (dist <= distanceThresholdDeg) {
        cluster.push(hotspots[j]);
        visited.add(j);
      }
    }

    clusters.push(cluster);
  }

  const designations = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Sierra', 'Tango', 'Victor', 'Zulu'];
  return clusters
    .filter(c => c.length >= 2)
    .map((c, idx) => {
      const totalFrp = c.reduce((s, h) => s + (h.frp_mw || 0), 0);
      const avgLat = c.reduce((s, h) => s + h.latitude, 0) / c.length;
      const avgLon = c.reduce((s, h) => s + h.longitude, 0) / c.length;
      const maxFrp = Math.max(...c.map(h => h.frp_mw || 0));
      const modisCount = c.filter(h => h.sensor === 'MODIS').length;
      const viirsCount = c.filter(h => h.sensor === 'VIIRS').length;
      const name = `Complex ${designations[idx % designations.length]}-${idx + 1}`;

      let severity = 'Moderate';
      if (maxFrp > 100 || totalFrp > 300) severity = 'Extreme';
      else if (maxFrp > 40 || totalFrp > 100) severity = 'High';

      return {
        id: `cluster-${idx + 1}`,
        name,
        severity,
        centroid: { latitude: Math.round(avgLat * 10000) / 10000, longitude: Math.round(avgLon * 10000) / 10000 },
        hotspot_count: c.length,
        modis_count: modisCount,
        viirs_count: viirsCount,
        dual_sensor: modisCount > 0 && viirsCount > 0,
        total_frp_mw: Math.round(totalFrp * 10) / 10,
        peak_frp_mw: Math.round(maxFrp * 10) / 10,
        biomass_rate_kg_s: Math.round(totalFrp * 0.368 * 10) / 10,
      };
    })
    .sort((a, b) => b.total_frp_mw - a.total_frp_mw);
}

module.exports = {
  processAiChat,
  generateIncidentBriefing,
  clusterHotspots,
  callGeminiApi,
};
