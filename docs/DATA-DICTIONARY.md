# Data dictionary

Two payload shapes: the **core record** (one per project, in `data/projects.json`) and the
**detail record** (one file per project, in `data/detail/<id>.json`, fetched on demand).

## A. Core record — `data/projects.json`

| Field | Type | Meaning | Source |
|---|---|---|---|
| `id` | int | RERA project id | `GetProjects.Id` |
| `encId` | string | portal's 12-char project handle (used in the public project URL) | `EncryptedProjectId` |
| `name` | string | project name as registered | `GetProjectBasic.Name` |
| `cat` | string | `Group Housing` / `Plotted` / `Commercial` / `Mixed (Residential And Commercial)` | `ProjectTypeName` |
| `status` | string | `INPROGRESS` / `COMPLETED` / … from the project page | `ProjectDtlsWebsite.data.StatusOfProject` |
| `app` | string | application state: `Application Approved`, `APPLICATION REVOKE`, `APPLICATION SUSPENDED` | `GetProjects.AppStatus` |
| `regNo` | string | registration number, e.g. `RAJ/P/2026/5551` | `GetProjectBasic.RegistrationNo` |
| `regDate` | date | registration date, parsed from the certificate string | `CertificateNo` → `(dd/mm/yyyy)` |
| `regYear` | string | `regDate` truncated to the year | derived |
| `promoter` | string | promoter name as filed | `GetProjectBasic.PromoterName` |
| `promoterKey` | string | normalised promoter key used for grouping/joins | derived (see METHOD §7) |
| `promoterType` | string | `Partnership Firm`, `Company`, `Proprietorship`, `Society`, … | `PromoterType` |
| `tehsil` | string | tehsil | `TahsilName` |
| `village` | string | village | `VillageName` |
| `pin` | string | PIN code | `PinCode` |
| `landArea` | number | land parcel area, m² | `PhaseArea`, else `Area` |
| `openSpace` | number | aggregate open space, m² | `AggregateAreaOpenSpace` |
| `saleable` | number | saleable area, m² (blank when not filed) | `SaleableArea` |
| `builtUp` | number | built-up area on FSI, m² | `BuiltUpAreaFSI` |
| `buildings` | int | building entries in the form (see METHOD §4) | `GetBuildingDetails` |
| `buildingsReported` | int | the portal's `TotalBuildingCount` verbatim (plot count on plotted projects) | `TotalBuildingCount` |
| `bSanctioned` | int | sanctioned buildings, as filed (0 on plotted projects, where the field holds plots) | `SanctionedbuildingCount` |
| `bUnsanctioned` | int | not-sanctioned buildings, as filed (0 on plotted projects). A handful of group-housing projects file figures in the hundreds here; they are reproduced verbatim, not interpreted. | `NotSanctionedbuildingCount` |
| `blocks` | int | tower blocks, from the floors schedule | `NumberOfBlocksString` |
| `units` | int | flats / shops / offices (deduplicated, see METHOD §2) | `GetApartmentAllotteeDetailsList` |
| `plotCount` | int | plots in a plotted project | allottee list, else `PlotDetails` |
| `unitMix` | object | `{ "2BHK": 24, "Shop/Showroom": 6, … }` | derived from unit type labels |
| `carpetMin` / `carpetMax` / `carpetAvg` | number | carpet area spread, m² | `CarpetArea` |
| `plotMin` / `plotMax` | number | plot size spread, m² | `PlotArea` |
| `sold` / `unsold` | int | booking split, only when a group's status is unambiguous | `BookingStatus` |
| `isPlotted` | bool | plotted inventory dominates | derived |
| `landCost` | number | land-cost heads of the cost estimate, ₹ | `GetProjectCostDetail` |
| `totalCost` | number | sum of all estimated cost heads, ₹ | `GetProjectCostDetail` |
| `casesProject` | int | complaints matched by exact project name | complaint register |
| `casesPromoter` | int | complaints matched by respondent = promoter name | complaint register |
| `docs` | int | documents in the register | `GetDocumentsList` |
| `milestones` | int | schedule milestones | `GanttChartModel` |
| `completion` | date | original declared completion | `DateOfComplation` |
| `revCompletion` | date | revised completion | `RevisedDateOfComplation` |
| `startDate` | date | actual commencement | `ActualCommencementDate` |

