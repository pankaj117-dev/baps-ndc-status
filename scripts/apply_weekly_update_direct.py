#!/usr/bin/env python3
"""Apply ONE weekly update directly to data.json/history.json — no GitHub
issue, no waiting for the scheduled bot. Used by the `pm-weekly-update`
Cursor/Claude skill after it finishes interviewing a PM conversationally.

Usage:
    python3 scripts/apply_weekly_update_direct.py --fields /tmp/fields.json

`fields.json` is a flat {label: value} dict using the EXACT SAME field
labels as .github/ISSUE_TEMPLATE/weekly-update.yml's rendered form labels
(e.g. "Overall status", "Progress (0-100)", "Dependencies", ...) — this
file reuses ingest.py's apply_weekly_update() unchanged for all of those,
so the business rules (status-downgrade needs a reason, delay>0 needs
impact/mitigation, dependency/risk same-order-line matching, etc.) stay
in exactly one place.

Six extra keys cover fields the GitHub issue form doesn't have yet. Each
is a JSON array of objects, upserted (matched + merged, or appended with
a freshly minted id/key) rather than wholesale-replaced like the
risks/dependencies textareas above:

    "ChangeRequests"  -> [{id?, title, description, submittedDate, by, actionItem, approvalStatus, impact}]
    "Decisions"       -> [{id?, decision, description, dateTaken, by}]
    "GoLiveChecklist" -> [{item, status, notes}]                 (upsert by "item")
    "RaidLog"         -> [{id?, type, item, description, reportedDate, actionItem, targetedCompletionDate, responsible, status, closureRemarks}]
    "Features"        -> [{sprint, type, feature, status, notes, plannedDate, actualDate, delayReason}]  (upsert by sprint+feature)
    "Milestones"      -> [{name, date, status}]                  (upsert by "name")
    "DelayItemLog"    -> [{id?, delayedItem, description, reportedDate, impactedPhase, impact, rootCause, responsible, actionItem, actionTaken, status, closureRemarks}]

Any of the six may be omitted or an empty list — same "blank = unchanged"
rule as every other weekly field. Entries WITH an "id" that already
exists get merged in place (lets a PM update a past CR's approvalStatus,
close out a RAID item, etc.); entries without an id get a freshly minted
one and are appended.
"""
import argparse
import datetime
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from lib import (  # noqa: E402
    PROJECT_NAME_TO_ID,
    STATUS_LABEL,
    STATUS_RANK,
    STATUS_TEXT_TO_KEY,
    load_json,
    save_json,
)
from ingest import apply_weekly_update, snapshot_history  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_PATH = os.path.join(ROOT, "data.json")
HISTORY_PATH = os.path.join(ROOT, "history.json")

EXTENDED_LOG_FIELDS = [
    # (fields.json key, data.json array key, seq counter key, id prefix)
    ("ChangeRequests", "changeRequests", "changeRequestSeq", "CR"),
    ("Decisions", "decisions", "decisionSeq", "DEC"),
    ("RaidLog", "raidLog", "raidLogSeq", "RAID"),
    ("DelayItemLog", "delayItemLog", "delayItemLogSeq", "DL-ITEM"),
]


def next_seq_id(project, seq_key, prefix):
    seq = project.get(seq_key, 100)
    seq += 1
    project[seq_key] = seq
    return f"{prefix}-{seq}"


def upsert_by_id(project, field_key, seq_key, prefix, items):
    existing = project.get(field_key) or []
    by_id = {e.get("id"): e for e in existing if isinstance(e, dict) and e.get("id")}
    count = 0
    for raw in items:
        item = dict(raw)
        item_id = item.get("id")
        if item_id and item_id in by_id:
            by_id[item_id].update(item)
        else:
            item["id"] = item_id or next_seq_id(project, seq_key, prefix)
            existing.append(item)
            by_id[item["id"]] = item
        count += 1
    project[field_key] = existing
    return count


def upsert_by_key(project, field_key, items, key_fields):
    existing = project.get(field_key) or []

    def keyof(d):
        return tuple(d.get(k) for k in key_fields)

    index = {keyof(e): e for e in existing if isinstance(e, dict)}
    count = 0
    for raw in items:
        item = dict(raw)
        k = keyof(item)
        if k in index:
            index[k].update(item)
        else:
            existing.append(item)
            index[k] = item
        count += 1
    project[field_key] = existing
    return count


