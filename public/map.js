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
  const GEO_COMMUNES = (dep) =>
    `https://geo.api.gouv.fr/departements/${dep}/communes?fields=code,nom,centre&format=json&geometry=centre`;

  const HUBEAU_DEP = (dept) =>
    `https://hubeau.eaufrance.fr/api/v1/qualite_eau_potable/resultats_dis` +
    `?code_departement=${dept}&size=10000&fields=code_commune,libelle_parametre,parametre,resultat,resultat_numerique,unite,unite_resultat,date_prelevement`;

  async function getJSON(url){
    const res = await fetch(url);
    return res.json();
  }

  // Retourne la valeur max PFAS pour une commune
  function aggregateByCommune(rows){
    const communesMap = {};
    for(const r of rows){
      if (!PFAS_REGEX.test(r.libelle_parametre||r.parametre||"")) continue;
      const insee = r.code_commune;
      const v = r.resultat!=null ? Number(r.resultat) : (r.resultat_numerique!=null ? Number(r.resultat_numerique) : NaN);
      if(Number.isNaN(v)) continue;

      if(!communesMap[insee] || communesMap[insee].value < v){
        communesMap[insee] = {
          code: insee,
          value: v,
          unit: r.unite || r.unite_resultat || "µg/L",
          date: r.date_prelevement || ""
        };
      }
    }
    return communesMap;
  }

  async function loadCommunes(){
    const depts = await getJSON(GEO_DEPTS);
    let depDone = 0;
    const start = Date.now();
    let matches = 0;

    for(const dep of depts){
      // Récupérer d’un coup toutes les communes du département
      const communesGeo = await getJSON(GEO_COMMUNES(dep.code));
      const geoMap = {};
      communesGeo.forEach(c => {
        if(c.code) geoMap[c.code] = c;
      });

      // Récupérer les analyses PFAS pour ce département
      const data = await getJSON(HUBEAU_DEP(dep.code));
      const rows = data?.data || [];
      const byCommune = aggregateByCommune(rows);

      for(const [code, agg] of Object.entries(byCommune)){
        if(agg.value > seuil && geoMap[code]){
          matches++;
          const c = geoMap[code];
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
      }

      depDone++;
      const percent = Math.round((depDone/depts.length)*100);
      progressBar.style.width = percent+"%";
      statusEl.textContent = `Départements traités : ${depDone}/${depts.length}`;

      const elapsed = (Date.now()-start)/1000;
      const rate = depDone/elapsed;
      const remaining = (depts.length-depDone)/rate;
      etaEl.textContent = `Temps estimé restant : ~${Math.ceil(remaining)} sec`;
    }

    statusEl.textContent = `✅ Terminé — ${matches} communes dépassent le seuil`;
    etaEl.textContent = "";
    resultsSection.style.display = "block";
  }

  function toggleMap(c, agg){
    if(currentCity && currentCity.code === c.code){
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

  // Lancement
  loadBtn.addEventListener("click", () => {
    loadBtn.disabled = true;
    progressBox.style.display = "block";
    loadCommunes();
  });
});
