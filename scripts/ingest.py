#!/usr/bin/env python3
"""Pull open 'weekly-update', 'new-dependency', 'update-dependency', 'new-risk', and
'feedback' issues into
data.json / history.json / notes.json, then close successfully ingested issues.

Run by .github/workflows/ingest.yml (scheduled + manual). Safe to run
repeatedly — issues are only closed once they've been merged in, and repeat
runs with no open issues are no-ops.
"""
import datetime
import json
import os
import re
import sys

from lib import (
    PROJECT_NAME_TO_ID,
    STATUS_LABEL,
    STATUS_RANK,
    STATUS_TEXT_TO_KEY,
    load_json,
    lines,
    parse_issue_form_body,
    run_gh,
    save_json,
    to_int,
)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_PATH = os.path.join(ROOT, "data.json")
HISTORY_PATH = os.path.join(ROOT, "history.json")
NOTES_PATH = os.path.join(ROOT, "notes.json")


def fetch_issues(label):
    out = run_gh([
        "issue", "list",
        "--label", label,
        "--state", "open",
        "--json", "number,body,createdAt,author,url,labels",
        "--limit", "100",
    ])
    return json.loads(out)


NEEDS_REASON_LABEL = "needs-reason"

DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
DEP_ID_PREFIX_RE = re.compile(r"^(DEP-\d+)\s*[|:]\s*(.*)$", re.IGNORECASE)
RISK_ID_PREFIX_RE = re.compile(r"^(RISK-\d+)\s*[|:]\s*(.*)$", re.IGNORECASE)
PRIORITY_LEVELS = ["Critical", "High", "Medium", "Low"]

LEGACY_DEP_KEYS = (
    "dependencyTeams",
    "dependencyMitigations",
    "dependencyDueBy",
    "dependencyPriority",
    "dependencyEscalated",
)


def is_none_dependency_text(text):
    return not text or re.match(r"^(none|no dependency)$", (text or "").strip(), re.I)


def parse_yes_no(value):
    return (value or "").strip().lower() in ("yes", "y", "true")


def normalize_priority(value):
    p = (value or "").strip().title()
    return p if p in PRIORITY_LEVELS else "Medium"


def parse_dependency_line(line):
    """Optional 'DEP-101 | description' prefix so PMs can tie a row to a stable id."""
    m = DEP_ID_PREFIX_RE.match((line or "").strip())
    if m:
        return m.group(1).upper(), m.group(2).strip()
    return None, (line or "").strip()


def next_dependency_id(project):
    seq = project.get("dependencySeq", 100)
    seq += 1
    project["dependencySeq"] = seq
    return f"DEP-{seq}"


def infer_dependency_seq(project):
    """Set dependencySeq from existing DEP-* ids when missing."""
    if "dependencySeq" in project:
        return
    max_num = 100
    for dep in project.get("dependencies") or []:
        if isinstance(dep, dict):
            dep_id = dep.get("id") or ""
            if dep_id.upper().startswith("DEP-"):
                try:
                    max_num = max(max_num, int(dep_id.split("-")[-1]))
                except ValueError:
                    pass
    project["dependencySeq"] = max_num


def strip_legacy_dependency_keys(project):
    for key in LEGACY_DEP_KEYS:
        project.pop(key, None)


def migrate_project_dependencies(project):
    """Upgrade parallel-array dependency fields to a single id-based object array."""
    deps = project.get("dependencies")
    legacy_present = any(project.get(k) for k in LEGACY_DEP_KEYS)

    if isinstance(deps, list) and deps and isinstance(deps[0], dict):
        infer_dependency_seq(project)
        strip_legacy_dependency_keys(project)
        return False

    if isinstance(deps, list) and not deps and not legacy_present:
        infer_dependency_seq(project)
        strip_legacy_dependency_keys(project)
        return False

    texts = deps if isinstance(deps, list) else []
    teams = project.get("dependencyTeams") or []
    mitigations = project.get("dependencyMitigations") or []
    due_by = project.get("dependencyDueBy") or []
    priorities = project.get("dependencyPriority") or []
    escalated = project.get("dependencyEscalated") or []

    seq = project.get("dependencySeq", 100)
    new_deps = []
    max_len = max(
        len(texts),
        len(teams),
        len(mitigations),
        len(due_by),
        len(priorities),
        len(escalated),
        0,
    )
    for i in range(max_len):
        text = texts[i] if i < len(texts) else ""
        if is_none_dependency_text(text):
            continue
        seq += 1
        raw_due = due_by[i] if i < len(due_by) else ""
        new_deps.append({
            "id": f"DEP-{seq}",
            "text": text,
            "team": teams[i] if i < len(teams) else "",
            "mitigation": mitigations[i] if i < len(mitigations) else "",
            "dueBy": raw_due if is_valid_iso_date(raw_due) else "",
            "priority": normalize_priority(priorities[i] if i < len(priorities) else ""),
            "escalated": bool(escalated[i]) if i < len(escalated) else False,
            "resolved": False,
        })

    project["dependencies"] = new_deps
    project["dependencySeq"] = seq
    strip_legacy_dependency_keys(project)
    return True


