#!/usr/bin/env python3
"""
Normalise raw/ -> SQLite + static JSON for the dashboard.

Payload layout (site/data/):
  meta.json         counts, coverage, as_of, filter domains, complaint stats
  projects.json     compact core record per Jaipur project  (~0.5 KB each)
  detail/<id>.json  lazy per-project deep detail (buildings, cost, docs, unit mix)
  promoters.json    promoter-level aggregates
  complaints.json   complaint register rows matched to a Jaipur project/promoter
  agents.json       Jaipur registered agents
  timeseries.json   registrations + area by month
  jaipur_rera.db    SQLite mirror of the core table (downloadable)
"""
import gzip
import json
import os
import re
import sqlite3
import statistics
import time
from collections import Counter, defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, "raw")
AUX = os.path.join(RAW, "aux")
OUT = os.path.join(ROOT, "site", "data")
DETAIL = os.path.join(OUT, "detail")

SQM_TO_SQFT = 10.7639

# --------------------------------------------------------------------------- #
# helpers
# --------------------------------------------------------------------------- #
LEGAL = re.compile(r"\b(PVT|PRIVATE|LTD|LIMITED|LLP|CO|COMPANY|AND|&)\b")


def norm(s):
    """Normalise a promoter / respondent name for join purposes."""
    if not s:
        return ""
    s = str(s).upper()
    s = LEGAL.sub(" ", s)
    s = re.sub(r"[^A-Z0-9 ]+", " ", s)
    return re.sub(r"\s+", " ", s).strip()


# --------------------------------------------------------------------------- #
# places: the portal spells the same tehsil/village several ways
# --------------------------------------------------------------------------- #
PLACE_JUNK = re.compile(r"^[\s.\-–—/]*$")          # '', '.', '-', '—' mean "not filed"


def place_key(v):
    """Identity of a place, insensitive to case, spaces and punctuation.

    'JAIPUR' / 'Jaipur' / ' Jaipur ' / 'jAIPUR'  -> jaipur
    'KALWAR' / 'Kalwar' / 'kalwar'              -> kalwar
    'RAMPURA DABRI' / 'Rampuradabri'            -> rampuradabri
    'KALWAD' and 'KALWAR' stay apart: different villages.
    """
    s = str(v or "").strip()
    if PLACE_JUNK.match(s):
        return ""
    return re.sub(r"[^a-z0-9]", "", s.lower())


def _display_variant(variants):
    """Most common spelling, preferring one that is not SHOUTING.

    Better to show 'Kalwar' (10 rows) than 'KALWAR' (6) or 'kalwar' (9); when the
    only spelling is upper case that is what gets shown, so nothing is invented.
    """
    def score(v):
        mixed = not (v.isupper() or v.islower())
        return (mixed, variants[v], v)
    return max(variants, key=score)


ALIASES_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "place-aliases.json")


def load_aliases():
    """Curated same-place spellings the automatic fold cannot see (Dabdi/Dabri, ...)."""
    try:
        with open(ALIASES_PATH, encoding="utf-8") as fh:
            raw = json.load(fh)
    except FileNotFoundError:
        return {"tehsil": {}, "village": {}}
    return {f: {place_key(k): v for k, v in (raw.get(f) or {}).items()} for f in ("tehsil", "village")}


def _tidy_display(v):
    """'JOBNER' -> 'Jobner', 'mahal' -> 'Mahal'; mixed case is left alone."""
    if v and " " not in v and (v.isupper() or v.islower()) and v.isalpha() and len(v) > 2:
        return v.capitalize()
    return v


