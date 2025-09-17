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

  // ⚡ pour réduire le volume, on ne prend que les analyses récentes (à ajuster si besoin)
  const DATE_MIN = "2024-01-01"; // ISO yyyy-mm-dd

  // --- endpoints ---
  const GEO_DEPTS = `https://geo.api.gouv.fr/departements?fields=code,nom&format=json`;
  // Liste nationale des communes (pour éviter 101 appels GeoAPI) — cache 1 jour
  const GEO_COMMUNES_FR =
    `https://geo.api.gouv.fr/communes?fields=code,nom,centre&format=json&geometry=centre`;

  // Hub’Eau potable — par département, pagination via "next"
  // Doc : resultats_dis, pagination (prev/next/first/last, count, data). Taille page max typiquement 20000. :contentReference[oaicite:1]{index=1}
  function HUBEAU_DEP_FIRST(dept) {
    const base = `https://hubeau.eaufrance.fr/api/v1/qualite_eau_potable/resultats_dis`;
    const fields = [
      "code_commune",
      "libelle_parametre",
      "parametre",
      "resultat",
      "resultat_numerique",
      "unite",
      "unite_resultat",
      "date_prelevement"
    ].join(",");
    return `${base}?code_departement=${encodeURIComponent(dept)}&fields=${fields}` +
           `&date_min_prelevement=${DATE_MIN}&size=20000&sort=desc`;
  }

  // --- utils http ---
  async function getJSON(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} on ${url}`);
    return res.json();
  }

  // --- pagination Hub’Eau : on suit "next" jusqu’à null ---
  async function fetchAllDisForDepartment(deptCode) {
    let url = HUBEAU_DEP_FIRST(deptCode);
    const all = [];
    let guard = 0;
    while (url && guard < 100) {
      const json = await getJSON(url);
      const rows = json?.data || [];
      all.push(...rows);
      url = json?.next || null;  // fourni par Hub’Eau
      guard++;
    }
    return all;
  }

  // Agrège par commune (max PFAS)
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
  const todayKey = () => new Date().toISOString().slice(0, 10);
  const readCache = (key) => {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return null;
      const obj = JSON.parse(raw);
      if (obj.date !== todayKey()) return null;
      return obj.data;
    } catch { return null; }
  };
  const writeCache = (key, data) => {
    try {
      localStorage.setItem(key, JSON.stringify({ date: todayKey(), data }));
    } catch {}
  };

  // Précharge la carte des communes (INSEE -> nom, lat, lon)
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

  // Charge par DEPARTEMENT (fiable) + jointure + filtre > seuil
  async function loadPFASByDepartments() {
    const cached = readCache("pfas_by_department");
    if (cached) return cached;

    const geoMap = await getGeoCommunesMap();
    const depts = await getJSON(GEO_DEPTS);

    const start = Date.now();
    let done = 0;
    const matches = [];

    for (const dep of depts) {
      const rows = await fetchAllDisForDepartment(dep.code);
      const byCommune = aggregateByCommune(rows);

      for (const [insee, agg] of Object.entries(byCommune)) {
        if (agg.value > seuil && geoMap[insee]) {
          matches.push({
            code: insee,
            nom: geoMap[insee].nom,
            lat: geoMap[insee].lat,
            lon: geoMap[insee].lon,
            dep: dep.code,
            value: agg.value,
            date: agg.date
          });
        }
      }

      done++;
      const percent = Math.round((done / depts.length) * 100);
      progressBar.style.width = percent + "%";
      statusEl.textContent = `Départements traités : ${done}/${depts.length}`;

      const elapsed = (Date.now() - start) / 1000;
      const rate = done / (elapsed || 1e-6);
      const remaining = (depts.length - done) / rate;
      etaEl.textContent = `Temps estimé restant : ~${Math.ceil(remaining)} sec`;
    }

    writeCache("pfas_by_department", matches);
    return matches;
  }

  // Affichage tableau + cartes inline
  function displayCommunes(list) {
    etaEl.textContent = "";
    statusEl.textContent = `✅ Terminé — ${list.length} communes dépassent le seuil`;
    resultsSection.style.display = "block";

    // tri décroissant par valeur
    list.sort((a, b) => b.value - a.value);

    list.forEach((c) => {
      const row = document.createElement("tr");
      row.innerHTML = `
        <td>${escapeHtml(c.nom)}</td>
        <td>${escapeHtml(c.dep)}</td>
        <td>${c.value.toFixed(3)}</td>
        <td>${c.date || "-"}</td>
      `;
      row.addEventListener("click", () => toggleInlineMap(row, c));
      tableBody.appendChild(row);
    });
  }

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
      const data = await loadPFASByDepartments();
      displayCommunes(data);
    } catch (e) {
      console.error(e);
      statusEl.textContent = "Erreur lors du chargement des données Hub’Eau.";
      etaEl.textContent = "";
    }
  });
});
