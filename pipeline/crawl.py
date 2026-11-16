#!/usr/bin/env python3
"""
RERA Rajasthan -> Jaipur district crawler.

Data path (reverse engineered from the Angular bundle, see docs/API.md):
  1. POST https://reraapi.rajasthan.gov.in/api/web/Home/GetProjects      (X-API-KEY required)
     -> master list of every registered / suspended / revoked project, with EncryptedProjectId
  2. GET  https://reraapp.rajasthan.gov.in/HomeWebsite/ProjectDtlsWebsite/<EncryptedProjectId>
     -> document lists, QPR/APR, encumbrances, special modifications, and data.ProjectId
        (a SECOND encrypted id, unlocks step 3)
  3. GET  https://reraapp.rajasthan.gov.in/HomeWebsite/ViewProjectWebsite?id=<data.ProjectId>&type=U
     -> full Form-A / Form-B payload (areas, buildings, unit inventory, plot inventory,
        cost estimate, promoter, banks, milestones)

Output: raw/<ProjectId>.json.gz - one trimmed record per project, resumable.
"""
import gzip
import json
import os
import random
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, "raw")

API = "https://reraapi.rajasthan.gov.in/api/web/Home"
MVC = "https://reraapp.rajasthan.gov.in/HomeWebsite"
API_KEY = "MySuperSecretApiKey_123"
DISTRICT_JAIPUR = 1077

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36")

HEADERS = {
    "user-agent": UA,
    "accept": "application/json, text/plain, */*",
    "accept-language": "en-GB,en;q=0.9",
    "referer": "https://rera.rajasthan.gov.in/",
    "origin": "https://rera.rajasthan.gov.in",
}

_print_lock = threading.Lock()


def log(*a):
    with _print_lock:
        print(*a, flush=True)


def _request(url, data=None, tries=4):
    body = json.dumps(data).encode() if data is not None else None
    h = dict(HEADERS)
    if data is not None:
        h["content-type"] = "application/json"
        h["x-api-key"] = API_KEY
    last = None
    for attempt in range(tries):
        try:
            req = urllib.request.Request(url, data=body, headers=h,
                                         method="POST" if data is not None else "GET")
            with urllib.request.urlopen(req, timeout=180) as r:
                return json.loads(r.read().decode("utf-8", "replace"))
        except Exception as e:  # noqa: BLE001 - retry everything network-ish
            last = e
            time.sleep((2 ** attempt) * 1.5 + random.random())
    raise RuntimeError(f"{url} failed after {tries} tries: {last}")


# --------------------------------------------------------------------------- #
# master list
# --------------------------------------------------------------------------- #
def fetch_master():
    payload = {"DistrictId": DISTRICT_JAIPUR, "TeshilId": 0, "ProjectName": "",
               "PromoterName": "", "RegistrationNo": "", "ProjectType": 0,
               "ApplicationStatus": 0, "Year": 0}
    d = _request(f"{API}/GetProjects", payload)
    rows = d.get("Data") or []
    if not rows:
        raise RuntimeError("master list empty")
    return rows


# --------------------------------------------------------------------------- #
# trimming helpers
# --------------------------------------------------------------------------- #
BASIC_KEYS = [
    "Name", "ProjectTypeName", "ProjectType", "ProjectSubtype", "RegistrationNo",
    "ApplicationNo", "DistrictName", "District", "TahsilName", "Taluka", "VillageName",
    "StreetName", "PostOffice", "PinCode", "ProjectPlotNo", "PlotNo", "Area", "PhaseArea",
    "Rectified_PhaseArea", "AggregateAreaOpenSpace", "TotalBuildingCount",
    "SanctionedbuildingCount", "NotSanctionedbuildingCount", "BuiltUpAreaFSI",
    "NotApprovedBuiltUpAreaFSI", "SaleableArea", "TotalFSI", "DateOfComplation",
    "RevisedDateOfComplation", "ActualCommencementDate", "ActualfinishDate",
    "ApprovedOn", "ProjectRemark", "PromoterType", "IsActive", "Litigations",
    "Litigations1", "MapApprovalDate", "MapApprovingAuthority", "OCDateofissue",
    "OCissuingAuthority", "CertiPath", "BankName", "BranchName", "IFSCCode",
    "AccountHolderName", "ProjectStatus", "PStatus", "Status", "Id", "UserId",
]

