document.addEventListener("DOMContentLoaded", () => {
  const statusEl = document.getElementById("status");
  const btnFrance = document.getElementById("loadFrance");
  const thresholdInput = document.getElementById("threshold");
  const filterSelect = document.getElementById("filter");
  const toggleLegendBtn = document.getElementById("toggleLegendBtn");

  const CONCURRENCY_COMMUNES = 12;
  const CONCURRENCY_DEPTS = 4;
  const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

  // Carte
  const map = L.map("map", { preferCanvas: true }).setView([46.7, 2.5], 6);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "© OpenStreetMap contributors"
  }).addTo(map);
  const cluster = L.markerClusterGroup({ chunkedLoading: true, maxClusterRadius: 60 });
  map.addLayer(cluster);

  // Légende
  let legendEl;
  const legend = L.control({ position: "bottomright" });
  legend.onAdd = function(){
    const div = L.DomUtil.create("div", "legend");
    div.innerHTML = `
      <strong>Légende</strong><br>
      <span class="dot risk"></span> &gt; seuil<br>
      <span class="dot safe"></span> &lt; seuil<br>
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

  // HTTP
  const sleep = (ms)=> new Promise(r=>setTimeout(r,ms));
  async function getJSON(url, tries=4, timeout=20000){
    for(let i=0;i<tries;i++){
      try{
        const ctrl = new AbortController();
        const to = setTimeout(()=>ctrl.abort(), timeout);
        const res = await fetch(url,{signal:ctrl.signal,headers:{Accept:"application/json"}});
        clearTimeout(to);
        if(res.ok) return res.json();
        if(res.status===429 || res.status>=500){ await sleep(500*(i+1)); continue; }
        throw new Error(`HTTP ${res.status} ${url}`);
      }catch(e){
        if(i===tries-1) throw e;
        await sleep(500*(i+1));
      }
    }
  }

  // APIs
  const GEO_DEPTS = `https://geo.api.gouv.fr/departements?fields=code,nom&format=json`;
  const GEO_COMMUNES = (dept) => `https://geo.api.gouv.fr/departements/${dept}/communes?fields=code,nom,centre&format=json&geometry=centre`;
  const HUBEAU_COMMUNE = (insee) =>
    `https://hubeau.eaufrance.fr/api/v1/qualite_eau_potable/resultats_dis` +
    `?code_commune=${encodeURIComponent(insee)}` +
    `&size=200&sort=desc` +
    `&fields=libelle_parametre,parametre,resultat,resultat_numerique,unite,unite_resultat,date_prelevement,date_analyse`;

  const PFAS_REGEX = /(pfas|perfluoro|polyfluoro|fluoroalkyl|perfluoro(carboxyl|sulfon))/i;

  // Cache local
  const cacheKey = (insee)=> `pfas:${insee}`;
  const readCache = (k)=> {
    try{ const raw = localStorage.getItem(k); if(!raw) return null;
      const obj = JSON.parse(raw); if(Date.now()-obj.ts > CACHE_TTL_MS) return null; return obj.data;
    }catch{return null;}
  };
  const writeCache = (k, data)=> { try{ localStorage.setItem(k, JSON.stringify({ts:Date.now(), data})); }catch{} };

  // Agrégation simple : max PFAS trouvé
  function aggregatePFAS(rows){
    if (!rows || !rows.length) return null;
    const vals = rows.map(r=>{
      if (!PFAS_REGEX.test(r.libelle_parametre||r.parametre||"")) return null;
      const v = r.resultat!=null ? Number(r.resultat) : (r.resultat_numerique!=null ? Number(r.resultat_numerique) : NaN);
      if (Number.isNaN(v)) return null;
      return { value:v, unit:r.unite||r.unite_resultat||"µg/L", date:r.date_prelevement||r.date_analyse||"", label:r.libelle_parametre||r.parametre||"" };
    }).filter(Boolean);
    if (!vals.length) return null;
    return vals.reduce((m,x)=> (m && m.value > x.value)?m:x);
  }

  async function fetchAgg(insee){
    const k = cacheKey(insee);
    const c = readCache(k);
    if (c) return c;
    const json = await getJSON(HUBEAU_COMMUNE(insee));
    const rows = json?.data || [];
    const agg = aggregatePFAS(rows);
    const out = { agg };
    writeCache(k, out);
    return out;
  }

  async function eachWithConcurrency(items, limit, worker){
    let idx = 0;
    const runners = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
      while(idx < items.length){
        const i = idx++;
        try{ await worker(items[i], i); }catch{}
      }
    });
    await Promise.all(runners);
  }

  // Charger toute la France
  btnFrance.addEventListener("click", async () => {
    const seuil = parseFloat(thresholdInput.value) || 0.1;
    const filter = filterSelect.value; // "above" ou "below"

    btnFrance.disabled = true;
    cluster.clearLayers();
    statusEl.textContent = "Chargement des départements…";

    const depts = await getJSON(GEO_DEPTS);
    let depDone=0, comScanned=0, matches=0;

    await eachWithConcurrency(depts, CONCURRENCY_DEPTS, async (dep)=>{
      const communes = await getJSON(GEO_COMMUNES(dep.code)) || [];
      const list = communes.filter(c=>c?.centre?.coordinates).map(c=>({
        insee:c.code, name:c.nom, lat:c.centre.coordinates[1], lon:c.centre.coordinates[0]
      }));

      await eachWithConcurrency(list, CONCURRENCY_COMMUNES, async (c)=>{
        const { agg } = await fetchAgg(c.insee);
        comScanned++;
        const val = agg?.value ?? null;
        if (val!=null){
          const condition = filter==="above" ? (val > seuil) : (val <= seuil);
          if (condition){
            matches++;
            const m = L.circleMarker([c.lat,c.lon], styleFor(val,seuil)).bindPopup(`
              <strong>${c.name}</strong><br/>
              Valeur PFAS : ${val.toFixed(3)} µg/L ${agg.unit||""}${agg.date?` — <small>${agg.date}</small>`:""}<br/>
              ${agg.label?`<small>Paramètre : ${agg.label}</small><br/>`:""}
            `);
            cluster.addLayer(m);
          }
        }
        if (comScanned % 200 === 0){
          statusEl.textContent = `Dépts: ${depDone}/${depts.length} — Communes: ${comScanned} — Correspondantes: ${matches}`;
        }
      });
      depDone++;
    });

    statusEl.textContent = `Terminé — Communes scannées: ${comScanned}, correspondantes: ${matches}`;
    btnFrance.disabled = false;
  });

  function styleFor(v, seuil){
    const c = v==null ? "grey" : (v>seuil?"red":"green");
    const palette = {
      green:{color:"#2e7d32",fillColor:"#2e7d32"},
      red:{color:"#c62828",fillColor:"#c62828"},
      grey:{color:"#9e9e9e",fillColor:"#9e9e9e"},
    }[c];
    return { radius:6, weight:1, opacity:1, fillOpacity:.7, ...palette };
  }
});
