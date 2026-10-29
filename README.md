# Chain prices

Current prices of Serbian retail chains, rebuilt twice a day and published on
GitHub Pages for the Receipt Tracker app.

Since 1 September 2026, retailers with over 3 billion RSD in revenue publish
their prices every day (Pravilnik o uslovima, sadržaju i načinu objavljivanja
cenovnika, Sl. glasnik RS 35/2026), each as one CSV listed on
[data.gov.rs](https://data.gov.rs) with the current list and monthly
snapshots: about 60 MB for the six chains here. `build-prices.mjs` keeps only
the current prices, one JSON file per chain and store type, about 1-2 MB in all
for the app to download (compressed in transit).

| Chain | Files |
|---|---|
| Maxi | `maxi-maxi`, `maxi-megamaxi`, `maxi-shopandgo`, `maxi-profi`, `maxi-maxionline` |
| Idea (with Mercator and Roda) | `idea-idea`, `idea-mercator`, `idea-roda` |
| Lidl | `lidl` |
| Super Vero | `vero` |
| dm | `dm` |
| Lilly | `lilly` (a monthly snapshot of two stores with the day's changes) |

## Format

`prices/index.json` lists the files with their product count, the date of the
prices, a hash (unchanged files can be skipped) and any error from the last
run; a chain that fails keeps its last files.

Each file holds `fields` and `rows`:

```json
{"chain": "maxi", "list": "Maxi", "date": "2026-10-27",
 "fields": ["barcode", "name", "brand", "category", "unit", "price", "sale", "saleEnds"],
 "rows": [["8600050420159", "Palenta Corn Product 500g", "Corn Produkt", 13, "kg", 18399, 13999, "2026-10-28"]]}
```

Prices are in paras (1/100 RSD). Barcodes are padded to 13 digits, so the same
product matches across chains. `category` is the rulebook's category number.

## Running it

```bash
node build-prices.mjs site
```

Node 20 or newer, no dependencies. The workflow in `.github/workflows` runs it
at 06:30 and 12:30 (Serbian winter time) and publishes `site/` to GitHub Pages.
GitHub emails the owner when a run fails.