COST_KEYS = ["Name", "Type", "ParticulerId", "EstimatedAmount", "ActualAmount", "FundEstimatedAmount"]


def trim_cost(rows):
    out = []
    for r in rows or []:
        out.append({k: r.get(k) for k in COST_KEYS if k in r})
    return out


def trim_units(rows):
    """Apartment / plot inventory rows -> unit mix."""
    out = []
    for r in rows or []:
        out.append({
            "building": r.get("BuildingName"),
            "buildingId": r.get("BuildingId"),
            "unitType": r.get("ApartmentName") or r.get("PlotType"),
            "count": r.get("NumberOfApartments") or r.get("TotalPlots"),
            "carpet": r.get("CarpetArea"),
            "plotArea": r.get("PlotArea"),
            "block": r.get("Block"),
            "status": r.get("BookingStatus"),
            "unit": r.get("Units"),
            "sold": r.get("Plots_booked_allotted_sold"),
            "saleValue": r.get("TotalSale"),
            "received": r.get("AmountReceived"),
            "afsDate": r.get("DateAFS"),
        })
    return out


def trim_buildings(rows):
    out = []
    for r in rows or []:
        docs = r.get("GetBuildingDocuments") or []
        out.append({
            "name": r.get("Name"),
            "blocks": r.get("NumberOfBlocks"),
            "blocksString": r.get("NumberOfBlocksString"),
            "basement": r.get("NumberOfBaseMent"),
            "plinth": r.get("NumberOfPlinth"),
            "podium": r.get("NumberOfPodium"),
            "slabOfSS": r.get("NumberOfSlabOfSS"),
            "stilt": r.get("NumberOfStilts"),
            "openParking": r.get("NumberOfOpeningParking"),
            "closeParking": r.get("NumberOfcloseparking"),
            "docCount": len(docs),
            "docs": [{"name": d.get("DocumentName"), "file": d.get("Name")} for d in docs],
        })
    return out


def trim_common_area(ca):
    ca = ca or {}
    return {
        "items": [{k: r.get(k) for k in ("TypeName", "NoOfCars", "NoOfTwoWeelers", "NoOfCycles",
                                         "MechanicalCarParking", "NoOfVisitorCarParking",
                                         "NoOfVisitorScooterParking", "CarParkingAllocated",
                                         "ScooterParkingAllocated")}
                  for r in (ca.get("ProjectCommonAreaDetails") or [])],
        "charged": len(ca.get("CommonAreaItemsCharged") or []) if isinstance(ca.get("CommonAreaItemsCharged"), list) else 0,
    }


def trim_facilities(f):
    f = f or {}
    return {
        "commonArea": [{k: r.get(k) for k in ("Type", "Name", "Proposed", "Booked", "TypeId")}
                       for r in (f.get("ProjectDetail") or [])],
        "development": [{"name": r.get("Name"), "proposed": r.get("Proposed")}
                        for r in (f.get("ProjectDevelopementWork") or [])],
    }


