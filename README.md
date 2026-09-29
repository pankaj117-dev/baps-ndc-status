# BAPS NDC · Program Status

A single-page status dashboard for the BAPS NDC project portfolio, replacing the
weekly slide-deck review. Built as a static site — no backend, no build step —
so any PM can update it by editing one JSON file and pushing.

**Live site:** `https://pankaj117.github.io/baps-ndc-status/` (enabled via GitHub Pages on the `main` branch)

## Global filter bar

A **"🔎 Project" dropdown** sits right under the tab bar, visible on every
tab, next to a **"PM" dropdown** and a **"Team" dropdown**. Pick any
combination and Program Status, Grid, Hawk-eye, Status History, and
Dependencies (which includes the escalations rollup) all narrow down to match (the
metrics row recomputes for the filtered set too). Clear any one with its
✕ button to see everything again. These global filters replace the old
per-tab Team/Status/PM filter rows — one filter bar, same effect everywhere.

- **Project / PM** — the usual "just show me one project" / "just show me
  one PM's projects" filters.
- **Team** — filters to projects that have a dependency owned by another
  team (DevOps, BAPS ID Team, SSO Team, etc. — populated from whatever's
  actually been entered on each open dependency's `team` field, see the Data
  model section). Handy for someone on one of those teams to jump straight
  to "which of these projects need something from me" without scanning
  every card.

## Why this exists

The weekly 90-minute leadership review used a slide per project with wildly
inconsistent formats, no shared sense of "how far along is this really,"
and no single place to see dependencies/risks across the whole portfolio.
This dashboard gives every PM the same template and gives leadership one page
to scan instead of a 15-slide deck.

## Tab 1 — Program Status (live today)

- **Metrics row** — auto-computed rollup: on-track / at-risk / critical counts,
  average delay, total open risks.
