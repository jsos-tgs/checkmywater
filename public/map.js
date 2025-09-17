document.addEventListener("DOMContentLoaded", () => {
  const loadBtn = document.getElementById("loadBtn");
  const progressBox = document.getElementById("progressBox");
  const progressBar = document.getElementById("progressBar");
  const statusEl = document.getElementById("status");
  const etaEl = document.getElementById("eta");
  const resultsSection = document.getElementById("results");
  const tableBody = document.querySelector("#communesTable tbody");

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
    // Vérifier cache
    const cache = localStorage.getItem("pfasData");
    if(cache){
      const parsed = JSON.parse(cache);
      const today = new Date().toISOString().slice(0,10);
      if(parsed.date === today){
        console.log("✅ Chargement depuis le cache");
        displayCommunes(parsed.data);
        return;
      }
    }

    // Sinon -> API
    const depts = await getJSON(GEO_DEPTS);
    let depDone = 0;
    const start = Date.now();
    let matches = [];

    for(const dep of depts){
      const communesGeo = await getJSON(GEO_COMMUNES(dep.code));
      const geoMap = {};
      communesGeo.forEach(c => { if(c.code) geoMap[c.code] = c; });

      const data = await getJSON(HUBEAU_DEP(dep.code));
      const rows = data?.data || [];
      const byCommune = aggregateByCommune(rows);

      for(const [code, agg] of Object.entries(byCommune)){
        if(agg.value > seuil && geoMap[code]){
          matches.push({
            nom: geoMap[code].nom,
            dep: dep.code,
            lat: geoMap[code].centre.coordinates[1],
            lon: geoMap[code].centre.coordinates[0],
            value: agg.value,
            date: agg.date
          });
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

    // Cache pour la journée
    localStorage.setItem("pfasData", JSON.stringify({
      date: new Date().toISOString().slice(0,10),
      data: matches
    }));

    displayCommunes(matches);
  }

  function displayCommunes(matches){
    etaEl.textContent = "";
    statusEl.textContent = `✅ Terminé — ${matches.length} communes dépassent le seuil`;
    resultsSection.style.display = "block";

    matches.forEach(c => {
      const row = document.createElement("tr");
      row.innerHTML = `
        <td>${c.nom}</td>
        <td>${c.dep}</td>
        <td>${c.value.toFixed(3)}</td>
        <td>${c.date || "-"}</td>
      `;
      row.addEventListener("click", ()=> toggleMap(row, c));
      tableBody.appendChild(row);
    });
  }

  function toggleMap(row, c){
    // Vérifier si une carte existe déjà sous cette ligne
    const existing = row.nextElementSibling;
    if(existing && existing.classList.contains("mapRow")){
      existing.remove();
      return;
    }

    // Supprimer toute autre carte ouverte
    document.querySelectorAll(".mapRow").forEach(el => el.remove());

    // Créer ligne contenant la carte
    const mapRow = document.createElement("tr");
    mapRow.classList.add("mapRow");
    const td = document.createElement("td");
    td.colSpan = 4;
    td.innerHTML = `
      <div style="position:relative; height:400px;">
        <button class="closeMapBtn">Fermer la carte ✖</button>
        <div class="miniMap" style="height:100%;"></div>
      </div>
    `;
    mapRow.appendChild(td);
    row.insertAdjacentElement("afterend", mapRow);

    const mapDiv = td.querySelector(".miniMap");
    const closeBtn = td.querySelector(".closeMapBtn");

    // Init carte
    const map = L.map(mapDiv).setView([c.lat, c.lon], 13);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "© OpenStreetMap contributors"
    }).addTo(map);

    L.marker([c.lat, c.lon]).addTo(map)
      .bindPopup(`<strong>${c.nom}</strong><br/>PFAS : ${c.value.toFixed(3)} µg/L`).openPopup();

    // Bouton fermer
    closeBtn.addEventListener("click", ()=> mapRow.remove());
  }

  // Lancement
  loadBtn.addEventListener("click", () => {
    loadBtn.disabled = true;
    progressBox.style.display = "block";
    loadCommunes();
  });
});
