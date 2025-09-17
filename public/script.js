let labels = {};
let currentLang = "fr";

function loadLabels(lang) {
  if (!window.verbal || !window.verbal[lang]) return; // fallback si verbal.js n'est pas trouvé
  labels = window.verbal[lang];
  updateTexts();
}

function updateTexts() {
  if (!labels) return;
  document.getElementById("title").innerText = labels.title;
  document.getElementById("postalLabel").innerText = labels.enterPostal;
  document.getElementById("checkBtn").innerText = labels.checkBtn;
  document.getElementById("footer").innerText = labels.footer;
}

document.addEventListener("DOMContentLoaded", () => {
  // Charger les textes multilingues au démarrage
  loadLabels(currentLang);

  // Gestion du sélecteur de langue
  document.getElementById("langSelector").addEventListener("change", (e) => {
    currentLang = e.target.value;
    loadLabels(currentLang);
  });

  // Action du bouton Vérifier
  document.getElementById("checkBtn").addEventListener("click", async () => {
    const postalCode = document.getElementById("postalInput").value;
    if (!postalCode) return alert(labels.errorPostal || "Veuillez entrer un code postal valide.");

    const res = await fetch(`/api/check/${postalCode}`);
    const data = await res.json();

    document.getElementById("result").innerHTML = `
      <h3>${labels.results || "Résultats :"}</h3>
      <p>${labels.pfas || "PFAS"}: <strong>${data.pfas} µg/L</strong></p>
      <p>${labels.limit || "Limite légale (2026)"}: 0.1 µg/L</p>
      <p class="${data.pfas > 0.1 ? "alert" : "safe"}">
        ${data.pfas > 0.1 ? (labels.alert || "⚠️ Dépassement de la limite !") : (labels.safe || "✅ Eau conforme")}
      </p>
    `;
  });
});
