document.addEventListener("DOMContentLoaded", () => {
  const loadBtn = document.getElementById("loadBtn");
  const progressBox = document.getElementById("progressBox");
  const progressBar = document.getElementById("progressBar");
  const statusEl = document.getElementById("status");
  const etaEl = document.getElementById("eta");
  const resultsSection = document.getElementById("results");
  const tableBody = document.querySelector("#communesTable tbody");

  // --- paramètres ---
  const seuil = 0.10;
  const PFAS_REGEX = /(pfas|perfluoro|polyfluoro|fluoroalkyl|perfluoro(carboxyl|sulfon))/i;

  // 7 grands bassins métropolitains (codes Hub’Eau usuels 1..7)
  const BASINS = [
    { code: 1, name: "Artois-Picardie" },
    { code: 2, name: "Rhin-Meuse" },
    { code: 3, name: "Seine-Normandie" },
    { code: 4, name: "Loire-Bretagne" },
    { code: 5, name: "Garonne-Adour" },
    { code: 6, name: "Rhône-Méditerranée" },
    { code: 7, name: "Corse" }
  ];

  // --- endpoints ---
  const HUBEAU_BASSIN = (b) =>
    `https://hubeau.eaufrance.fr/api/v1/qualite_eau_potable/resultats_dis` +
    `?code_bassin=${b}&fields=code_commune,libelle_parametre,parametre,resultat,resultat_numerique,unite,unite_resultat,date_prelevement` +
    `&size=10000&page=`;

  // Liste nationale des communes (nom + centre) — 1 requête (cache 1 jour)
  const GEO_COMMUNES_FR =
    `https://geo.api.gouv.fr/communes?fields=code,nom,centre&format=json&geometry=centre`;

  // --- utils http ---
  async function getJSON(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} on ${url}`);
    return res.json();
  }

  // Pagination Hub’Eau (page=1..n, size=10000) — on concatène tout
  async function fetchAllResultsForBasin(basinCode) {
    const all = [];
    let page = 1;
    while (true) {
      const url = HUBEAU_BASSIN(basinCode) + page;
      const json = await getJSON(url);
      const rows = json?.data || [];
      if (!rows.length) break;
      all.push(...rows);
      // Heuristique : si moins de 10k, on a tout; sinon on tente page suivante
      if (rows.length < 10000) break;
      page++;
    }
    return all;
  }

  // Agrège par commune (valeur max PFAS observée)
  function aggregateByCommune(rows) {
    const map = {};
    for (const r of rows) {
      if (!PFAS_REGEX.test(r.libelle_parametre || r.parametre || "")) continue;
      const insee = r.code_commune;
      if (!insee) continue;
      const v = r.resultat != null
        ? Number(r.resultat)
        : (r.resultat_numerique != null ? Number(r.resultat_numerique) : NaN);
      if (Number.isNaN(v)) continue;

      if (!map[insee] || map[insee].value < v) {
        map[insee] = {
          code: insee,
          value: v,
          unit: r.unite || r.unite_resultat || "µg/L",
          date: r.date_prelevement || ""
        };
      }
    }
    return map;
  }

  // --- cache jour simple ---
  function todayKey() {
    return new Date().toISOString().slice(0, 10);
  }
  function readCache(name) {
    try {
      const raw = localStorage.getItem(name);
      if (!raw) return null;
      const obj = JSON.parse(raw);
      if (obj.date !== todayKey()) return null;
      return obj.data;
    } catch { return null; }
  }
  function writeCache(name, data) {
    try {
      localStorage.setItem(name, JSON.stringify({ date: todayKey(), data }));
    } catch {}
  }

  // Charge (ou cache) la liste nationale des communes pour join INSEE -> {nom, lat, lon}
  async function getGeoCommunesMap() {
    const cached = readCache("geo_communes_fr");
    if (cached) return cached;
    const list = await getJSON(GEO_COMMUNES_FR);
    const map = {};
    for (const c of list) {
      if (!c?.code || !c?.centre?.coordinates) continue;
      map[c.code] = {
        code: c.code,
        nom: c.nom,
        lat: c.centre.coordinates[1],
        lon: c.centre.coordinates[0]
      };
    }
    writeCache("geo_communes_fr", map);
    return map;
  }

  // Charge PFAS par bassins (7 appels) + agrège par commune + filtre > seuil
  async function loadPFASByBasins() {
    const cached = readCache("pfas_by_basin");
    if (cached) {
      return cached; // [{nom, dep?, lat, lon, value, date, code}]
    }

    const geoMap = await getGeoCommunesMap();

    const start = Date.now();
    let basinDone = 0;
    let matches = [];

    for (const b of BASINS) {
      // Récupération paginée de ce bassin
      const rows = await fetchAllResultsForBasin(b.code);
      const byCommune = aggregateByCommune(rows);

      // Join + filtre au-dessus du seuil
      for (const [insee, agg] of Object.entries(byCommune)) {
        if (agg.value > seuil && geoMap[insee]) {
          matches.push({
            code: insee,
            nom: geoMap[insee].nom,
            lat: geoMap[insee].lat,
            lon: geoMap[insee].lon,
            value: agg.value,
            date: agg.date
          });
        }
      }

      basinDone++;
      // progression & ETA (mise à jour visuelle)
      const percent = Math.round((basinDone / BASINS.length) * 100);
      progressBar.style.width = percent + "%";
      statusEl.textContent = `Bassins traités : ${basinDone}/${BASINS.length}`;

      const elapsed = (Date.now() - start) / 1000;
      const rate = basinDone / elapsed; // bassin/s
      const remaining = (BASINS.length - basinDone) / (rate || 0.001);
      etaEl.textContent = `Temps estimé restant : ~${Math.ceil(remaining)} sec`;
    }

    // Cache pour la journée
    writeCache("pfas_by_basin", matches);
    return matches;
  }

  // Affichage du tableau + cartes inline au clic (avec bouton Fermer)
  function displayCommunes(list) {
    etaEl.textContent = "";
    statusEl.textContent = `✅ Terminé — ${list.length} communes dépassent le seuil`;
    resultsSection.style.display = "block";

    // Tri décroissant par valeur
    list.sort((a, b) => b.value - a.value);

    list.forEach((c) => {
      const row = document.createElement("tr");
      row.innerHTML = `
        <td>${escapeHtml(c.nom)}</td>
        <td><!-- Département non calculé en mode bassin --></td>
        <td>${c.value.toFixed(3)}</td>
        <td>${c.date || "-"}</td>
      `;
      row.addEventListener("click", () => toggleInlineMap(row, c));
      tableBody.appendChild(row);
    });
  }

  // Affiche/ferme une carte sous la ligne
  function toggleInlineMap(row, c) {
    const existing = row.nextElementSibling;
    if (existing && existing.classList.contains("mapRow")) {
      existing.remove();
      return;
    }
    document.querySelectorAll(".mapRow").forEach((el) => el.remove());

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

    const map = L.map(mapDiv).setView([c.lat, c.lon], 13);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "© OpenStreetMap contributors"
    }).addTo(map);

    L.marker([c.lat, c.lon]).addTo(map)
      .bindPopup(`<strong>${escapeHtml(c.nom)}</strong><br/>PFAS : ${c.value.toFixed(3)} µg/L`).openPopup();

    closeBtn.addEventListener("click", () => mapRow.remove());
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
  }

  // Lancement
  loadBtn.addEventListener("click", async () => {
    loadBtn.disabled = true;
    progressBox.style.display = "block";

    try {
      const data = await loadPFASByBasins();
      displayCommunes(data);
    } catch (e) {
      console.error(e);
      statusEl.textContent = "Erreur lors du chargement des données.";
      etaEl.textContent = "";
    }
  });
});
