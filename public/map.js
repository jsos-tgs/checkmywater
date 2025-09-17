document.addEventListener("DOMContentLoaded", () => {
  const mapBtn = document.getElementById("mapBtn");
  const mapDiv = document.getElementById("map");
  let map;

  // Exemples de zones contaminées (remplaçables par dataset complet)
  const contaminatedZones = [
    { name: "Village-Neuf", coords: [47.6, 7.58], pfas: 0.34 },
    { name: "Lunel-Viel", coords: [43.68, 4.05], pfas: 0.17 },
    { name: "Fos-sur-Mer", coords: [43.44, 4.94], pfas: 0.16 },
    { name: "Givors", coords: [45.59, 4.77], pfas: 0.14 }
  ];

  mapBtn.addEventListener("click", () => {
    // Affiche la div carte
    mapDiv.style.display = "block";

    if (!map) {
      // Init carte centrée sur la France
      map = L.map("map").setView([46.8, 2.5], 6);

      // Fond de carte OSM
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: "© OpenStreetMap contributors"
      }).addTo(map);

      // Ajout des zones contaminées
      contaminatedZones.forEach(zone => {
        const marker = L.circleMarker(zone.coords, {
          radius: 8,
          color: zone.pfas > 0.1 ? "red" : "green",
          fillOpacity: 0.6
        }).addTo(map);

        marker.bindPopup(`
          <strong>${zone.name}</strong><br/>
          PFAS : ${zone.pfas} µg/L<br/>
          Limite : 0.1 µg/L<br/>
          ${zone.pfas > 0.1 ? "⚠️ Dépassement" : "✅ Conforme"}
        `);
      });
    }
  });
});
