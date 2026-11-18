"""Build qa.json from the QA team's daily task workbook (QA_Daily_Task.xlsx).

Usage:
    python scripts/qa_import.py QA_Daily_Task.xlsx --from 2026-08-01 [--to 2026-11-18] [--out qa.json]

Reads only the "Task_Details" sheet (header on row 3, one row per QA person,
project and day) and writes one qa.json week per Monday-Sunday block, the
same grouping the weekly QA deck uses (weekend work counts in its week).
Each week is labelled Monday to Friday, clipped to --from/--to, so a range
that starts on a Saturday or ends mid-week shows its real dates.

Column mapping (Task_Details -> qa.json):
    Total Requirement.      -> userStories
    Total TC Designed       -> tcDesigned
    Total TC Modify         -> tcModified
    Total TC Executed       -> tcExecuted
    Total Defect logged     -> defectsLogged
    Closed                  -> defectsClosed
    Reopen                  -> defectsReopen
    Reject by Dev           -> defectsRejected
    Leave (Fullday/Half day)-> leave (days: full = 1, half = 0.5, "2 days" = 2;
                               notes about hours or power cuts = 0)

Names are cleaned up so spelling variants merge (e.g. "MYBKY", "My Bky" ->
"MyBKY"; "Nirav Doalsiya" -> "Nirav Dolasiya"). A leave row with no project
is put on that person's main project for the week. Resource/project pairs
with nothing logged for the week are left out.
"""
import argparse
import collections
import datetime as dt
import json
import re
import sys

import openpyxl

SHEET = "Task_Details"
FIRST_DATA_ROW = 4  # rows 1-3 are the grouped header

# 0-based column index in Task_Details -> qa.json key
COLUMNS = {
    3: "userStories",
    9: "tcDesigned",
    10: "tcModified",
    17: "tcExecuted",
    32: "defectsLogged",
    42: "defectsClosed",
    43: "defectsReopen",
    38: "defectsRejected",
}
LEAVE_COL = 60
METRICS = ["userStories", "tcDesigned", "tcModified", "tcExecuted",
           "defectsLogged", "defectsClosed", "defectsReopen", "defectsRejected", "leave"]

# Project names as the weekly deck writes them, keyed by lowercase with
# spaces removed. Anything not listed keeps its own (trimmed) spelling.
PROJECT_NAMES = {
    "mybky": "MyBKY",
    "mymandir": "My Mandir",
    "mysatsang": "MySatsang",
    "webnext": "Webnext",
    "ssov2": "SSO V2",
    "sso": "SSO V2",
    "samarpan": "Samarpan",
    "samrpan": "Samarpan",
    "hds": "HDS",
    "walle": "WFS",
}

PERSON_NAMES = {
    "nirav doalsiya": "Nirav Dolasiya",
    "nisha mandalliya": "Nisha Mandaliya",
}


def clean_project(v):
    if v is None:
        return None
    s = str(v).strip()
    if not s or s.lower() == "none":
        return None
    key = s.lower().replace(" ", "")
    return PROJECT_NAMES.get(key, s)


def clean_person(v):
    s = re.sub(r"\s+", " ", str(v or "").strip())
    if not s:
        return None
    s = " ".join(w[:1].upper() + w[1:].lower() for w in s.split(" "))
    return PERSON_NAMES.get(s.lower(), s)


def to_num(v):
    """Numbers, or the leading number of text like '2(30 steps)'."""
    if v is None or v == "":
        return 0
    if isinstance(v, bool):
        return 0
    if isinstance(v, (int, float)):
        return v
    m = re.match(r"\s*(\d+(?:\.\d+)?)", str(v))
    return float(m.group(1)) if m else 0


def leave_days(v):
    """Free-text leave column -> days. Hour-level notes don't count."""
    if v is None or isinstance(v, (int, float)):
        return 0  # bare numbers here are hour notes, not leave days
    s = str(v).lower()
    if re.search(r"\b(hr|hrs|hour|hours|min|mins)\b", s) or "power" in s or "electricity" in s or "travel" in s:
        return 0
    m = re.search(r"(\d+(?:\.\d+)?)\s*(day|days|leave)", s)
    if m:
        return float(m.group(1))
    if "half" in s or "hald" in s:
        return 0.5
    if "full" in s or "leave" in s:
        return 1
    return 0


def as_date(v):
    if isinstance(v, dt.datetime):
        return v.date()
    if isinstance(v, dt.date):
        return v
    return None