def trim_promoter(p):
    p = p or {}
    addr = p.get("Address") or {}
    partners = []
    seen = set()
    for x in p.get("PartnerModel") or []:
        nm = (x.get("PartnerName") or "").strip()
        if nm and nm.upper() not in seen:
            seen.add(nm.upper())
            partners.append({"name": nm, "designation": x.get("Designation")})
    proj_list = []
    for x in p.get("_ProjectList") or []:
        proj_list.append({"id": x.get("Id"), "name": x.get("UserFullName"),
                          "status": x.get("Statusnam") or x.get("Status"),
                          "regNo": x.get("RegistrationNo")})
    return {
        "orgName": p.get("OrgName"),
        "orgType": p.get("OrgType"),
        "informationType": p.get("InformationType"),
        "firstName": (p.get("FirstName") or "").strip(),
        "middleName": (p.get("MiddleName") or "").strip(),
        "lastName": (p.get("LastName") or "").strip(),
        "officeNo": p.get("OfficeNo"),
        "mobile": p.get("MobileNo"),
        "website": p.get("WebSiteURL"),
        "address": {k: addr.get(k) for k in ("StateName", "DistrictName", "Taluka", "VillageName",
                                             "PlotNumber", "StreetName", "PostOffice", "ZipCode")},
        "partners": partners,
        "promoterProjects": proj_list,
        "pastExperience": len(p.get("PastExprienceDetails") or []),
    }


def trim_dtls(d):
    d = d or {}
    return {
        "documents": [{k: r.get(k) for k in ("MasterType", "ApplicationDocumentName",
                                             "DocumentName", "DocumentUrl", "CreatedOn", "IsRequired")}
                      for r in (d.get("GetDocumentsList") or [])],
        "qpr": d.get("GetQPRList") or [],
        "apr": d.get("GetAPRList") or [],
        "extensions": d.get("GetPreviousExtsList") or [],
        "mapRevisions": (d.get("GetMapRevision") or []) + (d.get("GetMapRevisionnew") or []),
        "encumbrances": (d.get("GetEncumbranceList") or d.get("GetEncumbranceList_New") or []),
        "specialMods": (d.get("GetSpecialModProjectList") or d.get("GetSpecialModProjectList_New") or []),
        "specialModProfiles": (d.get("GetSpecialModProfileList") or d.get("GetSpecialModProfileList_New") or []),
        "notices": d.get("GetNoticesForProjects") or [],
        "orders": d.get("GetOrderDoc") or [],
        "statusOfProject": d.get("StatusOfProject"),
        "hasComplaintOrder": bool((d.get("ComplaintOrderDoc") or "").strip()),
        "projectLocation": d.get("ProjectLocation"),
        "formD": d.get("FormD"),
    }


# --------------------------------------------------------------------------- #
# per project
# --------------------------------------------------------------------------- #
def fetch_project(master_row):
    pid = master_row["Id"]
    dest = os.path.join(RAW, f"{pid}.json.gz")
    if os.path.exists(dest):
        return "skip"

    dtls_raw = _request(f"{MVC}/ProjectDtlsWebsite/{master_row['EncryptedProjectId']}")
    dd = dtls_raw.get("data") or {}
    enc2 = dd.get("ProjectId")
    if not enc2:
        raise RuntimeError("no second-stage id")

    view = _request(f"{MVC}/ViewProjectWebsite?id={urllib.parse.quote(enc2)}&type=U")
    basic = view.get("GetProjectBasic") or {}

    rec = {
        "projectId": pid,
        "master": master_row,
        "dtls": trim_dtls(dd),
        "basic": {k: basic.get(k) for k in BASIC_KEYS},
        "cost": trim_cost(view.get("GetProjectCostDetail")),
        "buildings": trim_buildings(view.get("GetBuildingDetails")),
        "units": trim_units(view.get("GetApartmentAllotteeDetailsList")),
        "plots": trim_units(view.get("PlotDetails") or []),
        "plotSummary": {k: (view.get("Tbl_Plots") or {}).get(k)
                        for k in ("Total_Sanctioned", "Total_Proposed_ButNot_Sanctioned", "Total")},
        "commonArea": trim_common_area(view.get("ProjectCommanArea")),
        "facilities": trim_facilities(view.get("GetProjectAreaFacilities")),
        "promoter": trim_promoter(view.get("PromoterDetails")),
        "gantt": view.get("GanttChartModel") or [],
        "ganttCommercial": view.get("GanttChartModelcomm") or [],
        "floorActivities": view.get("FloorActivitiesDateListModel") or [],
        "plotDetailCount": len(view.get("PlotDetails") or []),
        "consultant": {k: view.get(k) for k in ("ConsultantName", "ConsultantEmail", "ConsultantMobileNo")},
        "projectDocuments": view.get("ProjectDocuments"),
        "litigations": view.get("ProjectLitigations"),
        "paymentSummary": view.get("ProjectSummaryPayment"),
        "ganttProjectType": view.get("GantChart_ProjectType"),
        "fetchedAt": time.strftime("%Y-%m-%dT%H:%M:%S"),
    }
    tmp = dest + ".tmp"
    with gzip.open(tmp, "wt", encoding="utf-8") as f:
        json.dump(rec, f, separators=(",", ":"))
    os.replace(tmp, dest)
    return "ok"


