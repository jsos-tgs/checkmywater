// Seuils d’affichage
const LIMIT_RED = 0.1;   // > 0.1 µg/L => non conforme 2026
const LIMIT_AMB = 0.05;  // 0.05–0.1 µg/L => à surveiller

// util style & badge
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

// helpers
const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));
async function getJSON(url, tries=4, timeout=30000){
  for(let i=0;i<tries;i++){
    try{
      const ctrl=new AbortController();
      const to=setTimeout(()=>ctrl.abort(), timeout);
      const r=await fetch(url,{signal:ctrl.signal, headers:{'Accept':'application/json'}});
      clearTimeout(to);
      if(r.ok) return r.json();
      if(r.status===429 || r.status>=500){ await sleep(800*(i+1)); continue; }
      throw new Error(`HTTP ${r.status} ${url}`);
    }catch(e){ if(i===tries-1) throw e; await sleep(800*(i+1)); }
  }
}

// API endpoints
const GEO_COMMUNES = (dept) => `https://geo.api.gouv.fr/departements/${dept}/communes?fields=code,nom,centre&format=json&geometry=centre`;
const HUBEAU_COMMUNE = (insee) => `https://hubeau.eaufrance.fr/api/v1/qualite_eau_potable/resultats_dis?code_commune=${encodeURIComponent(insee)}&size=300&format=json`;

// PFAS label detection (les libellés varient)
const PFAS_REGEX = /(pfas|perfluoro|polyfluoro|fluoroalkyl|perfluoro(carboxyl|sulfon))/i;

// récup PFAS pour un code INSEE (prend la valeur la plus récente)
async function fetchPFASForCommune(insee){
  const json = await getJSON(HUBEAU_COMMUNE(insee));
  const rows = json?.data || [];
  let best = null;
  for(const r of rows){
    const label = r.libelle_parametre || r.parametre || "";
    if(!PFAS_REGEX.test(label)) continue;
    const val = r.resultat!==undefined? Number(r.resultat): NaN;
    if(Number.isNaN(val)) continue;
    const date = r.date_prelevement || r.date_analyse || "";
    if(!best || (date && best.date_mesure && date > best.date_mesure) || (!best.date_mesure && date)){
      best = { value: val, date };
    }
  }
  return best; // ou null si rien trouvé
}

// petite file d'attente à concurrence limitée (natif)
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

let map, cluster, statusEl, deptSelect, btn;
init();

async function init(){
  // init carte
  map = L.map("map", { preferCanvas:true }).setView([46.8, 2.5], 7);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "© OpenStreetMap contributors"
  }).addTo(map);
  cluster = L.markerClusterGroup({ chunkedLoading:true, maxClusterRadius:60 });
  map.addLayer(cluster);

  // UI
  statusEl = document.getElementById("status");
  deptSelect = document.getElementById("dept");
  btn = document.getElementById("loadDept");
  deptSelect.addEventListener("change", ()=> btn.disabled = !deptSelect.value);
  btn.disabled = !deptSelect.value;

  btn.addEventListener("click", () => loadDepartment(deptSelect.value));
}

async function loadDepartment(deptCode){
  if(!deptCode) return;
  btn.disabled = true;
  statusEl.textContent = "Chargement des communes…";
  cluster.clearLayers();

  // 1) communes du département
  let communes = await getJSON(GEO_COMMUNES(deptCode));
  communes = communes
    .filter(c => c?.centre?.coordinates)
    .map(c => ({
      insee: c.code,
      name: c.nom,
      lat: c.centre.coordinates[1],
      lon: c.centre.coordinates[0]
    }));

  // center map on dept
  if (communes.length){
    const bounds = communes.map(c => [c.lat, c.lon]);
    map.fitBounds(bounds, { padding:[30,30] });
  }

  // 2) pour chaque commune → PFAS Hub’Eau (limite de concurrence pour rester gentil)
  let done = 0, withData = 0;
  statusEl.textContent = `Analyses PFAS… (0 / ${communes.length})`;

  const results = await mapWithConcurrency(communes, 6, as