def open_dependencies(project):
    return [d for d in project.get("dependencies") or [] if isinstance(d, dict) and not d.get("resolved")]


def find_dependency_by_id(project, dep_id):
    if not dep_id:
        return None
    target = dep_id.upper()
    for dep in project.get("dependencies") or []:
        if isinstance(dep, dict) and (dep.get("id") or "").upper() == target:
            return dep
    return None


def apply_weekly_dependency_fields(project, fields):
    """Merge weekly-form dependency textareas into id-based dependency objects."""
    migrate_project_dependencies(project)

    deps_raw = fields.get("Dependencies", "")
    if deps_raw:
        dep_lines = lines(deps_raw)
        team_lines = lines(fields.get("Dependency owning team(s)", ""))
        mit_lines = lines(fields.get("Dependency mitigation plan / impact", ""))
        due_lines = lines(fields.get("Dependency needed by (date)", ""))
        pri_lines = lines(fields.get("Dependency priority", ""))
        esc_lines = lines(fields.get("Dependency escalated to leadership?", ""))
        res_lines = lines(fields.get("Dependency resolved?", ""))

        old_open = open_dependencies(project)
        old_open_by_id = {d["id"]: d for d in old_open if d.get("id")}
        seen_ids = set()
        new_open = []

        for i, line in enumerate(dep_lines):
            if is_none_dependency_text(line):
                continue
            dep_id, text = parse_dependency_line(line)
            resolved_flag = parse_yes_no(res_lines[i]) if i < len(res_lines) else False

            dep = None
            if dep_id and dep_id in old_open_by_id:
                dep = old_open_by_id[dep_id]
            elif i < len(old_open):
                dep = old_open[i]

            if dep:
                dep_id = dep.get("id") or next_dependency_id(project)
                dep["id"] = dep_id
            else:
                if dep_id and not find_dependency_by_id(project, dep_id):
                    dep_id = dep_id.upper()
                    try:
                        n = int(dep_id.split("-")[-1])
                        project["dependencySeq"] = max(project.get("dependencySeq", 100), n)
                    except ValueError:
                        pass
                else:
                    dep_id = next_dependency_id(project)
                dep = {"id": dep_id, "resolved": False}
                project.setdefault("dependencies", []).append(dep)

            dep["text"] = text
            if i < len(team_lines):
                dep["team"] = team_lines[i]
            elif "team" not in dep:
                dep["team"] = ""
            if i < len(mit_lines):
                dep["mitigation"] = mit_lines[i]
            elif "mitigation" not in dep:
                dep["mitigation"] = ""
            if i < len(due_lines):
                raw_due = due_lines[i]
                dep["dueBy"] = raw_due if is_valid_iso_date(raw_due) else ""
            elif "dueBy" not in dep:
                dep["dueBy"] = ""
            if i < len(pri_lines):
                dep["priority"] = normalize_priority(pri_lines[i])
            elif "priority" not in dep:
                dep["priority"] = "Medium"
            if i < len(esc_lines):
                dep["escalated"] = parse_yes_no(esc_lines[i])
            elif "escalated" not in dep:
                dep["escalated"] = False

            dep["resolved"] = resolved_flag
            if not resolved_flag:
                new_open.append(dep)
                seen_ids.add(dep_id)
            else:
                dep["resolved"] = True

        for dep in old_open:
            dep_id = dep.get("id")
            if dep_id and dep_id not in seen_ids:
                dep["resolved"] = True

        return

    # Partial field updates (same order as open dependencies) when the list
    # itself wasn't re-submitted — preserves the old per-field overwrite behavior.
    open_deps = open_dependencies(project)
    if not open_deps:
        return

    team_lines = lines(fields.get("Dependency owning team(s)", ""))
    if team_lines:
        for i, team in enumerate(team_lines):
            if i < len(open_deps):
                open_deps[i]["team"] = team

    mit_lines = lines(fields.get("Dependency mitigation plan / impact", ""))
    if mit_lines:
        for i, mit in enumerate(mit_lines):
            if i < len(open_deps):
                open_deps[i]["mitigation"] = mit

    due_lines = lines(fields.get("Dependency needed by (date)", ""))
    if due_lines:
        for i, raw_due in enumerate(due_lines):
            if i < len(open_deps):
                open_deps[i]["dueBy"] = raw_due if is_valid_iso_date(raw_due) else ""

    pri_lines = lines(fields.get("Dependency priority", ""))
    if pri_lines:
        for i, pri in enumerate(pri_lines):
            if i < len(open_deps):
                open_deps[i]["priority"] = normalize_priority(pri)

    esc_lines = lines(fields.get("Dependency escalated to leadership?", ""))
    if esc_lines:
        for i, esc in enumerate(esc_lines):
            if i < len(open_deps):
                open_deps[i]["escalated"] = parse_yes_no(esc)

    res_lines = lines(fields.get("Dependency resolved?", ""))
    if res_lines:
        for i, res in enumerate(res_lines):
            if i < len(open_deps):
                open_deps[i]["resolved"] = parse_yes_no(res)


