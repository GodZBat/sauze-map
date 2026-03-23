(function () {
  const STORAGE_ACTIVE = "skismart_tracking_active_v2";
  const STORAGE_HISTORY = "skismart_tracking_history_v2";
  const STORAGE_HEATMAP = "skismart_heatmap_enabled_v1";

  const MIN_POINT_DISTANCE_METERS = 6;
  const MAX_REASONABLE_SPEED_KMH = 120;
  const ACTIVE_SPEED_THRESHOLD_KMH = 3.0;

  let currentMap = null;
  let currentMapType = null; // "leaflet" | "maplibre"
  let watchId = null;
  let replayHandle = null;

  let leafletReplayLayer = null;
  let leafletUserMarker = null;

  let maplibreReplaySourceReady = false;
  let maplibreUserMarker = null;

  function $(id) {
    return document.getElementById(id);
  }

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

  function getHistory() {
    return loadJSON(STORAGE_HISTORY, []);
  }

  function setHistory(history) {
    saveJSON(STORAGE_HISTORY, history);
  }

  function getActiveSession() {
    return loadJSON(STORAGE_ACTIVE, null);
  }

  function setActiveSession(session) {
    saveJSON(STORAGE_ACTIVE, session);
  }

  function clearActiveSession() {
    localStorage.removeItem(STORAGE_ACTIVE);
  }

  function isTrackingActive() {
    const s = getActiveSession();
    return !!(s && s.isRecording);
  }

  function ensureSessionShape(session) {
    return {
      id: session.id || newSessionId(),
      startedAt: session.startedAt || new Date().toISOString(),
      endedAt: session.endedAt || null,
      isRecording: !!session.isRecording,
      points: Array.isArray(session.points) ? session.points : [],
      totalDistanceM: Number(session.totalDistanceM || 0),
      activeTimeS: Number(session.activeTimeS || 0),
      elapsedTimeS: Number(session.elapsedTimeS || 0),
      avgSpeedKmh: Number(session.avgSpeedKmh || 0),
      maxSpeedKmh: Number(session.maxSpeedKmh || 0),
      resort: session.resort || "Sauze d'Oulx"
    };
  }

  function newSessionId() {
    if (crypto && crypto.randomUUID) return crypto.randomUUID();
    return "sess_" + Date.now() + "_" + Math.random().toString(16).slice(2);
  }

  function toRad(v) {
    return v * Math.PI / 180;
  }

  function metersBetween(a, b) {
    const R = 6371000;
    const dLat = toRad(b.lat - a.lat);
    const dLon = toRad(b.lng - a.lng);
    const lat1 = toRad(a.lat);
    const lat2 = toRad(b.lat);
    const h =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  function kmhFromPoints(a, b) {
    const dtS = Math.max(0, (b.t - a.t) / 1000);
    if (dtS <= 0) return 0;
    const dM = metersBetween(a, b);
    return (dM / dtS) * 3.6;
  }

  function formatDistance(m) {
    if (m >= 1000) return (m / 1000).toFixed(1) + " km";
    return Math.round(m) + " m";
  }

  function formatTime(sec) {
    sec = Math.max(0, Math.round(sec));
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;

    if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
    if (m > 0) return `${m}m ${String(s).padStart(2, "0")}s`;
    return `${s}s`;
  }

  function formatDate(iso) {
    try {
      return new Date(iso).toLocaleString("it-IT");
    } catch {
      return iso || "—";
    }
  }

  function computeSessionStats(session) {
    const s = ensureSessionShape(session);
    const pts = s.points;

    let distance = 0;
    let movingTime = 0;
    let elapsed = 0;
    let maxSpeed = 0;

    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      const d = metersBetween(a, b);
      const dtS = Math.max(0, (b.t - a.t) / 1000);
      const speed = dtS > 0 ? (d / dtS) * 3.6 : 0;

      if (speed <= MAX_REASONABLE_SPEED_KMH) {
        distance += d;
        elapsed += dtS;
        if (speed >= ACTIVE_SPEED_THRESHOLD_KMH) movingTime += dtS;
        if (speed > maxSpeed) maxSpeed = speed;
      }
    }

    if (pts.length >= 2 && elapsed <= 0) {
      elapsed = Math.max(0, (pts[pts.length - 1].t - pts[0].t) / 1000);
    }

    const avgSpeed = movingTime > 0 ? ((distance / movingTime) * 3.6) : 0;

    s.totalDistanceM = distance;
    s.activeTimeS = movingTime;
    s.elapsedTimeS = elapsed;
    s.avgSpeedKmh = avgSpeed;
    s.maxSpeedKmh = maxSpeed;

    return s;
  }

  function updateTrackInfo(text) {
    const el = $("trackInfo");
    if (el) el.textContent = text;
  }

  function activeSessionSummary(session) {
    const s = computeSessionStats(session);
    if (!s.points.length) return "Tracking attivo • in attesa del primo punto";
    return `Tracking attivo • ${s.points.length} punti • ${formatDistance(s.totalDistanceM)} • media ${s.avgSpeedKmh.toFixed(1)} km/h • max ${s.maxSpeedKmh.toFixed(1)} km/h`;
  }

  function latestSession() {
    const history = getHistory();
    if (!history.length) return null;
    return history[0];
  }

  function updateDashboard() {
    const history = getHistory();

    let totalDistance = 0;
    let totalActive = 0;
    let weightedSpeedNumerator = 0;
    let maxSpeed = 0;

    for (const raw of history) {
      const s = computeSessionStats(raw);
      totalDistance += s.totalDistanceM;
      totalActive += s.activeTimeS;
      weightedSpeedNumerator += s.avgSpeedKmh * s.activeTimeS;
      if (s.maxSpeedKmh > maxSpeed) maxSpeed = s.maxSpeedKmh;
    }

    const avgSpeed = totalActive > 0 ? weightedSpeedNumerator / totalActive : 0;

    if ($("dashSessions")) $("dashSessions").textContent = String(history.length);
    if ($("dashDistance")) $("dashDistance").textContent = formatDistance(totalDistance);
    if ($("dashTime")) $("dashTime").textContent = formatTime(totalActive);
    if ($("dashAvgSpeed")) $("dashAvgSpeed").textContent = avgSpeed.toFixed(1) + " km/h";
    if ($("dashMaxSpeed")) $("dashMaxSpeed").textContent = maxSpeed.toFixed(1) + " km/h";
  }

  function renderHistory() {
    const el = $("trackHistory");
    if (!el) return;

    const history = getHistory();

    if (!history.length) {
      el.innerHTML = "Nessuna registrazione salvata.";
      return;
    }

    el.innerHTML = history.slice(0, 12).map((raw, index) => {
      const s = computeSessionStats(raw);
      const started = formatDate(s.startedAt);
      const ended = s.endedAt ? formatDate(s.endedAt) : "In corso";
      return `
        <div class="history-card">
          <div class="history-title">Sessione ${history.length - index}</div>
          <div class="history-meta">
            <strong>Inizio:</strong> ${started}<br>
            <strong>Fine:</strong> ${ended}<br>
            <strong>Distanza:</strong> ${formatDistance(s.totalDistanceM)}<br>
            <strong>Tempo attivo:</strong> ${formatTime(s.activeTimeS)}<br>
            <strong>Velocità media:</strong> ${s.avgSpeedKmh.toFixed(1)} km/h<br>
            <strong>Velocità massima:</strong> ${s.maxSpeedKmh.toFixed(1)} km/h<br>
            <strong>Punti:</strong> ${s.points.length}
          </div>
        </div>
      `;
    }).join("");
  }

  function syncUI() {
    updateDashboard();
    renderHistory();

    const active = getActiveSession();
    if (active && active.isRecording) {
      updateTrackInfo(activeSessionSummary(active));
    } else {
      const latest = latestSession();
      if (latest) {
        const s = computeSessionStats(latest);
        updateTrackInfo(
          `Ultima sessione • ${formatDistance(s.totalDistanceM)} • media ${s.avgSpeedKmh.toFixed(1)} km/h • max ${s.maxSpeedKmh.toFixed(1)} km/h`
        );
      } else {
        updateTrackInfo("Tracking fermo");
      }
    }
  }

  function createMapLibreReplayInfrastructure() {
    if (currentMapType !== "maplibre") return;
    if (maplibreReplaySourceReady) return;

    if (!currentMap.getSource("tracking-replay")) {
      currentMap.addSource("tracking-replay", {
        type: "geojson",
        data: {
          type: "FeatureCollection",
          features: []
        }
      });
    }

    if (!currentMap.getLayer("tracking-replay-line")) {
      currentMap.addLayer({
        id: "tracking-replay-line",
        type: "line",
        source: "tracking-replay",
        paint: {
          "line-color": "#ffffff",
          "line-width": 4.5,
          "line-opacity": 0.92
        },
        layout: {
          "line-join": "round",
          "line-cap": "round"
        }
      });
    }

    maplibreReplaySourceReady = true;
  }

  function clearReplay() {
    if (replayHandle) {
      cancelAnimationFrame(replayHandle);
      replayHandle = null;
    }

    if (currentMapType === "leaflet" && leafletReplayLayer) {
      leafletReplayLayer.remove();
      leafletReplayLayer = null;
    }

    if (currentMapType === "maplibre" && currentMap && currentMap.getSource("tracking-replay")) {
      currentMap.getSource("tracking-replay").setData({
        type: "FeatureCollection",
        features: []
      });
    }
  }

  function fitBoundsMapLibre(points) {
    if (!points.length) return;
    let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity;
    for (const p of points) {
      if (p.lng < minLng) minLng = p.lng;
      if (p.lat < minLat) minLat = p.lat;
      if (p.lng > maxLng) maxLng = p.lng;
      if (p.lat > maxLat) maxLat = p.lat;
    }
    currentMap.fitBounds([[minLng, minLat], [maxLng, maxLat]], { padding: 50, duration: 700 });
  }

  function replayLatest() {
    const latest = latestSession();
    if (!latest || !latest.points || latest.points.length < 2) {
      alert("Nessuna traccia da riprodurre. Registra prima.");
      return;
    }

    const pts = latest.points;
    clearReplay();

    if (currentMapType === "leaflet") {
      const latlngs = pts.map(p => [p.lat, p.lng]);
      if (!window.L) return;

      leafletReplayLayer = L.polyline([], {
        weight: 5,
        opacity: 0.95
      }).addTo(currentMap);

      currentMap.fitBounds(L.latLngBounds(latlngs), { padding: [40, 40] });

      let i = 0;
      function step() {
        i++;
        leafletReplayLayer.setLatLngs(latlngs.slice(0, i));
        if (i < latlngs.length) {
          replayHandle = requestAnimationFrame(step);
        }
      }
      step();
      return;
    }

    if (currentMapType === "maplibre") {
      createMapLibreReplayInfrastructure();
      fitBoundsMapLibre(pts);

      const coords = pts.map(p => [p.lng, p.lat]);
      let i = 2;

      function pushFrame() {
        const feature = {
          type: "Feature",
          geometry: {
            type: "LineString",
            coordinates: coords.slice(0, i)
          },
          properties: {}
        };

        currentMap.getSource("tracking-replay").setData({
          type: "FeatureCollection",
          features: [feature]
        });

        if (i < coords.length) {
          i += 1;
          replayHandle = requestAnimationFrame(pushFrame);
        }
      }

      pushFrame();
    }
  }

  function ensureUserMarker(position) {
    if (!currentMap) return;

    if (currentMapType === "leaflet") {
      if (!window.L) return;

      if (!leafletUserMarker) {
        leafletUserMarker = L.circleMarker([position.lat, position.lng], {
          radius: 8,
          weight: 3,
          fillOpacity: 0.75
        }).addTo(currentMap);
      } else {
        leafletUserMarker.setLatLng([position.lat, position.lng]);
      }
      return;
    }

    if (currentMapType === "maplibre") {
      if (!maplibreUserMarker) {
        const el = document.createElement("div");
        el.className = "user-dot";
        maplibreUserMarker = new maplibregl.Marker({ element: el, anchor: "center" })
          .setLngLat([position.lng, position.lat])
          .addTo(currentMap);
      } else {
        maplibreUserMarker.setLngLat([position.lng, position.lat]);
      }
    }
  }

  function saveFinishedSession(session) {
    const history = getHistory();
    const computed = computeSessionStats({
      ...session,
      endedAt: new Date().toISOString(),
      isRecording: false
    });

    history.unshift(computed);
    setHistory(history);
    clearActiveSession();
    syncUI();
  }

  function startTracking() {
    if (!navigator.geolocation) {
      alert("Geolocalizzazione non supportata.");
      return;
    }

    if (watchId !== null || isTrackingActive()) {
      updateTrackInfo("Tracking già attivo");
      return;
    }

    clearReplay();

    const session = ensureSessionShape({
      id: newSessionId(),
      startedAt: new Date().toISOString(),
      endedAt: null,
      isRecording: true,
      points: [],
      totalDistanceM: 0,
      activeTimeS: 0,
      elapsedTimeS: 0,
      avgSpeedKmh: 0,
      maxSpeedKmh: 0,
      resort: "Sauze d'Oulx"
    });

    setActiveSession(session);
    syncUI();

    watchId = navigator.geolocation.watchPosition(
      (pos) => {
        const active = ensureSessionShape(getActiveSession() || session);

        const point = {
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          t: Date.now(),
          accuracy: Number(pos.coords.accuracy || 0),
          altitude: Number.isFinite(pos.coords.altitude) ? pos.coords.altitude : null,
          speedKmh: Number.isFinite(pos.coords.speed) && pos.coords.speed !== null
            ? pos.coords.speed * 3.6
            : null
        };

        const last = active.points[active.points.length - 1];
        if (last) {
          const d = metersBetween(last, point);
          if (d < MIN_POINT_DISTANCE_METERS) {
            ensureUserMarker(point);
            return;
          }

          const calcSpeed = kmhFromPoints(last, point);
          if (calcSpeed > MAX_REASONABLE_SPEED_KMH) {
            ensureUserMarker(point);
            return;
          }
        }

        active.points.push(point);

        const updated = computeSessionStats(active);
        updated.isRecording = true;
        setActiveSession(updated);

        ensureUserMarker(point);
        syncUI();
      },
      (err) => {
        console.error(err);
        alert("Errore GPS: " + err.message);
      },
      {
        enableHighAccuracy: true,
        maximumAge: 1000,
        timeout: 10000
      }
    );
  }

  function stopTracking() {
    if (watchId !== null) {
      navigator.geolocation.clearWatch(watchId);
      watchId = null;
    }

    const active = getActiveSession();
    if (!active || !active.points || active.points.length < 2) {
      clearActiveSession();
      syncUI();
      updateTrackInfo("Tracking fermo");
      return;
    }

    saveFinishedSession(active);
  }

  function bindButtons() {
    if ($("trackStart")) $("trackStart").onclick = startTracking;
    if ($("trackStop")) $("trackStop").onclick = stopTracking;
    if ($("trackReplayLatest")) $("trackReplayLatest").onclick = replayLatest;

    const heatBtn = $("btnHeatmap");
    if (heatBtn && !heatBtn.dataset.bound) {
      const enabled = loadJSON(STORAGE_HEATMAP, true);
      heatBtn.textContent = "🔥 Heatmap: " + (enabled ? "ON" : "OFF");
      heatBtn.onclick = () => {
        const next = !loadJSON(STORAGE_HEATMAP, true);
        saveJSON(STORAGE_HEATMAP, next);
        heatBtn.textContent = "🔥 Heatmap: " + (next ? "ON" : "OFF");
      };
      heatBtn.dataset.bound = "1";
    }
  }

  function resumeStateIfNeeded() {
    const active = getActiveSession();
    if (!active || !active.isRecording) {
      syncUI();
      return;
    }

    syncUI();

    if (watchId !== null || !navigator.geolocation) return;

    watchId = navigator.geolocation.watchPosition(
      (pos) => {
        const session = ensureSessionShape(getActiveSession() || active);

        const point = {
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          t: Date.now(),
          accuracy: Number(pos.coords.accuracy || 0),
          altitude: Number.isFinite(pos.coords.altitude) ? pos.coords.altitude : null,
          speedKmh: Number.isFinite(pos.coords.speed) && pos.coords.speed !== null
            ? pos.coords.speed * 3.6
            : null
        };

        const last = session.points[session.points.length - 1];
        if (last) {
          const d = metersBetween(last, point);
          if (d < MIN_POINT_DISTANCE_METERS) {
            ensureUserMarker(point);
            return;
          }

          const calcSpeed = kmhFromPoints(last, point);
          if (calcSpeed > MAX_REASONABLE_SPEED_KMH) {
            ensureUserMarker(point);
            return;
          }
        }

        session.points.push(point);

        const updated = computeSessionStats(session);
        updated.isRecording = true;
        setActiveSession(updated);

        ensureUserMarker(point);
        syncUI();
      },
      (err) => {
        console.error(err);
      },
      {
        enableHighAccuracy: true,
        maximumAge: 1000,
        timeout: 10000
      }
    );
  }

  function commonInit(map, type) {
    currentMap = map;
    currentMapType = type;

    bindButtons();

    if (type === "maplibre") {
      if (map.isStyleLoaded()) {
        createMapLibreReplayInfrastructure();
      } else {
        map.on("load", () => createMapLibreReplayInfrastructure());
      }
    }

    syncUI();
    resumeStateIfNeeded();
  }

  window.SkiSmartTracking = {
    initLeaflet(map) {
      commonInit(map, "leaflet");
    },
    initMapLibre(map) {
      commonInit(map, "maplibre");
    },
    stopTracking,
    startTracking,
    syncUI
  };

  window.addEventListener("storage", (ev) => {
    if (ev.key === STORAGE_HISTORY || ev.key === STORAGE_ACTIVE) {
      syncUI();
    }
  });
})();