def main():
    os.makedirs(RAW, exist_ok=True)
    workers = int(os.environ.get("WORKERS", "12"))
    master = fetch_master()
    log(f"master list: {len(master)} Jaipur projects")
    with open(os.path.join(ROOT, "raw", "_master.json"), "w") as f:
        json.dump(master, f)

    todo = [m for m in master if not os.path.exists(os.path.join(RAW, f"{m['Id']}.json.gz"))]
    log(f"to fetch: {len(todo)}  (cache hits: {len(master) - len(todo)})")

    ok = err = skip = 0
    errors = []
    t0 = time.time()
    lock = threading.Lock()

    def run(row):
        nonlocal ok, err, skip
        for attempt in range(3):
            try:
                r = fetch_project(row)
                with lock:
                    if r == "ok":
                        ok += 1
                    else:
                        skip += 1
                    n = ok + err + skip
                    if n % 25 == 0:
                        rate = n / max(time.time() - t0, 1e-6)
                        eta = (len(todo) - n) / rate / 60 if rate else 0
                        log(f"  {n}/{len(todo)}  ok={ok} err={err}  {rate:.1f}/s  eta {eta:.1f}m")
                return
            except Exception as e:  # noqa: BLE001
                if attempt == 2:
                    with lock:
                        err += 1
                        errors.append({"id": row["Id"], "name": row["ProjectName"], "error": str(e)[:200]})
                        log(f"  FAIL {row['Id']} {row['ProjectName']}: {str(e)[:120]}")
                else:
                    time.sleep(2 * (attempt + 1))

    with ThreadPoolExecutor(max_workers=workers) as ex:
        list(ex.map(run, todo))

    # second chance: transient 5xx / socket resets are common on this host
    if errors:
        failed_ids = {e["id"] for e in errors}
        retry = [m for m in master if m["Id"] in failed_ids and
                 not os.path.exists(os.path.join(RAW, f"{m['Id']}.json.gz"))]
        if retry:
            log(f"retrying {len(retry)} failures with lower concurrency")
            errors.clear()
            err = 0
            with ThreadPoolExecutor(max_workers=max(2, workers // 3)) as ex:
                list(ex.map(run, retry))

    got = len([f for f in os.listdir(RAW) if f.endswith(".json.gz")])
    rate_err = 1 - got / max(len(master), 1)
    log(f"done: {got}/{len(master)} projects fetched in {(time.time()-t0)/60:.1f} min "
        f"({rate_err*100:.2f}% missing)")
    if errors:
        with open(os.path.join(ROOT, "raw", "_errors.json"), "w") as f:
            json.dump(errors, f, indent=1)
        log(f"{len(errors)} failures recorded in raw/_errors.json")
    # Fail the run only if the loss is material - a handful of 500s from the portal
    # should not block publishing a 99%-complete dataset.
    return 1 if rate_err > 0.03 else 0


if __name__ == "__main__":
    import urllib.parse  # noqa: E402
    sys.exit(main())
