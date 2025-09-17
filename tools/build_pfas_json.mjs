// tools/build_pfas_json.mjs
// Usage local : node tools/build_pfas_json.mjs
// En CI (GHA) : exécuté depuis le dossier "source" via npm script (voir package.json)

import fs from "fs/promises";
import path from "path";
import fetch from "node-fetch";
import pLimit from "p-limit";

const ROOT = path.resolve(process.cwd(), "..");          // on est lancé depuis /source en CI
const OUT_PATH = path.resolve(ROOT, "public", "pfas.json");
const UA = "CheckMyWaterBot/1.0 (contact: maintainer@example.com)";

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function httpGetJson(url, { retries = 3, timeoutMs = 20000 } = {}) {
  for (let i = 0; i < retries; i++) {
    try {
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), timeoutMs);

      const r = await fetch(url, {
        signal: ctrl.signal,
        headers: { "User-Agent": UA, "Accept": "application/json" }
      });
      clearTimeout(to);

      if (r.ok) return await r.json();
      console.warn(`[HTTP ${r.status}] ${url}`);
      // 429/5xx → retry
      if (r.status >= 500 || r.status === 429) {
        await sleep(1000 * (i + 1));
        continue;
      }
      throw new Error(`HTTP ${r.status}`);
    } catch (e) {
      if (i === retries - 1) throw e;
      await sleep(1000 * (i + 1));
    }
  }
  throw new Error("Unreachable");
}

// 1) Toutes les communes FR (code INSEE + centre géo)
async function fetchCommunes() {
  const url = "https://geo.api.gouv.fr/communes?fields=code,nom,centre,codeDepartement,departement,codeRegion,region&format=json&geometry=centre";
  const communes = await httpGetJson(url, { retries: 4, timeoutMs: 30000 });
  return communes
    .filter(c => c?.centre?.coordinates)
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

// 2) PFAS pour une commune (Hub’Eau DIS)
async function fetchPFASForCommune(code_insee) {
  const base = "https://hubeau.eaufrance.fr/api/v1/qualite_eau_potable/resultats_dis";
  const url = `${base}?code_commune=${encodeURIComponent(code_insee)}&size=500&format=json`;

  const json = await httpGetJson(url, { retries: 4, timeoutMs: 30000 });
  const rows = json?.data || [];
  if (!rows.length) return null;

  // large filet pour PFAS (labels variables)
  const PFAS_REGEX = /(pfas|perfluoro|polyfluoro|fluoroalkyl|perfluorocarboxyl|perfluorosulfon)/i;

  let best = null;
  for (const row of rows) {
    const label = row.libelle_parametre || row.parametre || "";
    if (!PFAS_REGEX.test(label)) continue;

    const val = row.resultat !== undefined ? Number(row.resultat) : NaN;
    if (Number.isNaN(val)) continue;

    const date = row.date_prelevement || row.date_analyse || null;

    // garde la plus récente
    if (
      !best ||
      (date && best.date_mesure && date > best.date_mesure) ||
      (!best.date_mesure && date)
    ) {
      best = { pfas: val, date_mesure: date, libelle: label };
    }
  }
  return best;
}

async function buildAll() {
  console.log("➡️  Chargement des communes…");
  const communes = await fetchCommunes();
  console.log(`✅ ${communes.length} communes`);

  // limite de parallélisme pour ménager les APIs
  const limit = pLimit(6);
  let processed = 0, withData = 0;

  const results = await Promise.all(
    communes.map(c =>
      limit(async () => {
        try {
          const pf = await fetchPFASForCommune(c.code_insee);
          processed++;
          if (pf) withData++;
          if (processed % 1000 === 0) {
            console.log(`… ${processed}/${communes.length} (avec PFAS : ${withData})`);
          }
          return {
            commune: c.commune,
            code_insee: c.code_insee,
            code_postal: null,
            departement: c.departement,
            region: c.region,
            pfas: pf ? pf.pfas : null,
            date_mesure: pf ? pf.date_mesure : null,
            lat: c.lat,
            lon: c.lon,
            source: pf ? "HubEau" : "HubEau (non mesuré)"
          };
        } catch (e) {
          processed++;
          if (processed % 1000 === 0) console.log(`… ${processed}/${communes.length}`);
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

  await fs.mkdir(path.dirname(OUT_PATH), { recursive: true });
  await fs.writeFile(OUT_PATH, JSON.stringify(results), "utf8");
  console.log(`✅ Écrit: ${OUT_PATH} — ${results.length} lignes — avec PFAS: ${withData}`);
}

buildAll().catch(err => {
  console.error("❌ Build échoué:", err);
  process.exit(1);
});
