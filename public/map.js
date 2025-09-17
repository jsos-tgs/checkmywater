document.addEventListener("DOMContentLoaded", () => {
  const loadBtn = document.getElementById("loadBtn");
  const progressBox = document.getElementById("progressBox");
  const progressBar = document.getElementById("progressBar");
  const statusEl = document.getElementById("status");
  const etaEl = document.getElementById("eta");
  const resultsSection = document.getElementById("results");
  const tableBody = document.querySelector("#communesTable tbody");
  const mapContainer = document.getElementById("mapContainer");
  const mapTitle = document.getElementById("mapTitle");

  let map = null;
  let currentCity = null;

  const seuil = 0.10;
  const PFAS_REGEX = /(pfas|perfluoro|polyfluoro|fluoroalkyl)/i;

  const GEO_DEPTS = `https://geo.api.gouv.fr/departements?fields=code,nom&format=json`;
  const GEO_COMMUNES = (dept) =>
    `https://geo.api.gouv.fr/departements/${dept}/communes?fields=code,nom,centre&format=json&geometry=centre`;
  const HUBEAU_COMMUNE = (insee) =>
    `https://hubeau.eaufrance.fr/api/v1/qualite_eau_potable/resultats_dis` +
    `?code_commune=${encodeURIComponent(insee)}&size=100&sort=desc` +
    `&fields=libelle_parametre,parametre,resultat,resultat_numerique,unite,unite_resultat,date_prelevement`;

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

  async function loadCommunes(){
    const depts = await getJSON(GEO_DEPTS);
    let comScanned = 0;
    let matches = 0;
    let totalCommunes = 0;

    // compter pour ETA
    for(const dep of depts){
      const communes = await getJSON(GEO_COMMUNES(dep.code)) || [];
      totalCommunes += communes.length;
    }

    const start = Date.now();

    for (const dep of depts){
      const communes = await getJSON(GEO_COMMUNES(dep.code)) || [];
      for (const c of communes){
        if(!c?.centre?.coordinates) continue;
        const data = await getJSON(HUBEAU_COMMUNE(c.code));
        const agg = aggregatePFAS(data?.data||[]);
        comScanned++;

        if (agg && agg.value > seuil){
          matches++;
          const row = document.createElement("tr");
          row.innerHTML = `
            <td>${c.nom}</td>
            <td>${dep.code}</td>
            <td>${agg.value.toFixed(3)}</td>
            <td>${agg.date || "-"}</td>
          `;
          row.addEventListener("click", ()=> toggleMap(c, agg));
          tableBody.appendChild(row);
        }

        // progression
        const percent = Math.round((comScanned/totalCommunes)*100);
        progressBar.style.width = percent+"%";
        statusEl.textContent = `Communes analysées : ${comScanned}/${totalCommunes}`;
        
        const elapsed = (Date.now() - start)/1000;
        const rate = comScanned/elapsed; // communes/sec
        const remaining = (totalCommunes - comScanned)/rate;
        etaEl.textContent = `Temps estimé restant : ~${Math.ceil(remaining/60)} min`;
      }
    }

    // terminé
    etaEl.textContent = "";
    statusEl.textContent = `✅ Terminé — ${matches} communes dépassent le seuil`;
    resultsSection.style.display = "block";
  }

  function toggleMap(c, agg){
    if(currentCity && currentCity.nom === c.nom){
      mapContainer.style.display = "none";
      if(map){ map.remove(); map = null; }
      currentCity = null;
      return;
    }

    currentCity = c;
    mapTitle.textContent = `Localisation : ${c.nom} (PFAS ${agg.value.toFixed(3)} µg/L)`;
    mapContainer.style.display = "block";

    if(map){ map.remove(); }

    map = L.map("map").setView([c.centre.coordinates[1], c.centre.coordinates[0]], 13);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "© OpenStreetMap contributors"
    }).addTo(map);

    L.marker([c.centre.coordinates[1], c.centre.coordinates[0]]).addTo(map)
      .bindPopup(`<strong>${c.nom}</strong><br/>PFAS : ${agg.value.toFixed(3)} µg/L`).openPopup();
  }

  // lancement
  loadBtn.addEventListener("click", () => {
    loadBtn.disabled = true;
    progressBox.style.display = "block";
    loadCommunes();
  });
});
