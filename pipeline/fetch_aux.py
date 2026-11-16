#!/usr/bin/env python3
"""
Auxiliary Jaipur datasets that are not per-project:
  - registered agents (real-estate agents) in Jaipur district
  - the full statewide complaint register (filtered to Jaipur builders/projects)
  - the violation-of-act register
These are small, single-call endpoints.
"""
import json
import os

from crawl import _request, API, DISTRICT_JAIPUR, ROOT

AUX = os.path.join(ROOT, "raw", "aux")


def main():
    os.makedirs(AUX, exist_ok=True)

    agents = _request(f"{API}/GetAgents", {"districtId": DISTRICT_JAIPUR, "tehsilId": 0,
                                           "agentName": "", "registrationNo": ""})
    json.dump(agents, open(os.path.join(AUX, "agents.json"), "w"))
    print("agents:", len(agents.get("Data") or []))

    complaints = _request(f"{API}/GetComplaintDetailsWebsite", {
        "compalaint_no": "", "complainant": "", "complaint_status": "",
        "respondent_name": "", "ComplaintTypeId": 0, "actionType": "Complaint"})
    json.dump(complaints, open(os.path.join(AUX, "complaints.json"), "w"))
    print("complaints:", len(complaints.get("Data") or []))

    for action in ("Appeal", "Order"):
        try:
            d = _request(f"{API}/GetComplaintDetailsWebsite", {
                "compalaint_no": "", "complainant": "", "complaint_status": "",
                "respondent_name": "", "ComplaintTypeId": 0, "actionType": action})
            json.dump(d, open(os.path.join(AUX, f"complaints_{action.lower()}.json"), "w"))
            print(f"{action}:", len(d.get("Data") or []))
        except Exception as e:  # noqa: BLE001
            print(f"{action}: failed {e}")

    # status lookup for complaints
    for url in (f"{API}/GetDDl_StatusForGrievance", f"{API}/Common/GetComponentsNew?parentId=18&typeId=2"):
        try:
            if "GetComponents" in url:
                continue
            d = _request(url)
            json.dump(d, open(os.path.join(AUX, "complaint_status_master.json"), "w"))
            print("status master:", str(d)[:200])
            break
        except Exception as e:  # noqa: BLE001
            print("status master failed", e)


if __name__ == "__main__":
    main()
