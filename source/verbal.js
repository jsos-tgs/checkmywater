const express = require("express");
const path = require("path");
const fetch = require("node-fetch");

const app = express();

// Servir frontend
app.use(express.static(path.join(__dirname, "../public")));

app.get("/verbal.js", (req, res) => {
  res.sendFile(path.join(__dirname, "verbal.js"));
});

// Limite légale en 2026
const PFAS_LIMIT = 0.1;

// Fonction : trouver le code INSEE depuis code postal
async function getCommuneInseeFromPostal(postal) {
  const url = `https://api-adresse.data.gouv.fr/search/?q=${postal}&type=municipality`;
  try {
    const resp = await fetch(url);
    const json = await resp.json();
    if (json.features && json.features.length > 0) {
      return json.features[0].properties.code; // code INSEE
    }
  } catch (err) {
    console.error("Erreur getCommuneInseeFromPostal:", err);
  }
  return null;
}

// Endpoint API
app.get("/api/check/:postal", async (req, res) => {
  const postal = req.params.postal;

  try {
    const codeCommune = await getCommuneInseeFromPostal(postal);
    if (!codeCommune) {
      return res.json({ pfas: null, message: "Commune introuvable pour ce code postal." });
    }

    const hubUrl = `https://hubeau.eaufrance.fr/api/v1/qualite_eau_potable/resultats_dis?code_commune=${codeCommune}&size=50&format=json`;
    const apiResp = await fetch(hubUrl);
    if (!apiResp.ok) throw new Error("Erreur API Hub’Eau");

    const apiJson = await apiResp.json();
    const resultats = apiJson.data || [];

    // Chercher un résultat PFAS
    let pfasValue = null;
    for (const item of resultats) {
      if (item.libelle_parametre && /pfas/i.test(item.libelle_parametre)) {
        pfasValue = parseFloat(item.resultat);
        break;
      }
    }

    if (pfasValue === null) {
      return res.json({ pfas: null, message: "PFAS non mesuré dans les analyses de cette commune." });
    }

    res.json({ pfas: pfasValue });
  } catch (err) {
    console.error("Erreur interne:", err);
    res.status(500).json({ error: "Erreur interne serveur" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
