# Method — how each number is produced

Every figure in the dashboard is derived from portal table data. This file records the decisions
that change a number, so a result can be audited instead of trusted.

## 1. Scope

District = **Jaipur**, selected on the portal's own district key (`DistrictId = 1077`), not by
string matching. The master call returns 2,416 rows for that key and every one is carried through —
including suspended (`APPLICATION SUSPENDED`, 11) and revoked (`APPLICATION REVOKE`, 55) projects,
because "how many projects were ever registered in Jaipur" and "how many are live" are different
questions and the status filter answers the second.

Adjacent districts that read like Jaipur but are not (Khairthal-Tijara, Dausa, Jaipur Rural as a
separate filing) are excluded because the portal files them under their own district key.

## 2. Units vs plots

The hard part. The portal exposes inventory in two places that disagree in shape:

1. `GetApartmentAllotteeDetailsList` — one row per **unit type per block**, with a `count`.
2. `PlotDetails` — one row per **plot size group**, with a `count`.

### 2.1 The repeated-count trap

For built inventory the portal writes the type total on **every unit row**:

```
Block - A (T-1), Studio-Room Units   count=108   unit="1"
Block - A (T-1), Studio-Room Units   count=108   unit="10"
… 108 rows …
```

Summing `count` gives 11,664 studio units for a tower that holds 108. Summing rows gives 108.
For plotted inventory the opposite happens — 25 plots share one row labelled
`"Plot No.- 8,9,10,…"` with `count=25`.

**Rule used:** group rows by `(building/block, unit type)`; a group's size is
`max(row_count, stated_count)`. Both traps collapse correctly:

| Case | rows | stated | group size | correct? |
|---|---|---|---|---|
| Wyndham studios | 108 | 108 | 108 | ✓ (no inflation) |
| Grouped plots | 1 | 25 | 25 | ✓ (no loss) |
| Solo unit | 1 | 1 | 1 | ✓ |

### 2.2 The double-inventory trap

For plotted projects the same plots arrive **twice**: once as plot rows in the allottee list and
once in `PlotDetails`, grouped differently (195 vs 80 rows for one project). Adding both doubled
every plotted project.

**Rule used:** the allottee list is authoritative; `PlotDetails` is only read when the allottee list
carries no plot rows. Verified against three projects (195 / 489 / 32 plots) by comparing to the
portal's own `Units` labels `1…N`.

### 2.3 Classifying a row

A row is a **plot** if it has a `plotArea`, or its type starts with `PLOT`. Otherwise it is a
**unit** (flat, shop, office, studio). A project is "plotted" when plots exceed units.

## 3. Areas

- `landArea` ← `PhaseArea`, falling back to `Area` (Form-A land parcel).
- `saleable` ← `SaleableArea`, `builtUp` ← `BuiltUpAreaFSI`. These are separate Form-B heads and
  are **not** interchangeable: many projects file one and zero the other.
- `openSpace` ← `AggregateAreaOpenSpace`.
- Units are **square metres**, the portal's native unit. The UI converts to sq ft at
  ×10.7639 on demand; the JSON payloads stay in m².

Blanks stay blank. A `0.0` on the portal is treated as *not filed* and shown as `–`, because a
registered project cannot have zero built area; it means the promoter left the head empty.

## 4. Building configuration

- `buildings` = number of entries in `GetBuildingDetails` (one per building/tower block).
  For plotted projects, `TotalBuildingCount` is actually the plot count (195 for a 195-plot
  colony), so it is **not** used as a building count. The raw value is kept as
  `buildingsReported` for anyone who wants it.
- `blocks` = `max(NumberOfBlocks, entries in NumberOfBlocksString)`. The string is the floors
  schedule — `"2,13,1,"` means three blocks of 2, 13 and 1 floors — and is more reliable than the
  numeric field, which is frequently 1 regardless of the towers.
- Basements, plinths, podiums, stilts, open/covered parking are summed across building entries.

## 5. Dates

`CreatedOn` in the Form payload is a sentinel (`/Date(-62135596800000)/` = year 1) for every row
produced by the current system. The trustworthy registration date is inside the certificate
string:

```
CertificateNo: "RAJ/P/2026/5551 (12/11/2026) "   ->   2026-11-12
```

Falling back to the master list's `APPROVEDON`. `DateOfComplation` / `RevisedDateOfComplation` are
`/Date(ms)/` values and are converted directly.

## 6. Costs

`GetProjectCostDetail` carries 14 heads (land, construction, infrastructure, etc.) with
`EstimatedAmount` and `ActualAmount`. `totalCost` = sum of estimated heads; `landCost` = the head
whose name contains "land cost"; `constructionCost` = heads containing "construction"/"built up".
Actual spend is almost always 0 at registration time — that is expected, not a bug.

## 7. Promoters

The portal has a promoter **user id** (`UserId`) and a display name. Names are matched on a
normalised form: uppercase, legal suffixes removed (`PVT`, `PRIVATE`, `LTD`, `LIMITED`, `LLP`,
`CO`, `COMPANY`, `AND`, `&`), punctuation collapsed, whitespace collapsed. Two spellings that
normalise identically are treated as one promoter; the UI shows the most common literal spelling.

This is a name join, not an identity join. Where the portal's `UserId` is available it is carried
in the detail payload, so a strict identity view is possible later.

## 8. Cases

**Complaints are builder-level, not project-level.** This was measured, not assumed: the register
schema has a `ProjectName` column, and it is populated on **0 of 7,903 rows** — every complaint
carries no project name at all. The only identity a complaint carries is its respondent.

Consequences, reflected in the UI:

- Cases are joined on `RespondentName` → normalised promoter key. Of 7,903 statewide cases,
  **3,393** name a respondent that is a Jaipur promoter; the other 4,510 name builders/agents
  with no Jaipur registration.
- A project's case count is therefore **its promoter's case count in Jaipur**. It is not a case
  filed against that project. The column is labelled *Builder cases* for that reason.
- Because 365 of 1,371 Jaipur promoter names control more than one project, one case fans out
  across that builder's whole portfolio. The project detail modal shows both numbers side by side
  so the fan-out is visible.
- The code keeps a project-name matching pass for the day the portal starts populating the
  column, but today it matches nothing.

## 9. Aggregation

All aggregation happens in the browser over `projects.json`, so any filter combination
(category × promoter × custom date range) is instant and consistent: the same filtered array feeds
the KPIs, every chart, the tables, the pivot and the CSV export. The pivot recomputes shares and
the totals row from that same array — a metric cannot disagree with the table above it.

## 10. Verification performed

- Row count: master list 2,416 = distinct project ids in the payload.
- Spot checks against live endpoints: areas, building counts, plot counts for four projects across
  three categories (see commit history).
- Coverage percentages printed in `meta.json` and surfaced in the UI, so a 42% saleable-area
  coverage is visible rather than implied.
