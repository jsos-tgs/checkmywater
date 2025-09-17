// tools/build_pfas_real.mjs
// Usage local :
//   - test rapide (échantillon) : SAMPLE=1 node tools/build_pfas_real.mjs
//   - run complet : node tools/build_pfas_real.mjs
//
// Produit : public/pfas.json  (format consommé par ta carte Leaflet)

import fs from "fs/promises";
import path from "path";
import fetch from "node-fetch";
import pLimit from "p-limit";

const ROOT = process.cwd();
const OUT  = path.resolve(ROOT, "public", "pfas.json");

// ---- Config ----
const SAMPLE = process.env.SAMPLE === "1";   // SAMPLE=1 pour un test rapide
const CONCURRENCY = Number(process.env.CONCURRENCY || (SAMPLE ? 6 : 3));
const MAX_COMMUNES = SAMPLE ? 800 : Infinity; // ~800 pour tester rapidement
const UA = "CheckMyWaterBot/1.0 (+contact@example.com)";

// seuil visuel (front)
const LIMIT_2026 = 0.1; // µg/L (info uniquement)

// ---- Helpers HTTP ----
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function getJson(url, { retries = 4, timeoutMs = 30000 } = {}) {
  for (let i = 0; i < retries; i++) {
    try {
      const ctrl = new AbortController();
      const tid = setTimeout(() => ctrl.abort(), timeoutMs);
      const res = await fetch(url, {
        signal: ctrl.signal,
        headers: { "User-Agent": UA, "Accept": "application/json" }
      });
      clearTimeout(tid);
      if (res.ok) return await res.json();
      if (res.status === 429 || res.status >= 500) {
        await sleep(1000 * (i + 1));
        continue;
      }
      const text = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status} ${url} ${text.slice(0,140)}`);
    } catch (e) {
      if (i === retries - 1) throw e;
      await sleep(1000 * (i + 1));
    }
  }
  throw new Error("unreachable");
}

// 1) Liste des communes FR + coordonnées (centre)
async function fetchCommunes() {
  const url =
    "https://geo.api.gouv.fr/communes" +
    "?fields=code,nom,centre,codeDepartement,departement,codeRegion,region" +
    "&format=json&geometry=centre";
  const arr = await getJson(url, { retries: 4, timeoutMs: 45000 });
  const list = arr
    .filter(c => c?.centre?.coordinates)
    .map(c => ({
      code_insee: c.code,
      commune: c.nom,
      lat: c.centre.coordinates[1],
      lon: c.centre.coordinates[0],
      departement: c.departement || null,
      region: c.region || null
    }));
  return list.slice(0, MAX_COMMUNES);
}

// 2) Valeur PFAS pour une commune (Hub’Eau - DIS)
async function fetchPFASForCommune(code_insee) {
  // Doc : https://hubeau.eaufrance.fr/page/api-qualite-eau-potable
  // Endpoint : /api/v1/qualite_eau_potable/resultats_dis
  const base = "https://hubeau.eaufrance.fr/api/v1/qualite_eau_potable/resultats_dis";
  const url  = `${base}?code_commune=${encodeURIComponent(code_insee)}&size=500&format=json`;

  const json = await getJson(url, { retries: 4, timeoutMs: 45000 });
  const rows = json?.data || [];
  if (!rows.length) return null;

  // Les libellés PFAS peuvent varier : on ratisse large
  const PFAS_REGEX = /(pfas|perfluoro|polyfluoro|fluoroalkyl|perfluorocarboxyl|perfluorosulfon)/i;

  // On retient la mesure PFAS la plus récente (si plusieurs)
  let best = null;
  for (const r of rows) {
    const label = r.libelle_parametre || r.parametre || "";
    if (!PFAS_REGEX.test(label)) continue;

    const val = r.resultat !== undefined ? Number(r.resultat) : NaN;
    if (Number.isNaN(val)) continue;

    const date = r.date_prelevement || r.date_analyse || null;

    if (
      !best ||
      (date && best.date_mesure && date > best.date_mesure) ||
      (!best.date_mesure && date)
    ) {
      best = { pfas: val, date_mesure: date, libelle: label };
    }
  }

  return best; // peut rester null si aucun PFAS dans les lignes
}

// 3) Build complet
async function main() {
  console.log(`➡️  Build PFAS (SAMPLE=${SAMPLE ? "ON" : "OFF"}, concurrency=${CONCURRENCY})`);
  const communes = await fetchCommunes();
  console.log(`✅ Communes chargées : ${communes.length}`);

  const limit = pLimit(CONCURRENCY);
  let processed = 0, withPFAS = 0;

  const out = await Promise.all(
    communes.map(c =>
      limit(async () => {
        try {
          const pf = await fetchPFASForCommune(c.code_insee);
          processed++;
          if (pf) withPFAS++;
          if (processed % 1000 === 0) {
            console.log(`… ${processed}/${communes.length} (PFAS trouvés: ${withPFAS})`);
          }
          return {
            commune: c.commune,
            code_insee: c.code_insee,
            departement: c.departement,
            region: c.region,
            pfas: pf ? pf.pfas : null,
            date_mesure: pf ? pf.date_mesure : null,
            lat: c.lat,
            lon: c.lon,
            source: pf ? "HubEau" : "HubEau (non mesuré)",
            limite_2026: LIMIT_2026
          };
        } catch (e) {
          processed++;
          if (processed % 1000 === 0) console.log(`… ${processed}/${communes.length}`);
          return {
            commune: c.commune,
            code_insee: c.code_insee,
            departement: c.departement,
            region: c.region,
            pfas: null,
            date_mesure: null,
            lat: c.lat,
            lon: c.lon,
            source: "HubEau (erreur commune)",
            limite_2026: LIMIT_2026
          };
        }
      })
    )
  );

  await fs.mkdir(path.dirname(OUT), { recursive: true });
  await fs.writeFile(OUT, JSON.stringify(out), "utf8");
  console.log(`✅ Écrit : ${OUT} — ${out.length} lignes — PFAS trouvés : ${withPFAS}`);
}

main().catch(async (e) => {
  console.error("❌ Build global :", e);
  // On écrit quand même un fichier vide pour ne pas bloquer l’intégration
  await fs.mkdir(path.dirname(OUT), { recursive: true });
  await fs.writeFile(OUT, "[]", "utf8");
});
