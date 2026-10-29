// Builds compact files of the big Serbian chains' current prices for the Receipt
// Tracker app. Each chain publishes its prices every day under the Pravilnik o
// uslovima, sadržaju i načinu objavljivanja cenovnika (Sl. glasnik RS 35/2026), as
// one CSV listed on data.gov.rs holding the current list and monthly snapshots.
// This keeps only the current prices, one JSON file per chain and store type, plus
// index.json listing them, so the app downloads about 1-2 MB instead of 60 MB.
//
// Usage: node build-prices.mjs <output dir> [<URL of the published files>]
// With the URL, a chain whose download fails keeps its last published files.
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const [outDir, publishedUrl] = process.argv.slice(2);
if (!outDir) {
  console.error("Usage: node build-prices.mjs <output dir> [<URL of the published files>]");
  process.exit(1);
}

// Store types are the values of "Naziv trgovca - formata" where prices differ by store type.
const CHAINS = [
  { id: "maxi", name: "Maxi", dataset: "68f203a18b8ba3a1d826fa77", storeTypes: ["Maxi", "Mega Maxi", "Shop and Go", "Profi", "Maxi Online"] },
  { id: "idea", name: "Idea", dataset: "68f61c62dc53a8c8410427f1", storeTypes: ["IDEA", "MERCATOR", "RODA"] },
  { id: "lidl", name: "Lidl", dataset: "68f61917f9daecc02d803b84" },
  { id: "vero", name: "Super Vero", dataset: "68f0d59ff413b4011f0f9e12" },
  { id: "dm", name: "dm", dataset: "6a9582c4651dee3015336a5c" },
  // A monthly snapshot of two of its stores plus the day's changes, rather than a full current list.
  { id: "lilly", name: "Lilly", dataset: "6aaa6fed2c54dbbf6dd8eeee", snapshotPlusChanges: true },
];

const FIELDS = ["barcode", "name", "brand", "category", "unit", "price", "sale", "saleEnds"];
// Fewer products than this means a cut-off or changed file, not a price list.
const MIN_PRODUCTS = 100;

// --- Reading the files (the same rules as the app's src/lib/prices/csv.ts) -----------

/** Fields of a ";"-separated file; quoted fields may hold ";", line breaks and "" for a quote. */
function parseCsv(text) {
  const source = text.replace(/^﻿/, "").replace(/\0/g, "");
  const end = source.length;
  const rows = [];
  let row = [];
  let i = 0;
  const isBreak = (c) => c === 59 || c === 10 || c === 13;
  while (i < end) {
    let field;
    if (source[i] === '"') {
      let value = "";
      let from = i + 1;
      for (;;) {
        const quote = source.indexOf('"', from);
        if (quote < 0) {
          value += source.slice(from);
          i = end;
          break;
        }
        value += source.slice(from, quote);
        if (source[quote + 1] === '"') {
          value += '"';
          from = quote + 2;
        } else {
          i = quote + 1;
          break;
        }
      }
      let j = i;
      while (j < end && !isBreak(source.charCodeAt(j))) j++;
      field = value + source.slice(i, j);
      i = j;
    } else {
      let j = i;
      while (j < end && !isBreak(source.charCodeAt(j))) j++;
      field = source.slice(i, j);
      i = j;
    }
    row.push(field);
    if (i >= end) break;
    if (source.charCodeAt(i) === 59) {
      i++;
      if (i === end) row.push("");
      continue;
    }
    i += source.charCodeAt(i) === 13 && source.charCodeAt(i + 1) === 10 ? 2 : 1;
    if (row.length > 1 || row[0] !== "") rows.push(row);
    row = [];
  }
  if (row.length > 1 || (row.length === 1 && row[0] !== "")) rows.push(row);
  return rows;
}

// Header names without case, accents, spaces or underscores, so Lilly's "NAZIV_PROIZVODA" reads like "Naziv proizvoda".
const simplify = (text) => text.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/gi, "dj").replace(/[^a-z]/gi, "").toLowerCase();

