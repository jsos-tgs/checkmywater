// tools/build_pfas_json.mjs
// Usage local: node tools/build_pfas_json.mjs
// Produit: public/pfas.json

import fs from "fs/promises";
import path from "path";
import fetch from "node-fetch";
import pLimit from "p-limit";

const OUT_PATH = path.resolve(process.cwd(), "public", "pfas.json");

// 1) Récupère toutes les communes de France + coordonnées (centre)
async function fetchCommunes() {
  // API Découpage administratif (geo.api.gouv.fr)
  // Doc: https://geo.api.gouv.fr/  (communes?fields=code,nom,centre)
  const url = "https://geo.api.gouv.fr/communes?fields=code,nom,centre,codeDepartement,departement,codeRegion,region&format=json&geometry=centre";
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Erreur communes: ${r.status}`);
  const communes = await r.json();
  // Normalise {code, nom, lat, lon, departement, region}
  return communes
    .filter(c => c.centre && c.centre.coordinates)
    .map(c => ({
      code_insee: c.code,
      commune: c.nom,
      lat: c.centre.coordinates[1],
      lon: c.centre.coordinates[0],
      departement: c.departement || null,
      code_departement: c.codeDepartement || null,
      region: c.region || null,
      code_region: c.codeRegion || null
    }));
}

// 2) Interroge Hub’Eau pour une commune (code INSEE) et retourne une mesure PFAS (valeur + date)
async function fetchPFASForCommune(code_insee) {
  // Hub’Eau "Qualité de l'eau potable" (DIS)
  // Docs: https://hubeau.eaufrance.fr/page/api-qualite-eau-potable
  // Endpoint (JSON): /api/v1/qualite_eau_potable/resultats_dis
  // Filtrage: code_commune=INSEE ; size large pour capter les entrées récentes
  const base = "https://hubeau.eaufrance.fr/api/v1/qualite_eau_potable/resultats_dis";
  const url = `${base}?code_commune=${encodeURIComponent(code_insee)}&size=500&format=json`;

  const r = await fetch(url);
  if (!r.ok) throw new Error(`HubEau ${code_insee}: ${r.status}`);
  const json = await r.json();
  const rows = json.data || [];

  if (!rows.length) return null;

  // On scanne les lignes pour trouver des paramètres PFAS.
  // Les libellés varient (PFAS, perfluoro-, polyfluoro-…), on ratisse large.
  const PFAS_REGEX = /(pfas|perfluoro|polyfluoro|fluoroalkyl|perfluorocarboxyl|perfluorosulfon)/i;

  // On retient la mesure la plus récente (date_prelevement) si plusieurs
  let best = null;
  for (const row of rows) {
    const label = row.libelle_parametre || row.parametre || "";
    if (!PFAS_REGEX.test(label)) continue;

    const val = row.resultat !== undefined ? Number(row.resultat) : NaN;
    if (Number.isNaN(val)) continue;

    const date = row.date_prelevement || row.date_analyse || null;

    // Choix: on prend la mesure la plus récente
    if (!best || (date && best.date_mesure && date > best.date_mesure) || (!best.date_mesure && date)) {
      best = {
        pfas: val,
        date_mesure: date,
        libelle: label
      };
    }
  }

  return best; // peut être null si aucune ligne PFAS détectée
}

// 3) Pipeline complet avec limitation de concurrence pour ménager les APIs
async function buildAll() {
  console.log("➡️  Récupération de la liste des communes…");
  const communes = await fetchCommunes();
  console.log(`✅ ${communes.length} communes chargées`);

  const limit = pLimit(6); // 6 requêtes en parallèle (réglable)
  let processed = 0;

  const results = await Promise.all(
    communes.map(c =>
      limit(async () => {
        try {
          const pf = await fetchPFASForCommune(c.code_insee);
          processed++;
          if (processed % 1000 === 0) console.log(`… ${processed}/${communes.length}`);

          return {
            commune: c.commune,
            code_insee: c.code_insee,
            code_postal: null, // non fourni ici (peut être enrichi plus tard)
            departement: c.departement,
            region: c.region,
            pfas: pf ? pf.pfas : null,
            date_mesure: pf ? pf.date_mesure : null,
            lat: c.lat,
            lon: c.lon,
            source: pf ? "HubEau" : "HubEau (non mesuré)"
          };
        } catch (e) {
          // En cas d’erreur ponctuelle sur une commune, on n’arrête pas tout
          return {
            commune: c.commune,
            code_insee: c.code_insee,
            code_postal: null,
            departement: c.departement,
            region: c.region,
            pfas: null,
            date_mesure: null,
            lat: c.lat,
            lon: c.lon,
            source: "HubEau (erreur commune)"
          };
        }
      })
    )
  );

  // Écrit le JSON final
  await fs.mkdir(path.dirname(OUT_PATH), { recursive: true });
  await fs.writeFile(OUT_PATH, JSON.stringify(results), "utf8");
  console.log(`✅ Généré: ${OUT_PATH} (${results.length} entrées)`);
}

buildAll().catch(err => {
  console.error("❌ Erreur build:", err);
  process.exit(1);
});
