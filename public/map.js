document.addEventListener("DOMContentLoaded", () => {
  const statusEl = document.getElementById("status");
  const deptSelect = document.getElementById("dept");
  const btn = document.getElementById("loadDept");
  const toggleLegendBtn = document.getElementById("toggleLegendBtn");
  const methodSelect = document.getElementById("method");

  const LIMIT_RED = 0.1;   // µg/L
  const LIMIT_AMB = 0.05;  // µg/L
  const CONCURRENCY = 10;  // + rapide mais poli envers l'API
  const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 jours

  // ---- Carte
  const map = L.map("map", { preferCanvas: true }).setView([46.8, 2.5], 7);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "© OpenStreetMap contributors"
  }).addTo(map);
  const cluster = L.markerClusterGroup({ chunkedLoading: true, maxClusterRadius: 60 });
  map.addLayer(cluster);

  // ---- Légende (Leaflet control + bouton ?)
  let legendEl;
  const legend = L.control({ position: "bottomright" });
  legend.onAdd = function(){
    const div = L.DomUtil.create("div", "legend");
    div.innerHTML = `
      <strong>Légende</strong><br>
      <span class="dot safe"></span> &lt; 0,05 µg/L (Conforme)<br>
      <span class="dot warn"></span> 0,05–0,1 µg/L (À surveiller)<br>
      <span class="dot risk"></span> &gt; 0,1 µg/L (Dépassement)<br>
      <span class="dot na"></span> Non mesuré<br>
      <hr style="border:none;border-top:1px solid #eee;margin:6px 0">
      <small>Les chiffres = communes regroupées (cluster)</small>
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

  // ---- HTTP util
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  async function getJSON(url, tries=4, timeout=25000) {
    for (let i = 0; i < tries; i++) {
      try {
        const ctrl = new AbortController();
        const to = setTimeout(() => ctrl.abort(), timeout);
        const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: "application/json" } });
        clearTimeout(to);
        if (res.ok) return res.json();
        if (res.status === 429 || res.status >= 500) { await sleep(600*(i+1)); continue; }
        throw new Error(`HTTP ${res.status} ${url}`);
      } catch (e) {
        if (i === tries - 1) throw e;
        await sleep(600*(i+1));
      }
    }
  }

  // ---- APIs
  const GEO_DEPTS    = `https://geo.api.gouv.fr/departements?fields=code,nom&format=json`;
  const GEO_COMMUNES = (dept) => `https://geo.api.gouv.fr/departements/${dept}/communes?fields=code,nom,centre&format=json&geometry=centre`;
  // On réduit drastiquement les colonnes via `fields` (doc Hub’Eau “Exposition/Pagination/fields”) :
  // libellés + valeur + unité + dates suffisent pour l’agrégation et l’affichage.
  const HUBEAU_COMMUNE = (insee) =>
    `https://hubeau.eaufrance.fr/api/v1/qualite_eau_potable/resultats_dis` +
    `?code_commune=${encodeURIComponent(insee)}` +
    `&size=500&sort=desc` +
    `&fields=libelle_parametre,parametre,resultat,resultat_numerique,unite,unite_resultat,date_prelevement,date_analyse,code_prelevement`;

  // ---- PFAS detection
  const SUM_REGEX  = /(somme|sum|total).*(pfas)|pfas.*(somme|sum|total)/i;
  const PFAS_REGEX = /(pfas|perfluoro|polyfluoro|fluoroalkyl|perfluoro(carboxyl|sulfon))/i;

  // ---- Couleurs & UI
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

  // ---- Classement 2A/2B
  const codeOrder = (code) => {
    if (code==="2A") return 20.1;
    if (code==="2B") return 20.2;
    const n = parseInt(code,10);
    return Number.isNaN(n) ? 999 : n;
  };

  // ---- Départements auto (tous)
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
      deptSelect.innerHTML = `<option value="">Impossible de charger les départements</option>`;
      statusEl.textContent = "Erreur de chargement des départements.";
    }
  })();

  // ---- Agrégation précise (identique à avant)
  function aggregatePFAS(rows, method){
    if (!rows || !rows.length) return null;
    const mapRow = (r) => ({
      label: r.libelle_parametre || r.parametre || "",
      value: (r.resultat!=null ? Number(r.resultat) : (r.resultat_numerique!=null ? Number(r.resultat_numerique) : NaN)),
      unit:  r.unite || r.unite_resultat || "µg/L",
      date:  r.date_prelevement || r.date_analyse || ""
    });

    const sums = rows.filter(r => SUM_REGEX.test((r.libelle_parametre||r.parametre||""))).map(mapRow).filter(x=>!Number.isNaN(x.value));
    const individuals = rows.filter(r => {
      const lab = (r.libelle_parametre||r.parametre||"");
      return PFAS_REGEX.test(lab) && !SUM_REGEX.test(lab);
    }).map(mapRow).filter(x=>!Number.isNaN(x.value));

    const latest = (arr) => arr.length ? arr.reduce((a,b)=> (a.date && b.date && b.date > a.date) ? b : a, arr[0]) : null;

    if (method === "max_only"){
      const byLabel = {};
      for (const x of individuals){ if (!byLabel[x.label] || byLabel[x.label].date < x.date) byLabel[x.label] = x; }
      const best = Object.values(byLabel).reduce((m,x)=> (m && m.value > x.value) ? m : x, null);
      return best ? { mode:"max_only", value:best.value, unit:best.unit, date:best.date, details:{picked:best, nIndividuals:individuals.length, nSums:sums.length} } : null;
    }

    if (method === "strict"){
      const byLabel = {};
      for (const x of individuals){ if (!byLabel[x.label] || byLabel[x.label].date < x.date) byLabel[x.label] = x; }
      const arr = Object.values(byLabel);
      const over = arr.filter(x => x.value > LIMIT_RED);
      const picked = over.length ? over.reduce((m,x)=> (m && m.value> x.value? m : x), null) : latest(arr);
      if (!picked) return sums.length ? { mode:"sum_first", value: latest(sums).value, unit: latest(sums).unit, date: latest(sums).date, details:{picked:latest(sums), nIndividuals:individuals.length, nSums:sums.length} } : null;
      return { mode:"strict", value:picked.value, unit:picked.unit, date:picked.date, details:{picked, nIndividuals:individuals.length, nSums:sums.length} };
    }

    const sumPick = latest(sums);
    if (sumPick){
      return { mode:"sum_first", value: sumPick.value, unit: sumPick.unit, date: sumPick.date, details:{picked:sumPick, nIndividuals:individuals.length, nSums:sums.length} };
    }
    const byLabel = {};
    for (const x of individuals){ if (!byLabel[x.label] || byLabel[x.label].date < x.date) byLabel[x.label] = x; }
    const maxPick = Object.values(byLabel).reduce((m,x)=> (m && m.value > x.value) ? m : x, null);
    return maxPick ? { mode:"max_fallback", value:maxPick.value, unit:maxPick.unit, date:maxPick.date, details:{picked:maxPick, nIndividuals:individuals.length, nSums:sums.length} } : null;
  }

  function methodLabel(sel, mode){
    if (sel === "max_only") return "Max molécule PFAS";
    if (sel === "strict") return "Strict (n’importe quelle molécule > 0,1)";
    if (mode === "sum_first") return "Somme PFAS";
    if (mode === "max_fallback") return "Max (faute de somme)";
    return "Somme puis max (auto)";
  }

  const escapeHtml = (s)=> String(s).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));

  // ---- Cache local simple (localStorage)
  const cacheKey = (insee, method) => `pfas:${insee}:${method}`;
  function readCache(insee, method){
    try{
      const raw = localStorage.getItem(cacheKey(insee,method));
      if (!raw) return null;
      const obj = JSON.parse(raw);
      if (Date.now() - obj.ts > CACHE_TTL_MS) return null;
      return obj.data;
    }catch{ return null; }
  }
  function writeCache(insee, method, data){
    try{
      localStorage.setItem(cacheKey(insee,method), JSON.stringify({ ts: Date.now(), data }));
    }catch{}
  }

  async function fetchAggPFASForCommune(insee, method){
    const cached = readCache(insee, method);
    if (cached) return cached;

    const url = HUBEAU_COMMUNE(insee);
    // Doc Hub’Eau : supporte CORS + paramètre `fields` pour réduire la réponse. :contentReference[oaicite:1]{index=1}
    const json = await getJSON(url);
    const rows = json?.data || [];
    const agg  = aggregatePFAS(rows, method);
    const out  = { agg, countAll: rows.length };
    writeCache(insee, method, out);
    return out;
  }

  // ---- Petite file d'attente (concurrence limitée)
  async function mapWithConcurrency(items, limit, worker, onEach){
    const ret = new Array(items.length);
    let idx = 0;
    const runners = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
      while(idx < items.length){
        const i = idx++;
        try { ret[i] = await worker(items[i], i); }
        catch(e){ ret[i] = null; }
        if (onEach) onEach(items[i], ret[i], i);
      }
    });
    await Promise.all(runners);
    return ret;
  }

  // ---- Charger un département (affichage progressif)
  async function loadDepartment(deptCode){
    if(!deptCode) return;
    btn.disabled = true;
    cluster.clearLayers();
    statusEl.textContent = "Chargement des communes…";

    let communes = await getJSON(GEO_COMMUNES(deptCode));
    communes = (communes || [])
      .filter(c => c?.centre?.coordinates)
      .map(c => ({ insee:c.code, name:c.nom, lat:c.centre.coordinates[1], lon:c.centre.coordinates[0] }));

    if (communes.length){
      const bounds = communes.map(c => [c.lat, c.lon]);
      map.fitBounds(bounds, { padding:[30,30] });
    }

    let done = 0, withData = 0;
    const method = methodSelect.value;
    statusEl.textContent = `Analyses PFAS… (0 / ${communes.length})`;

    await mapWithConcurrency(
      communes,
      CONCURRENCY,
      async (c) => {
        const { agg, countAll } = await fetchAggPFASForCommune(c.insee, method);
        if (agg && agg.value != null) withData++;
        return { ...c, agg, countAll };
      },
      // onEach: ajoute le marqueur immédiatement (progressif)
      (c, r) => {
        done++;
        if (!r) return;
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

        if (done % 10 === 0 || done === communes.length) {
          statusEl.textContent = `Analyses PFAS… (${done} / ${communes.length}) — communes avec valeur: ${withData}`;
        }
      }
    );

    statusEl.textContent = `Terminé : ${communes.length} communes — avec valeur PFAS : ${withData}`;
    btn.disabled = false;
  }

  // ---- UI
  deptSelect.addEventListener("change", ()=> { btn.disabled = !deptSelect.value; });
  btn.addEventListener("click", ()=> loadDepartment(deptSelect.value));
  methodSelect.addEventListener("change", ()=> { if (deptSelect.value) loadDepartment(deptSelect.value); });
});