function columnsOf(header) {
  const names = header.map(simplify);
  const find = (start) => names.findIndex((name) => name.startsWith(start));
  const columns = {
    category: names.indexOf("kategorija"),
    name: find("nazivproizvoda"),
    brand: find("robnamarka"),
    barcode: find("barkod"),
    unit: find("jedinicamere"),
    list: find("nazivtrgovca"),
    date: find("datumcenovnika"),
    price: find("redovnacena"),
    sale: find("snizenacena"),
    saleEnds: find("datumkrajasnizenja"),
    kind: find("vrstacenovnika"),
  };
  const missing = ["name", "barcode", "price", "kind"].filter((key) => columns[key] < 0);
  if (missing.length) throw new Error(`no ${missing.join(", ")} column`);
  return columns;
}

function isoDate(text) {
  const match = /^(\d{1,2})[-./](\d{1,2})[-./](\d{4})/.exec((text ?? "").trim());
  return match ? `${match[3]}-${match[2].padStart(2, "0")}-${match[1].padStart(2, "0")}` : null;
}

function minor(text) {
  const trimmed = (text ?? "").trim();
  const value = Number(trimmed.replace(",", "."));
  return trimmed !== "" && Number.isFinite(value) ? Math.round(value * 100) : null;
}

function toPriceRow(fields, columns) {
  const field = (index) => (index >= 0 ? (fields[index] ?? "").trim() : "");
  // Barcodes padded to 13 digits, so EAN-8 codes written with or without zeros match across chains.
  const digits = field(columns.barcode).replace(/^0+/, "");
  const price = minor(field(columns.price));
  if (!/^\d+$/.test(digits) || digits.length > 14 || price === null) return null;
  const sale = minor(field(columns.sale));
  return {
    barcode: digits.padStart(13, "0"),
    name: field(columns.name),
    brand: field(columns.brand),
    category: Number(field(columns.category)) || null,
    unit: field(columns.unit),
    list: field(columns.list),
    date: isoDate(field(columns.date)) ?? "",
    price,
    sale: sale !== null && sale < price ? sale : null,
    saleEnds: sale !== null && sale < price ? isoDate(field(columns.saleEnds)) : null,
    current: simplify(field(columns.kind)).startsWith("vazeci"),
  };
}

function readPriceList(text) {
  const lines = parseCsv(text);
  const columns = columnsOf(lines.shift() ?? []);
  return lines.map((fields) => toPriceRow(fields, columns)).filter(Boolean);
}

/** One price per product: the current list, or for Lilly the latest snapshot with the day's changes. */
function currentPrices(rows, { list, snapshotPlusChanges } = {}) {
  const inList = list ? rows.filter((row) => row.list === list) : rows;
  const prices = new Map();
  if (snapshotPlusChanges) {
    for (const row of inList) {
      if (row.current) continue;
      const kept = prices.get(row.barcode);
      if (!kept || row.date > kept.date) prices.set(row.barcode, row);
    }
  }
  const changed = new Set();
  for (const row of inList) {
    if (!row.current || changed.has(row.barcode)) continue;
    changed.add(row.barcode);
    prices.set(row.barcode, row);
  }
  return [...prices.values()];
}

// --- Downloading ---------------------------------------------------------------------

async function get(url, timeoutMs = 180_000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { "User-Agent": "chain-prices (Receipt Tracker)" } });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return res;
}

/** The chain's newest CSV of prices on data.gov.rs (not, say, Lidl's list of extra barcodes). */
async function findPriceListUrl(chain) {
  const { resources = [] } = await (await get(`https://data.gov.rs/api/1/datasets/${chain.dataset}/`, 30_000)).json();
  const csv = resources.filter((r) => /csv/i.test(r.format ?? "") || /\.csv(\?|$)/i.test(r.url));
  const prices = csv.filter((r) => /cen/i.test(`${r.title ?? ""} ${r.url}`));
  const newest = [...(prices.length ? prices : csv)].sort((a, b) => (b.last_modified ?? "").localeCompare(a.last_modified ?? ""))[0];
  if (!newest) throw new Error("data.gov.rs lists no price list");
  return newest.url;
}

