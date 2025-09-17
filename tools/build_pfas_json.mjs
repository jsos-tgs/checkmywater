// tools/build_pfas_json.mjs
import fs from "fs/promises";
import path from "path";
import fetch from "node-fetch";
import pLimit from "p-limit";

const ROOT = path.resolve(process.cwd(), ".."); // on exécute depuis /source
const OUT = path.resolve(ROOT, "public", "pfas.json");
const UA = "CheckMyWaterBot/1.0 (+contact@example.com)";

// ---- config exécutables via variables CI ----
const SAMPLE_MODE = process.env.SAMPLE_MODE === "1";     // ex: 1 pour accélérer les tests
const CONCURRENCY = Number(process.env.CONCURRENCY || (SAMPLE_MODE ? 6 : 3));
const PAGE_COMMUNES = SAMPLE_MODE ? 500 : Infinity;      // limite de communes en mode test

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function httpGetJson(url, { retries = 4, timeoutMs = 30000 } = {}) {
  for (let i = 0; i < retries; i++) {
    try {
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), timeoutMs);
      const r = await fetch(url, { signal: ctrl.signal, headers: { "User-Agent": UA, "Accept": "application/json" } });
      clearTimeout(to);
      if (r.ok) return await r.json();
      if (r.status === 429 || r.status >= 500) { await sleep(1000 * (i + 1)); continue; }
      throw new Error(`HTTP ${r.status} on ${url}`);
    } catch (e) {
      if (i === retries - 1) throw e;
      await sleep(1000 * (i + 1));
    }
  }
  throw new Error("unreachable");
}

async function fetchCommunes() {
  const url = "https://geo.api.gouv.fr/communes?fields=code,nom,centre,codeDepartement,departement,codeRegion,region&format=json&geometry=centre";
  const arr = await httpGetJson(url, { retries: 4, timeoutMs: 45000 });
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
  return SAMPLE_MODE ? list.slice(0, PAGE_COMMUNES) : list;
}

async function fetchPFASForCommune(code_insee) {
  const base = "https://hubeau.eaufrance.fr/api/v1/qualite_eau_potable/resultats_dis";
  const url = `${base}?code_commune=${encodeURIComponent(code_insee)}&size=500&format=json`;
  const json = await httpGetJson(url, { retries: 4, timeoutMs: 45000 });
  const rows = json?.data || [];
  if (!rows.length) return null;

  const PFAS_REGEX = /(pfas|perfluoro|polyfluoro|fluoroalkyl|perfluorocarboxyl|perfluorosulfon)/i;
  let best = null;
  for (const r of rows) {
    const label = r.libelle_parametre || r.parametre || "";
    if (!PFAS_REGEX.test(label)) continue;
    const val = r.resultat !== undefined ? Number(r.resultat) : NaN;
    if (Number.isNaN(val)) continue;
    const date = r.date_prelevement || r.date_analyse || null;
    if (!best || (date && best.date_mesure && date > best.date_mesure) || (!best.date_mesure && date)) {
      best = { pfas: val, date_mesure: date, libelle: label };
    }
  }
  return best;
}

async function main() {
  console.log(`➡️  Build PFAS (sample=${SAMPLE_MODE}, concurrency=${CONCURRENCY})`);
  let communes;
  try {
    communes = await fetchCommunes();
  } catch (e) {
    console.error("❌ communes:", e);
    // Écrit au moins un fichier vide lisible par le front
    await fs.mkdir(path.dirname(OUT), { recursive: true });
    await fs.writeFile(OUT, "[]", "utf8");
    return; // ne pas exit 1
  }
  console.log(`✅ Communes chargées: ${communes.length}`);

  const limit = pLimit(CONCURRENCY);
  let processed = 0, withData = 0;

  const results = await Promise.all(communes.map(c =>
    limit(async () => {
      try {
        const pf = await fetchPFASForCommune(c.code_insee);
        processed++;
        if (pf) withData++;
        if (processed % 1000 === 0) console.log(`… ${processed}/${communes.length} (PFAS trouvés: ${withData})`);
        return {
          commune: c.commune, code_insee: c.code_insee,
          departement: c.departement || null, region: c.region || null,
          pfas: pf ? pf.pfas : null, date_mesure: pf ? pf.date_mesure : null,
          lat: c.lat, lon: c.lon, source: pf ? "HubEau" : "HubEau (non mesuré)"
        };
      } catch (e) {
        processed++;
        if (processed % 1000 === 0) console.log(`… ${processed}/${communes.length}`);
        return {
          commune: c.commune, code_insee: c.code_insee,
          departement: c.departement || null, region: c.region || null,
          pfas: null, date_mesure: null, lat: c.lat, lon: c.lon,
          source: "HubEau (erreur commune)"
        };
      }
    })
  ));

  await fs.mkdir(path.dirname(OUT), { recursive: true });
  await fs.writeFile(OUT, JSON.stringify(results), "utf8");
  console.log(`✅ Écrit ${OUT} — ${results.length} lignes — PFAS trouvés: ${withData}`);
}

main().catch(async e => {
  console.error("❌ Build global:", e);
  // On écrit quand même un fichier vide pour ne pas planter la CI
  await fs.mkdir(path.dirname(OUT), { recursive: true });
  await fs.writeFile(OUT, "[]", "utf8");
});