def canonicalise_places(records, fields=("tehsil", "village")):
    """Fold case/punctuation variants of a tehsil or village into one value."""
    aliases = load_aliases()
    report = {}
    for field in fields:
        before = {str(r.get(field) or "") for r in records}
        groups = defaultdict(list)
        for r in records:
            groups[place_key(r.get(field))].append(str(r.get(field) or "").strip())
        mapping = {}
        for key, values in groups.items():
            mapping[key] = "" if key == "" else _display_variant(Counter(values))
        for r in records:
            r[field] = _tidy_display(mapping[place_key(r.get(field))])
        # curated aliases run after the fold, so one entry fixes every spelling
        n_alias = 0
        for r in records:
            target = aliases.get(field, {}).get(place_key(r.get(field)))
            if target:
                r[field] = target
                n_alias += 1
        after = {str(r.get(field) or "") for r in records}
        merged = len(before) - len(after)
        report[field] = {"before": len(before), "after": len(after), "merged": merged,
                         "alias_rows": n_alias}
        if merged:
            print(f"  {field:8s} {len(before)} -> {len(after)} distinct "
                  f"({merged} variants merged, {n_alias} rows via aliases)")
    return report


def num(v):
    if v is None or v == "":
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def dt(v):
    """Handle '/Date(1789121313000)/', 'dd-mm-yyyy' and ISO strings."""
    if not v:
        return None
    if isinstance(v, str) and v.startswith("/Date("):
        try:
            ms = int(re.search(r"-?\d+", v).group())
            return None if ms <= 0 else time.strftime("%Y-%m-%d", time.gmtime(ms / 1000))
        except Exception:  # noqa: BLE001
            return None
    if isinstance(v, str):
        m = re.match(r"^(\d{2})[-/](\d{2})[-/](\d{4})$", v.strip())
        if m:
            return f"{m.group(3)}-{m.group(2)}-{m.group(1)}"
        m = re.match(r"^(\d{4})-(\d{2})-(\d{2})", v.strip())
        if m:
            return f"{m.group(1)}-{m.group(2)}-{m.group(3)}"
    return None


UNIT_BUCKETS = [
    (r"\b4\s*BHK", "4BHK"),
    (r"\b3\s*BHK", "3BHK"),
    (r"\b2\s*BHK", "2BHK"),
    (r"\b1\s*BHK", "1BHK"),
    (r"\b5\s*BHK|\bPENTHOUSE|\bDUPLEX", "5BHK+"),
    (r"STUDIO|\b1\s*RK", "Studio/1RK"),
    (r"SHOP|SHOWROOM|RETAIL", "Shop/Showroom"),
    (r"OFFICE|CORPORATE|IT\s*PARK", "Office"),
    (r"PLOT", "Plot"),
    (r"VILLA|ROW\s*HOUSE|BUNGALOW", "Villa/RowHouse"),
]


def unit_bucket(name):
    if not name:
        return "Other"
    u = str(name).upper()
    for pat, label in UNIT_BUCKETS:
        if re.search(pat, u):
            return label
    return "Other"


QPR_RAW = os.path.join(ROOT, "raw_qpr")
_QF = {"january to march": 1, "april to june": 2, "july to september": 3, "october to december": 4}


def quarter_code(label):
    """'July to September, 2026' -> '2026Q3'. None when the label is not a quarter."""
    m = re.match(r"\s*([A-Za-z ]+?),\s*(\d{4})", str(label or ""))
    if not m:
        return None
    q = _QF.get(m.group(1).strip().lower())
    return f"{m.group(2)}Q{q}" if q else None


def load_qpr(pid):
    """Filed QPR rows for a project (pipeline/fetch_qpr.py), newest first."""
    p = os.path.join(QPR_RAW, f"{pid}.json.gz")
    if not os.path.exists(p):
        return []
    try:
        with gzip.open(p, "rt", encoding="utf-8") as fh:
            rows = (json.load(fh) or {}).get("rows") or []
    except Exception:  # noqa: BLE001
        return []
    for r in rows:
        r["code"] = quarter_code(r.get("quarter"))
    rows.sort(key=lambda r: (r.get("code") or ""), reverse=True)
    return rows


def load_complaints():
    p = os.path.join(AUX, "complaints.json")
    return json.load(open(p)).get("Data") or [] if os.path.exists(p) else []