def apply_extended_fields(project, fields):
    """Fields the GitHub issue form doesn't parse yet — applied directly."""
    changed = []

    for json_key, field_key, seq_key, prefix in EXTENDED_LOG_FIELDS:
        items = fields.get(json_key)
        if items:
            n = upsert_by_id(project, field_key, seq_key, prefix, items)
            if n:
                changed.append(f"{n} {field_key}")

    gl = fields.get("GoLiveChecklist")
    if gl:
        n = upsert_by_key(project, "goLiveChecklist", gl, ("item",))
        if n:
            changed.append(f"{n} goLiveChecklist")

    ms = fields.get("Milestones")
    if ms:
        n = upsert_by_key(project, "milestones", ms, ("name",))
        if n:
            changed.append(f"{n} milestones")

    ft = fields.get("Features")
    if ft:
        n = upsert_by_key(project, "features", ft, ("sprint", "feature"))
        if n:
            changed.append(f"{n} features")

    return changed


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--fields", required=True, help="Path to a JSON file: {label: value} dict")
    ap.add_argument("--dry-run", action="store_true", help="Validate and print what WOULD change, write nothing")
    args = ap.parse_args()

    with open(args.fields) as f:
        fields = json.load(f)

    data = load_json(DATA_PATH, {"asOf": None, "lastUpdated": None, "projects": []})
    history = load_json(HISTORY_PATH, {})

    project_name = (fields.get("Project") or "").strip()
    project_id = PROJECT_NAME_TO_ID.get(project_name)
    if not project_id:
        print(
            f"error: unrecognized project '{project_name}'. Known: {sorted(PROJECT_NAME_TO_ID)}",
            file=sys.stderr,
        )
        sys.exit(1)

    by_id = {p["id"]: p for p in data["projects"]}
    project = by_id.get(project_id)
    if not project:
        print(f"error: no project with id '{project_id}' in data.json", file=sys.stderr)
        sys.exit(1)

    as_of = (fields.get("As of date") or "").strip()
    if not as_of:
        print("error: missing 'As of date'", file=sys.stderr)
        sys.exit(1)

    prev_status = project.get("status")
    status_text = (fields.get("Overall status") or "").strip().lower()
    new_status = STATUS_TEXT_TO_KEY.get(status_text) if status_text else None
    reason = (fields.get("Reason for status change") or "").strip()
    status_changed = bool(new_status) and bool(prev_status) and new_status != prev_status
    worsened = status_changed and STATUS_RANK.get(new_status, 0) > STATUS_RANK.get(prev_status, 0)

    if worsened and not reason:
        print(
            f"error: this update moves '{project['name']}' from "
            f"{STATUS_LABEL.get(prev_status, prev_status)} to {STATUS_LABEL.get(new_status, new_status)} "
            "but 'Reason for status change' is blank. Ask the PM for a reason and retry — "
            "same rule the GitHub issue pipeline enforces, not merged without one.",
            file=sys.stderr,
        )
        sys.exit(2)

    if args.dry_run:
        print(f"dry-run OK: would apply weekly update for '{project['name']}' (as of {as_of})")
        if status_changed:
            print(f"  status: {STATUS_LABEL.get(prev_status)} -> {STATUS_LABEL.get(new_status)} (reason: {reason!r})")
        for json_key, field_key, _, _ in EXTENDED_LOG_FIELDS:
            if fields.get(json_key):
                print(f"  {field_key}: {len(fields[json_key])} entr{'y' if len(fields[json_key]) == 1 else 'ies'} to upsert")
        for json_key, field_key in (("GoLiveChecklist", "goLiveChecklist"), ("Milestones", "milestones"), ("Features", "features")):
            if fields.get(json_key):
                print(f"  {field_key}: {len(fields[json_key])} entr{'y' if len(fields[json_key]) == 1 else 'ies'} to upsert")
        sys.exit(0)

    apply_weekly_update(project, fields)
    project["statusChangeReason"] = reason if status_changed else ""

    extended_changed = apply_extended_fields(project, fields)

    if not data.get("asOf") or as_of >= data["asOf"]:
        data["asOf"] = as_of
    data["lastUpdated"] = datetime.datetime.utcnow().isoformat() + "Z"

    snapshot_history(data, history)
    save_json(DATA_PATH, data)
    save_json(HISTORY_PATH, history)

    print(f"OK: applied weekly update for '{project['name']}' (as of {as_of})")
    if extended_changed:
        print("Also updated: " + ", ".join(extended_changed))


if __name__ == "__main__":
    main()
