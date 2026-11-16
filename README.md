# Jaipur RERA Dashboard

A self-updating, dependency-free dashboard over **every real-estate project registered with
RERA Rajasthan in Jaipur district** — extracted from the portal's own JSON APIs, never from the
PDFs it hosts.

**Live:** https://mayankmohan1992.github.io/jaipur-rera-dashboard/

| | |
|---|---|
| Projects | 2,416 (Jaipur district, all categories, all statuses) |
| Source | `rera.rajasthan.gov.in` (RERA Rajasthan 2.0 — Angular SPA over a .NET Web API) |
| Data volunteers | project master, Form-A/Form-B payload, unit & plot inventory, cost estimate, document register, QPR/APR, encumbrances, complaint register, agent register |
| Refreshed | daily 06:00 IST by GitHub Actions |
| Stack | Python 3 stdlib for ingest · vanilla HTML/CSS/JS for the UI · no build step, no CDN, no database server |

---

## What it answers

Everything the portal holds in tables, sliced any way you like:

- Total projects, by **category** (Group Housing / Plotted / Commercial / Mixed), **status**,
  **tehsil**, **village**, **year of registration** or any **custom date range**.
- **Promoter** league tables — project count, saleable area, built-up area, land area, unit count,
  plot count, estimated cost, cases — with drill-through to that promoter's projects.
- **Group & compare** pivot: pick a dimension (promoter, category, year, tehsil, status, promoter
  type, project size band, village) and a metric, get ranked shares and a totals row. This is the
  "group housing by promoter" / "saleable area by promoter in FY2026" view.
- **Building configuration** per project: blocks, floors per block, basements, stilts, podiums,
  open and covered parking, sanctioned vs unsanctioned buildings.
- **Unit inventory**: unit counts, BHK/unit-type mix, carpet-area range and per-type counts,
  sold/unsold split, plot count and plot-size range.
- **Cases**: the statewide complaint register, linked to Jaipur **builders** by respondent name
  (the portal's own `ProjectName` field is empty on every row — see
  [`docs/METHOD.md`](docs/METHOD.md) §8).
- **Agents**: all registered real-estate agents in the district.
- **Data quality**: field-by-field coverage, so a blank area is never mistaken for a zero.

Not included by design: the contents of approval letters, sanctioned plans, drawings and other
PDFs. The portal lists them (with links) and this project counts them, but does not parse them.

---

## Quick start

```bash
git clone https://github.com/mayankmohan1992/jaipur-rera-dashboard.git
cd jaipur-rera-dashboard

python3 pipeline/crawl.py       # ~2,400 projects x 2 requests -> raw/*.json.gz
python3 pipeline/fetch_aux.py   # complaints + agents
python3 pipeline/build.py       # raw/ -> site/data/*.json + site/data/jaipur_rera.db

cd site && python3 -m http.server 8777
open http://localhost:8777
```

No dependencies. Python 3.9+ and a browser. Everything is stdlib: `urllib`, `gzip`, `json`,
`sqlite3`, `concurrent.futures`.

Environment knobs for the crawler: `WORKERS` (default 12; the portal throttles hard above ~16)
and the standard `HTTPS_PROXY` if you need to route through a proxy.

---

## Repository layout

```
pipeline/
  crawl.py         master list + per-project deep fetch (resumable, threaded)
  fetch_aux.py     statewide complaint register, Jaipur agent register
  build.py         normalise -> SQLite + static JSON payloads
site/
  index.html       single page
  app.js           filtering, aggregation, charts, detail modal (no framework)
  style.css        dark, dense, tabular
  data/            generated: meta, projects, promoters, complaints, agents, timeseries,
                   detail/<id>.json per project, jaipur_rera.db
docs/
  API.md           the reverse-engineered API: endpoints, payloads, auth, quirks
  DATA-DICTIONARY.md  every field, its meaning and its provenance
  METHOD.md        how units and plots are counted, and why that is the hard part
.github/workflows/
  refresh.yml      daily crawl -> build -> Pages artifact deploy
```

