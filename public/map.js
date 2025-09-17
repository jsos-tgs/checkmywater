document.addEventListener("DOMContentLoaded", () => {
  const statusEl = document.getElementById("status");
  const btnFrance = document.getElementById("loadFrance");
  const thresholdInput = document.getElementById("threshold");
  const methodSelect = document.getElementById("method");
  const toggleLegendBtn = document.getElementById("toggleLegendBtn");

  const LIMIT_AMB = 0.05; // juste pour la couleur "à surveiller"
  const CONCURRENCY_COMMUNES = 12;  // communes en parallèle
  const CONCURRENCY_DEPTS = 4;      // départements en parallèle
  const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

  // --- Carte France
  const map = L.map("map", { preferCanvas: true }).setView([46.7, 2.5], 6);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "© OpenStreetMap contributors"
  }).addTo(map);
  const cluster = L.markerClusterGroup({ chunkedLoading: true, maxClusterRadius: 60 });
  map.addLayer(cluster);

  // --- Légende (Leaflet control)
  let legendEl;
  const legend = L.control({ position: "bottomright" });
  legend.onAdd = function(){
    const div = L.DomUtil.create("div", "legend");
    div.innerHTML = `
      <strong>Légende</strong><br>
      <span class="dot risk"></span> &gt; seuil (marqué)<br>
      <span class="dot warn"></span> entre 0,05 et seuil<br>
      <span class="dot safe"></span> &lt; 0,05<br>
      <span class="dot na"></span> Non mesuré<br>
      <hr style="border:none;border-top:1px solid #eee;margin:6px 0">
      <small>Les chiffres = communes regroupées</small>
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

  // --- HTTP util
  const sleep = (ms)=> new Promise(r=>setTimeout(r,ms));
  async function getJSON(url, tries=4, timeout=25000){
    for(let i=0;i<tries;i++){
      try{
        const ctrl = new AbortController();
        const to = setTimeout(()=>ctrl.abort(), timeout);
        const res = await fetch(url,{signal:ctrl.signal,headers:{Accept:"application/json"}});
        clearTimeout(to);
        if(res.ok) return res.json();
        if(res.status===429 || res.status>=500){ await sleep(600*(i+1)); continue; }
        throw new Error(`HTTP ${res.status} ${url}`);
      }catch(e){
        if(i===tries-1) throw e;
        await sleep(600*(i+1));
      }
    }
  }

  // --- APIs
  const GEO_DEPTS = `https://geo.api.gouv.fr/departements?fields=code,nom&format=json`;
  const GEO_COMMUNES = (dept) => `https://geo.api.gouv.fr/departements/${dept}/communes?fields=code,nom,centre&format=json&geometry=centre`;
  const HUBEAU_COMMUNE = (insee) =>
    `https://hubeau.eaufrance.fr/api/v1/qualite_eau_potable/resultats_dis` +
    `?code_commune=${encodeURIComponent(insee)}` +
    `&size=500&sort=desc` +
    `&fields=libelle_parametre,parametre,resultat,resultat_numerique,unite,unite_resultat,date_prelevement,date_analyse`;

  // --- Détection PFAS
  const SUM_REGEX  = /(somme|sum|total).*(pfas)|pfas.*(somme|sum|total)/i;
  const PFAS_REGEX = /(pfas|perfluoro|polyfluoro|fluoroalkyl|perfluoro(carboxyl|sulfon))/i;

  // --- Couleurs affichage (selon seuil courant)
  function colorFor(v, limitRed){
    if (v == null || Number.isNaN(v)) return "grey";
    if (v > limitRed) return "red";          // on marque au-dessus du seuil choisi
    if (v >= LIMIT_AMB) return "amber";
    return "green";
  }
  function styleFor(v, limitRed){
    const c = colorFor(v, limitRed);
    const palette = {
      green:{color:"#2e7d32",fillColor:"#2e7d32"},
      amber:{color:"#f9a825",fillColor:"#f9a825"},
      red:{color:"#c62828",fillColor:"#c62828"},
      grey:{color:"#9e9e9e",fillColor:"#9e9e9e"},
    }[c];
    return { radius:6, weight:1, opacity:1, fillOpacity:.7, ...palette };
  }
  function badgeFor(v, limitRed){
    const c = colorFor(v, limitRed);
    if (c==="red")   return '<span class="badge risk">Au-dessus du seuil</span>';
    if (c==="amber") return '<span class="badge warn">À surveiller</span>';
    if (c==="green") return '<span class="badge safe">Bas</span>';
    return '<span class="badge na">Non mesuré</span>';
  }
  const escapeHtml = (s)=> String(s).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));

  // --- Agrégation précise
  function aggregatePFAS(rows, method, limitRed){
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
      return best ? { mode:"max_only", value:best.value, unit:best.unit, date:best.date, picked:best, nInd:individuals.length, nSum:sums.length } : null;
    }
    if (method === "strict"){
      const byLabel = {};
      for (const x of individuals){ if (!byLabel[x.label] || byLabel[x.label].date < x.date) byLabel[x.label] = x; }
      const arr = Object.values(byLabel);
      const over = arr.filter(x => x.value > limitRed);
      const picked = over.length ? over.reduce((m,x)=> (m && m.value> x.value? m : x), null) : latest(arr);
      if (!picked) {
        const s = latest(sums);
        return s ? { mode:"sum_first", value:s.value, unit:s.unit, date:s.date, picked:s, nInd:individuals.length, nSum:sums.length } : null;
      }
      return { mode:"strict", value:picked.value, unit:picked.unit, date:picked.date, picked, nInd:individuals.length, nSum:sums.length };
    }

    // sum_first (défaut)
    const sumPick = latest(sums);
    if (sumPick) return { mode:"sum_first", value:sumPick.value, unit:sumPick.unit, date:sumPick.date, picked:sumPick, nInd:individuals.length, nSum:sums.length };
    const byLabel = {};
    for (const x of individuals){ if (!byLabel[x.label] || byLabel[x.label].date < x.date) byLabel[x.label] = x; }
    const maxPick = Object.values(byLabel).reduce((m,x)=> (m && m.value > x.value) ? m : x, null);
    return maxPick ? { mode:"max_fallback", value:maxPick.value, unit:maxPick.unit, date:maxPick.date, picked:maxPick, nInd:individuals.length, nSum:sums.length } : null;
  }

  // --- Cache local
  const key = (insee, method)=> `pfas:${insee}:${method}`;
  const readCache = (k)=> {
    try{ const raw = localStorage.getItem(k); if(!raw) return null;
      const obj = JSON.parse(raw); if(Date.now()-obj.ts > CACHE_TTL_MS) return null; return obj.data;
    }catch{return null;}
  };
  const writeCache = (k, data)=> { try{ localStorage.setItem(k, JSON.stringify({ts:Date.now(), data})); }catch{} };

  async function fetchAgg(insee, method){
    const k = key(insee, method);
    const c = readCache(k);
    if (c) return c;
    const json = await getJSON(HUBEAU_COMMUNE(insee));
    const rows = json?.data || [];
    const agg = aggregatePFAS(rows, method, parseFloat(thresholdInput.value));
    const out = { agg, countAll: rows.length };
    writeCache(k, out);
    return out;
  }

  // --- util concurrence
  async function eachWithConcurrency(items, limit, worker){
    let idx = 0;
    const runners = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
      while(idx < items.length){
        const i = idx++;
        try{ await worker(items[i], i); } catch{}
      }
    });
    await Promise.all(runners);
  }

  // --- Charger la France (progressif & filtré par seuil)
  btnFrance.addEventListener("click", async () => {
    const limitRed = Math.max(0, parseFloat(thresholdInput.value) || 0.1);
    const method = methodSelect.value;

    btnFrance.disabled = true;
    statusEl.textContent = "Chargement des départements…";
    cluster.clearLayers();

    // 1) Liste complète des départements
    const depts = await getJSON(GEO_DEPTS);
    // tri grossier (gère 2A/2B naturellement en alpha)
    depts.sort((a,b)=> a.code.localeCompare(b.code));

    let depDone = 0, comScanned = 0, matches = 0;

    await eachWithConcurrency(depts, CONCURRENCY_DEPTS, async (dep) => {
      // 2) Communes du département
      const communes = await getJSON(GEO_COMMUNES(dep.code)) || [];
      const list = communes
        .filter(c => c?.centre?.coordinates)
        .map(c => ({ insee:c.code, name:c.nom, lat:c.centre.coordinates[1], lon:c.centre.coordinates[0] }));

      // 3) Pour chaque commune, on calcule l’agg et on NE PLACE QUE si > seuil
      await eachWithConcurrency(list, CONCURRENCY_COMMUNES, async (c) => {
        const { agg } = await fetchAgg(c.insee, method);
        comScanned++;
        const val = agg?.value ?? null;
        if (val != null && val > limitRed) {
          matches++;
          const unit = agg.unit || "µg/L";
          const date = agg.date || null;
          const picked = agg.picked?.label;

          const m = L.circleMarker([c.lat, c.lon], styleFor(val, limitRed)).bindPopup(`
            <strong>${escapeHtml(c.name)}</strong><br/>
            Méthode : <em>${escapeHtml(methodLabel(method, agg?.mode))}</em><br/>
            Valeur : ${val.toFixed(3)} ${unit}${date ? ` — <small>${date}</small>` : ""}<br/>
            ${picked ? `<small>Paramètre : ${escapeHtml(picked)}</small><br/>` : ""}
            ${badgeFor(val, limitRed)}
          `);
          cluster.addLayer(m);
        }

        // statut par tranche
        if (comScanned % 200 === 0) {
          statusEl.textContent = `Dépts: ${depDone}/${depts.length} — Communes scannées: ${comScanned} — Communes > ${limitRed} µg/L: ${matches}`;
        }
      });

      depDone++;
      statusEl.textContent = `Dépts: ${depDone}/${depts.length} — Communes scannées: ${comScanned} — Communes > ${limitRed} µg/L: ${matches}`;
    });

    statusEl.textContent = `Terminé — Communes scannées: ${comScanned} — Marqueurs > ${limitRed} µg/L: ${matches}`;
    btnFrance.disabled = false;
  });

  function methodLabel(sel, mode){
    if (sel === "max_only") return "Max molécule PFAS";
    if (sel === "strict")   return "Strict (n’importe quelle molécule > seuil)";
    if (mode === "sum_first") return "Somme PFAS";
    if (mode === "max_fallback") return "Max (faute de somme)";
    return "Somme puis max (auto)";
  }
});
