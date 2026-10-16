# pm-weekly-update: field reference

Source of truth: `.github/ISSUE_TEMPLATE/weekly-update.yml` (core fields) and
`README.md`'s "Data model" section (extended fields). If either changes,
update this file to match — don't let it drift.

## Known projects (`"Project"` must be exactly one of these)

WebNext, WebNext 2.0, Pledge – 1.0, Pledge - 1.x, EMM, MyBKY (Phase 1),
myBKY 2A, myMandir 1B, myMandir 1C, GMS 1.4, SSO V2, SPM, BKMS, MIS,
mySatsang – BAPS ID Integration

(Note the en-dashes in "Pledge – 1.0" and "mySatsang – BAPS ID Integration"
— not hyphens. Copy exactly, don't retype.)

## Core fields (`fields.json` keys — exact labels, case-sensitive)

| Label | Required? | Notes |
|---|---|---|
| `Project` | always | must match the list above exactly |
| `PM name` | always | |
| `As of date` | always | `YYYY-MM-DD` |
| `Overall status` | always | `Green` \| `Amber` \| `Red` \| `Non-Recoverable` |
| `Reason for status change` | only if status got worse than last week | script exits 2 if missing when required |
| `Progress (0-100)` | always | |
| `Pipeline stage` | only if changed | one of: Proposal, Requirements, Tech. Design, Estimate & Planning, Development, UAT, VAPT, Rollout, Hypercare |
| `Current stage — planned start date` | only with a stage change / new baseline | `YYYY-MM-DD` |
| `Current stage — planned completion date` | same as above | `YYYY-MM-DD` |
| `Delay log entries (this week)` | optional | one per line: `date \| reason \| team \| person \| days` |
| `Current phase` | optional | free text, e.g. "Regression / Perf / UAT" |
| `Next milestone name` | optional | |
| `Next milestone date` | optional | `YYYY-MM-DD` |
| `Go-live date` | optional | `YYYY-MM-DD` |
| `Delay (days)` | always | `0` if on schedule — never leave blank |
| `Delay note` | only if delay > 0 | |
| `Impact of delay` | required if delay > 0 | |
| `Mitigation steps taken` | required if delay > 0 | one per line |
| `Trade-off conversations` | optional | |
| `Time saved this week (days)` | optional | |
| `What did the team do to save that time?` | required if time saved > 0 | one per line |
| `Reducing scope to hold the date?` | optional | `Yes` \| `No` |
| `Dependencies` | optional | one per line, same order as the 5 fields below; omitting a previously-open one marks it resolved; prefix `DEP-101 \|` to pin an id |
| `Dependency owning team(s)` | required if any dependency listed | one per line, same order |
| `Dependency mitigation plan / impact` | required if any dependency listed | one per line, same order |
| `Dependency needed by (date)` | optional | one per line, same order, `YYYY-MM-DD` or `-` |
| `Dependency priority` | optional | one per line, same order — `Critical`\|`High`\|`Medium`\|`Low` |
| `Dependency escalated to leadership?` | optional | one per line, same order — `Yes`\|`No` |
| `Dependency resolved?` | optional | one per line, same order — `Yes`\|`No` (or just omit the line) |
| `Completed this week` | always | one per line |
| `In progress` | always | one per line |
| `Next plan` | always | one per line |
| `Risks / blockers` | optional | one per line, same order as `Risk mitigation plan` |
| `Risk mitigation plan` | required if any risk listed | one per line, same order |
| `Fast-follow items (planned or remaining)` | optional | one per line |
| `Escalations to leadership this week` | optional | one per line; blank clears last week's list |

## Extended fields (no issue-form equivalent — direct-write only)

Each is a JSON array under its own top-level `fields.json` key. Include
`"id"` on an object to update an EXISTING entry in place (merge, not
replace other keys); omit `"id"` to append a new one (the script mints
`CR-*` / `DEC-*` / `RAID-*` / `DL-ITEM-*` ids automatically).

### `ChangeRequests` → `data.json`'s `changeRequests`
```json
{
  "id": "CR-104",                 // omit for a new CR
  "title": "Rooming Validation Enhancements",
  "description": "...",
  "submittedDate": "2026-06-09",
  "by": "Aksharbhai",
  "actionItem": "Review requirements, assess effort, obtain CR approval",
  "approvalStatus": "Approved for current phase",  // free text; "approved"/"pending"/"tbd" (substring, case-insensitive) drives badge color
  "impact": "Go-Live date impacted by 10 days"
}
```

### `Decisions` → `decisions`
```json
{ "id": "DEC-6", "decision": "Go-Live Date Extension by 1 Month", "description": "...", "dateTaken": "2026-04-09", "by": "Aksharbhai Patel" }
```

### `GoLiveChecklist` → `goLiveChecklist` (upserted by `"item"`, not `"id"`)
Only list items that moved off "Not started" — the fixed 7-item list
(SIT, Regression, UAT, Cyber Security, Performance, Change Management,
RGC Approval) defaults anything unlisted to "Not started."
```json
{ "item": "System Integration Testing (SIT)", "status": "Complete", "notes": "" }
```
`status`: `"Not started"` | `"In progress"` | `"Complete"`

### `RaidLog` → `raidLog`
```json
{
  "id": "RAID-12",
  "type": "Issue",                // "Risk" | "Assumption" | "Issue" | "Dependency"
  "item": "QA tasks delayed",
  "description": "...",
  "reportedDate": "2026-03-24",
  "actionItem": "...",
  "targetedCompletionDate": "2026-04-03",
  "responsible": "Nimeshbhai / Kishanbhai",
  "status": "Open",               // free text; "closed"/"resolved" (case-insensitive) renders green
  "closureRemarks": ""
}
```

### `Features` → `features` (upserted by `("sprint", "feature")` composite key)
```json
{
  "sprint": 1,
  "type": "Web",                  // free text, e.g. "Web", "Mobile", "Web/Mob."
  "feature": "Login & Profile Management",
  "status": "Done",               // "Done" | "In Progress" | "Partially Done" | "Excluded" | "Blocked" | "Upcoming"
  "notes": "...",
  "plannedDate": "2026-04-20",
  "actualDate": "2026-04-24",
  "delayReason": "Design delay (4 days)"
}
```

### `Milestones` → `milestones` (upserted by `"name"`)
```json
{ "name": "Requirements sign-off", "date": "2026-08-01", "status": "green" }
```
`status`: `"green"` | `"amber"` | `"red"` | `"black"` (same vocabulary as a project's own `status`)

### `DelayItemLog` → `delayItemLog`
Narrative delay log — NOT the same as the stage detail view's
`Delay log entries (this week)` core field above (that's `delayLog`,
a different, auto-growing array keyed to a specific pipeline stage).
```json
{
  "id": "DL-ITEM-7",
  "delayedItem": "Web UI/UX Readiness",
  "description": "...",
  "reportedDate": "2026-03-26",
  "impactedPhase": "Development",
  "impact": "Lost 3 weeks",
  "rootCause": "Vendor onboarding delays",
  "responsible": "Satish Buddhadev",
  "actionItem": "Cancel vendor contract",
  "actionTaken": "Proceeded with internal design team",
  "status": "Closed",             // free text; "closed"/"resolved" (case-insensitive) renders green
  "closureRemarks": "Go-Live date extended from 07/31 to 08/28/2026"
}
```

## Example end-to-end `fields.json`

```json
{
  "Project": "SPM",
  "PM name": "Sandeep Pistolwala",
  "As of date": "2026-10-23",
  "Overall status": "Green",
  "Progress (0-100)": "100",
  "Delay (days)": "0",
  "Completed this week": "Hypercare monitoring continued",
  "In progress": "No work",
  "Next plan": "No work",
  "ChangeRequests": [
    { "id": "CR-101", "approvalStatus": "Approved for current phase" }
  ]
}
```

## Running the script

```bash
python3 scripts/apply_weekly_update_direct.py --fields /tmp/fields.json --dry-run
python3 scripts/apply_weekly_update_direct.py --fields /tmp/fields.json
```

Exit codes: `0` = applied (or dry-run OK), `1` = unknown project / missing
`As of date`, `2` = status downgraded without a reason (fix and retry).