Generated data is deliberately **not** committed: the workflow builds it and deploys it as a
Pages artifact, so the repository stays code-sized and history does not fill with daily snapshots.

---

## How the data is obtained

The site is an Angular SPA; nothing useful is in the HTML. Three endpoints carry the payload:

1. `POST /api/web/Home/GetProjects` with `{"DistrictId":1077, ...}` → all 2,416 Jaipur rows
   (registration no, promoter, category, status, and `EncryptedProjectId`).
2. `GET /HomeWebsite/ProjectDtlsWebsite/<EncryptedProjectId>` → document register, QPR/APR,
   encumbrances, special modifications, and a **second** encrypted id.
3. `GET /HomeWebsite/ViewProjectWebsite?id=<second id>&type=U` → the full Form-A/Form-B object:
   areas, buildings, unit/plot inventory, cost estimate, promoter, banks, milestones.

Plus `GetComplaintDetailsWebsite` (7,903 complaints statewide) and `GetAgents` (10,283 Jaipur
agents). Details, including the API key the web app ships in its own bundle, are in
[`docs/API.md`](docs/API.md).

---

## How units and plots are counted

This is the part that lies quietly, so it is documented rather than assumed
([`docs/METHOD.md`](docs/METHOD.md)):

- The portal repeats a type's **total** count on every unit row (108 studio units → 108 rows each
  saying `count = 108`), and elsewhere groups many plots into one row (`count = 25`). A group's true
  size is therefore `max(rows, stated_count)`; summing the stated column inflates some projects 100×.
- Plotted projects carry the same inventory twice (`PlotDetails` and the allottee list), grouped
  differently. The allottee list wins; `PlotDetails` is only a fallback — otherwise plots double.
- `SaleableArea` and `BuiltUpAreaFSI` are separate Form-B heads and are frequently not both filed;
  ~42% of projects have a non-zero saleable area and ~64% a non-zero built-up area. Blanks are
  shown as blanks.
- `TotalBuildingCount` on a plotted project is the plot count, not a building count, so
  "buildings" comes from the building rows when they exist.

---

## The dashboard

- All filtering is client-side over one 2.5 MB JSON file — instant, no server, works offline.
- Deep detail is lazy: `data/detail/<id>.json` is fetched only when a project is opened.
- Units toggle between m² and ft²; the portal is native m².
- Export CSV exports exactly the current selection, not the whole dataset.
- `site/data/jaipur_rera.db` is a SQLite mirror for anyone who wants to run their own SQL:

```sql
SELECT promoter, COUNT(*) n, SUM(saleable) sqm, SUM(totalCost) cost
FROM projects WHERE cat='Group Housing' AND regYear='2026'
GROUP BY promoter ORDER BY sqm DESC LIMIT 20;
```

---

## Automation

`.github/workflows/refresh.yml` runs daily:

1. `crawl.py` — full re-crawl (every project's detail is re-fetched, so revisions, status changes
   and new registrations all land).
2. `fetch_aux.py` — complaint + agent registers.
3. `build.py` — normalises and prints payload sizes; asserts the row count against the master list.
4. Deploys `site/` as a Pages artifact.

The workflow fails loudly if the crawl loses more than 3% of projects, so a silent partial
dataset never gets published.

---

## Caveats

- Unofficial. RERA Rajasthan is the authority; this is a convenience layer over its public data.
- **Cases are builder-level, not project-level.** The complaint register has a `ProjectName`
  column that is empty on all 7,903 rows, so a case can only be attached to its respondent. A
  project's case count is its promoter's case count in Jaipur — the UI labels the column
  *Builder cases* and shows the promoter's portfolio size next to it.
- Areas are as filed by promoters. A promoter's own numbers are not audited by RERA at filing time.
- Registration dates come from the certificate string (`RAJ/P/2026/5551 (12/11/2026)`), which is
  the most reliable date field the API exposes.

## Licence

MIT for the code. The data belongs to RERA Rajasthan.
