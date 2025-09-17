const express = require("express");
const path = require("path");

const app = express();

// Servir les fichiers statiques depuis /public
app.use(express.static(path.join(__dirname, "../public")));

// Servir verbal.js
app.get("/verbal.js", (req, res) => {
  res.sendFile(path.join(__dirname, "verbal.js"));
});

// Données simulées (à remplacer par des données réelles plus tard)
const fakeData = {
  "75020": { pfas: 0.12 },
  "69001": { pfas: 0.05 },
  "13001": { pfas: 0.08 }
};

// Endpoint API
app.get("/api/check/:postal", (req, res) => {
  const code = req.params.postal;
  const result = fakeData[code] || { pfas: (Math.random() * 0.2).toFixed(2) };
  res.json(result);
});

// Lancement serveur
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