## B. Detail record — `data/detail/<id>.json`

| Field | Meaning |
|---|---|
| `appNo` | application number `RAJ-RERA-APP-P-YYYY-NNNNN` |
| `approvedOn` | approval timestamp from the master list |
| `finishDate` | actual finish date when filed |
| `totalArea` | full land area (`Area`) before phasing |
| `notApprovedBuiltUp` | built-up area not approved on FSI, m² |
| `address` | full project location string as published |
| `remark` | the promoter's own remark on file (often the open-area note) |
| `floors` | floors schedule string, e.g. `2,13,1,` |
| `basement` / `plinth` / `podium` / `stilt` | counts across buildings |
| `parkingOpen` / `parkingClose` | parking counts declared per building |
| `cars` / `twoWheelers` / `visitorCars` | common-area parking |
| `buildingDocs` | number of drawing/plan documents attached to building rows |
| `constructionCost` | construction heads of the cost estimate, ₹ |
| `costByType` | `{ "LandCost": …, "Construction": …, … }` |
| `costDetail` | `[{n: head, t: type, e: estimated, a: actual}]`, all 14 heads |
| `buildingsDetail` | per building: blocks, floors string, basements, parking, drawing list |
| `unitInventory` | `[{type, n, carpet, status[]}]` — deduplicated unit groups |
| `plotInventory` | `[{type, n, area, status[]}]` — deduplicated plot groups |
| `ganttChart` | milestone schedule `[{Milestone, FromDate, ToDate}]` |
| `promoterAddress` | structured registered address of the promoter |
| `promoterOrgType` | `Partnership`, `Company`, … |
| `promoterUserId` | portal user id of the promoter (identity key, if you want strict grouping) |
| `partners` | `[{name, designation}]`, de-duplicated |
| `promoterProjects` | other projects the portal lists under the same promoter user id |
| `documentList` | `[{name, file, url}]` — the register only; the PDFs are not read |
| `notices` / `orders` / `extensions` / `encumbrances` / `specialMods` / `mapRevisions` | counts of those filings |
| `qpr` / `apr` | quarterly / annual progress report counts |
| `hasComplaintOrder` | whether a complaint order document is attached |
| `paymentStatus` / `fees` | registration fee and payment state |
| `consultant` | consultant name when filed |

## C. `data/meta.json`

| Field | Meaning |
|---|---|
| `asOf` | build timestamp (IST) |
| `totals` | headline sums over all Jaipur projects |
| `category`, `status`, `appStatus`, `promoterTypes`, `tehsils`, `years` | counts per dimension (filter chips) |
| `coverage` | for each measurable field: `{n, pct}` of projects that filed a value |
| `complaints` | statewide total, matched, unmatched, by type/status |
| `areaUnit` | the unit of every area in the payloads |

## D. `data/promoters.json`

`key` (normalised) · `name` (most common spelling) · `projects` · `types` · `saleable` · `builtUp` ·
`land` · `units` · `plots` · `cost` · `cases` · `first` / `last` registration date · `tehsils` (top 5) ·
`statuses` · `sanctioned` / `unsanctioned` buildings · `ids` (first 80 project ids).

## E. `data/complaints.json`

`no` (complaint number) · `title` (cause title) · `respondent` · `citizen` · `project` (as named in
the filing, often blank) · `typeId` (1/2/3) · `statusId` (numeric stage, no public dictionary) ·
`updated` · `hearing` · `advocate` · `match` = `{type: "project"|"promoter", id|ids}`.

## F. `data/timeseries.json`

`YYYY-MM → {n, saleable, builtUp, land, units, plots, cost, cats{}}` for registration-cohort charts.

## G. `data/jaipur_rera.db`

SQLite mirror. Table `projects` has every scalar core field as a column (`unitMix` excluded —
it is a JSON object); table `complaints` has `no, respondent, project, typeId, statusId,
matchType, matchId`.
