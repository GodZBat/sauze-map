const SkiSmartTracking = (() => {
  const STORAGE_KEY = "skismart_tracking_sessions_v1";

  let map = null;
  let isTracking = false;
  let watchId = null;
  let currentSession = null;
  let currentLineSourceId = "tracking-current-source";
  let currentLineLayerId = "tracking-current-layer";

  function nowIso() {
    return new Date().toISOString();
  }

  function formatDateTime(iso) {
    const d = new Date(iso);
    return d.toLocaleString("it-IT", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit"
    });
  }

  function generateId() {
    return "trk_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
  }

  function loadSessions() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    } catch {
      return [];
    }
  }

  function saveSessions(sessions) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions));
  }

  function haversine(a, b) {
    const R = 6371000;
    const toRad = deg => deg * Math.PI / 180;

    const lat1 = toRad(a.lat);
    const lat2 = toRad(b.lat);
    const dLat = toRad(b.lat - a.lat);
    const dLon = toRad(b.lng - a.lng);

    const x = Math.sin(dLat / 2) ** 2 +
              Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;

    return 2 * R * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
  }

  function getDurationSec(startIso, endIso) {
    return Math.max(0, Math.round((new Date(endIso) - new Date(startIso)) / 1000));
  }

  function formatDistance(m) {
    if (m < 1000) return `${Math.round(m)} m`;
    return `${(m / 1000).toFixed(2)} km`;
  }

  function formatDuration(sec) {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;

    if (h > 0) return `${h}h ${m}m ${s}s`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  }

  function ensureTrackingLayer() {
    if (!map.getSource(currentLineSourceId)) {
      map.addSource(currentLineSourceId, {
        type: "geojson",
        data: {
          type: "Feature",
          geometry: {
            type: "LineString",
            coordinates: []
          },
          properties: {}
        }
      });
    }

    if (!map.getLayer(currentLineLayerId)) {
      map.addLayer({
        id: currentLineLayerId,
        type: "line",
        source: currentLineSourceId,
        paint: {
          "line-color": "#00c2ff",
          "line-width": 5,
          "line-opacity": 0.95
        }
      });
    }
  }

  function updateCurrentLine() {
    if (!map || !currentSession || !map.getSource(currentLineSourceId)) return;

    const coords = currentSession.points.map(p => [p.lng, p.lat]);

    map.getSource(currentLineSourceId).setData({
      type: "Feature",
      geometry: {
        type: "LineString",
        coordinates: coords
      },
      properties: {}
    });
  }

  function resetCurrentLine() {
    if (!map || !map.getSource(currentLineSourceId)) return;

    map.getSource(currentLineSourceId).setData({
      type: "Feature",
      geometry: {
        type: "LineString",
        coordinates: []
      },
      properties: {}
    });
  }

  function computeSessionSummary(session) {
    const points = session.points || [];
    let distanceM = 0;
    let maxSpeedKmh = 0;

    for (let i = 1; i < points.length; i++) {
      distanceM += haversine(points[i - 1], points[i]);

      if (typeof points[i].speed === "number") {
        const kmh = points[i].speed * 3.6;
        if (kmh > maxSpeedKmh) maxSpeedKmh = kmh;
      }
    }

    const durationSec = getDurationSec(session.startedAt, session.endedAt || nowIso());
    const avgSpeedKmh = durationSec > 0 ? (distanceM / durationSec) * 3.6 : 0;

    session.distanceM = distanceM;
    session.durationSec = durationSec;
    session.maxSpeedKmh = maxSpeedKmh;
    session.avgSpeedKmh = avgSpeedKmh;

    return session;
  }

  function addPointFromPosition(position) {
    if (!currentSession) return;

    const p = {
      lat: position.coords.latitude,
      lng: position.coords.longitude,
      accuracy: position.coords.accuracy,
      altitude: position.coords.altitude,
      speed: position.coords.speed,
      heading: position.coords.heading,
      timestamp: new Date(position.timestamp).toISOString()
    };

    const last = currentSession.points[currentSession.points.length - 1];

    // filtro anti-rumore GPS
    if (last) {
      const dist = haversine(last, p);
      if (dist < 2) return;
    }

    currentSession.points.push(p);
    updateCurrentLine();
    updateLiveStatus();
  }

  function updateLiveStatus() {
    const el = document.getElementById("trackingStatus");
    if (!el) return;

    if (!currentSession) {
      el.textContent = "Tracking fermo";
      return;
    }

    computeSessionSummary(currentSession);

    el.textContent =
      `Tracking attivo • ${currentSession.points.length} punti • ` +
      `${formatDistance(currentSession.distanceM || 0)} • ` +
      `${formatDuration(currentSession.durationSec || 0)}`;
  }

  function renderHistory() {
    const container = document.getElementById("trackingHistory");
    if (!container) return;

    const sessions = loadSessions().sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));

    if (!sessions.length) {
      container.innerHTML = `<div style="opacity:.7">Nessuna registrazione salvata.</div>`;
      return;
    }

    container.innerHTML = sessions.map(s => `
      <div style="border:1px solid rgba(0,0,0,.08);border-radius:12px;padding:10px;margin-bottom:8px;background:#fff;">
        <div style="font-weight:900;">${formatDateTime(s.startedAt)}</div>
        <div style="font-size:12px;color:#444;margin-top:4px;">
          Durata: ${formatDuration(s.durationSec || 0)}<br>
          Distanza: ${formatDistance(s.distanceM || 0)}<br>
          Punti: ${(s.points || []).length}
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;">
          <button onclick="SkiSmartTracking.viewSession('${s.id}')" style="border:0;border-radius:10px;padding:8px 10px;font-weight:800;cursor:pointer;background:#111;color:#fff;">Rivedi</button>
          <button onclick="SkiSmartTracking.deleteSession('${s.id}')" style="border:0;border-radius:10px;padding:8px 10px;font-weight:800;cursor:pointer;background:#eee;color:#111;">Elimina</button>
        </div>
      </div>
    `).join("");
  }

  function startTracking() {
    if (isTracking) return;

    if (!navigator.geolocation) {
      alert("Geolocalizzazione non supportata.");
      return;
    }

    currentSession = {
      id: generateId(),
      startedAt: nowIso(),
      endedAt: null,
      points: [],
      distanceM: 0,
      durationSec: 0,
      maxSpeedKmh: 0,
      avgSpeedKmh: 0
    };

    isTracking = true;
    updateButtons();
    updateLiveStatus();
    ensureTrackingLayer();
    resetCurrentLine();

    watchId = navigator.geolocation.watchPosition(
      (pos) => {
        addPointFromPosition(pos);
      },
      (err) => {
        console.error("Tracking error:", err);
        const el = document.getElementById("trackingStatus");
        if (el) el.textContent = "Errore GPS: " + err.message;
      },
      {
        enableHighAccuracy: true,
        maximumAge: 1000,
        timeout: 10000
      }
    );
  }

  function stopTracking() {
    if (!isTracking) return;

    isTracking = false;

    if (watchId !== null) {
      navigator.geolocation.clearWatch(watchId);
      watchId = null;
    }

    if (currentSession) {
      currentSession.endedAt = nowIso();
      computeSessionSummary(currentSession);

      const sessions = loadSessions();
      sessions.push(currentSession);
      saveSessions(sessions);
    }

    currentSession = null;
    updateButtons();
    updateLiveStatus();
    renderHistory();
  }

  function updateButtons() {
    const btnStart = document.getElementById("btnTrackStart");
    const btnStop = document.getElementById("btnTrackStop");

    if (btnStart) btnStart.disabled = isTracking;
    if (btnStop) btnStop.disabled = !isTracking;

    if (btnStart) btnStart.style.opacity = isTracking ? "0.5" : "1";
    if (btnStop) btnStop.style.opacity = !isTracking ? "0.5" : "1";
  }

  function viewSession(id) {
    const sessions = loadSessions();
    const session = sessions.find(s => s.id === id);
    if (!session || !map) return;

    const srcId = "tracking-history-source";
    const lyrId = "tracking-history-layer";

    const coords = (session.points || []).map(p => [p.lng, p.lat]);

    const feature = {
      type: "Feature",
      geometry: {
        type: "LineString",
        coordinates: coords
      },
      properties: {}
    };

    if (!map.getSource(srcId)) {
      map.addSource(srcId, { type: "geojson", data: feature });
    } else {
      map.getSource(srcId).setData(feature);
    }

    if (!map.getLayer(lyrId)) {
      map.addLayer({
        id: lyrId,
        type: "line",
        source: srcId,
        paint: {
          "line-color": "#ff006e",
          "line-width": 5,
          "line-opacity": 0.95
        }
      });
    }

    if (coords.length) {
      const bounds = new maplibregl.LngLatBounds(coords[0], coords[0]);
      coords.forEach(c => bounds.extend(c));
      map.fitBounds(bounds, { padding: 50, maxZoom: 15, duration: 800 });
    }
  }

  function deleteSession(id) {
    const ok = confirm("Vuoi eliminare questa registrazione?");
    if (!ok) return;

    const sessions = loadSessions().filter(s => s.id !== id);
    saveSessions(sessions);
    renderHistory();
  }

  function init(options) {
    map = options.map;
    ensureTrackingLayer();
    updateButtons();
    updateLiveStatus();
    renderHistory();
  }

  return {
    init,
    startTracking,
    stopTracking,
    renderHistory,
    viewSession,
    deleteSession
  };
})();