def is_none_risk_text(text):
    return not text or re.match(
        r"^(none|no risk|no risks|no blocker|no blockers)$",
        (text or "").strip(),
        re.I,
    )


def parse_risk_line(line):
    """Optional 'RISK-101 | description' prefix so PMs can tie a row to a stable id."""
    m = RISK_ID_PREFIX_RE.match((line or "").strip())
    if m:
        return m.group(1).upper(), m.group(2).strip()
    return None, (line or "").strip()


def next_risk_id(project):
    seq = project.get("riskSeq", 100)
    seq += 1
    project["riskSeq"] = seq
    return f"RISK-{seq}"


def infer_risk_seq(project):
    """Set riskSeq from existing RISK-* ids when missing."""
    if "riskSeq" in project:
        return
    max_num = 100
    for risk in project.get("risks") or []:
        if isinstance(risk, dict):
            risk_id = risk.get("id") or ""
            if risk_id.upper().startswith("RISK-"):
                try:
                    max_num = max(max_num, int(risk_id.split("-")[-1]))
                except ValueError:
                    pass
    project["riskSeq"] = max_num


def migrate_project_risks(project):
    """Upgrade parallel-array risk fields to a single id-based object array."""
    risks = project.get("risks")
    mitigations = project.get("riskMitigations") or []

    if isinstance(risks, list) and risks and isinstance(risks[0], dict):
        infer_risk_seq(project)
        project.pop("riskMitigations", None)
        return False

    if isinstance(risks, list) and not risks and not mitigations:
        infer_risk_seq(project)
        project.pop("riskMitigations", None)
        return False

    texts = risks if isinstance(risks, list) else []
    seq = project.get("riskSeq", 100)
    new_risks = []
    max_len = max(len(texts), len(mitigations), 0)
    for i in range(max_len):
        text = texts[i] if i < len(texts) else ""
        if is_none_risk_text(text):
            continue
        seq += 1
        new_risks.append({
            "id": f"RISK-{seq}",
            "text": text,
            "mitigation": mitigations[i] if i < len(mitigations) else "",
            "resolved": False,
        })

    project["risks"] = new_risks
    project["riskSeq"] = seq
    project.pop("riskMitigations", None)
    return True


def open_risks(project):
    return [
        r for r in project.get("risks") or []
        if isinstance(r, dict) and not r.get("resolved")
    ]


def find_risk_by_id(project, risk_id):
    if not risk_id:
        return None
    target = risk_id.upper()
    for risk in project.get("risks") or []:
        if isinstance(risk, dict) and (risk.get("id") or "").upper() == target:
            return risk
    return None


def apply_weekly_risk_fields(project, fields):
    """Merge weekly-form risk textareas into id-based risk objects."""
    migrate_project_risks(project)

    risks_raw = fields.get("Risks / blockers", "")
    if risks_raw:
        risk_lines = lines(risks_raw)
        mit_lines = lines(fields.get("Risk mitigation plan", ""))

        old_open = open_risks(project)
        old_open_by_id = {r["id"]: r for r in old_open if r.get("id")}
        seen_ids = set()

        for i, line in enumerate(risk_lines):
            if is_none_risk_text(line):
                continue
            risk_id, text = parse_risk_line(line)

            risk = None
            if risk_id and risk_id in old_open_by_id:
                risk = old_open_by_id[risk_id]
            elif i < len(old_open):
                risk = old_open[i]

            if risk:
                risk_id = risk.get("id") or next_risk_id(project)
                risk["id"] = risk_id
            else:
                if risk_id and not find_risk_by_id(project, risk_id):
                    risk_id = risk_id.upper()
                    try:
                        n = int(risk_id.split("-")[-1])
                        project["riskSeq"] = max(project.get("riskSeq", 100), n)
                    except ValueError:
                        pass
                else:
                    risk_id = next_risk_id(project)
                risk = {"id": risk_id, "resolved": False}
                project.setdefault("risks", []).append(risk)

            risk["text"] = text
            if i < len(mit_lines):
                risk["mitigation"] = mit_lines[i]
            elif "mitigation" not in risk:
                risk["mitigation"] = ""
            risk["resolved"] = False
            seen_ids.add(risk_id)

        for risk in old_open:
            risk_id = risk.get("id")
            if risk_id and risk_id not in seen_ids:
                risk["resolved"] = True

        return

    open_risk_list = open_risks(project)
    if not open_risk_list:
        return

    mit_lines = lines(fields.get("Risk mitigation plan", ""))
    if mit_lines:
        for i, mit in enumerate(mit_lines):
            if i < len(open_risk_list):
                open_risk_list[i]["mitigation"] = mit