# --------------------------------------------------------------------------- #
# per-project normalisation
# --------------------------------------------------------------------------- #
def inventory(rows):
    """Collapse the portal's unit rows into per-type groups.

    The portal repeats a type's total count on every unit row (108 studio units -> 108
    rows each saying count=108), and conversely groups many plots into one row with
    count=25. So a group's true size is max(row_count, stated_count).
    """
    groups = {}
    for u in rows:
        typ = (u.get("unitType") or u.get("unit") or "").strip()
        key = ((u.get("building") or u.get("block") or "").strip(), typ)
        g = groups.setdefault(key, {"rows": 0, "max": 0, "carpet": None, "area": None,
                                    "status": set(), "type": typ})
        g["rows"] += 1
        try:
            c = max(int(u.get("count") or 1), 1)
        except (TypeError, ValueError):
            c = 1
        g["max"] = max(g["max"], c)
        g["carpet"] = g["carpet"] or num(u.get("carpet"))
        g["area"] = g["area"] or num(u.get("plotArea"))
        g["status"].add((u.get("status") or "").strip().lower())
    out = []
    for g in groups.values():
        out.append({"type": g["type"], "n": max(g["rows"], g["max"]), "carpet": g["carpet"],
                    "area": g["area"], "status": g["status"]})
    return out