- **Project cards** — the primary view, front and center: one card per
  project with status, progress bar, **current Stage** (the same canonical
  pipeline stage driving the Grid / Hawk-eye / Stage-gate timeline tabs,
  plus that stage's own target completion date when `stagePlan` has one —
  the free-text `phase` description, when present, is kept as a smaller
  detail line underneath it, e.g. "Regression / Performance / Security /
  UAT"), next milestone (name + date), go-live date, delay, and expandable
  dependencies / sprint status
  (completed, in progress, next plan) / risks. Every risk and dependency in
  the detail view is paired with its mitigation plan / impact, and any delay
  requires a stated impact — items missing one are flagged in amber so it's
  obvious what still needs to be filled in. Cards also show a **fast-follow
  badge** whenever a project is live/in-production but still has items left
  to close it out (see below). Filter chips narrow the grid to on-track /
  at-risk / critical / non-recoverable, plus a **PM filter dropdown** to
  show only one person's projects.
- **Recent change glimpse** — right under the owner line, a small pill row
  shows that project's single most recent status change (e.g. "AT RISK →
  CRITICAL") or go-live/milestone date shift (e.g. "📅 Go-Live moved Sep 16 →
  Oct 5, +19 days"), whichever happened later — same underlying data as the
  **Status History** tab (Tab 4) and this project's own detail view's
  **Week-over-week changes** / **Schedule timeline**, just collapsed to
  "what changed last" so you don't have to open either to see it. Only
  shows up once a project has at least one recorded history snapshot (new
  projects with no history yet show nothing here).

## Tab 2 — Grid (live)

A portfolio-wide matrix: every project as a row, every pipeline stage as a
column (Proposal → Requirements → Tech. Design → Estimate & Planning →
Development → UAT → VAPT → Rollout → Hypercare — 9 canonical stages). One
glance shows exactly where every project sits relative to every other
project, not just relative to its own lane.

**KPI strip** at the top (respects the global Project/PM/Team filters, same
as everything else):
- **Active Projects** — count in view, plus how many PMs that spans.
- **Stages Over SLA** — how many projects' *current* stage is past its SLA
  right now (the "needs escalation" number).
- **Cumulative SLA Overage** — total days over SLA, summed across *every*
  stage segment of *every* project in view (not just current stages) — the
  full stage-gate picture, including stages a project has already moved
  past.
- **In Hypercare** — how many are live, post go-live.

**Each column header** also shows that stage's SLA (e.g. "SLA 10d").

**Each cell:**
- **Green, "✓ Xd" + a date range** — that stage is done, on time. The date
  range is the actual start → end for that stage (from the same stage-gate
  reconstruction used in the per-project Stage-gate timeline).
- **Green→red, "✓ Xd" + "+Xd over SLA"** — that stage is done, but blew its
  own SLA back when the project was in it. This is tracked per-stage, so a
  project doing fine today can still show a past stage that ran long — the
  history isn't lost once a project moves on.
- **Highlighted cell** (the project's *current* stage) — blue/neutral if
  within SLA, amber if approaching (≥80% of SLA), red and bold if over SLA,
  with "Xd" and "SLA Xd · +Xd over" shown directly in the cell.
- **Grey "—" cell** — stage not reached yet.

Click a project name to open its full detail view, scrolled straight to its
**Schedule timeline** section (the Grid tab is fundamentally a scheduling /
"what moved" view, so that's the more relevant landing spot). Click an
individual stage cell to open that exact stage's detail modal directly
(Overview / Date History / Delay Analysis / Delay Log) — the same modal and
`openStageDetail(projectId, stage)` call used when clicking a row in the
per-project Stage-gate timeline, so a cell click here has the identical
effect.

**Shared stage-gate computation.** The Grid tab, Hawk-eye, and each
project's **Stage-gate timeline** (in the detail modal) all use the same
primitives — `computeStageSegments`, `stageSlaDays`, `stageFlagLevel`,
`currentStageInfo`, and `cumulativeStageOverageDays` — so they never
disagree on durations, SLA flags, or cumulative overage. "Days in stage" is
reconstructed from weekly history snapshots (calendar days, not business
days); the first segment a project was ever seen in is marked with "≥"
since we don't know how long it was in that stage before tracking began.
SLAs per stage live in `data.json`'s top-level `stageSlaDays` (defaults:
Proposal 7d, Requirements 10d, Tech. Design 10d, Estimate & Planning 5d,
Development 30d, UAT 14d, VAPT 5d, Rollout 5d, Hypercare 21d).

**Migrated from a 6-stage model (2026-09-29).** The pipeline used to be
Requirements → Design/Estimation → Development → QA/UAT → Production
Release → Hypercare/Post-Launch (6 stages); it's now the 9 above, splitting
Design/Estimation into Tech. Design + Estimate & Planning, QA/UAT into UAT
+ VAPT, renaming Production Release → Rollout and Hypercare/Post-Launch →
Hypercare, and adding a new Proposal stage before Requirements. Existing
`stagePlan`/`delayLog`/history data was migrated best-effort: old stage
names were mapped 1:1 onto whichever new stage carries the same dates
(Design/Estimation → Tech. Design, QA/UAT → UAT, Production Release →
Rollout, Hypercare/Post-Launch → Hypercare) — the newly-split-off stages
(Proposal, Estimate & Planning, VAPT) start with no historical data and
will only populate going forward as PMs report against them on the
weekly-update form.

The detail view's **Stage-gate timeline** lists every stage the project has
passed through (same segments as the Grid row). **Click any row** to open a
**stage detail modal** with four tabs (Overview, Date History, Delay
Analysis, Delay Log) — see `stagePlan` / `delayLog` in the Data model
section for how PMs feed planned dates and delay attribution via the
weekly-update form.

The **Delay Log** tab has two sections: manually-reported entries (from
`p.delayLog`, with a reason/team/member) come second; **"Schedule shifts
(auto-detected)"** comes first and needs no manual reporting at all — it's
the same Go-Live / milestone date-shift events as the Schedule timeline's
"Date change log" (see Tab 1), automatically attributed to whichever stage
the project was actually in when that shift happened (`stageAutoScheduleShifts`,
using each weekly snapshot's own `stage` field — not a guess from the
milestone's free-text label), and filtered to actual delays only (the date
moved LATER; "no change" and pulled-in/early shifts don't show up here).

This tab was adapted from
a "Project × Stage Status" grid concept the team liked in a separate
internal admin-dashboard mockup, rebuilt here using our own stage-gate SLA
data and the site's existing visual style instead of copying that mockup's
own design system.

## Tab 3 — 🦅 Hawk-eye (live)

A cross-project **stage-gate calendar**: every project on one shared
timeline, one row each, sorted by go-live date — but instead of a couple of
milestone dots, each row is the project's actual pipeline stages laid out
end to end as blocks, built from the same stage-segment reconstruction used
by the Grid tab / each project's Stage-gate timeline, so all three stage-gate
views always agree.

- **Solid block, green** — a stage already completed, positioned at its
  real date range.
- **Solid block, blue/amber/red** — the project's *current* stage, colored
  by its SLA flag (on track / approaching / over). Sized to at least that
  stage's SLA even mid-stage, so it visually reads as "expected to land
  around here."
- **Outlined block (dashed border, grey)** — a stage the project hasn't
  reached yet. Purely a **planned placeholder**: chained forward from the
  end of the current stage, each sized to that stage's configured SLA — not
  a real commitment, just "if things ran to SLA from here."
- Any block gets a small red **"+Xd"** appended to its label if that stage
  ran (or is running) over its own SLA.
- A per-row **"Xd cumulative delay"** line under each project's name sums
  the SLA overage across every stage it's been through — the per-project
  version of the Grid tab's portfolio-wide "Cumulative SLA Overage" KPI.
- A blue "Today" line runs through every row.

Click any row or block to open the full detail view, scrolled straight to
the Stage-gate timeline. Adapted from the same "Project States in Calendar"
concept in the internal admin-dashboard mockup mentioned in Tab 2, rebuilt
with our real stage-gate data instead of copying its design system.

## Tab 4 — Status History (live)

A flat, chronological feed that merges **two kinds of events** across the
whole portfolio, newest first:

1. **Status changes** — every time a project moved between **On Track → At
   Risk / Delay → Critical → Non-Recoverable** (in either direction). Each
   row shows the date, the from → to status pills, the project name (click
   to jump into its full detail view), what stage/progress the project was
   tracking at when it happened, and whatever context was captured that
   moment — the reason for the change (required for any downgrade — see
   below), delay note, days delayed, or current phase.
2. **Schedule shifts** — every time a go-live or milestone date moved (e.g.
   because of a CR), shown as a "📅 \<label\> moved" row with the old date →
   new date and the delta in days (late/early).

Filter to a single project with the global Project filter above the tabs to
get that project's full story in one place — every status change, every
delay, every timeline shift, and the why, in order. This answers "when did
SPM go red, and why?" and "how did this project's go-live end up slipping?"
without digging through every project's individual change log. Built from
`history.json` snapshots, so it fills in automatically as weekly updates get
ingested; the same status-change is also highlighted (as colored pills)
inside each project's own week-over-week change log in its detail view, and
the same schedule shifts also drive the per-project schedule timeline there.

## Tab 5 — Dependencies (live)

Every dependency across every project, plus **when it's actually needed by**
and **how urgent it is** — the goal is a team like DevOps being able to tell
at a glance whether something is due today, this week, next week, or has
already slipped past its date, without reading every project card.

The tab has three layers, top to bottom:

- **KPI row (four cards)** — aligned to the leadership rollup mockups, computed
  from real project/dependency data (respecting global and Dependencies-tab
  filters):
  - **Active Projects** — distinct projects with at least one open dependency
    in view; subtext is how many distinct owning teams those deps span.
  - **Blocked Stages** — count of in-scope projects whose **current** pipeline
    stage is over SLA (`stageFlagLevel` → breach), same definition as the Grid
    tab’s “Stages Over SLA”.
  - **Cumulative Delay** — sum of `cumulativeStageOverageDays()` across those
    projects (summed SLA overage across all stages lived so far).
  - **In Rollout / Hypercare** — projects in **Rollout** or **Hypercare**
    (post-UAT/VAPT), among projects with open deps in scope.
- **Rollup pivot table**, toggled **By Project** or **By Team**, with header
  controls:
  - **Cycle** — optional filter by **calendar year** of each dependency’s
    `dueBy` (`FY 2026`, etc., derived from dates in the data). Dependencies
    with no `dueBy` stay visible regardless of cycle.
  - **Compact** — toggles denser pivot row height/font (`.deps-pivot-wrap.is-compact`).
  - **Export** — downloads a CSV of the current pivot (grouping, cycle, and
    global filters applied).

  (A separate **Portfolio** narrow-to-one-project dropdown used to sit here
  too — removed since it just duplicated the page-level **Project** filter
  in the global filter bar, which already applies to this tab like every
  other. One less control, same result.)
  Columns: **Project** + **Team** (order swaps with the toggle), **Total**, **By
  Priority** (Critical/High/Medium/Low), **By Due Window** (Overdue, Today,
  Tomorrow, This Week, Next Week, This Month, Next Month). Overdue is a seventh
  window column so past-due items are not hidden when the mockup’s six forward
  buckets are used. Dependencies with **no date** count toward row **Total**
  only (not toward a due-window column). Each primary group lists secondary
  rows, then a **Total · …** subtotal row. **Click any non-zero count** to open
  a modal list of matching dependencies (project, team, description, priority,
  due date, escalated flag).
- **Detail cards**, still grouped by owning team. Priority and needed-by badges
  use the same due-window buckets as the pivot. **🚨 Escalated** when flagged on
  the weekly form. Missing mitigation still flagged in amber.

Use the global Project/PM/Team filter to narrow any of this; click a project
name on a detail card to open its full detail view.

Needed-by date, priority, escalated-to-leadership, and resolved status are
optional per-dependency fields on the weekly-update issue form (`Dependency
needed by (date)` / `Dependency priority` / `Dependency escalated to
leadership?` / `Dependency resolved?`, one line each, same order as open
`Dependencies`) — see the `dependencies` object array in the Data model
section below. **New** dependencies mid-week go through the **Add a Dependency**
issue form (`.github/ISSUE_TEMPLATE/new-dependency.yml`); the bot assigns a
stable `DEP-*` id. Older dependencies with no date/priority/escalated flag
recorded just show "No Date" / default to "Medium" / no escalated badge
rather than breaking the rollup. Resolved dependencies are hidden from this
tab but kept on the project for history.

To change, escalate, or resolve ONE already-tracked dependency without
retyping the whole open-dependencies list, use the **Update / Resolve a
Dependency** issue form (`.github/ISSUE_TEMPLATE/update-dependency.yml`),
targeted by a dependency's `DEP-*` id. On the project detail view, each
dependency row shows its id plus **✎ Update / 🚨 Escalate (or ✓ Un-escalate) /
✓ Resolve** quick-action links that open this form pre-filled with the
project and dependency id already set — the "Resolve"/"Escalate" links also
pre-select the matching dropdown option so a single click on the dashboard
gets you straight to "submit" on GitHub. Any field left blank/"No change"
on the form keeps that field as-is; only the fields you actually fill in
get changed.

**Click anywhere on a dependency or risk/blocker row** (in a project's full
detail view — not on the ✎/🚨/✓ action links themselves, which handle their
own click) **to open an item detail modal** with every field, including ones
that don't fit in the inline row: for dependencies, that's team, priority,
due date, escalated status, and resolved status; for risks (which don't
carry those structured fields — team/priority/ETA are usually embedded in
the free-text description instead), it's just the full description,
mitigation plan, and resolved status. The modal reuses the same quick-action
links as the inline row for dependencies with a stable id.

Week-over-week history for an individual project (progress-over-time chart,
a **schedule timeline** tracking every time the go-live or next-milestone
date moved — e.g. from a CR — with the date it happened, plain-English
change log, and full feedback history) lives inside that project's full
detail view — click any project card to open it. If time was pulled back
IN this week, a green **"Time saved"** block shows up there with how many
days ahead of plan that put the team and what specifically was done to
save it. If the project is cutting/deferring scope to hold the date, or is
live/in production but not fully closed out, a **"Fast-follow items
(planned or remaining)"** block shows up there listing what's been
deferred — a card badge (✂️ scope cut / N fast-follow) flags this at a
glance so nothing gets forgotten once the project launches.

Each row in the **"Week-over-week changes"** log shows what changed that
week (progress/phase/stage/status). Click a row to load the **Dependencies /
Weekly Status / Risks** sections right below it as they stood that week —
a pill shows which week is being displayed ("Showing current data" or
"Showing snapshot as of ..."). Defaults to the latest week. (Weekly Status
detail is captured going forward from each weekly update; older snapshots recorded
before this existed will say so instead of showing stale/empty data.)

**Time saved** is tracked the same way as delay: it's a per-week value
(`timeSavedDays`/`timeSavedNote`), not a diff, so it shows up everywhere the
delay does — a "Time saved: -N days" row on the card and detail facts
(green, mirrors the "Delay" row), an entry in the project's own **Schedule
timeline / Date change log**, and as a green "⏱ Time saved" row in the
**Status History** tab (Tab 4) alongside status transitions and date
shifts, every week it's reported.

### Escalated to leadership (bottom of this tab)

Below the Detail cards, a separate **"🚨 Escalated to leadership"** section
(formerly its own standalone tab — merged in here so a dependency and its
escalation status live in one place) rolls up every current escalation to
leadership across every project — the go-to view for walking through the
weekly review meeting. Grouped by project (with owner and status), newest
asks first within each group. Its own metrics row shows total escalations
and how many projects have one open. A **"📋 Copy summary to share"** button
copies a plain-text, ready-to-paste summary (grouped by project, dated as of
the current data) to the clipboard so it's easy to drop into Slack/email/
meeting notes. These project-level escalations are a separate concept from a
*dependency's* own `escalated` flag (the 🚨 badge on individual dependency
rows above) — this section is specifically things that need a leadership
decision, unblock, or heads-up, independent of whether they're tied to a
tracked dependency.

An escalation also shows up (in red) on the project's card as a
**"🚨 N escalated"** badge, and inside the project detail view's snapshot
sections (so clicking a past week in "Week-over-week changes" shows what
was escalated that week, too). PMs add these via the **"Escalations to
leadership this week"** field on the weekly update form — unlike most
fields, leaving it blank clears it (it means "nothing to escalate this
week"), it doesn't carry last week's escalation forward.

## Tab 6 — Team Performance (skeleton only)

Placeholder tab for engineering execution metrics (PR velocity, review
turnaround, commit activity, deploy cadence) once we wire up GitHub data per
project repo. Nothing is connected yet — it's there so the layout and nav
don't need to change when that's ready.

## How PMs submit their weekly update

No more editing JSON by hand. Each PM opens a **GitHub Issue** using the
"Weekly Project Update" template — either from the repo's Issues tab, or by
clicking **"Submit weekly update"** on their project's card in the dashboard
(it opens the form pre-filled with the project name and today's `asOf`
date). Leave any field blank to keep last week's value for that field.

The moment the issue is opened, a bot comments with any **open follow-ups**
for that project from previous meetings (see below) — so the PM sees "hey,
Swami asked about hypercare tickets last week" before they even finish
filling out the form.

A scheduled GitHub Action (`.github/workflows/ingest.yml`, weekdays at noon
UTC — adjust the cron to your meeting cadence, or just run it manually from
the Actions tab) reads all open "weekly-update", "new-dependency", and "new-risk" issues, merges them into
`data.json`, snapshots the result into `history.json`, and **closes each
issue** with a confirmation comment. You can also trigger it on demand via
`workflow_dispatch` right before a meeting if someone submitted late.

### Status downgrades require a reason

If a submission moves a project to a **worse** status than last week
(On Track → At Risk, At Risk → Critical, anything → Non-Recoverable — using
the rank On Track < At Risk < Critical < Non-Recoverable) and the **"Reason
for status change"** field is blank, `ingest.py` does **not** merge it. It
instead leaves the issue open, labels it `needs-reason`, and comments asking
the PM to edit the issue and add the reason. The next scheduled (or manual)
run automatically picks it back up once the reason is filled in — no reason
is ever silently dropped. Once merged, the reason shows up with its date on
the **Status History** tab and is highlighted (amber) if it's ever missing.

## Adding a dependency mid-week

When a new cross-team blocker comes up between weekly cycles, open a **Add a
Dependency** issue (repo Issues → New issue → that template). Pick the
project, describe the dependency, owning team, optional needed-by date /
priority / mitigation, and whether it's already escalated. The same ingest
Action picks up open issues labeled `new-dependency`, appends one object to
that project's `dependencies` array with the next `DEP-*` id, and closes the
issue. Edit or resolve it later on the normal weekly update (list every
**open** dependency there, same one-line-per-field order as before) — or use
the single-dependency update form described next.

## Updating, escalating, or resolving one dependency

To change a single already-tracked dependency without retyping the whole
open-dependencies list on the weekly form, open an **Update / Resolve a
Dependency** issue (repo Issues → New issue → that template, or use the
**✎ Update / 🚨 Escalate / ✓ Resolve** links next to each dependency on a
project's detail view — these pre-fill the project and dependency id for
you). Give the project and the dependency's `DEP-*` id, then fill in only
whichever of "Resolve this dependency?", "Escalated to leadership?", or the
updated description/team/mitigation/due date/priority fields you want to
change — leave the rest on "No change"/blank. The ingest run picks up open
issues labeled `update-dependency`, finds that one dependency by id on the
named project, applies only the fields you set, and closes the issue.

## Reporting a risk mid-week

When a new risk or blocker comes up between weekly cycles, open a **Report a
Risk** issue (repo Issues → New issue → that template). Pick the project,
describe the risk, and optionally add a mitigation plan. The same ingest
Action picks up open issues labeled `new-risk`, appends one object to
that project's `risks` array with the next `RISK-*` id, and closes the
issue. Edit or clear it later on the normal weekly update (list every
**open** risk there, same one-line-per-field order as before).

From a project's **full detail view** (opened from a project card), use
**"+ Add a Dependency ↗"** or **"+ Report a Risk ↗"** in the Dependencies
and Risks / blockers sections — each opens the matching GitHub issue form
with the project pre-filled.

## How live meeting feedback works

Click **"📝 Add feedback"** in the header (or "Add feedback" on a specific
project's card) to log something raised in the meeting — e.g. "Swami asked
where are the tickets for the hypercare project." That opens a small
in-dashboard form; submitting it opens a pre-filled GitHub issue
("Meeting Feedback / Takeaway" template) for you to send — no backend, no
login for the dashboard itself, just a one-click handoff to GitHub.

The same scheduled Action ingests open "feedback" issues into `notes.json`
as **open follow-ups**, tied to a project. They show up as a badge on that
project's card, in the Week-over-Week feedback history, and — most
importantly — as a reminder comment the next time that PM opens a weekly
update issue for the same project. Once ingested, the follow-up issue is
closed automatically; it stays "open" in `notes.json` until it's resolved
(see below).

**Note:** this means every PM (and anyone logging feedback) needs a GitHub
account with access to open issues on this repo. That's the trade-off for
zero custom backend/hosting.

### Closing out a follow-up

Every open follow-up — in the "Open follow-ups" block and in the Week-over-Week
**Feedback history** list — has a **"✓ Resolve"** button. Clicking it is
instant: no GitHub tab, no form. It drops off the open list and the "Open
Follow-ups" count right away. Under the hood the note itself is left
completely untouched in `notes.json` — the resolve is tracked as a
local-only override in that browser's `localStorage`. If you resolved
something by mistake, an **"↺ Undo"** link puts it back in the open list.

Because it's local-only by default, it won't show as resolved for someone
else viewing the dashboard in a different browser, and a fresh deploy/clear
of `localStorage` would bring it back. Once you resolve something locally,
a **"Sync to GitHub ↗"** link appears next to it in the Feedback history —
clicking that opens a pre-filled GitHub issue ("Resolve a Follow-up"
template); the same scheduled Action picks up open "resolve-feedback" issues
and flips that note's `status` from `"open"` to `"resolved"` in `notes.json`
for real (never deleted — `resolvedAt`/`resolvedBy`/`resolutionNote` get
added), so it's permanent, in git, and visible to everyone. The full history
(open + resolved, local or synced) is always visible in a project's Feedback
history.

## Data model

Everything lives in three files:

- **`data.json`** — current live state, one object per project in the
  `projects` array, plus a top-level `stageSlaDays` object (SLA, in calendar
  days, per pipeline stage — used for the Grid tab and Stage-gate timeline).
- **`history.json`** — one snapshot per `asOf` date, keyed by date, used by
  the Week-over-Week tab and to reconstruct each project's stage-gate
  timeline (how long it's spent in each stage).
- **`notes.json`** — flat array of feedback/follow-up entries, each tied to
  a `projectId`, with `status: "open" | "resolved"`. Resolved entries also
  carry `resolvedAt`, `resolvedBy`, `resolutionNote`, and `resolvedVia`
  (the resolving issue's URL) — nothing is ever deleted, just flipped.

`data.json` project shape:

```json
{
  "id": "webnext",
  "name": "WebNext",
  "owner": "Jeet Savani",
  "status": "green",        // "green" (On Track) | "amber" (At Risk) | "red" (Critical) | "black" (Non-Recoverable)
  "statusChangeReason": "", // only set the week status actually got worse — required by ingest.py
                             // for any On Track→At Risk / →Critical / →Non-Recoverable style downgrade;
                             // shown on the Status History tab, cleared once the status stops changing
  "progress": 80,             // 0-100, your best call on % complete
  "stage": "Requirements",    // canonical pipeline stage — drives the Pipeline stages
                               // board; one of Proposal | Requirements | Tech. Design |
                               // Estimate & Planning | Development | UAT | VAPT |
                               // Rollout | Hypercare
  "phase": "Requirements Finalization",
  "nextMilestone": { "name": "Requirements Finalization", "date": "2026-08-21" },
  "goLive": "2026-09-25",     // current planned go-live, or null if not yet set
  "originalGoLive": "2026-09-21", // baseline date, set once and preserved across
                                   // slips so the changelog can show the delta
  "delayDays": 0,              // 0 if on schedule, positive integer if late
  "delayNote": "No delay reported",
  "delayImpact": "",           // required in the form whenever delayDays > 0
  "delayMitigation": ["..."],  // one per line — what's being done to recover the delay
  "delayTradeoffs": "",        // any scope/resource/date trade-offs made because of the delay
  "timeSavedDays": 0,          // positive integer if the team pulled time back IN this week
  "timeSavedNote": ["..."],    // one per line — what specifically was done to save that time;
                                // required in the form whenever timeSavedDays > 0
  "scopeReduced": false,       // true if scope is being cut/deferred this week to hold the go-live
                                // date — flags a "✂️ scope cut" badge on the card; what's being
                                // deferred should be listed in fastFollowItems below
  "dependencies": [                 // id-based objects (ingest migrates legacy parallel arrays on load)
    {
      "id": "DEP-101",              // SYSTEM-MANAGED — minted from dependencySeq (starts at 100+)
      "text": "Waiting on SSO team for prod credentials",
      "team": "SSO Team",           // owning team(s) — drives Team filter + card grouping
      "mitigation": "Escalated to SSO lead 9/20",
      "dueBy": "2026-10-05",        // "" if no hard date; invalid dates dropped at ingest
      "priority": "High",           // Critical | High | Medium | Low
      "escalated": false,           // per-dependency leadership escalation (🚨 badge on Tab 5)
      "resolved": false             // true = hidden from Dependencies tab, kept for history
    }
  ],
  "dependencySeq": 101,             // SYSTEM-MANAGED — counter for next DEP-* id (like delayLogSeq)
  "sprintStatus": {
    "completed": ["..."],
    "inProgress": ["..."],
    "nextPlan": ["..."]
  },
  "risks": [                        // id-based objects (ingest migrates legacy parallel arrays on load)
    {
      "id": "RISK-101",             // SYSTEM-MANAGED — minted from riskSeq (starts at 100+)
      "text": "Security re-verification may miss UAT window",
      "mitigation": "Escalated to security lead — ~1 week slip if missed",
      "resolved": false             // true = hidden from risk counts/detail, kept for history
    }
  ],
  "riskSeq": 101,                   // SYSTEM-MANAGED — counter for next RISK-* id
  "fastFollowItems": ["..."],  // one per line — scope being deferred (see scopeReduced above) and/or
                                // remaining work to fully close out a live/in-production project;
                                // shows a badge on the card and a block in the detail view so it's
                                // tracked and doesn't get forgotten once the project launches
  "escalations": ["..."],      // one per line — things needing a leadership decision/unblock THIS week.
                                // Unlike other fields, a blank submission CLEARS this (it isn't "unchanged"
                                // like most fields — it means nothing to escalate this week). Drives the
                                // "Escalated to leadership" section at the bottom of the Dependencies
                                // tab (Tab 5), the card's "🚨 N escalated" badge, and the
                                // detail view's escalations block.
  "milestones": [              // OPTIONAL — full schedule for the mini Gantt in a project's own
                                // detail view. If omitted, that view falls back to plotting just
                                // `nextMilestone` + `goLive`. (Hawk-eye/Tab 3 plots pipeline stages
                                // instead, built entirely from history — doesn't read this field.)
    { "name": "Requirements sign-off", "date": "2026-08-01", "status": "green" }
  ],
  "stagePlan": {                // OPTIONAL — per-stage planned dates, keyed by pipeline stage name.
                                 // Only the CURRENT stage gets written to on a given weekly update
                                 // (see "Current stage — planned start/completion date" on the form);
                                 // once a project moves to the next stage, this stage's entry is
                                 // frozen and its history lives on in history.json snapshots. Feeds
                                 // the stage detail modal's Overview (planned vs actual + variance)
                                 // and Date History (revision log, diffed across history.json) tabs.
    "Development": {
      "initialStart": "2026-01-05",  // locked the first time a start date is submitted for this stage
      "initialEnd": "2026-01-20",    // locked the first time an end date is submitted for this stage
      "latestStart": "2026-01-05",   // moves every time a later submission changes it
      "latestEnd": "2026-01-28"      // moves every time a later submission changes it
    }
  },
  "delayLog": [                 // OPTIONAL, append-only (unlike every other array field, which is
                                 // wholesale-replaced on submit) — every individual delay incident
                                 // ever logged, across every stage, accumulated week over week from
                                 // the "Delay log entries (this week)" field. Feeds the stage detail
                                 // modal's Delay Analysis (by team/member/reason) and Delay Log
                                 // (searchable/sortable table) tabs — both filtered to `stage`.
    { "id": "DL-101", "date": "2026-01-10", "stage": "Development", "reason": "Review defects resolution", "team": "Team2", "member": "V. Mehta", "days": 2 }
  ],
  "delayLogSeq": 101             // SYSTEM-MANAGED — running counter scripts/ingest.py uses to mint
                                  // each new delayLog entry's sequential "DL-NNN" id. Don't hand-edit.
}
```

Risks are a single **array of objects** with stable `RISK-*` ids (same pattern
as dependencies). PMs add brand-new risks anytime via the **Report a Risk**
issue form; the scheduled ingest appends one object and bumps `riskSeq`. On the
weekly update, list every **open** risk (one line per field, same order as
before) — rows keep their ids by line position (or an optional `RISK-101 |`
prefix). Omitting a row from the re-submitted list sets `resolved: true`
without deleting history. Partial weekly updates (e.g. only re-submitting
mitigation lines) still apply by index to open risks.
Dependencies are a single **array of objects** with stable `DEP-*` ids. PMs add
brand-new dependencies anytime via the **Add a Dependency** issue form; the
scheduled ingest appends one object and bumps `dependencySeq`. To change,
escalate, or resolve just ONE existing dependency by id (without retyping the
whole list), use the **Update / Resolve a Dependency** issue form instead —
the project detail view's per-dependency **✎ Update / 🚨 Escalate / ✓ Resolve**
links open it pre-filled. On the weekly update, list every **open** dependency
(one line per field, same order as before) — rows keep their ids by line
position (or an optional `DEP-101 |` prefix). Omitting a row or marking
**Dependency resolved?** = Yes sets `resolved: true` without deleting history.
Partial weekly updates (e.g. only re-submitting mitigation lines) still apply
by index to open dependencies.
`scripts/ingest.py` transparently upgrades legacy five-array projects when it
runs, so old open issues and stale `data.json` shapes stay safe. The dashboard
flags any risk or open dependency that's missing its team label / mitigation /
impact in amber. The Dependencies tab reads `team`, `dueBy`, `priority`, and
`escalated` on each unresolved object for rollups and cards.
Meeting feedback issues also carry an optional `mitigationImpact` field for
when leadership flags a risk/dependency live in the meeting.

`originalGoLive` is system-managed: `scripts/ingest.py` sets it the first time
a PM submits a go-live date for a project and never overwrites it after that,
so it always reflects the original baseline even as `goLive` moves.
`stagePlan[stage].initialStart`/`initialEnd` follow the exact same
lock-on-first-write pattern, just per-stage instead of once per project — see
`is_valid_iso_date` in `scripts/ingest.py`, which both `goLive` and
`stagePlan` dates run through before being written (a typo'd month/day is
dropped rather than silently corrupting the field, the same fix that came out
of the GMS 1.4 goLive incident, issue #6).

`delayLog` is the one array field that's **appended to, not replaced** on
each submit — every other array field (dependencies, risks, etc.) is
wholesale-overwritten by whatever's in that week's issue, but delay log
entries accumulate indefinitely so the Delay Log/Delay Analysis tabs can show
the full history for a stage, not just this week's. `delayLogSeq` is the
system-managed counter behind each entry's `DL-NNN` id.

Adding a brand-new project: add a matching option to the `project` dropdown
in `.github/ISSUE_TEMPLATE/weekly-update.yml`, `new-dependency.yml`,
`update-dependency.yml`, `new-risk.yml`, and `meeting-feedback.yml`, add the
id/name mapping in
`scripts/lib.py`'s `PROJECT_NAME_TO_ID`, and add the initial project object
to `data.json`. Retiring one: reverse of the above (or just leave it in
`data.json` with no further updates — it'll simply stop moving in the
Week-over-Week view).

## Local preview

```bash
python3 -m http.server 8765
# open http://localhost:8765
```

## Stack

Plain HTML/CSS/JS, no framework, no build step — fast to load, trivial to
host on GitHub Pages, and easy for any PM to edit `data.json` without touching
the app code.

## Roadmap

- [ ] Wire Tab 6 (Team Performance) up to real GitHub data (PRs, reviews,
      commits, deploys) per project repo.
- [x] Hawk-eye (Tab 3) now plots each project's full pipeline-stage history
      built from `history.json` — no per-project `milestones` array needed
      for that anymore. `milestones` is still useful for the finer-grained
      mini Gantt in a project's own detail view, if you want to hand-track
      sub-milestones within a stage.
- [x] Add a "resolve" action for follow-ups — click "✓ Resolve" on the
      dashboard, which opens a pre-filled "Resolve a Follow-up" GitHub issue
      that the ingestion bot uses to flip `"status"` to `"resolved"` (stays in
      `notes.json`/git history, just drops off the open list).
- [ ] Consider a GitHub Action that auto-resolves a follow-up when the next
      weekly update for that project explicitly references it.
- [x] Per-stage detail modal (click a Stage-gate timeline row) with
      planned-vs-actual dates, a Date History revision log, and delay
      attribution/log tabs, fed by new `stagePlan`/`delayLog` fields on the
      weekly-update form.
- [x] Dependencies tab (Tab 5) now tracks a "needed by" date and a priority
      per dependency, with a by-project / by-team pivot rollup on top of the
      existing team-grouped card board.
