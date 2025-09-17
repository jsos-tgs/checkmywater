let labels = {};
let currentLang = "fr";

function loadLabels(lang) {
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
    if (!postalCode) return alert(labels.errorPostal);

    const res = await fetch(`/api/check/${postalCode}`);
    const data = await res.json();

    document.getElementById("result").innerHTML = `
      <h3>${labels.results}</h3>
      <p>${labels.pfas}: <strong>${data.pfas} µg/L</strong></p>
      <p>${labels.limit}: 0.1 µg/L</p>
      <p class="${data.pfas > 0.1 ? "alert" : "safe"}">
        ${data.pfas > 0.1 ? labels.alert : labels.safe}
      </p>
    `;
  });
});
