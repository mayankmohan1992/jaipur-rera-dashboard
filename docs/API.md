# RERA Rajasthan — API teardown

What the portal actually is, and how to talk to it without a browser.

**Site:** `https://rera.rajasthan.gov.in` (branded "RERA 2.0")
**App:** Angular 19 SPA, lazily-loaded route chunks, hand-rolled `HttpInterceptor`
**Backend:** two hosts

| Host | Role |
|---|---|
| `https://reraapi.rajasthan.gov.in/api/web/` | JSON API for lists, complaints, agents, status |
| `https://reraapp.rajasthan.gov.in/HomeWebsite/` | legacy MVC JSON actions for the deep project payload |
| `https://rera.rajasthan.gov.in/api/Home/GetVisitorCount` | visitor counter (cosmetic) |

---

## 1. Authentication

There is no login and no token exchange for public data. Every call needs one header, and it is
hard-coded in the shipped bundle (`main-*.js`, interceptor component):

```
X-API-KEY: MySuperSecretApiKey_123
```

Without it the API answers `401` with the body `API Key missing`.

Recommended headers for everything else (the MVC actions are picky about a same-site referer):

```
Referer:  https://rera.rajasthan.gov.in/
Origin:   https://rera.rajasthan.gov.in
Accept:   application/json, text/plain, */*
User-Agent: <a normal browser UA>
Content-Type: application/json   (POST only)
```

Note the mismatch you will eventually hit: `POST` bodies must be `application/json`, but several
legacy actions want a **JSON string literal** body (`"\"AddVisitorCount\""`), not an object.

## 2. Endpoints that matter

### 2.1 Project master list

```
POST https://reraapi.rajasthan.gov.in/api/web/Home/GetProjects
```

```json
{"DistrictId":1077,"TeshilId":0,"ProjectName":"","PromoterName":"",
 "RegistrationNo":"","ProjectType":0,"ApplicationStatus":0,"Year":0}
```

`DistrictId` 1077 = Jaipur (`GET /api/web/Common/GetComponentsNew?parentId=18&typeId=2` returns the
41-district lookup as `[{"Text":"Jaipur","Value":"1077"}]`).

One shot returns **all 5,488** statewide projects (6.1 MB, ~10 s) or **2,416** for Jaipur.
Response envelope for every API here:

```json
{"State":1,"Status":false,"Message":"Data load successfully.","ErrorMessage":null,"Data":[...]}
```

Useful columns per row: `Id` (numeric project id), `EncryptedProjectId` (12-char base64url handle
used by the website), `ProjectName`, `ProjectTypeName` (`GROUP HOUSING` / `PLOTTED` /
`Commercial` / `Mixed (Residential And Commercial)`), `REGISTRATIONNO`, `PromoterName`,
`ORGNAME`, `AppStatus` (`Application Approved` / `APPLICATION REVOKE` / `APPLICATION SUSPENDED`),
`APPROVEDON`, `CertificateNo`, `DistrictName`, `Taluka`.

`ProjectType` is the numeric twin: `1` = Group Housing, `4` = Plotted.

### 2.2 Project detail, stage 1 — documents and second id

```
GET https://reraapp.rajasthan.gov.in/HomeWebsite/ProjectDtlsWebsite/<EncryptedProjectId>
```

Returns `{"success":true,"data":{...}}` with: `ProjectId` (**the second-stage encrypted id**),
`ProjectName`, `ProjectCategory`, `RegistrationNo`, `DateofRegistration`, `PromoterName`,
`PromoterType`, `PhaseArea`, `AggregateAreaOpenSpace`, `TotalBuildingCount`,
`SanctionedbuildingCount`, `NotSanctionedbuildingCount`, `StatusOfProject`, `GetDocumentsList`
(the document register: name, type, URL), `GetQPRList`, `GetAPRList`, `GetEncumbranceList_New`,
`GetSpecialModProjectList_New`, `GetSpecialModProfileList_New`, `GetPreviousExtsList`,
`GetMapRevision`, `GetOrderDoc`.

### 2.3 Project detail, stage 2 — the full Form-A/Form-B payload

```
GET https://reraapp.rajasthan.gov.in/HomeWebsite/ViewProjectWebsite?id=<data.ProjectId>&type=U
```

~110–600 KB per project. Top-level keys:

| Key | What is inside |
|---|---|
| `GetProjectBasic` | ~190 fields: areas, dates, bank accounts (three of them), promoter block, approval metadata, district/tehsil/village, `SaleableArea`, `BuiltUpAreaFSI`, `TotalBuildingCount` |
| `GetProjectCostDetail` | 14 cost heads (land, construction, infrastructure…) with estimated and actual amounts |
| `GetBuildingDetails` | one entry per building: blocks, `NumberOfBlocksString` = floors per block (`"2,13,1,"`), basements, plinths, podiums, stilts, open/covered parking, and the drawing register |
| `GetApartmentAllotteeDetailsList` | the unit **and** plot inventory: building, block, unit type, count, carpet area, plot area, booking status |
| `PlotDetails` | plotted inventory, grouped by identical plot size (same plots as above, different grouping) |
| `Tbl_Plots` | plot-level sanctioned / not-sanctioned totals plus plan documents |
| `ProjectCommanArea` / `GetProjectAreaFacilities` | garages, covered / mechanical / stilt parking, cars, two-wheelers, visitor parking, development works |
| `PromoterDetails` | org name, type, address, partners (with designations), past experience, other projects by the same user id |
| `GanttChartModel` / `GanttChartModelcomm` | milestone schedule (name, from, to) |
| `ProjectSummaryPayment` | registration fee and payment status |
| `ProjectDocuments`, `GetDocumentsList` | document register (names + URLs; the files themselves are PDFs — out of scope) |
| `ProjectLitigations` | litigation flag when present |