def build_record(raw):
    m = raw.get("master") or {}
    b = raw.get("basic") or {}
    p = raw.get("promoter") or {}
    d = raw.get("dtls") or {}

    # The allottee list already carries the plotted inventory for plotted projects
    # (PlotDetails repeats the same plots in grouped form), so it is the single source
    # of truth and PlotDetails is only a fallback.
    unit_groups, plot_groups = [], []
    for g in inventory(raw.get("units") or []):
        if g["area"] is not None or re.match(r"^PLOT\b", (g["type"] or "").upper()):
            plot_groups.append(g)
        else:
            unit_groups.append(g)
    if not plot_groups:
        plot_groups = inventory(raw.get("plots") or [])

    unit_mix = Counter()
    carpets, sold, unsold, mixed = [], 0, 0, 0
    for g in unit_groups:
        unit_mix[unit_bucket(g["type"])] += g["n"]
        if g["carpet"]:
            carpets.extend([g["carpet"]] * min(g["n"], 4000))
        st = g["status"]
        if len(st) == 1:
            s = next(iter(st))
            if s:
                if s.startswith("un") or "unsold" in s:
                    unsold += g["n"]
                elif "sold" in s or "book" in s or "allot" in s:
                    sold += g["n"]
                else:
                    mixed += g["n"]
        else:
            mixed += g["n"]

    plot_areas = [(g["area"], g["n"]) for g in plot_groups if g["area"]]
    plots = sum(g["n"] for g in plot_groups)

    total_units = sum(unit_mix.values())
    is_plotted = (m.get("ProjectTypeName") or "").upper() == "PLOTTED" or (plots > total_units)

    blocks = basement = plinth = podium = stilt = parking_open = parking_close = 0
    floors, building_docs = "", 0
    for bl in raw.get("buildings") or []:
        bs = (bl.get("blocksString") or "").strip()
        n_from_string = len([x for x in bs.split(",") if x.strip()]) if bs else 0
        blocks += max(int(num(bl.get("blocks")) or 0), n_from_string)
        floors = bl.get("blocksString") or floors
        basement += int(num(bl.get("basement")) or 0)
        plinth += int(num(bl.get("plinth")) or 0)
        podium += int(num(bl.get("podium")) or 0)
        stilt += int(num(bl.get("stilt")) or 0)
        parking_open += int(num(bl.get("openParking")) or 0)
        parking_close += int(num(bl.get("closeParking")) or 0)
        building_docs += bl.get("docCount") or 0

    cost_by_type, land_cost, construction_cost = defaultdict(float), 0.0, 0.0
    for c in raw.get("cost") or []:
        t = (c.get("Type") or "Other").strip()
        amt = num(c.get("EstimatedAmount")) or 0
        if t:
            cost_by_type[t] += amt
        nm = (c.get("Name") or "").lower()
        if "land cost" in nm:
            land_cost += amt
        elif "construction" in nm or "built up" in nm or "builtup" in nm:
            construction_cost += amt
    total_cost = sum(cost_by_type.values())

    reg_date = None
    cert = m.get("CertificateNo") or ""
    mc = re.search(r"\((\d{2})/(\d{2})/(\d{4})\)", cert)
    if mc:
        reg_date = f"{mc.group(3)}-{mc.group(2)}-{mc.group(1)}"
    reg_date = reg_date or dt(m.get("APPROVEDON"))

    promoter_name = (b.get("PromoterName") or p.get("orgName") or m.get("PromoterName") or "").strip()

    ca_items = (raw.get("commonArea") or {}).get("items") or []
    cars = sum(int(num(i.get("NoOfCars")) or 0) for i in ca_items)
    two_wheelers = sum(int(num(i.get("NoOfTwoWeelers")) or 0) for i in ca_items)
    visitor_cars = sum(int(num(i.get("NoOfVisitorCarParking")) or 0) for i in ca_items)

    # The portal has ONE declared-area field, labelled "Total built up area /
    # saleable area": building projects file BuiltUpAreaFSI, plotted layouts file
    # SaleableArea (only 40 of 2,419 file both). Treating the two API columns as
    # independent measures made a 100%-covered register look 11% covered, and made
    # area charts go blank on filters where the other column was the one filed.
    qpr = load_qpr(raw["projectId"])
    apr_rows = d.get("apr") or []

    saleable = num(b.get("SaleableArea"))
    built_up = num(b.get("BuiltUpAreaFSI"))
    declared_area = built_up or saleable
    area_src = "built-up" if built_up else ("saleable" if saleable else None)

    gantt = raw.get("gantt") or []
    g_from = sorted(x for x in (dt(g.get("FromDate")) for g in gantt) if x)
    g_to = sorted(x for x in (dt(g.get("ToDate")) for g in gantt) if x)

    core = {
        "id": raw["projectId"],
        "name": (b.get("Name") or m.get("ProjectName") or "").strip(),
        "cat": b.get("ProjectTypeName") or m.get("ProjectTypeName") or "",
        "status": d.get("statusOfProject") or "",
        "app": m.get("AppStatus") or "",
        "regNo": b.get("RegistrationNo") or m.get("REGISTRATIONNO") or "",
        "regDate": reg_date,
        "regYear": reg_date[:4] if reg_date else None,
        "promoter": promoter_name,
        "promoterKey": norm(promoter_name),
        "promoterType": b.get("PromoterType") or m.get("PromoterType") or "",
        "tehsil": b.get("TahsilName") or "",
        "village": b.get("VillageName") or "",
        "pin": b.get("PinCode") or "",
        "landArea": num(b.get("PhaseArea")) or num(b.get("Area")),
        "openSpace": num(b.get("AggregateAreaOpenSpace")),
        "saleable": saleable,
        "builtUp": built_up,
        "area": declared_area,          # what the portal shows in its single field
        "areaSrc": area_src,
        "buildings": len(raw.get("buildings") or []) or (
            0 if is_plotted else int(num(b.get("TotalBuildingCount")) or 0)),
        "buildingsReported": int(num(b.get("TotalBuildingCount")) or 0),
        # on plotted projects these two counters hold plot counts, not buildings
        "bSanctioned": 0 if is_plotted else int(num(b.get("SanctionedbuildingCount")) or 0),
        "bUnsanctioned": 0 if is_plotted else int(num(b.get("NotSanctionedbuildingCount")) or 0),
        "blocks": blocks,
        "units": total_units,
        "plotCount": plots,
        "unitMix": dict(unit_mix),
        "carpetMin": round(min(carpets), 1) if carpets else None,
        "carpetMax": round(max(carpets), 1) if carpets else None,
        "carpetAvg": round(statistics.fmean(carpets), 1) if carpets else None,
        "plotMin": round(min(a for a, _ in plot_areas), 1) if plot_areas else None,
        "plotMax": round(max(a for a, _ in plot_areas), 1) if plot_areas else None,
        # QPR is the authority's own per-quarter inventory figure - use it for "sold"
        "sold": (qpr[0].get("booked") if qpr else None),
        "unsold": (qpr[0].get("unbooked") if qpr else None),
        "sanctioned": (qpr[0].get("sanctioned") if qpr else None),
        "pctSold": (qpr[0].get("pctBooked") if qpr else None),
        "constPct": (qpr[0].get("constPct") if qpr else None),
        "qprQuarter": (qpr[0].get("quarter") if qpr else None),
        "qprQ": (qpr[0].get("code") if qpr else None),
        "qprFiled": (qpr[0].get("filedOn") if qpr else None),
        "qprFilings": len(d.get("qpr") or []),
        "qprEnriched": len(qpr),
        "aprYear": (apr_rows[0].get("CurrentFinYear") if apr_rows else None),
        "aprFilings": len(apr_rows),
        "isPlotted": bool(is_plotted),
        "landCost": round(land_cost) or None,
        "totalCost": round(total_cost) or None,
        "casesProject": 0,
        "casesPromoter": 0,
        "docs": len(d.get("documents") or []),
        "milestones": len(gantt),
        "completion": dt(b.get("DateOfComplation")),
        "revCompletion": dt(b.get("RevisedDateOfComplation")),
        "startDate": dt(b.get("ActualCommencementDate")),
        "encId": m.get("EncryptedProjectId"),
    }

    detail = {
        "id": raw["projectId"],
        "appNo": b.get("ApplicationNo") or m.get("ApplicationNo") or "",
        "approvedOn": dt(m.get("APPROVEDON")),
        "finishDate": dt(b.get("ActualfinishDate")),
        "totalArea": num(b.get("Area")),
        "notApprovedBuiltUp": num(b.get("NotApprovedBuiltUpAreaFSI")),
        "address": d.get("projectLocation") or "",
        "remark": b.get("ProjectRemark"),
        "floors": floors,
        "basement": basement, "plinth": plinth, "podium": podium, "stilt": stilt,
        "parkingOpen": parking_open, "parkingClose": parking_close,
        "cars": cars, "twoWheelers": two_wheelers, "visitorCars": visitor_cars,
        "buildingDocs": building_docs,
        "constructionCost": round(construction_cost) or None,
        "costByType": {k.strip(): round(v) for k, v in cost_by_type.items()},
        "costDetail": [{"n": c.get("Name"), "t": (c.get("Type") or "").strip(),
                        "e": num(c.get("EstimatedAmount")), "a": num(c.get("ActualAmount"))}
                       for c in (raw.get("cost") or [])],
        "buildingsDetail": raw.get("buildings") or [],
        "unitInventory": [{"type": g["type"], "n": g["n"], "carpet": g["carpet"],
                           "status": sorted(x for x in g["status"] if x)} for g in unit_groups],
        "plotInventory": [{"type": g["type"], "n": g["n"], "area": g["area"],
                           "status": sorted(x for x in g["status"] if x)} for g in plot_groups],
        "mixedStatus": mixed,
        "ganttChart": gantt,
        "promoterAddress": p.get("address") or {},
        "promoterOrgType": p.get("orgType") or "",
        "promoterUserId": b.get("UserId") or m.get("UserId"),
        "partners": p.get("partners") or [],
        "promoterProjects": p.get("promoterProjects") or [],
        "documentList": [{"name": x.get("ApplicationDocumentName"), "file": x.get("DocumentName"),
                          "url": x.get("DocumentUrl")} for x in (d.get("documents") or [])],
        "notices": len(d.get("notices") or []),
        "orders": len(d.get("orders") or []),
        "extensions": len(d.get("extensions") or []),
        "encumbrances": len(d.get("encumbrances") or []),
        "specialMods": len(d.get("specialMods") or []),
        "mapRevisions": len(d.get("mapRevisions") or []),
        "qpr": len(d.get("qpr") or []),
        "qprHistory": qpr,
        "apr": len(d.get("apr") or []),
        "hasComplaintOrder": bool(d.get("hasComplaintOrder")),
        "paymentStatus": (raw.get("paymentSummary") or {}).get("PaymentStatus"),
        "fees": num(b.get("Fees")),
        "consultant": (raw.get("consultant") or {}).get("ConsultantName"),
        "docs": d.get("documents") or [],
    }
    return core, detail