def apply_new_risk(data, fields):
    project_name = fields.get("Project", "").strip()
    project_id = PROJECT_NAME_TO_ID.get(project_name)
    if not project_id:
        return False, f"unrecognized project '{project_name}'"

    by_id = {p["id"]: p for p in data["projects"]}
    project = by_id.get(project_id)
    if not project:
        return False, f"no project with id '{project_id}' in data.json"

    migrate_project_risks(project)

    text = fields.get("Risk description", "").strip()
    if not text:
        return False, "missing risk description"

    mitigation = fields.get("Mitigation plan", "").strip()

    risk_id = next_risk_id(project)
    project.setdefault("risks", []).append({
        "id": risk_id,
        "text": text,
        "mitigation": mitigation,
        "resolved": False,
    })
    return True, f"added {risk_id} to '{project_id}'"


def ingest_new_risks(data):
    issues = fetch_issues("new-risk")
    if not issues:
        return []

    ingested = []
    for issue in issues:
        fields = parse_issue_form_body(issue["body"] or "")
        ok, msg = apply_new_risk(data, fields)
        if ok:
            ingested.append(issue["number"])
            print(f"issue #{issue['number']}: {msg}")
        else:
            print(f"issue #{issue['number']}: {msg}, skipping")

    return ingested


def apply_new_dependency(data, fields):
    project_name = fields.get("Project", "").strip()
    project_id = PROJECT_NAME_TO_ID.get(project_name)
    if not project_id:
        return False, f"unrecognized project '{project_name}'"

    by_id = {p["id"]: p for p in data["projects"]}
    project = by_id.get(project_id)
    if not project:
        return False, f"no project with id '{project_id}' in data.json"

    migrate_project_dependencies(project)

    text = fields.get("Dependency description", "").strip()
    if not text:
        return False, "missing dependency description"

    team = fields.get("Owning team(s)", "").strip()
    if not team:
        return False, "missing owning team(s)"

    due_raw = fields.get("Needed by date", "").strip()
    due_by = due_raw if is_valid_iso_date(due_raw) else ""
    if due_raw and not due_by:
        print(f"warning: invalid needed-by date {due_raw!r}, storing as empty", file=sys.stderr)

    priority = normalize_priority(fields.get("Priority", ""))
    mitigation = fields.get("Mitigation plan", "").strip()
    escalated = parse_yes_no(fields.get("Escalated to leadership already?", ""))

    dep_id = next_dependency_id(project)
    project.setdefault("dependencies", []).append({
        "id": dep_id,
        "text": text,
        "team": team,
        "mitigation": mitigation,
        "dueBy": due_by,
        "priority": priority,
        "escalated": escalated,
        "resolved": False,
    })
    return True, f"added {dep_id} to '{project_id}'"


def ingest_new_dependencies(data):
    issues = fetch_issues("new-dependency")
    if not issues:
        return []

    ingested = []
    for issue in issues:
        fields = parse_issue_form_body(issue["body"] or "")
        ok, msg = apply_new_dependency(data, fields)
        if ok:
            ingested.append(issue["number"])
            print(f"issue #{issue['number']}: {msg}")
        else:
            print(f"issue #{issue['number']}: {msg}, skipping")

    return ingested


def apply_dependency_update(data, fields):
    """Update, escalate, or resolve ONE existing dependency by id — does not
    require listing every other open dependency (unlike the weekly-update
    form's bulk dependency fields)."""
    project_name = fields.get("Project", "").strip()
    project_id = PROJECT_NAME_TO_ID.get(project_name)
    if not project_id:
        return False, f"unrecognized project '{project_name}'"

    by_id = {p["id"]: p for p in data["projects"]}
    project = by_id.get(project_id)
    if not project:
        return False, f"no project with id '{project_id}' in data.json"

    migrate_project_dependencies(project)

    dep_id = fields.get("Dependency ID", "").strip().upper()
    if not dep_id:
        return False, "missing dependency ID"

    deps = project.get("dependencies") or []
    dep = next((d for d in deps if (d.get("id") or "").upper() == dep_id), None)
    if not dep:
        return False, f"no dependency '{dep_id}' found on '{project_id}'"

    changes = []

    new_text = fields.get("Updated description", "").strip()
    if new_text:
        dep["text"] = new_text
        changes.append("description")

    new_team = fields.get("Updated owning team(s)", "").strip()
    if new_team:
        dep["team"] = new_team
        changes.append("team")

    new_mitigation = fields.get("Updated mitigation plan", "").strip()
    if new_mitigation:
        dep["mitigation"] = new_mitigation
        changes.append("mitigation")

    new_due_raw = fields.get("Updated needed-by date", "").strip()
    if new_due_raw:
        if is_valid_iso_date(new_due_raw):
            dep["dueBy"] = new_due_raw
            changes.append("due date")
        else:
            print(f"warning: invalid updated due date {new_due_raw!r} on {dep_id}, ignoring", file=sys.stderr)

    new_priority = fields.get("Updated priority", "No change").strip()
    if new_priority and new_priority != "No change":
        dep["priority"] = normalize_priority(new_priority)
        changes.append("priority")

    mark_resolved = fields.get("Resolve this dependency?", "No change").strip()
    if mark_resolved == "Yes — resolved":
        dep["resolved"] = True
        changes.append("resolved")

    mark_escalated = fields.get("Escalated to leadership?", "No change").strip()
    if mark_escalated == "Yes — escalate":
        dep["escalated"] = True
        changes.append("escalated")
    elif mark_escalated == "No — un-escalate":
        dep["escalated"] = False
        changes.append("un-escalated")

    if not changes:
        return False, f"no changes specified for {dep_id} on '{project_id}'"

    return True, f"updated {dep_id} on '{project_id}' ({', '.join(changes)})"