Two traps:

- The second-stage id is **not** the `EncryptedProjectId`. Passing the first id to
  `ViewProjectWebsite` returns HTTP 500 (`The input is not a valid Base-64 string…`).
- `ViewProjectWebsite` will not decrypt `ProjectDetails`-style ids either — it wants the base64
  string with standard `+`/`/` alphabet, exactly as `ProjectDtlsWebsite` handed it over.

### 2.4 Status, location, QR

```
GET /api/web/Home/Get_ProjectStatus?ProjectID=<EncryptedProjectId>          -> [{"PStatus":"INPROGRESS"}]
GET /api/web/Home/Get_ProjectStatus_Single?ProjectID=<EncryptedProjectId>
GET /api/web/Home/GetProjectIdWiseEndPointsLocation?ProjectID=<EncryptedProjectId>
      -> rajdharaa GIS deep-link with the numeric REFID
GET /HomeWebsite/GetProjectQrCode?id=<EncryptedProjectId>                    -> base64 PNG
```

`GetProjectById` (`POST {"ProjectId":"<EncryptedProjectId>"}`) returns a 20-field summary. It is
what the current `/ProjectDetail` page uses, and its `StatusOfProject` can disagree with
`ProjectDtlsWebsite`'s `StatusOfProject` for freshly-approved projects (`Rejected` vs
`INPROGRESS`). The stage-1 value is the one the project page renders, so this project uses it.

### 2.5 Complaint register (the "cases")

```
POST /api/web/Home/GetComplaintDetailsWebsite
{"compalaint_no":"","complainant":"","complaint_status":"","respondent_name":"",
 "ComplaintTypeId":0,"actionType":"Complaint"}
```

Note the misspelt `compalaint_no` — it is the real parameter name.

Returns **7,903** statewide rows (~7 MB) with `ComplaintNumber`, `titleOfCase`, `RespondentName`,
`CitizenName`, `ProjectName` (often blank), `complaintTypeID` (1/2/3), `StatusId` (numeric stage
code, no public dictionary), `createdon`, `updatedon`, `strHearingDate`, and advocate/CA contacts.
`actionType` accepts only `"Complaint"` in practice (`Appeal`/`Order` return 0 rows).

**Measured:** `ProjectName` is empty on **every one of the 7,903 rows**. The register is
builder-level only — the respondent is the sole identity carrier. Complaints therefore join to a
promoter, never to a project, and a project's case count is its promoter's case count.

### 2.6 Agents

```
POST /api/web/Home/GetAgents
{"districtId":1077,"tehsilId":0,"agentName":"","registrationNo":""}
```

10,283 rows for Jaipur: `PromoterName` (the agent), `CertificateNo`, `ApprovedOn`, `DistrictName`.

## 3. Endpoints deliberately not used

| Endpoint | Why not |
|---|---|
| `GetDeflauterlist` | GET with `parentId` returns `405`; the defaulter list is thin and overlaps status |
| `GetprojectDetailsbyDepecryValue` + `GetDepecryValueCommon` | superseded by `GetProjectById` + `ViewProjectWebsite`; the `ProjectId` argument only accepts an id minted by an internal AES round-trip and returns "Padding is invalid" for anything else |
| `HomeWebsite/ProjectDtlsWebsite` PDF links | the user's scope excludes document contents |
| SSO endpoints (`sso.rajasthan.gov.in`) | only needed for promoter/agent logins |

## 4. Discovering the API yourself

```bash
curl -s https://rera.rajasthan.gov.in/ProjectList > index.html
curl -s https://rera.rajasthan.gov.in/main-GRG2WOTF.js > main.js     # hash changes on deploys
grep -oE 'https?://[^"'"'"' ]+' main.js | sort | uniq -c | sort -rn | head
grep -o 'path:"[^"]*"' main.js                                       # route table
grep -oh 'chunk-[A-Z0-9]\{8\}\.js' main.js | sort -u                 # lazy chunks
```

The lazy chunk for a route names its service calls directly, e.g. `/ProjectList` →
`chunk-ONCZLUOQ.js` → `HomeService.GetProjectList` → `POST /Home/GetProjects`.

In the browser, `performance.getEntriesByType('resource')` lists every call a page made, and
`Network.enable` + `Network.requestWillBeSent` (CDP) gives you the exact POST bodies.

## 5. Behaviour to plan around

- **Throttling.** Response times inflate from ~1 s to ~8 s per request as concurrency rises.
  12–16 workers sits at ~1 project/s; more workers does not help and starts producing timeouts.
- **No pagination anywhere.** Every list endpoint returns everything in one body. The master list
  is 6 MB, the complaint register 7 MB.
- **Two requests per project** are mandatory (stage 1 mints the id stage 2 needs).
- **Names are dirty.** `SHREE BALAJI HOMES` vs `M/s Shree Balaji Homes Pvt Ltd`, trailing spaces,
  duplicated partners with two photos. Normalisation (uppercase, strip legal suffixes,
  collapse whitespace) is in `pipeline/build.py::norm`.
- **The portal conflates built-up and saleable area.** The public project page has one row,
  “Total built up area / saleable area (in sq. meters)”, whose value is `BuiltUpAreaFSI` for building
  projects and `SaleableArea` for plotted layouts — verified against MAHAL AANGAN (`BuiltUpAreaFSI`
  34773.57 shown, `SaleableArea` null) and RESIDENTIAL SCHEME MAANPUR TEELAWALA (`SaleableArea`
  14175.68, no built-up). Collapse them with `area = BuiltUpAreaFSI or SaleableArea`.
- **Zero is a value, blank is not.** `SaleableArea: 0.0` means "not filed", not "zero-area
  project". Never sum blanks as zeros without saying so.
