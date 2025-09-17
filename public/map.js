document.addEventListener("DOMContentLoaded", () => {
  const statusEl = document.getElementById("status");
  const progressBar = document.getElementById("progressBar");
  const btnFrance = document.getElementById("loadFrance");
  const thresholdInput = document.getElementById("threshold");
  const filterSelect = document.getElementById("filter");
  const toggleLegendBtn = document.getElementById("toggleLegendBtn");

  const CONCURRENCY_COMMUNES = 12;
  const CONCURRENCY_DEPTS = 4;
  const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

  // --- Carte France stylée ---
  const franceBounds = [
    [41.0, -5.5],  // sud-ouest
    [51.5, 9.8]    // nord-est
  ];
  const map = L.map("map", {
    preferCanvas: true,
    maxBounds: franceBounds,
    maxBoundsViscosity: 1.0,
    minZoom: 5,
    maxZoom: 12
  }).setView([46.7, 2.5], 6);

  // Fond clair (Carto Light)
  L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
    attribution: '&copy; <a href="https://www.openstreetmap.org/">OSM</a> &copy; <a href="https://carto.com/">CARTO</a>',
    subdomains: "abcd",
    maxZoom: 20
  }).addTo(map);

  const cluster = L.markerClusterGroup({ chunkedLoading: true, maxClusterRadius: 50 });
  map.addLayer(cluster);

  // --- Légende ---
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

  // --- APIs
  const GEO_DEPTS = `https://geo.api.gouv.fr/departements?fields=code&format=json`;
  const GEO_COMMUNES = (dept) =>
    `https://geo.api.gouv.fr/departements/${dept}/communes?fields=code,nom,centre&format=json&geometry=centre`;
  const HUBEAU_COMMUNE = (insee) =>
    `https://hubeau.eaufrance.fr/api/v1/qualite_eau_potable/resultats_dis` +
    `?code_commune=${encodeURIComponent(insee)}` +
    `&size=200&sort=desc` +
    `&fields=libelle_parametre,parametre,resultat,resultat_numerique,unite,unite_resultat,date_prelevement`;

  const PFAS_REGEX = /(pfas|perfluoro|polyfluoro|fluoroalkyl)/i;

  // --- Utils
  async function getJSON(url){
    const res = await fetch(url);
    return res.json();
  }

  function aggregatePFAS(rows){
    const vals = rows.map(r=>{
      if (!PFAS_REGEX.test(r.libelle_parametre||r.parametre||"")) return null;
      const v = r.resultat!=null ? Number(r.resultat) : (r.resultat_numerique!=null ? Number(r.resultat_numerique) : NaN);
      if (Number.isNaN(v)) return null;
      return { value:v, unit:r.unite||r.unite_resultat||"µg/L", date:r.date_prelevement||"", label:r.libelle_parametre||"" };
    }).filter(Boolean);
    if (!vals.length) return null;
    return vals.reduce((m,x)=> (m && m.value > x.value)?m:x);
  }

  function styleFor(v, seuil){
    const color = v==null ? "grey" : (v > seuil ? "red" : "green");
    const palette = {
      green:{color:"#2e7d32",fillColor:"#2e7d32"},
      red:{color:"#c62828",fillColor:"#c62828"},
      grey:{color:"#9e9e9e",fillColor:"#9e9e9e"},
    }[color];
    return { radius:6, weight:1, opacity:1, fillOpacity:.75, ...palette };
  }

  async function fetchAgg(insee){
    const json = await getJSON(HUBEAU_COMMUNE(insee));
    const rows = json?.data || [];
    return { agg: aggregatePFAS(rows) };
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

  // --- Charger toute la France ---
  btnFrance.addEventListener("click", async () => {
    const seuil = parseFloat(thresholdInput.value) || 0.1;
    const filter = filterSelect.value;

    btnFrance.disabled = true;
    cluster.clearLayers();
    progressBar.style.width = "0%";
    statusEl.textContent = "Chargement des départements…";

    const depts = await getJSON(GEO_DEPTS);
    let depDone=0, comScanned=0, matches=0, totalCommunes=0;

    // calculer total communes pour la progression
    for(const dep of depts){
      const communes = await getJSON(GEO_COMMUNES(dep.code)) || [];
      totalCommunes += communes.length;
    }

    await eachWithConcurrency(depts, CONCURRENCY_DEPTS, async (dep)=>{
      const communes = await getJSON(GEO_COMMUNES(dep.code)) || [];
      await eachWithConcurrency(communes, CONCURRENCY_COMMUNES, async (c)=>{
        if(!c?.centre?.coordinates) return;
        const { agg } = await fetchAgg(c.code);
        comScanned++;
        const val = agg?.value ?? null;

        if (val!=null){
          const condition = filter==="above" ? (val > seuil) : (val <= seuil);
          if (condition){
            matches++;
            const marker = L.circleMarker([c.centre.coordinates[1], c.centre.coordinates[0]], styleFor(val,seuil))
              .bindPopup(`
                <strong>${c.nom}</strong><br/>
                ${val!=null ? `PFAS : ${val.toFixed(3)} µg/L` : "Non mesuré"}
                ${agg?.date ? `<br/><small>${agg.date}</small>`:""}
              `);
            cluster.addLayer(marker);
          }
        }

        // progression
        const percent = Math.round((comScanned/totalCommunes)*100);
        progressBar.style.width = percent+"%";
        statusEl.textContent = `Communes: ${comScanned}/${totalCommunes} — Correspondantes: ${matches}`;
      });
      depDone++;
    });

    statusEl.textContent = `✅ Terminé — ${matches} communes affichées`;
    btnFrance.disabled = false;
  });
});
