(function () {
  const STORAGE_SESSIONS = "skismart_tracking_sessions_v5";
  const STORAGE_ACTIVE = "skismart_tracking_active_v2";

  let mapMode = null; // "leaflet" | "maplibre"
  let mapInstance = null;

  let watchId = null;
  let activeSession = null;

  let leafletLiveLine = null;
  let leafletHistoryLine = null;

  let uiBound = false;

  function loadJSON(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  }

  function saveJSON(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
  }

  function loadSessions() {
    return loadJSON(STORAGE_SESSIONS, []);
  }

  function saveSessions(sessions) {
    saveJSON(STORAGE_SESSIONS, sessions);
  }

  function loadActive() {
    return loadJSON(STORAGE_ACTIVE, null);
  }

  function saveActive(session) {
    if (session) {
      saveJSON(STORAGE_ACTIVE, session);
    } else {
      localStorage.removeItem(STORAGE_ACTIVE);
    }
  }

  function haversine(a, b) {
    const R = 6371000;
    const toRad = d => d * Math.PI / 180;

    const dLat = toRad(b.lat - a.lat);
    const dLon = toRad(b.lng - a.lng);
    const lat1 = toRad(a.lat);
    const lat2 = toRad(b.lat);

    const h =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;

    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  function clamp(n, min, max) {
    return Math.max(min, Math.min(max, n));
  }

  function makeSessionId() {
    if (crypto?.randomUUID) return crypto.randomUUID();
    return "trk_" + Date.now() + "_" + Math.random().toString(16).slice(2);
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

  function formatSpeed(kmh) {
    return `${(kmh || 0).toFixed(1)} km/h`;
  }

  function formatDateTime(iso) {
    return new Date(iso).toLocaleString("it-IT", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit"
    });
  }

  function computePointSpeed(prev, curr) {
    if (!prev) return 0;

    const t1 = new Date(prev.timestamp).getTime();
    const t2 = new Date(curr.timestamp).getTime();
    const dt = Math.max(0, (t2 - t1) / 1000);
    const dist = haversine(prev, curr);

    const calcSpeed = dt > 0 ? (dist / dt) * 3.6 : 0;
    const gpsSpeed = (typeof curr.gpsSpeedKmh === "number" && isFinite(curr.gpsSpeedKmh))
      ? curr.gpsSpeedKmh
      : null;

    let chosen;

    if (gpsSpeed !== null && curr.accuracy <= 15) {
      chosen = gpsSpeed * 0.7 + calcSpeed * 0.3;
    } else if (gpsSpeed !== null && curr.accuracy <= 25) {
      chosen = gpsSpeed;
    } else {
      chosen = calcSpeed;
    }

    return clamp(chosen, 0, 130);
  }

  function summarizeSession(session) {
    const points = session.points || [];
    let distanceM = 0;
    let maxSpeedKmh = 0;

    for (let i = 1; i < points.length; i++) {
      distanceM += haversine(points[i - 1], points[i]);
    }

    for (const p of points) {
      if (typeof p.speedKmh === "number" && isFinite(p.speedKmh)) {
        if (p.speedKmh > maxSpeedKmh) maxSpeedKmh = p.speedKmh;
      }
    }

    const endIso = session.endedAt || new Date().toISOString();
    const durationSec = Math.max(
      0,
      Math.round((new Date(endIso) - new Date(session.startedAt)) / 1000)
    );
    const avgSpeedKmh = durationSec > 0 ? (distanceM / durationSec) * 3.6 : 0;

    session.distanceM = distanceM;
    session.durationSec = durationSec;
    session.maxSpeedKmh = maxSpeedKmh;
    session.avgSpeedKmh = avgSpeedKmh;

    return session;
  }

  function persistActive() {
    if (!activeSession) return;
    summarizeSession(activeSession);
    saveActive(activeSession);
  }

  function upsertClosedSession(session) {
    const sessions = loadSessions().filter(s => s.id !== session.id);
    sessions.push(session);
    saveSessions(sessions);
  }

  function coordsOfSession(session) {
    return (session.points || []).map(p => [p.lng, p.lat]);
  }

  function clearLeafletLines() {
    if (leafletLiveLine) {
      mapInstance.removeLayer(leafletLiveLine);
      leafletLiveLine = null;
    }
    if (leafletHistoryLine) {
      mapInstance.removeLayer(leafletHistoryLine);
      leafletHistoryLine = null;
    }
  }

  function ensureMapLibreTrackingSources() {
    if (!mapInstance.getSource("track-live-source")) {
      mapInstance.addSource("track-live-source", {
        type: "geojson",
        data: {
          type: "Feature",
          geometry: { type: "LineString", coordinates: [] },
          properties: {}
        }
      });
    }

    if (!mapInstance.getLayer("track-live-layer")) {
      mapInstance.addLayer({
        id: "track-live-layer",
        type: "line",
        source: "track-live-source",
        paint: {
          "line-color": "#00c2ff",
          "line-width": 5,
          "line-opacity": 0.95
        }
      });
    }

    if (!mapInstance.getSource("track-history-source")) {
      mapInstance.addSource("track-history-source", {
        type: "geojson",
        data: {
          type: "Feature",
          geometry: { type: "LineString", coordinates: [] },
          properties: {}
        }
      });
    }

    if (!mapInstance.getLayer("track-history-layer")) {
      mapInstance.addLayer({
        id: "track-history-layer",
        type: "line",
        source: "track-history-source",
        paint: {
          "line-color": "#ff006e",
          "line-width": 5,
          "line-opacity": 0.95
        }
      });
    }
  }

  function setMapLibreLine(sourceId, coords) {
    const src = mapInstance.getSource(sourceId);
    if (!src) return;
    src.setData({
      type: "Feature",
      geometry: { type: "LineString", coordinates: coords },
      properties: {}
    });
  }

  function clearLines() {
    if (mapMode === "leaflet") {
      clearLeafletLines();
      return;
    }

    if (mapMode === "maplibre") {
      setMapLibreLine("track-live-source", []);
      setMapLibreLine("track-history-source", []);
    }
  }

  function redrawLiveTrack() {
    if (!activeSession) {
      if (mapMode === "leaflet" && leafletLiveLine) {
        mapInstance.removeLayer(leafletLiveLine);
        leafletLiveLine = null;
      }
      if (mapMode === "maplibre") {
        setMapLibreLine("track-live-source", []);
      }
      return;
    }

    const coordsLngLat = coordsOfSession(activeSession);
    const coordsLatLng = (activeSession.points || []).map(p => [p.lat, p.lng]);

    if (mapMode === "leaflet") {
      if (leafletLiveLine) mapInstance.removeLayer(leafletLiveLine);
      if (coordsLatLng.length >= 2) {
        leafletLiveLine = L.polyline(coordsLatLng, {
          color: "#00c2ff",
          weight: 5,
          opacity: 0.95
        }).addTo(mapInstance);
      }
      return;
    }

    if (mapMode === "maplibre") {
      setMapLibreLine("track-live-source", coordsLngLat);
    }
  }

  function showHistoryTrack(session, animate = true) {
    const coordsLngLat = coordsOfSession(session);
    const coordsLatLng = (session.points || []).map(p => [p.lat, p.lng]);

    if (mapMode === "leaflet") {
      if (leafletHistoryLine) mapInstance.removeLayer(leafletHistoryLine);
      if (coordsLatLng.length >= 2) {
        leafletHistoryLine = L.polyline(coordsLatLng, {
          color: "#ff006e",
          weight: 5,
          opacity: 0.95
        }).addTo(mapInstance);

        mapInstance.fitBounds(leafletHistoryLine.getBounds().pad(0.20));

        if (animate && typeof leafletHistoryLine.snakeIn === "function") {
          leafletHistoryLine.snakeIn();
        }
      }
      return;
    }

    if (mapMode === "maplibre") {
      setMapLibreLine("track-history-source", coordsLngLat);

      if (coordsLngLat.length >= 2) {
        const bounds = new maplibregl.LngLatBounds(coordsLngLat[0], coordsLngLat[0]);
        coordsLngLat.forEach(c => bounds.extend(c));
        mapInstance.fitBounds(bounds, { padding: 50, maxZoom: 15, duration: 800 });
      }
    }
  }

  function updateTrackInfo() {
    const el = document.getElementById("trackInfo");
    if (!el) return;

    if (!activeSession) {
      el.textContent = "Tracking fermo";
      return;
    }

    summarizeSession(activeSession);

    el.textContent =
      `Tracking attivo • ${activeSession.points.length} punti • ` +
      `${formatDistance(activeSession.distanceM || 0)} • ` +
      `${formatDuration(activeSession.durationSec || 0)} • ` +
      `Media ${formatSpeed(activeSession.avgSpeedKmh || 0)} • ` +
      `Max ${formatSpeed(activeSession.maxSpeedKmh || 0)}`;
  }

  function updateButtons() {
    const btnStart = document.getElementById("trackStart");
    const btnStop = document.getElementById("trackStop");

    const active = watchId !== null || !!activeSession;

    if (btnStart) {
      btnStart.disabled = active;
      btnStart.style.opacity = active ? "0.5" : "1";
    }

    if (btnStop) {
      btnStop.disabled = !active;
      btnStop.style.opacity = active ? "1" : "0.5";
    }
  }

  function renderHistory() {
    const box = document.getElementById("trackHistory");
    if (!box) return;

    const sessions = loadSessions().sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));

    if (!sessions.length) {
      box.innerHTML = "Nessuna registrazione salvata.";
      return;
    }

    box.innerHTML = sessions.map(s => `
      <div class="history-card">
        <div class="history-title">${formatDateTime(s.startedAt)}</div>
        <div class="history-meta">
          Durata: ${formatDuration(s.durationSec || 0)}<br>
          Distanza: ${formatDistance(s.distanceM || 0)}<br>
          Velocità media: ${formatSpeed(s.avgSpeedKmh || 0)}<br>
          Velocità massima: ${formatSpeed(s.maxSpeedKmh || 0)}<br>
          Punti: ${(s.points || []).length}
        </div>
        <div class="row" style="margin-top:8px;">
          <button class="btn-dark track-view" data-track-id="${s.id}">Rivedi</button>
          <button class="btn-light track-delete" data-track-id="${s.id}">Elimina</button>
        </div>
      </div>
    `).join("");
  }

  function addPointFromPosition(pos) {
    if (!activeSession) return;

    const rawGpsSpeed = pos.coords.speed;
    const gpsSpeedKmh =
      (typeof rawGpsSpeed === "number" && isFinite(rawGpsSpeed) && rawGpsSpeed >= 0)
        ? rawGpsSpeed * 3.6
        : null;

    const point = {
      lat: pos.coords.latitude,
      lng: pos.coords.longitude,
      accuracy: pos.coords.accuracy,
      altitude: pos.coords.altitude,
      heading: pos.coords.heading,
      gpsSpeedKmh,
      speedKmh: 0,
      timestamp: new Date(pos.timestamp).toISOString()
    };

    const last = activeSession.points[activeSession.points.length - 1];

    if (last) {
      const d = haversine(last, point);
      if (d < 3) return;
    }

    point.speedKmh = computePointSpeed(last, point);
    activeSession.points.push(point);

    summarizeSession(activeSession);
    persistActive();
    redrawLiveTrack();
    updateTrackInfo();
  }

  function startWatch() {
    if (!navigator.geolocation) {
      alert("Geolocalizzazione non supportata.");
      return;
    }

    if (watchId !== null) return;

    watchId = navigator.geolocation.watchPosition(
      (pos) => addPointFromPosition(pos),
      (err) => {
        console.error("Tracking GPS error:", err);
        const el = document.getElementById("trackInfo");
        if (el) el.textContent = "Errore GPS: " + err.message;
      },
      {
        enableHighAccuracy: true,
        maximumAge: 1000,
        timeout: 8000
      }
    );

    updateButtons();
  }

  function start() {
    if (watchId !== null) return;

    if (!activeSession) {
      activeSession = {
        id: makeSessionId(),
        startedAt: new Date().toISOString(),
        endedAt: null,
        points: [],
        distanceM: 0,
        durationSec: 0,
        avgSpeedKmh: 0,
        maxSpeedKmh: 0
      };
      persistActive();
    }

    startWatch();
    redrawLiveTrack();
    updateTrackInfo();
    updateButtons();
  }

  function stop() {
    if (watchId !== null) {
      navigator.geolocation.clearWatch(watchId);
      watchId = null;
    }

    if (!activeSession) {
      updateButtons();
      updateTrackInfo();
      return;
    }

    activeSession.endedAt = new Date().toISOString();
    summarizeSession(activeSession);
    upsertClosedSession(activeSession);

    saveActive(null);
    activeSession = null;

    redrawLiveTrack();
    updateButtons();
    updateTrackInfo();
    renderHistory();
  }

  function replayLatest() {
    const sessions = loadSessions().sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));
    if (!sessions.length) {
      alert("Nessuna registrazione salvata.");
      return;
    }
    showHistoryTrack(sessions[0], true);
  }

  function viewSession(id) {
    const sessions = loadSessions();
    const s = sessions.find(x => x.id === id);
    if (!s || !s.points || s.points.length < 2) {
      alert("Traccia troppo corta o non disponibile.");
      return;
    }
    showHistoryTrack(s, true);
  }

  function deleteSession(id) {
    if (!confirm("Vuoi eliminare questa registrazione?")) return;

    const sessions = loadSessions().filter(s => s.id !== id);
    saveSessions(sessions);
    renderHistory();

    if (mapMode === "leaflet" && leafletHistoryLine) {
      mapInstance.removeLayer(leafletHistoryLine);
      leafletHistoryLine = null;
    }
    if (mapMode === "maplibre") {
      setMapLibreLine("track-history-source", []);
    }
  }

  function bindUI() {
    if (uiBound) return;
    uiBound = true;

    const btnStart = document.getElementById("trackStart");
    const btnStop = document.getElementById("trackStop");
    const btnReplayLatest = document.getElementById("trackReplayLatest");

    if (btnStart) btnStart.addEventListener("click", start);
    if (btnStop) btnStop.addEventListener("click", stop);
    if (btnReplayLatest) btnReplayLatest.addEventListener("click", replayLatest);

    document.addEventListener("click", (ev) => {
      const viewBtn = ev.target.closest(".track-view");
      if (viewBtn) {
        viewSession(viewBtn.getAttribute("data-track-id"));
        return;
      }

      const delBtn = ev.target.closest(".track-delete");
      if (delBtn) {
        deleteSession(delBtn.getAttribute("data-track-id"));
      }
    });

    window.addEventListener("beforeunload", () => {
      persistActive();
    });
  }

  function restoreAndResumeAutomatically() {
    const saved = loadActive();
    if (!saved) {
      updateButtons();
      updateTrackInfo();
      renderHistory();
      return;
    }

    activeSession = saved;
    summarizeSession(activeSession);
    redrawLiveTrack();
    updateTrackInfo();
    renderHistory();
    updateButtons();

    // ripresa automatica senza prompt
    startWatch();
  }

  function initLeaflet(map) {
    mapMode = "leaflet";
    mapInstance = map;

    bindUI();
    updateButtons();
    updateTrackInfo();
    renderHistory();
    restoreAndResumeAutomatically();
  }

  function initMapLibre(map) {
    mapMode = "maplibre";
    mapInstance = map;

    ensureMapLibreTrackingSources();

    bindUI();
    updateButtons();
    updateTrackInfo();
    renderHistory();
    restoreAndResumeAutomatically();
  }

  window.SkiSmartTracking = {
    initLeaflet,
    initMapLibre,
    start,
    stop,
    replayLatest,
    viewSession,
    deleteSession,
    renderHistory
  };
})();