def ingest_dependency_updates(data):
    issues = fetch_issues("update-dependency")
    if not issues:
        return []

    ingested = []
    for issue in issues:
        fields = parse_issue_form_body(issue["body"] or "")
        ok, msg = apply_dependency_update(data, fields)
        if ok:
            ingested.append(issue["number"])
            print(f"issue #{issue['number']}: {msg}")
        else:
            print(f"issue #{issue['number']}: {msg}, skipping")

    return ingested


def ensure_all_projects_migrated(data):
    changed = False
    for project in data.get("projects", []):
        if migrate_project_dependencies(project):
            changed = True
        else:
            infer_dependency_seq(project)
        if migrate_project_risks(project):
            changed = True
        else:
            infer_risk_seq(project)
    return changed


def is_valid_iso_date(value):
    """Format AND calendar validity — catches typos like '2026-19-12'
    (month 19) that DATE_RE alone would let through (see the GMS 1.4
    goLive incident from issue #6)."""
    if not DATE_RE.match(value or ""):
        return False
    try:
        datetime.date.fromisoformat(value)
        return True
    except ValueError:
        return False


def has_label(issue, name):
    return any((l.get("name") or "").lower() == name.lower() for l in issue.get("labels", []))


def apply_weekly_update(project, fields):
    """Mutate `project` in place with any non-empty fields from the issue."""
    def set_if_present(key, source_key, transform=str):
        value = fields.get(source_key, "")
        if value:
            project[key] = transform(value)

    set_if_present("owner", "PM name")
    set_if_present("stage", "Pipeline stage")

    # Per-stage planned dates — keyed by the CURRENT stage (post the
    # set_if_present("stage", ...) call above, so a stage change this same
    # week keys against the NEW stage). First value recorded for a given
    # stage becomes its locked baseline (initialStart/initialEnd), exactly
    # like originalGoLive; later submissions move latestStart/latestEnd,
    # which the dashboard's stage detail view diffs across history.json
    # snapshots to build a revision log.
    current_stage = project.get("stage", "")
    stage_start = fields.get("Current stage — planned start date", "")
    stage_end = fields.get("Current stage — planned completion date", "")
    if current_stage and (stage_start or stage_end):
        stage_plan = project.get("stagePlan") or {}
        entry = stage_plan.get(current_stage) or {}
        if stage_start and is_valid_iso_date(stage_start):
            if not entry.get("initialStart"):
                entry["initialStart"] = stage_start
            entry["latestStart"] = stage_start
        if stage_end and is_valid_iso_date(stage_end):
            if not entry.get("initialEnd"):
                entry["initialEnd"] = stage_end
            entry["latestEnd"] = stage_end
        stage_plan[current_stage] = entry
        project["stagePlan"] = stage_plan

    # Delay log entries — append-only (unlike most fields, which are
    # wholesale-replaced on submit). Format per line: "date | reason | team |
    # person | days". Malformed lines are skipped with a warning rather than
    # failing the whole ingest run.
    delay_log_raw = fields.get("Delay log entries (this week)", "")
    if delay_log_raw and current_stage:
        delay_log = project.get("delayLog") or []
        seq = project.get("delayLogSeq", 100)
        for line in lines(delay_log_raw):
            parts = [p.strip() for p in line.split("|")]
            if len(parts) != 5:
                print(f"warning: skipping malformed delay log line (expected 5 '|'-separated fields): {line!r}", file=sys.stderr)
                continue
            date, reason, team, member, days_raw = parts
            if not is_valid_iso_date(date):
                print(f"warning: skipping delay log line with invalid date: {line!r}", file=sys.stderr)
                continue
            seq += 1
            delay_log.append({
                "id": f"DL-{seq}",
                "date": date,
                "stage": current_stage,
                "reason": reason,
                "team": team,
                "member": member,
                "days": to_int(days_raw, 0),
            })
        project["delayLog"] = delay_log
        project["delayLogSeq"] = seq

    set_if_present("phase", "Current phase")
    set_if_present("delayNote", "Delay note")
    set_if_present("delayImpact", "Impact of delay")

    delay_mitigation = fields.get("Mitigation steps taken", "")
    if delay_mitigation:
        project["delayMitigation"] = lines(delay_mitigation)

    delay_tradeoffs = fields.get("Trade-off conversations", "")
    if delay_tradeoffs:
        project["delayTradeoffs"] = delay_tradeoffs.strip()

    time_saved_days = fields.get("Time saved this week (days)", "")
    if time_saved_days:
        project["timeSavedDays"] = to_int(time_saved_days, project.get("timeSavedDays", 0))

    time_saved_note = fields.get("What did the team do to save that time?", "")
    if time_saved_note:
        project["timeSavedNote"] = lines(time_saved_note)

    scope_reduced = fields.get("Reducing scope to hold the date?", "")
    if scope_reduced:
        project["scopeReduced"] = scope_reduced.strip().lower() == "yes"

    status = fields.get("Overall status", "")
    if status:
        key = STATUS_TEXT_TO_KEY.get(status.strip().lower())
        if key:
            project["status"] = key

    progress = fields.get("Progress (0-100)", "")
    if progress:
        project["progress"] = max(0, min(100, to_int(progress, project.get("progress", 0))))

    delay_days = fields.get("Delay (days)", "")
    if delay_days:
        project["delayDays"] = to_int(delay_days, project.get("delayDays", 0))

    milestone_name = fields.get("Next milestone name", "")
    milestone_date = fields.get("Next milestone date", "")
    if milestone_name or milestone_date:
        nm = project.get("nextMilestone") or {}
        if milestone_name:
            nm["name"] = milestone_name
        if milestone_date:
            nm["date"] = milestone_date
        project["nextMilestone"] = nm

    go_live = fields.get("Go-live date", "")
    # Validate before writing — a typo like "2026-19-12" (month 19, hit for
    # real in issue #6) would otherwise silently corrupt goLive and break
    # every date-based view (Hawk-eye, Grid, delay math). Invalid input is
    # just skipped, same as leaving the field blank, rather than written.
    if go_live and is_valid_iso_date(go_live):
        # First time a go-live date is recorded for this project, lock it in as
        # the baseline. Later updates move `goLive` but `originalGoLive` stays
        # put so the dashboard can show how far the date has slipped.
        if not project.get("originalGoLive"):
            project["originalGoLive"] = go_live
        project["goLive"] = go_live

    dep_field_labels = (
        "Dependencies",
        "Dependency owning team(s)",
        "Dependency mitigation plan / impact",
        "Dependency needed by (date)",
        "Dependency priority",
        "Dependency escalated to leadership?",
        "Dependency resolved?",
    )
    if any(fields.get(label) for label in dep_field_labels):
        apply_weekly_dependency_fields(project, fields)

    sprint = project.get("sprintStatus") or {"completed": [], "inProgress": [], "nextPlan": []}
    completed = fields.get("Completed this week", "")
    in_progress = fields.get("In progress", "")
    next_plan = fields.get("Next plan", "")
    if completed:
        sprint["completed"] = lines(completed)
    if in_progress:
        sprint["inProgress"] = lines(in_progress)
    if next_plan:
        sprint["nextPlan"] = lines(next_plan)
    project["sprintStatus"] = sprint

    risk_field_labels = ("Risks / blockers", "Risk mitigation plan")
    if any(fields.get(label) for label in risk_field_labels):
        apply_weekly_risk_fields(project, fields)

    fast_follow = fields.get("Fast-follow items (planned or remaining)", "")
    if fast_follow:
        project["fastFollowItems"] = lines(fast_follow)

    # Unlike most fields (blank = "unchanged"), escalations are inherently
    # this-week's-news: if the PM leaves it blank they mean "nothing to
    # escalate this week", so we clear it rather than carrying last week's
    # escalation forward forever. Only skip entirely if the field wasn't
    # part of the submitted form at all (old issues from before this field
    # existed).
    if "Escalations to leadership this week" in fields:
        project["escalations"] = lines(fields.get("Escalations to leadership this week", ""))