// --- Building ------------------------------------------------------------------------

const slug = (text) => simplify(text.replace(/\s+/g, "-")) || "all";
const sha = (text) => createHash("sha256").update(text).digest("hex").slice(0, 16);

const pricesDir = path.join(outDir, "prices");
mkdirSync(pricesDir, { recursive: true });

const previous = publishedUrl
  ? await get(`${publishedUrl.replace(/\/$/, "")}/prices/index.json`, 30_000).then((res) => res.json()).catch(() => null)
  : null;

const index = { version: 1, generated: new Date().toISOString(), fields: FIELDS, chains: {} };
let failures = 0;

for (const chain of CHAINS) {
  const started = Date.now();
  try {
    const url = await findPriceListUrl(chain);
    const text = new TextDecoder("utf-8").decode(await (await get(url)).arrayBuffer());
    const rows = readPriceList(text);
    const lists = {};
    for (const list of chain.storeTypes ?? [null]) {
      const prices = currentPrices(rows, { list, snapshotPlusChanges: chain.snapshotPlusChanges });
      if (prices.length < MIN_PRODUCTS) throw new Error(`only ${prices.length} products${list ? ` for ${list}` : ""}`);
      const date = prices.reduce((latest, row) => (row.date > latest ? row.date : latest), "");
      const json = JSON.stringify({
        chain: chain.id,
        list,
        date,
        fields: FIELDS,
        rows: prices.map((p) => [p.barcode, p.name, p.brand, p.category, p.unit, p.price, p.sale, p.saleEnds]),
      });
      const file = `${chain.id}${list ? `-${slug(list)}` : ""}.json`;
      writeFileSync(path.join(pricesDir, file), json);
      lists[list ?? ""] = { file, products: prices.length, date, sha: sha(json), bytes: Buffer.byteLength(json) };
    }
    index.chains[chain.id] = { name: chain.name, sourceUrl: url, updated: index.generated, lists, error: null };
    console.log(`${chain.name}: ${Object.values(lists).map((l) => `${l.file} ${l.products}`).join(", ")} (${Date.now() - started} ms)`);
  } catch (err) {
    failures++;
    const error = err instanceof Error ? err.message : String(err);
    console.error(`${chain.name} failed: ${error}`);
    // The last published files stay up, marked with why this run failed.
    const kept = previous?.chains?.[chain.id];
    if (kept) {
      for (const entry of Object.values(kept.lists)) {
        const json = await (await get(`${publishedUrl.replace(/\/$/, "")}/prices/${entry.file}`, 60_000)).text();
        writeFileSync(path.join(pricesDir, entry.file), json);
      }
      index.chains[chain.id] = { ...kept, error };
    } else {
      index.chains[chain.id] = { name: chain.name, lists: {}, error };
    }
  }
}

writeFileSync(path.join(pricesDir, "index.json"), JSON.stringify(index, null, 1));
writeFileSync(
  path.join(outDir, "index.html"),
  `<!doctype html><meta charset="utf-8"><title>Chain prices</title>
<p>Current prices of Serbian retail chains, built every day from the price lists they publish on
<a href="https://data.gov.rs">data.gov.rs</a> under the Pravilnik o uslovima, sadržaju i načinu objavljivanja cenovnika.
Used by the Receipt Tracker app. Files: <a href="prices/index.json">prices/index.json</a>. Last built ${index.generated}.</p>\n`,
);
console.log(`Done: ${CHAINS.length - failures} of ${CHAINS.length} chains updated.`);
// Fail the run only when nothing could be built, so one chain's outage doesn't stop the others.
if (failures === CHAINS.length) process.exit(1);
