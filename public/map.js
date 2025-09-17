document.addEventListener("DOMContentLoaded", () => {
  const statusEl = document.getElementById("status");
  const deptSelect = document.getElementById("dept");
  const btn = document.getElementById("loadDept");
  const toggleLegendBtn = document.getElementById("toggleLegendBtn");
  const methodSelect = document.getElementById("method");

  // Seuils 2026 (à ajuster si besoin)
  const LIMIT_RED = 0.1;   // µg/L — limite pour l’évaluation finale
  const LIMIT_AMB = 0.05;  // µg/L — “à surveiller”

  // --- Carte
  const map = L.map("map", { preferCanvas: true }).setView([46.8, 2.5], 7);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "© OpenStreetMap contributors"
  }).addTo(map);
  const cluster = L.markerClusterGroup({ chunkedLoading: true, maxClusterRadius: 60 });
  map.addLayer(cluster);

  // --- Légende control
  let legendEl;
  const legend = L.control({ position: "bottomright" });
  legend.onAdd = function(){
    const div = L.DomUtil.create("div", "legend");
    div.innerHTML = `
      <strong>Légende</strong><br>
      <span class="dot safe"></span> Conforme (&lt; 0.05 µg/L)<br>
      <span class="dot warn"></span> À surveiller (0.05–0.1 µg/L)<br>
      <span class="dot risk"></span> Dépassement (&gt; 0.1 µg/L)<br>
      <span class="dot na"></span> Non mesuré<br>
      <hr style="border:none;border-top:1px solid #eee;margin:6px 0">
      <small>Les chiffres sur les gros cercles = communes regroupées (cluster)</small>
    `;
    legendEl = div;
    return div;
  };
  legend.addTo(map);

  let legendVisible = true;
  function setLegendVisible(show){
    legendVisible = !!show;
    if (legendEl) legendEl.style.display = legendVisible ? "block" : "none";
    toggleLegendBtn.setAttribute("aria-pressed", legendVisible ? "true" : "false");
  }
  toggleLegendBtn.addEventListener("click", () => setLegendVisible(!legendVisible));
  setLegendVisible(true);

  // --- Utils HTTP
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  async function getJSON(url, tries=4, timeout=30000){
    for(let i=0;i<tries;i++){
      try{
        const ctrl = new AbortController();
        const to = setTimeout(()=>ctrl.abort(), timeout);
        const res = await fetch(url, { signal: ctrl.signal, headers:{Accept:"application/json"}});
        clearTimeout(to);
        if (res.ok) return res.json();
        if (res.status===429 || res.status>=500){ await sleep(800*(i+1)); continue; }
        throw new Error(`HTTP ${res.status} ${url}`);
      }catch(e){
        if (i===tries-1) throw e;
        await sleep(800*(i+1));
      }
    }
  }

  // --- APIs
  const GEO_DEPTS = `https://geo.api.gouv.fr/departements?fields=code,nom&format=json`;
  const GEO_COMMUNES = (dept) => `https://geo.api.gouv.fr/departements/${dept}/communes?fields=code,nom,centre&format=json&geometry=centre`;
  const HUBEAU_COMMUNE = (insee) => `https://hubeau.eaufrance.fr/api/v1/qualite_eau_potable/resultats_dis?code_commune=${encodeURIComponent(insee)}&size=500&format=json`;

  // --- Détection PFAS
  // “Somme PFAS” (libellés variables : sum, total, somme…)
  const SUM_REGEX = /(somme|sum|total).*(pfas)|pfas.*(somme|sum|total)/i;
  // Molécules PFAS (perfluoro…, polyfluoro…, etc.)
  const PFAS_REGEX = /(pfas|perfluoro|polyfluoro|fluoroalkyl|perfluoro(carboxyl|sulfon))/i;

  // --- Couleurs
  function colorFor(v){
    if (v == null || Number.isNaN(v)) return "grey";
    if (v > LIMIT_RED) return "red";
    if (v >= LIMIT_AMB) return "amber";
    return "green";
  }
  function styleFor(v){
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

  // --- Classement des départements (gère 2A/2B)
  const codeOrder = (code) => {
    if (code==="2A") return 20.1;
    if (code==="2B") return 20.2;
    const n = parseInt(code,10);
    return Number.isNaN(n) ? 999 : n;
  };

  // --- Charger la liste complète des départements
  (async function populateDepartments(){
    try{
      statusEl.textContent = "Chargement des départements…";
      const list = await getJSON(GEO_DEPTS);
      list.sort((a,b)=> codeOrder(a.code)-codeOrder(b.code) || a.code.localeCompare(b.code));
      deptSelect.innerHTML = `<option value="">Choisir un département…</option>` +
        list.map(d=>`<option value="${d.code}">${d.code} — ${d.nom}</option>`).join("");
      btn.disabled = !deptSelect.value;
      statusEl.textContent = "";
    }catch(e){
      console.error(e);
      deptSelect.innerHTML = `<option value="">Impossible de charger les départements</option>`;
      statusEl.textContent = "Erreur de chargement des départements.";
    }
  })();

  // --- Analyse d’une commune : agrégation précise
  function aggregatePFAS(rows, method){
    // rows: lignes Hub’Eau pour une commune (paramètre, valeur, unité, date…)
    if (!rows || !rows.length) return null;

    // 1) Essayer de trouver une "somme PFAS" explicite
    const sums = rows
      .filter(r => {
        const label = (r.libelle_parametre || r.parametre || "");
        return SUM_REGEX.test(label);
      })
      .map(r => ({
        label: r.libelle_parametre || r.parametre || "",
        value: (r.resultat!=null ? Number(r.resultat) : NaN),
        unit: r.unite || r.unite_resultat || "µg/L",
        date: r.date_prelevement || r.date_analyse || ""
      }))
      .filter(x => !Number.isNaN(x.value));

    // 2) PFAS individuels
    const individuals = rows
      .filter(r => {
        const label = (r.libelle_parametre || r.parametre || "");
        return PFAS_REGEX.test(label) && !SUM_REGEX.test(label);
      })
      .map(r => ({
        label: r.libelle_parametre || r.parametre || "",
        value: (r.resultat!=null ? Number(r.resultat) : NaN),
        unit: r.unite || r.unite_resultat || "µg/L",
        date: r.date_prelevement || r.date_analyse || ""
      }))
      .filter(x => !Number.isNaN(x.value));

    // Helper: garde la mesure la plus récente
    const latest = (arr) => {
      if (!arr.length) return null;
      return arr.reduce((a,b)=> (a.date && b.date && b.date > a.date) ? b : a, arr[0]);
    };

    // Méthodes
    if (method === "max_only"){
      const latestByLabel = {};
      for (const x of individuals){
        if (!latestByLabel[x.label] || (x.date && latestByLabel[x.label].date < x.date)){
          latestByLabel[x.label] = x;
        }
      }
      const best = Object.values(latestByLabel).reduce((m,x)=> (m && m.value > x.value) ? m : x, null);
      return best ? { mode:"max_only", value:best.value, unit:best.unit, date:best.date, details:{picked:best, nIndividuals:individuals.length, nSums:sums.length} } : null;
    }

    if (method === "strict"){
      // strict: dépassement si UNE molécule > 0.1
      const latestByLabel = {};
      for (const x of individuals){
        if (!latestByLabel[x.label] || (x.date && latestByLabel[x.label].date < x.date)){
          latestByLabel[x.label] = x;
        }
      }
      const arr = Object.values(latestByLabel);
      const over = arr.filter(x => x.value > LIMIT_RED);
      const picked = over.length ? over.reduce((m,x)=> (m && m.value> x.value? m : x), null) : latest(arr);
      if (!picked) return sums.length ? { mode:"sum_first", value: latest(sums).value, unit: latest(sums).unit, date: latest(sums).date, details:{picked:latest(sums), nIndividuals:individuals.length, nSums:sums.length} } : null;
      return { mode:"strict", value:picked.value, unit:picked.unit, date:picked.date, details:{picked, nIndividuals:individuals.length, nSums:sums.length} };
    }

    // défaut: sum_first — si somme dispo, on la prend (mesure la plus récente), sinon max
    const sumPick = latest(sums);
    if (sumPick){
      return { mode:"sum_first", value: sumPick.value, unit: sumPick.unit, date: sumPick.date, details:{picked:sumPick, nIndividuals:individuals.length, nSums:sums.length} };
    }
    // sinon max des individuels (mesure la plus élevée parmi les plus récentes par molécule)
    const latestByLabel = {};
    for (const x of individuals){
      if (!latestByLabel[x.label] || (x.date && latestByLabel[x.label].date < x.date)){
        latestByLabel[x.label] = x;
      }
    }
    const maxPick = Object.values(latestByLabel).reduce((m,x)=> (m && m.value > x.value) ? m : x, null);
    return maxPick ? { mode:"max_fallback", value:maxPick.value, unit:maxPick.unit, date:maxPick.date, details:{picked:maxPick, nIndividuals:individuals.length, nSums:sums.length} } : null;
  }

  // PFAS fetch pour une commune, puis agrégation
  async function fetchAggPFASForCommune(insee, method){
    const url = HUBEAU_COMMUNE(insee);
    const json = await getJSON(url);
    const rows = json?.data || [];
    const agg = aggregatePFAS(rows, method);
    // on ajoute des méta utiles pour la popup
    const countAll = rows.length;
    return { agg, countAll };
  }

  // Petite file d'attente
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

  // Charger un département
  async function loadDepartment(deptCode){
    if(!deptCode) return;
    btn.disabled = true;
    statusEl.textContent = "Chargement des communes…";
    cluster.clearLayers();

    // communes
    let communes = await getJSON(GEO_COMMUNES(deptCode));
    communes = (communes || [])
      .filter(c => c?.centre?.coordinates)
      .map(c => ({ insee:c.code, name:c.nom, lat:c.centre.coordinates[1], lon:c.centre.coordinates[0] }));

    if (communes.length){
      const bounds = communes.map(c => [c.lat, c.lon]);
      map.fitBounds(bounds, { padding:[30,30] });
    }

    // PFAS + agrégation précise
    let done = 0, withData = 0;
    const method = methodSelect.value; // sum_first / max_only / strict
    statusEl.textContent = `Analyses PFAS… (0 / ${communes.length})`;

    const results = await mapWithConcurrency(communes, 6, async (c) => {
      try{
        const { agg, countAll } = await fetchAggPFASForCommune(c.insee, method);
        done++; if (agg && agg.value!=null) withData++;
        if (done % 10 === 0 || done === communes.length) {
          statusEl.textContent = `Analyses PFAS… (${done} / ${communes.length}) — communes avec valeur: ${withData}`;
        }
        return { ...c, agg, countAll };
      }catch{
        done++;
        statusEl.textContent = `Analyses PFAS… (${done} / ${communes.length})`;
        return { ...c, agg:null, countAll:0 };
      }
    });

    // affichage
    for (const r of results){
      if (!r) continue;
      const val = r.agg?.value ?? null;
      const unit = r.agg?.unit ?? "µg/L";
      const date = r.agg?.date ?? null;
      const picked = r.agg?.details?.picked?.label;
      const nInd = r.agg?.details?.nIndividuals ?? 0;
      const nSum = r.agg?.details?.nSums ?? 0;

      const m = L.circleMarker([r.lat, r.lon], styleFor(val)).bindPopup(`
        <strong>${r.name}</strong><br/>
        Méthode : <em>${methodLabel(method, r.agg?.mode)}</em><br/>
        Valeur retenue : ${val==null ? "N/A" : `${val} ${unit}`}${date ? ` — <small>${date}</small>` : ""}<br/>
        ${picked ? `<small>Paramètre : ${escapeHtml(picked)}</small><br/>` : ""}
        ${badgeFor(val)}<br/>
        <small>Analyses scannées : ${r.countAll} — PFAS individuels : ${nInd} — Sommes : ${nSum}</small>
      `);
      cluster.addLayer(m);
    }

    statusEl.textContent = `Terminé : ${communes.length} communes — avec valeur PFAS : ${withData}`;
    btn.disabled = false;
  }

  function methodLabel(sel, mode){
    if (sel === "max_only") return "Max molécule PFAS";
    if (sel === "strict") return "Strict (n’importe quelle molécule > 0,1)";
    // sum_first
    if (mode === "sum_first") return "Somme PFAS";
    if (mode === "max_fallback") return "Max (faute de somme)";
    return "Somme puis max (auto)";
  }

  // très simple
  function escapeHtml(s){
    return String(s).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
  }

  // UI wiring
  deptSelect.addEventListener("change", ()=> { btn.disabled = !deptSelect.value; });
  btn.addEventListener("click", ()=> loadDepartment(deptSelect.value));
  methodSelect.addEventListener("change", ()=> { if (deptSelect.value) loadDepartment(deptSelect.value); });
});
