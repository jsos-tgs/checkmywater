document.addEventListener("DOMContentLoaded", () => {
  // ---- Sélecteurs DOM ----
  const statusEl = document.getElementById("status");
  const deptSelect = document.getElementById("dept");
  const btn = document.getElementById("loadDept");
  const LIMIT_RED = 0.1;
  const LIMIT_AMB = 0.05;

  // Sanity check DOM
  if (!statusEl || !deptSelect || !btn) {
    console.error("❌ Elements manquants dans le DOM (status/dept/button)");
    alert("Erreur d’initialisation de la page. Rechargez et réessayez.");
    return;
  }

  // ---- Init Leaflet ----
  let map, cluster;
  try {
    map = L.map("map", { preferCanvas: true }).setView([46.8, 2.5], 7);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "© OpenStreetMap contributors"
    }).addTo(map);
    cluster = L.markerClusterGroup({ chunkedLoading: true, maxClusterRadius: 60 });
    map.addLayer(cluster);
    console.log("✅ Leaflet initialisé");
  } catch (e) {
    console.error("❌ Leaflet init error:", e);
    alert("Impossible d’initialiser la carte.");
    return;
  }

  // ---- Utils ----
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  async function getJSON(url, tries = 4, timeout = 30000) {
    for (let i = 0; i < tries; i++) {
      try {
        const ctrl = new AbortController();
        const to = setTimeout(() => ctrl.abort(), timeout);
        const res = await fetch(url, { signal: ctrl.signal, headers: { "Accept": "application/json" } });
        clearTimeout(to);
        if (res.ok) return res.json();
        if (res.status === 429 || res.status >= 500) { await sleep(800 * (i + 1)); continue; }
        throw new Error(`HTTP ${res.status} ${url}`);
      } catch (e) {
        if (i === tries - 1) throw e;
        await sleep(800 * (i + 1));
      }
    }
  }

  const GEO_COMMUNES = (dept) => `https://geo.api.gouv.fr/departements/${dept}/communes?fields=code,nom,centre&format=json&geometry=centre`;
  const HUBEAU_COMMUNE = (insee) => `https://hubeau.eaufrance.fr/api/v1/qualite_eau_potable/resultats_dis?code_commune=${encodeURIComponent(insee)}&size=300&format=json`;
  const PFAS_REGEX = /(pfas|perfluoro|polyfluoro|fluoroalkyl|perfluoro(carboxyl|sulfon))/i;

  function colorFor(v) {
    if (v == null || Number.isNaN(v)) return "grey";
    if (v > LIMIT_RED) return "red";
    if (v >= LIMIT_AMB) return "amber";
    return "green";
  }
  function styleFor(v) {
    const c = colorFor(v);
    const palette = {
      green: { color: "#2e7d32", fillColor: "#2e7d32" },
      amber: { color: "#f9a825", fillColor: "#f9a825" },
      red:   { color: "#c62828", fillColor: "#c62828" },
      grey:  { color: "#9e9e9e", fillColor: "#9e9e9e" },
    }[c];
    return { radius: 6, weight: 1, opacity: 1, fillOpacity: .7, ...palette };
  }
  function badgeFor(v) {
    const c = colorFor(v);
    if (c === "green") return '<span class="badge safe">Conforme</span>';
    if (c === "amber") return '<span class="badge warn">À surveiller</span>';
    if (c === "red")   return '<span class="badge risk">Dépassement</span>';
    return '<span class="badge na">Non mesuré</span>';
  }

  async function fetchPFASForCommune(insee) {
    const json = await getJSON(HUBEAU_COMMUNE(insee));
    const rows = json?.data || [];
    let best = null;
    for (const r of rows) {
      const label = r.libelle_parametre || r.parametre || "";
      if (!PFAS_REGEX.test(label)) continue;
      const val = r.resultat !== undefined ? Number(r.resultat) : NaN;
      if (Number.isNaN(val)) continue;
      const date = r.date_prelevement || r.date_analyse || "";
      if (!best || (date && best.date && date > best.date) || (!best.date && date)) {
        best = { value: val, date };
      }
    }
    return best; // null si non trouvé
  }

  async function mapWithConcurrency(items, limit, worker) {
    const ret = new Array(items.length);
    let idx = 0;
    const runners = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
      while (idx < items.length) {
        const i = idx++;
        try { ret[i] = await worker(items[i], i); }
        catch (e) { console.warn("Worker error", e); ret[i] = null; }
      }
    });
    await Promise.all(runners);
    return ret;
  }

  async function loadDepartment(deptCode) {
    try {
      if (!deptCode) {
        alert("Choisis un département dans la liste.");
        return;
      }
      btn.disabled = true;
      statusEl.textContent = "Chargement des communes…";
      cluster.clearLayers();

      // 1) Communes + recentrage
      let communes = await getJSON(GEO_COMMUNES(deptCode));
      if (!Array.isArray(communes) || communes.length === 0) {
        statusEl.textContent = "Aucune commune trouvée pour ce département.";
        btn.disabled = false;
        return;
      }
      communes = communes
        .filter(c => c?.centre?.coordinates)
        .map(c => ({
          insee: c.code,
          name: c.nom,
          lat: c.centre.coordinates[1],
          lon: c.centre.coordinates[0]
        }));
      const bounds = communes.map(c => [c.lat, c.lon]);
      if (bounds.length) map.fitBounds(bounds, { padding: [30, 30] });

      // 2) PFAS par commune
      let done = 0, withData = 0;
      statusEl.textContent = `Analyses PFAS… (0 / ${communes.length})`;
      const results = await mapWithConcurrency(communes, 6, async (c) => {
        try {
          const pf = await fetchPFASForCommune(c.insee);
          done++; if (pf) withData++;
          if (done % 10 === 0 || done === communes.length) {
            statusEl.textContent = `Analyses PFAS… (${done} / ${communes.length}) — trouvées: ${withData}`;
          }
          return { ...c, pfas: pf?.value ?? null, date: pf?.date ?? null };
        } catch (e) {
          done++;
          statusEl.textContent = `Analyses PFAS… (${done} / ${communes.length})`;
          return { ...c, pfas: null, date: null };
        }
      });

      // 3) Affichage
      for (const r of results) {
        if (!r) continue;
        const m = L.circleMarker([r.lat, r.lon], styleFor(r.pfas)).bindPopup(`
          <strong>${r.name}</strong><br/>
          PFAS : ${r.pfas == null ? "N/A" : r.pfas + " µg/L"}<br/>
          Limite 2026 : ${LIMIT_RED} µg/L<br/>
          ${badgeFor(r.pfas)}
          ${r.date ? `<br/><small>Mesure : ${r.date}</small>` : ""}
        `);
        cluster.addLayer(m);
      }

      statusEl.textContent = `Terminé : ${communes.length} communes — mesures PFAS trouvées : ${withData}`;
    } catch (err) {
      console.error("❌ loadDepartment error:", err);
      statusEl.textContent = "Erreur lors du chargement. Réessaie.";
      alert("Erreur réseau ou API. Essaie un autre département ou réessaie.");
    } finally {
      btn.disabled = false;
    }
  }

  // ---- Wiring UI ----
  // Active/désactive le bouton selon la sélection
  btn.disabled = !deptSelect.value;
  deptSelect.addEventListener("change", () => {
    btn.disabled = !deptSelect.value;
  });

  // Click handler
  btn.addEventListener("click", () => {
    console.log("▶️  Click sur Charger le département, code =", deptSelect.value);
    loadDepartment(deptSelect.value);
  });

  console.log("✅ map.js prêt. Sélectionne un département puis clique sur le bouton.");
});
