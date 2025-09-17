document.addEventListener("DOMContentLoaded", () => {
  const statusEl = document.getElementById("status");
  const deptSelect = document.getElementById("dept");
  const btn = document.getElementById("loadDept");

  const LIMIT_RED = 0.1;   // > 0.1 µg/L => non conforme 2026
  const LIMIT_AMB = 0.05;  // 0.05–0.1 µg/L => à surveiller

  // ---- Leaflet init ----
  let map = L.map("map", { preferCanvas: true }).setView([46.8, 2.5], 7);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "© OpenStreetMap contributors"
  }).addTo(map);
  let cluster = L.markerClusterGroup({ chunkedLoading: true, maxClusterRadius: 60 });
  map.addLayer(cluster);

  // ---- Utils HTTP ----
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  async function getJSON(url, tries=4, timeout=30000) {
    for (let i=0;i<tries;i++) {
      try {
        const ctrl = new AbortController();
        const to = setTimeout(()=>ctrl.abort(), timeout);
        const res = await fetch(url, { signal: ctrl.signal, headers: { "Accept":"application/json" }});
        clearTimeout(to);
        if (res.ok) return res.json();
        if (res.status === 429 || res.status >= 500) { await sleep(800*(i+1)); continue; }
        throw new Error(`HTTP ${res.status} ${url}`);
      } catch(e) {
        if (i === tries-1) throw e;
        await sleep(800*(i+1));
      }
    }
  }

  // ---- APIs ----
  const GEO_DEPTS = `https://geo.api.gouv.fr/departements?fields=code,nom&format=json`;
  const GEO_COMMUNES = (dept) => `https://geo.api.gouv.fr/departements/${dept}/communes?fields=code,nom,centre&format=json&geometry=centre`;
  const HUBEAU_COMMUNE = (insee) => `https://hubeau.eaufrance.fr/api/v1/qualite_eau_potable/resultats_dis?code_commune=${encodeURIComponent(insee)}&size=300&format=json`;
  const PFAS_REGEX = /(pfas|perfluoro|polyfluoro|fluoroalkyl|perfluoro(carboxyl|sulfon))/i;

  // ---- UI helpers ----
  function colorFor(v) {
    if (v == null || Number.isNaN(v)) return "grey";
    if (v > LIMIT_RED) return "red";
    if (v >= LIMIT_AMB) return "amber";
    return "green";
  }
  function styleFor(v) {
    const c = colorFor(v);
    const palette = {
      green:{color:"#2e7d32",fillColor:"#2e7d32"},
      amber:{color:"#f9a825",fillColor:"#f9a825"},
      red:{color:"#c62828",fillColor:"#c62828"},
      grey:{color:"#9e9e9e",fillColor:"#9e9e9e"},
    }[c];
    return { radius:6, weight:1, opacity:1, fillOpacity:.7, ...palette };
  }
  function badgeFor(v){
    const c = colorFor(v);
    if (c==="green") return '<span class="badge safe">Conforme</span>';
    if (c==="amber") return '<span class="badge warn">À surveiller</span>';
    if (c==="red")   return '<span class="badge risk">Dépassement</span>';
    return '<span class="badge na">Non mesuré</span>';
  }

  // tri des codes pour gérer 2A/2B correctement
  const codeOrder = (code) => {
    if (code === "2A") return 20.1;
    if (code === "2B") return 20.2;
    const n = parseInt(code, 10);
    return Number.isNaN(n) ? 999 : n; // 971..976 > métropole
  };

  // ---- Remplit TOUS les départements automatiquement ----
  (async function populateDepartments(){
    try {
      statusEl.textContent = "Chargement des départements…";
      const list = await getJSON(GEO_DEPTS);
      // tri par code (01..19, 2A, 2B, 21..95, 971..976)
      list.sort((a,b) => codeOrder(a.code) - codeOrder(b.code) || a.code.localeCompare(b.code));
      // remplit le select
      deptSelect.innerHTML = `<option value="">Choisir un département…</option>` +
        list.map(d => `<option value="${d.code}">${d.code} — ${d.nom}</option>`).join("");
      btn.disabled = !deptSelect.value;
      statusEl.textContent = "";
    } catch(e) {
      console.error("Chargement départements échoué:", e);
      deptSelect.innerHTML = `<option value="">Impossible de charger les départements</option>`;
      statusEl.textContent = "Erreur de chargement des départements.";
    }
  })();

  // ---- Récup PFAS pour une commune (valeur la plus récente) ----
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
    return best; // null si rien trouvé
  }

  // petite file d'attente
  async function mapWithConcurrency(items, limit, worker){
    const ret = new Array(items.length);
    let idx = 0;
    const runners = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
      while(idx < items.length){
        const i = idx++;
        try { ret[i] = await worker(items[i], i); }
        catch(e){ ret[i] = null; }
      }
    });
    await Promise.all(runners);
    return ret;
  }

  // ---- Chargement d’un département ----
  async function loadDepartment(deptCode){
    if(!deptCode) return;
    btn.disabled = true;
    statusEl.textContent = "Chargement des communes…";
    cluster.clearLayers();

    // 1) communes + recentrage
    let communes = await getJSON(GEO_COMMUNES(deptCode));
    communes = (communes || [])
      .filter(c => c?.centre?.coordinates)
      .map(c => ({
        insee: c.code,
        name: c.nom,
        lat: c.centre.coordinates[1],
        lon: c.centre.coordinates[0]
      }));

    if (communes.length) {
      const bounds = communes.map(c => [c.lat, c.lon]);
      map.fitBounds(bounds, { padding:[30,30] });
    }

    // 2) PFAS pour chaque commune (concurrence limitée)
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
      } catch {
        done++;
        statusEl.textContent = `Analyses PFAS… (${done} / ${communes.length})`;
        return { ...c, pfas: null, date: null };
      }
    });

    // 3) affichage
    for (const r of results) {
      if (!r) continue;
      const m = L.circleMarker([r.lat, r.lon], styleFor(r.pfas)).bindPopup(`
        <strong>${r.name}</strong><br/>
        PFAS : ${r.pfas==null ? "N/A" : r.pfas + " µg/L"}<br/>
        Limite 2026 : ${LIMIT_RED} µg/L<br/>
        ${badgeFor(r.pfas)}
        ${r.date ? `<br/><small>Mesure : ${r.date}</small>` : ""}
      `);
      cluster.addLayer(m);
    }

    statusEl.textContent = `Terminé : ${communes.length} communes — mesures PFAS trouvées : ${withData}`;
    btn.disabled = false;
  }

  // ---- Wiring UI ----
  deptSelect.addEventListener("change", () => {
    btn.disabled = !deptSelect.value;
  });
  btn.addEventListener("click", () => loadDepartment(deptSelect.value));
});