# --------------------------------------------------------------------------- #
# complaints linkage
# --------------------------------------------------------------------------- #
def link_complaints(records, complaints):
    by_name = defaultdict(list)
    by_promoter = defaultdict(list)
    for r in records:
        if r["name"]:
            by_name[norm(r["name"])].append(r["id"])
        if r["promoterKey"]:
            by_promoter[r["promoterKey"]].append(r["id"])

    counts = defaultdict(lambda: {"project": 0, "promoter": 0})
    matched, unmatched = [], 0
    for c in complaints:
        pn, rn = norm(c.get("ProjectName")), norm(c.get("RespondentName"))
        ids = by_name.get(pn) if pn else None
        match = None
        if ids and len(ids) == 1:
            match = {"type": "project", "id": ids[0]}
            counts[ids[0]]["project"] += 1
        elif rn and by_promoter.get(rn):
            pids = sorted(set(by_promoter[rn]))
            match = {"type": "promoter", "id": pids[0] if len(pids) == 1 else None,
                     "ids": pids[:40], "n": len(pids)}
            for pid in pids:
                counts[pid]["promoter"] += 1
        row = {
            "no": c.get("ComplaintNumber"),
            "title": c.get("titleOfCase"),
            "respondent": c.get("RespondentName"),
            "citizen": c.get("CitizenName"),
            "project": c.get("ProjectName"),
            "typeId": c.get("complaintTypeID"),
            "statusId": c.get("StatusId"),
            "updated": (c.get("updatedon") or "")[:10] or None,
            "hearing": c.get("strHearingDate") or c.get("strBhearingDate") or None,
            "advocate": c.get("Complainantadvocatename"),
            "match": match,
        }
        if match:
            matched.append(row)
        else:
            unmatched += 1

    for r in records:
        cc = counts.get(r["id"])
        if cc:
            r["casesProject"] = cc["project"]
            r["casesPromoter"] = cc["promoter"]
    # how many projects each promoter has in Jaipur, so a builder-level case count
    # can be read against the size of the portfolio it is attached to
    portfolio = Counter(r["promoterKey"] for r in records if r["promoterKey"])
    for r in records:
        r["promoterProjects"] = portfolio.get(r["promoterKey"], 0)
    return matched, unmatched


