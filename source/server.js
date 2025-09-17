const express = require("express");
const path = require("path");

const app = express();

// Données simulées
const fakeData = {
  "75020": { pfas: 0.12 },
  "69001": { pfas: 0.05 },
  "13001": { pfas: 0.08 }
};

app.use(express.static(path.join(__dirname)));

app.get("/api/check/:postal", (req, res) => {
  const code = req.params.postal;
  const result = fakeData[code] || { pfas: (Math.random() * 0.2).toFixed(2) };
  res.json(result);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));