def ingest_weekly_updates(data):
    issues = fetch_issues("weekly-update")
    if not issues:
        return [], None, []

    by_id = {p["id"]: p for p in data["projects"]}
    ingested = []
    blocked = []
    latest_as_of = data.get("asOf")

    for issue in issues:
        fields = parse_issue_form_body(issue["body"] or "")
        project_name = fields.get("Project", "").strip()
        project_id = PROJECT_NAME_TO_ID.get(project_name)
        as_of = fields.get("As of date", "").strip()

        if not project_id or project_id not in by_id:
            print(f"issue #{issue['number']}: unrecognized project '{project_name}', skipping")
            continue
        if not as_of:
            print(f"issue #{issue['number']}: missing 'As of date', skipping")
            continue

        project = by_id[project_id]
        prev_status = project.get("status")
        status_text = fields.get("Overall status", "").strip().lower()
        new_status = STATUS_TEXT_TO_KEY.get(status_text) if status_text else None
        reason = fields.get("Reason for status change", "").strip()
        status_changed = bool(new_status) and bool(prev_status) and new_status != prev_status
        worsened = status_changed and STATUS_RANK.get(new_status, 0) > STATUS_RANK.get(prev_status, 0)

        if worsened and not reason:
            if not has_label(issue, NEEDS_REASON_LABEL):
                comment = (
                    f"⚠️ This update moves **{project['name']}** from **{STATUS_LABEL.get(prev_status, prev_status)}** "
                    f"to **{STATUS_LABEL.get(new_status, new_status)}**, but the **'Reason for status change'** field "
                    "is blank. Please edit this issue and add the reason (what changed / root cause) — that's required "
                    "any time a project moves to a worse status, so leadership can see why along with the date. "
                    "This issue will stay open and get picked up automatically on the next run once the reason is added."
                )
                try:
                    run_gh(["issue", "comment", str(issue["number"]), "--body", comment])
                    run_gh(["issue", "edit", str(issue["number"]), "--add-label", NEEDS_REASON_LABEL])
                except RuntimeError as e:
                    print(f"warning: could not flag issue #{issue['number']}: {e}", file=sys.stderr)
            blocked.append(issue["number"])
            print(f"issue #{issue['number']}: blocked — status worsened with no reason given, left open")
            continue

        apply_weekly_update(project, fields)
        project["statusChangeReason"] = reason if status_changed else ""

        if has_label(issue, NEEDS_REASON_LABEL):
            try:
                run_gh(["issue", "edit", str(issue["number"]), "--remove-label", NEEDS_REASON_LABEL])
            except RuntimeError as e:
                print(f"warning: could not unlabel issue #{issue['number']}: {e}", file=sys.stderr)

        if latest_as_of is None or as_of >= latest_as_of:
            latest_as_of = as_of

        ingested.append(issue["number"])
        print(f"issue #{issue['number']}: merged into '{project_id}' (as of {as_of})")

    if latest_as_of and latest_as_of != data.get("asOf"):
        data["asOf"] = latest_as_of

    return ingested, latest_as_of, blocked