def build(path, start, end):
    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    if SHEET not in wb.sheetnames:
        sys.exit("No '%s' sheet in %s (sheets: %s)" % (SHEET, path, ", ".join(wb.sheetnames)))
    ws = wb[SHEET]

    # week Monday -> person -> project -> metrics
    weeks = collections.defaultdict(lambda: collections.defaultdict(lambda: collections.defaultdict(collections.Counter)))
    loose_leave = collections.defaultdict(lambda: collections.Counter())  # (monday) -> person -> days
    for r in ws.iter_rows(min_row=FIRST_DATA_ROW, values_only=True):
        d = as_date(r[0])
        if d is None or not (start <= d <= end):
            continue
        person = clean_person(r[1])
        if not person:
            continue
        monday = d - dt.timedelta(days=d.weekday())
        project = clean_project(r[2])
        lv = leave_days(r[LEAVE_COL]) if len(r) > LEAVE_COL else 0
        if project is None:
            loose_leave[monday][person] += lv
            continue
        bucket = weeks[monday][person][project]
        for col, key in COLUMNS.items():
            bucket[key] += to_num(r[col])
        bucket["leave"] += lv
        bucket["_rows"] += 1

    # A leave-only row with no project goes on the person's main project.
    for monday, people in loose_leave.items():
        for person, days in people.items():
            if not days:
                continue
            projs = weeks[monday][person]
            if projs:
                main = max(projs, key=lambda p: projs[p]["_rows"])
            else:
                main = "—"
            projs[main]["leave"] += days

    out = []
    for monday in sorted(weeks):
        friday = monday + dt.timedelta(days=4)
        wk_start = max(monday, start)
        wk_end = min(friday, end)
        if wk_end < wk_start:  # range starts on the weekend
            wk_end = min(monday + dt.timedelta(days=6), end)
        rows = []
        for person in sorted(weeks[monday]):
            for project in sorted(weeks[monday][person]):
                m = weeks[monday][person][project]
                vals = {k: m.get(k, 0) for k in METRICS}
                if not any(vals.values()):
                    continue
                for k, v in vals.items():
                    vals[k] = int(v) if float(v).is_integer() else round(v, 1)
                rows.append({"resource": person, "project": project, **vals})
        if rows:
            out.append({"weekStart": wk_start.isoformat(), "weekEnd": wk_end.isoformat(), "rows": rows})
    return out


def dump(doc):
    """JSON with one resource row per line, so weekly diffs stay readable."""
    j = lambda v: json.dumps(v, ensure_ascii=False)
    out = ["{"]
    out.append('  "_readme": %s,' % j(doc["_readme"]))
    out.append('  "source": %s,' % j(doc["source"]))
    out.append('  "weeks": [')
    for wi, w in enumerate(doc["weeks"]):
        out.append('    {"weekStart": %s, "weekEnd": %s, "rows": [' % (j(w["weekStart"]), j(w["weekEnd"])))
        for ri, r in enumerate(w["rows"]):
            out.append("      " + j(r) + ("," if ri < len(w["rows"]) - 1 else ""))
        out.append("    ]}" + ("," if wi < len(doc["weeks"]) - 1 else ""))
    out.append("  ]")
    out.append("}")
    return "\n".join(out) + "\n"


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("xlsx")
    ap.add_argument("--from", dest="start", required=True, help="first date, YYYY-MM-DD")
    ap.add_argument("--to", dest="end", default=dt.date.today().isoformat(), help="last date, YYYY-MM-DD (default today)")
    ap.add_argument("--out", default="qa.json")
    a = ap.parse_args()
    start = dt.date.fromisoformat(a.start)
    end = dt.date.fromisoformat(a.end)
    weeks = build(a.xlsx, start, end)
    doc = {
        "_readme": "Weekly QA status, one entry per week. Generated by scripts/qa_import.py from the "
                   "Task_Details sheet of QA_Daily_Task.xlsx (Monday-Sunday weeks, labelled Mon-Fri). "
                   "The QA tab shows the latest week by default. Totals are computed by the page.",
        "source": {"file": re.sub(r"^[0-9a-f]{8}-", "", a.xlsx.replace("\\", "/").split("/")[-1]), "sheet": SHEET, "from": start.isoformat(), "to": end.isoformat()},
        "weeks": weeks,
    }
    with open(a.out, "w", encoding="utf-8") as f:
        f.write(dump(doc))
    print("Wrote %d weeks to %s" % (len(weeks), a.out))


if __name__ == "__main__":
    main()