# --------------------------------------------------------------------------- #
# aggregates
# --------------------------------------------------------------------------- #
def promoter_rows(records):
    g = defaultdict(lambda: {"n": 0, "types": Counter(), "saleable": 0.0, "builtUp": 0.0,
                             "land": 0.0, "units": 0, "plots": 0, "cost": 0.0, "cases": 0,
                             "first": None, "last": None, "ids": [], "tehsils": Counter(),
                             "statuses": Counter(), "sanctioned": 0, "unsanctioned": 0,
                             "display": Counter()})
    for r in records:
        k = r["promoterKey"] or "(UNNAMED)"
        x = g[k]
        x["n"] += 1
        x["types"][r["cat"]] += 1
        x["saleable"] += r["saleable"] or 0
        x["builtUp"] += r["builtUp"] or 0
        x["land"] += r["landArea"] or 0
        x["units"] += r["units"] or 0
        x["plots"] += r["plotCount"] or 0
        x["cost"] += r["totalCost"] or 0
        x["cases"] += (r["casesProject"] or 0) + (r["casesPromoter"] or 0)
        x["sanctioned"] += r["bSanctioned"] or 0
        x["unsanctioned"] += r["bUnsanctioned"] or 0
        x["tehsils"][r["tehsil"] or "-"] += 1
        x["statuses"][r["status"] or r["app"] or "-"] += 1
        if r["promoter"]:
            x["display"][r["promoter"]] += 1
        rd = r["regDate"]
        if rd:
            x["first"] = rd if not x["first"] or rd < x["first"] else x["first"]
            x["last"] = rd if not x["last"] or rd > x["last"] else x["last"]
        if len(x["ids"]) < 80:
            x["ids"].append(r["id"])
    rows = []
    for k, x in g.items():
        rows.append({
            "key": k,
            "name": x["display"].most_common(1)[0][0] if x["display"] else k,
            "projects": x["n"],
            "types": dict(x["types"]),
            "saleable": round(x["saleable"]),
            "builtUp": round(x["builtUp"]),
            "land": round(x["land"]),
            "units": x["units"],
            "plots": x["plots"],
            "cost": round(x["cost"]),
            "cases": x["cases"],
            "first": x["first"],
            "last": x["last"],
            "tehsils": dict(x["tehsils"].most_common(5)),
            "statuses": dict(x["statuses"]),
            "sanctioned": x["sanctioned"],
            "unsanctioned": x["unsanctioned"],
            "ids": x["ids"],
        })
    rows.sort(key=lambda r: (-r["projects"], -r["saleable"]))
    return rows