def ingest_feedback(notes):
    issues = fetch_issues("feedback")
    if not issues:
        return []

    ingested = []
    existing_ids = {n["id"] for n in notes}
    next_id = 1 + max([0] + [int(n["id"].split("-")[-1]) for n in notes if n["id"].startswith("note-")])

    for issue in issues:
        fields = parse_issue_form_body(issue["body"] or "")
        project_name = fields.get("Project", "").strip()
        project_id = PROJECT_NAME_TO_ID.get(project_name)
        note_text = fields.get("Feedback / ask", "").strip()
        mitigation_impact = fields.get("Mitigation plan / impact (if this is a risk or dependency)", "").strip()
        raised_by = fields.get("Raised by", "").strip() or (issue.get("author") or {}).get("login", "unknown")

        if not project_id or not note_text:
            print(f"issue #{issue['number']}: missing project or note text, skipping")
            continue

        note_id = f"note-{next_id}"
        next_id += 1
        notes.append({
            "id": note_id,
            "projectId": project_id,
            "text": note_text,
            "mitigationImpact": mitigation_impact,
            "raisedBy": raised_by,
            "createdAt": issue.get("createdAt"),
            "sourceIssue": issue.get("url"),
            "status": "open",
        })
        ingested.append(issue["number"])
        print(f"issue #{issue['number']}: logged feedback for '{project_id}'")

    return ingested


def ingest_resolutions(notes):
    """Pick up 'resolve-feedback' issues (opened via the dashboard's "✓ Resolve"
    link) and flip the matching note's status to "resolved" in place. The note
    is never removed — it stays in notes.json and git history, just no longer
    counts as "open"."""
    issues = fetch_issues("resolve-feedback")
    if not issues:
        return []

    by_id = {n["id"]: n for n in notes}
    ingested = []

    for issue in issues:
        fields = parse_issue_form_body(issue["body"] or "")
        note_id = fields.get("Note ID", "").strip()
        resolution = fields.get("How was this resolved?", "").strip()
        resolved_by = (issue.get("author") or {}).get("login", "unknown")

        note = by_id.get(note_id)
        if not note:
            print(f"issue #{issue['number']}: no note with id '{note_id}' found, closing anyway")
            ingested.append(issue["number"])
            continue

        if note["status"] != "resolved":
            note["status"] = "resolved"
            note["resolvedAt"] = issue.get("createdAt")
            note["resolvedBy"] = resolved_by
            note["resolutionNote"] = resolution
            note["resolvedVia"] = issue.get("url")
            print(f"issue #{issue['number']}: resolved '{note_id}'")
        else:
            print(f"issue #{issue['number']}: '{note_id}' was already resolved, closing anyway")

        ingested.append(issue["number"])

    return ingested


