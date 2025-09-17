let labels = {};
let currentLang = "fr";

function loadLabels(lang) {
  if (!window.verbal || !window.verbal[lang]) return;
  labels = window.verbal[lang];
  updateTexts();
}

function updateTexts() {
  document.getElementById("title").innerText = labels.title;
  document.getElementById("postalLabel").innerText = labels.enterPostal;
  document.getElementById("checkBtn").innerText = labels.checkBtn;
  document.getElementById("footer").innerText = labels.footer;
}

document.addEventListener("DOMContentLoaded", () => {
  loadLabels(currentLang);

  document.getElementById("langSelector").addEventListener("change", (e) => {
    currentLang = e.target.value;
    loadLabels(currentLang);
  });

  document.getElementById("checkBtn").addEventListener("click", async () => {
    const postalCode = document.getElementById("postalInput").value;
    if (!postalCode) return alert(labels.errorPostal || "Veuillez entrer un code postal valide.");

    const resultDiv = document.getElementById("result");
    resultDiv.innerHTML = `<p>⏳ Recherche en cours...</p>`;

    try {
      const res = await fetch(`/api/check/${postalCode}`);
      const data = await res.json();

      if (data.error) {
        resultDiv.innerHTML = `<p class="alert">❌ ${data.error}</p>`;
        return;
      }

      if (data.pfas === null) {
        resultDiv.innerHTML = `<p>${data.message || "PFAS non mesuré pour cette commune."}</p>`;
        return;
      }

      resultDiv.innerHTML = `
        <h3>${labels.results || "Résultats :"}</h3>
        <p>${labels.pfas || "PFAS"}: <strong>${data.pfas} µg/L</strong></p>
        <p>${labels.limit || "Limite légale (2026)"}: 0.1 µg/L</p>
        <p class="${data.pfas > 0.1 ? "alert" : "safe"}">
          ${data.pfas > 0.1 ? (labels.alert || "⚠️ Dépassement de la limite !") : (labels.safe || "✅ Eau conforme")}
        </p>
      `;
    } catch (err) {
      console.error("Erreur:", err);
      resultDiv.innerHTML = `<p class="alert">❌ Impossible de récupérer les données</p>`;
    }
  });
});
