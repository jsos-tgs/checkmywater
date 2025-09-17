// Config seuils
const limitRed = 0.1;   // > 0.1 = rouge (non conforme 2026)
const limitAmber = 0.05; // 0.05–0.1 = ambre (à surveiller)

// Couleur selon PFAS
function colorFor(value) {
  if (value == null || Number.isNaN(value)) return "grey";
  if (value > limitRed) return "red";
  if (value >= limitAmber) return "amber";
  return "green";
}

// Style cercle
function styleFor(value) {
  const c = colorFor(value);
  const palette = {
    green: { color: "#2e7d32", fillColor: "#2e7d32" },
    amber: { color: "#f9a825", fillColor: "#f9a825" },
    red:   { color: "#c62828", fillColor: "#c62828" },
    grey:  { color: "#9e9e9e", fillColor: "#9e9e9e" }
  }[c];
  return {
    radius: 6, weight: 1, opacity: 1,
    fillOpacity: 0.7, ...palette
  };
}

// Badge HTML
function badgeFor(value) {
  const c = colorFor(value);
  if (c === "green") return '<span class="badge safe">Conforme</span>';
  if (c === "amber") return '<span class="badge warn">À surveiller</span>';
  if (c === "red")   return '<span class="badge risk">Dépassement</span>';
  return '<span class="badge na">Non mesuré</span>';
}

let map, cluster, rows = [];

async function init() {
  // Carte
  map = L.map("map", { preferCanvas: true }).setView([46.8, 2.5], 6);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "© OpenStreetMap contributors"
  }).addTo(map);

  cluster = L.markerClusterGroup({
    chunkedLoading: true,
    maxClusterRadius: 60
  });
  map.addLayer(cluster);

  // Charge le gros JSON (toutes les villes)
  // Format attendu ci-dessous (section 4)
  const res = await fetch("/pfas.json");
  rows = await res.json();

  // Ajoute les points
  const pts = [];
  rows.forEach(r => {
    if (typeof r.lat !== "number" || typeof r.lon !== "number") return;
    const m = L.circleMarker([r.lat, r.lon], styleFor(r.pfas))
      .bindPopup(`
        <strong>${r.commune}${r.departement ? " ("+r.departement+")" : ""}</strong><br/>
        PFAS : ${r.pfas == null ? "N/A" : r.pfas + " µg/L"}<br/>
        Limite 2026 : ${limitRed} µg/L<br/>
        ${badgeFor(r.pfas)}
        ${r.date_mesure ? `<br/><small>Mesure : ${r.date_mesure}</small>` : ""}
      `);
    cluster.addLayer(m);
    pts.push([r.lat, r.lon]);
  });
  if (pts.length) map.fitBounds(pts, { padding: [30, 30] });

  // Recherche commune
  const input = document.getElementById("search");
  input.addEventListener("input", (e) => {
    const q = e.target.value.trim().toLowerCase();
    if (q.length < 2) return; // éviter les sauts de carte sur une lettre
    const found = rows.find(r =>
      (r.commune || "").toLowerCase().includes(q) ||
      (r.departement || "").toLowerCase().includes(q)
    );
    if (found && typeof found.lat === "number" && typeof found.lon === "number") {
      map.setView([found.lat, found.lon], 11);
    }
  });
}

init().catch(err => {
  console.error("Init map error:", err);
  alert("Impossible de charger la carte/données.");
});