def close_issues(numbers, comment):
    for n in numbers:
        try:
            run_gh(["issue", "comment", str(n), "--body", comment])
            run_gh(["issue", "close", str(n)])
        except RuntimeError as e:
            print(f"warning: could not close issue #{n}: {e}", file=sys.stderr)


def snapshot_history(data, history):
    as_of = data.get("asOf")
    if not as_of:
        return
    history[as_of] = {
        "capturedAt": datetime.datetime.utcnow().isoformat() + "Z",
        "projects": [
            {
                "id": p["id"],
                "name": p["name"],
                "status": p["status"],
                "progress": p["progress"],
                "stage": p.get("stage", ""),
                "delayDays": p.get("delayDays", 0),
                "delayNote": p.get("delayNote", ""),
                "statusChangeReason": p.get("statusChangeReason", ""),
                "phase": p.get("phase", ""),
                "nextMilestone": p.get("nextMilestone"),
                "goLive": p.get("goLive"),
                "originalGoLive": p.get("originalGoLive"),
                "delayImpact": p.get("delayImpact", ""),
                "delayMitigation": p.get("delayMitigation", []),
                "delayTradeoffs": p.get("delayTradeoffs", ""),
                "timeSavedDays": p.get("timeSavedDays", 0),
                "timeSavedNote": p.get("timeSavedNote", []),
                "scopeReduced": p.get("scopeReduced", False),
                "risks": p.get("risks", []),
                "fastFollowItems": p.get("fastFollowItems", []),
                "escalations": p.get("escalations", []),
                "dependencies": p.get("dependencies", []),
                "stagePlan": p.get("stagePlan", {}),
                "sprintStatus": p.get("sprintStatus", {"completed": [], "inProgress": [], "nextPlan": []}),
            }
            for p in data["projects"]
        ],
    }


def main():
    data = load_json(DATA_PATH, {"asOf": None, "lastUpdated": None, "projects": []})
    history = load_json(HISTORY_PATH, {})
    notes = load_json(NOTES_PATH, [])

    migrated = ensure_all_projects_migrated(data)

    update_issue_numbers, as_of_changed, blocked_issue_numbers = ingest_weekly_updates(data)
    new_dep_issue_numbers = ingest_new_dependencies(data)
    dep_update_issue_numbers = ingest_dependency_updates(data)
    new_risk_issue_numbers = ingest_new_risks(data)
    feedback_issue_numbers = ingest_feedback(notes)
    resolve_issue_numbers = ingest_resolutions(notes)
    if blocked_issue_numbers:
        print(f"note: {len(blocked_issue_numbers)} issue(s) left open pending a reason for status change: {blocked_issue_numbers}")

    if (
        migrated
        or update_issue_numbers
        or new_dep_issue_numbers
        or dep_update_issue_numbers
        or new_risk_issue_numbers
        or feedback_issue_numbers
        or resolve_issue_numbers
    ):
        data["lastUpdated"] = datetime.datetime.utcnow().isoformat() + "Z"
        snapshot_history(data, history)

        save_json(DATA_PATH, data)
        save_json(HISTORY_PATH, history)
        save_json(NOTES_PATH, notes)

        close_issues(
            update_issue_numbers,
            "✅ Merged into `data.json` — thanks! This will show up on the dashboard shortly.",
        )
        close_issues(
            new_dep_issue_numbers,
            "✅ Dependency logged in `data.json` — it'll show on the Dependencies tab shortly.",
        )
        close_issues(
            dep_update_issue_numbers,
            "✅ Dependency updated in `data.json` — the change will show up on the dashboard shortly.",
        )
        close_issues(
            new_risk_issue_numbers,
            "✅ Risk logged in `data.json` — it'll show on the project detail view shortly.",
        )
        close_issues(
            feedback_issue_numbers,
            "✅ Logged as an open follow-up — it'll show on the dashboard and the PM will be "
            "reminded next time they submit a weekly update for this project.",
        )
        close_issues(
            resolve_issue_numbers,
            "✅ Marked resolved — it'll drop off the open follow-ups list but stays in the "
            "feedback history (and in git) for the record.",
        )
        print("done: data updated, issues closed")
    else:
        print("done: nothing to ingest")


if __name__ == "__main__":
    main()
