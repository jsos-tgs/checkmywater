const verbal = {
  fr: {
    title: "Mon Eau 2026",
    enterPostal: "Entrez votre code postal :",
    checkBtn: "Vérifier",
    footer: "Données issues de Hub’Eau - Version démo",
    results: "Résultats :",
    pfas: "PFAS",
    limit: "Limite légale (2026)",
    alert: "⚠️ Dépassement de la limite !",
    safe: "✅ Eau conforme",
    errorPostal: "Veuillez entrer un code postal valide."
  },
  en: {
    title: "My Water 2026",
    enterPostal: "Enter your postal code:",
    checkBtn: "Check",
    footer: "Data from Hub’Eau - Demo version",
    results: "Results:",
    pfas: "PFAS",
    limit: "Legal limit (2026)",
    alert: "⚠️ Above the limit!",
    safe: "✅ Water is compliant",
    errorPostal: "Please enter a valid postal code."
  }
};

// Export selon l'environnement
if (typeof module !== "undefined") {
  module.exports = verbal; // Node.js (backend)
} else {
  window.verbal = verbal; // Navigateur (frontend)
}