def timeseries(records):
    months = defaultdict(lambda: {"n": 0, "saleable": 0.0, "builtUp": 0.0, "land": 0.0,
                                  "units": 0, "plots": 0, "cost": 0.0, "cats": Counter()})
    for r in records:
        rd = r["regDate"]
        if not rd:
            continue
        x = months[rd[:7]]
        x["n"] += 1
        x["saleable"] += r["saleable"] or 0
        x["builtUp"] += r["builtUp"] or 0
        x["land"] += r["landArea"] or 0
        x["units"] += r["units"] or 0
        x["plots"] += r["plotCount"] or 0
        x["cost"] += r["totalCost"] or 0
        x["cats"][r["cat"]] += 1
    return {k: {"n": v["n"], "saleable": round(v["saleable"]), "builtUp": round(v["builtUp"]),
                "land": round(v["land"]), "units": v["units"], "plots": v["plots"],
                "cost": round(v["cost"]), "cats": dict(v["cats"])}
            for k, v in sorted(months.items())}


def coverage(records, field):
    have = [r for r in records if r.get(field)]
    # two decimals: 2418/2419 is 99.96%, not "100%"
    return {"n": len(have), "pct": round(100 * len(have) / max(len(records), 1), 2)}


# --------------------------------------------------------------------------- #
def main():
    for p in (OUT, DETAIL):
        os.makedirs(p, exist_ok=True)
    for f in os.listdir(DETAIL):
        os.remove(os.path.join(DETAIL, f))

    records, details = [], []
    for f in sorted(x for x in os.listdir(RAW) if x.endswith(".json.gz") and not x.startswith("_")):
        with gzip.open(os.path.join(RAW, f), "rt", encoding="utf-8") as fh:
            try:
                core, det = build_record(json.load(fh))
                records.append(core)
                details.append(det)
            except Exception as e:  # noqa: BLE001
                print("skip", f, e)
    records.sort(key=lambda r: (r["name"] or "").lower())
    places = canonicalise_places(records)

    complaints = load_complaints()
    matched, unmatched = link_complaints(records, complaints)

    agents = []
    ap = os.path.join(AUX, "agents.json")
    if os.path.exists(ap):
        agents = json.load(open(ap)).get("Data") or []

    proms = promoter_rows(records)

    # per-project detail files
    for det in details:
        with open(os.path.join(DETAIL, f"{det['id']}.json"), "w", encoding="utf-8") as fh:
            json.dump(det, fh, separators=(",", ":"), ensure_ascii=False)

    # SQLite mirror
    db_path = os.path.join(OUT, "jaipur_rera.db")
    if os.path.exists(db_path):
        os.remove(db_path)
    con = sqlite3.connect(db_path)
    cols = list(records[0].keys()) if records else []
    con.execute("CREATE TABLE projects (%s)" % ",".join(
        f'"{c}" {"TEXT" if isinstance(records[0][c], str) or records[0][c] is None else "REAL"}'
        for c in cols if c != "unitMix"))
    keep = [c for c in cols if c != "unitMix"]
    con.executemany(f'INSERT INTO projects VALUES ({",".join("?" * len(keep))})',
                    [[r.get(c) for c in keep] for r in records])
    con.execute("CREATE TABLE complaints (no TEXT, respondent TEXT, project TEXT, typeId INT,"
                " statusId INT, matchType TEXT, matchId INT)")
    con.executemany("INSERT INTO complaints VALUES (?,?,?,?,?,?,?)",
                    [(x["no"], x["respondent"], x["project"], x["typeId"], x["statusId"],
                      (x["match"] or {}).get("type"), (x["match"] or {}).get("id")) for x in matched])
    con.commit()
    con.close()

    totals = {
        "projects": len(records),
        "promoters": len({r["promoterKey"] for r in records if r["promoterKey"]}),
        "saleable": round(sum(r["saleable"] or 0 for r in records)),
        "builtUp": round(sum(r["builtUp"] or 0 for r in records)),
        "area": round(sum(r["area"] or 0 for r in records)),
        "land": round(sum(r["landArea"] or 0 for r in records)),
        "units": sum(r["units"] or 0 for r in records),
        "plots": sum(r["plotCount"] or 0 for r in records),
        "cost": round(sum(r["totalCost"] or 0 for r in records)),
        "buildings": sum(r["buildings"] or 0 for r in records),
        "sold": sum(r["sold"] or 0 for r in records),
        "unsold": sum(r["unsold"] or 0 for r in records),
        "cases": len(matched),
        "agents": len(agents),
    }

    meta = {
        "asOf": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "district": "Jaipur",
        "districtId": 1077,
        "source": "rera.rajasthan.gov.in (RERA Rajasthan 2.0)",
        "totals": totals,
        "category": dict(Counter(r["cat"] for r in records)),
        "status": dict(Counter(r["status"] or r["app"] for r in records)),
        "appStatus": dict(Counter(r["app"] for r in records)),
        "promoterTypes": dict(Counter(r["promoterType"] or "-" for r in records)),
        "tehsils": dict(Counter(r["tehsil"] or "-" for r in records).most_common()),
        # how many spellings the portal shipped vs how many places remain after folding
        "places": places,
        "years": dict(sorted(Counter(r["regYear"] for r in records if r["regYear"]).items())),
        "coverage": {f: coverage(records, f) for f in
                     ("area", "saleable", "builtUp", "landArea", "units", "plotCount", "totalCost",
                      "regDate", "carpetAvg", "plotMin", "qprQ", "sold")},
        # filing recency: how many projects last filed each quarter, newest first
        "qprQuarters": dict(Counter(r["qprQ"] for r in records if r["qprQ"]).most_common()),
        "aprYears": dict(Counter(r.get("aprYear") for r in records if r.get("aprYear")).most_common()),
        "unitBuckets": dict(Counter(b for r in records for b in (r["unitMix"] or {}))),
        "complaints": {
            "linkage": "builder-level",
            "note": ("The public complaint register names a respondent (promoter/builder) and has a "
                     "ProjectName column that is empty on every row, so cases are linked to a "
                     "builder, not to a project. Per-project figures are that builder's cases."),
            "withProjectName": sum(1 for c in complaints if (c.get("ProjectName") or "").strip()),
            "statewide": len(complaints),
            "matched": len(matched),
            "unmatched": unmatched,
            "byType": dict(Counter(str(x["typeId"]) for x in matched)),
            "byStatus": dict(Counter(str(x["statusId"]) for x in matched).most_common()),
        },
        "areaUnit": "sq m (portal native); sq ft = sq m × 10.7639",
    }

    def dump(name, obj, compact=True):
        path = os.path.join(OUT, name)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(obj, f, separators=(",", ":"), ensure_ascii=False) if compact \
                else json.dump(obj, f, indent=1, ensure_ascii=False)
        print(f"  {name:18s} {os.path.getsize(path)/1024:9.1f} KB")

    print("writing site/data/")
    dump("meta.json", meta, False)
    dump("projects.json", records)
    dump("promoters.json", proms)
    dump("complaints.json", matched)
    dump("agents.json", [{"name": a.get("PromoterName"), "cert": a.get("CertificateNo"),
                          "approved": dt(a.get("ApprovedOn"))} for a in agents])
    dump("timeseries.json", timeseries(records))
    print(f"projects={len(records)} promoters={len(proms)} complaints(matched)={len(matched)} "
          f"agents={len(agents)} detail_files={len(details)}")


if __name__ == "__main__":
    main()
