# BAPS NDC · Program Status

A single-page status dashboard for the BAPS NDC project portfolio, replacing the
weekly slide-deck review. Built as a static site — no backend, no build step —
so any PM can update it by editing one JSON file and pushing.

**Live site:** `https://pankaj117.github.io/baps-ndc-status/` (enabled via GitHub Pages on the `main` branch)

## Global project filter

A **"🔎 Project" dropdown** sits right under the tab bar, visible on every
tab, next to a **"PM" dropdown**. Pick a project and/or a PM and Program
Status, Pipeline Stages, Hawk-eye, Status History, and Dependencies all
narrow down to match (the metrics row recomputes for the filtered set too).
Clear either with the ✕ button to see everything again. These two global
filters replace the old per-tab Team/Status/PM filter rows — one filter bar,
same effect everywhere.

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
  project with status, progress bar, phase, next milestone (name + date),
  go-live date, delay, and expandable dependencies / sprint status
  (completed, in progress, next plan) / risks. Every risk and dependency in
  the detail view is paired with its mitigation plan / impact, and any delay
  requires a stated impact — items missing one are flagged in amber so it's
  obvious what still needs to be filled in. Cards also show a **fast-follow
  badge** whenever a project is live/in-production but still has items left
  to close it out (see below). Filter chips narrow the grid to on-track /
  at-risk / critical / non-recoverable, plus a **PM filter dropdown** to
  show only one person's projects.

## Tab 2 — Pipeline Stages (live)

A Kanban-style board grouping every project by its canonical delivery stage
(Requirements → Design/Estimation → Development → QA/UAT → Production
Release → Hypercare/Post-Launch), so you can see at a glance where the whole
portfolio actually sits without opening each card. Click any card to jump
into its full detail view. Inspired by the stage board on Intuit's internal
PDLC dashboard.

## Tab 3 — 🦅 Hawk-eye (live, rough until fuller schedule data lands)

A cross-project Gantt: every project on one shared calendar timeline, one
row each, sorted by go-live date. Shows the next milestone (small square),
the go-live date (large circle, colored by status), and — whenever a
project has slipped — a faint dashed line connecting the original go-live
to the current one. A blue "Today" line runs through every row so you can
see at a glance what's imminent vs. far out. Click any row to open the full
detail view.

This currently plots from `goLive` / `originalGoLive` / `nextMilestone` only,
so it's a rough first pass. It's built to also read a richer, optional
`"milestones": [{ "name": "...", "date": "...", "status": "..." }]` array per
project (see data model below) — once that's populated, each project's row
will plot its **full** schedule instead of just one milestone + go-live.

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

Every dependency across every project, flattened into one cross-project
board and grouped by the **owning team** (DevOps, Security, GMS Team,
Business/Stakeholder, etc. — whatever the PM labels it as in their weekly
update). Each card shows which project it's blocking, the dependency text,
and its mitigation plan / impact — with anything missing a team label or a
mitigation plan flagged in amber so it's obvious what to chase down (see the
metrics row at the top for the counts). Use the global Project/PM filter to
narrow this to one project or PM; click a project name to jump straight into
its full detail view. This is the fastest way to answer "what's DevOps
blocking us on this week?" without reading every project card individually.

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
Sprint status / Risks** sections right below it as they stood that week —
a pill shows which week is being displayed ("Showing current data" or
"Showing snapshot as of ..."). Defaults to the latest week. (Sprint detail
is captured going forward from each weekly update; older snapshots recorded
before this existed will say so instead of showing stale/empty data.)

**Time saved** is tracked the same way as delay: it's a per-week value
(`timeSavedDays`/`timeSavedNote`), not a diff, so it shows up everywhere the
delay does — a "Time saved: -N days" row on the card and detail facts
(green, mirrors the "Delay" row), an entry in the project's own **Schedule
timeline / Date change log**, and as a green "⏱ Time saved" row in the
**Status History** tab (Tab 4) alongside status transitions and date
shifts, every week it's reported.

## Tab 6 — 🚨 Escalations (live)

Every current escalation to leadership, rolled up across every project —
the go-to view for walking through the weekly review meeting. Grouped by
project (with owner and status), newest asks first within each group. The
metrics row shows total escalations and how many projects have one open.
A **"📋 Copy summary to share"** button copies a plain-text, ready-to-paste
summary (grouped by project, dated as of the current data) to the clipboard
so it's easy to drop into Slack/email/meeting notes. Escalations are
separate from general risks/blockers — they're specifically things that
need a leadership decision, unblock, or heads-up.

An escalation also shows up (in red) on the project's card as a
**"🚨 N escalated"** badge, and inside the project detail view's snapshot
sections (so clicking a past week in "Week-over-week changes" shows what
was escalated that week, too). PMs add these via the **"Escalations to
leadership this week"** field on the weekly update form — unlike most
fields, leaving it blank clears it (it means "nothing to escalate this
week"), it doesn't carry last week's escalation forward.

## Tab 7 — Team Performance (skeleton only)

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
the Actions tab) reads all open "weekly-update" issues, merges them into
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
**Feedback history** list — has a **"✓ Resolve"** link. Clicking it opens a
pre-filled GitHub issue ("Resolve a Follow-up" template) with the note's ID
already filled in, plus an optional field to note how it was resolved.

The same scheduled Action picks up open "resolve-feedback" issues and flips
that note's `status` from `"open"` to `"resolved"` in `notes.json` — it's
**never deleted**. The note, who raised it, who resolved it, when, and how
all stay in `notes.json` and in git history permanently; it just stops
counting toward "Open Follow-ups" and drops off the open list. The full
history (open + resolved) is always visible in a project's Feedback history.

## Data model

Everything lives in three files:

- **`data.json`** — current live state, one object per project in the
  `projects` array.
- **`history.json`** — one snapshot per `asOf` date, keyed by date, used by
  the Week-over-Week tab.
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
                               // board; one of Requirements | Design / Estimation |
                               // Development | QA / UAT | Production Release |
                               // Hypercare / Post-Launch
  "phase": "Requirements Finalization",
  "nextMilestone": { "name": "Requirements Finalization", "date": "2026-08-21" },
  "goLive": "2026-09-25",     // current planned go-live, or null if not yet set
  "originalGoLive": "2026-09-21", // baseline date, set once and preserved across
                                   // slips so Hawk-eye and the changelog can show the delta
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
  "dependencies": ["..."],
  "dependencyTeams": ["..."],       // same length/order as dependencies — which team owns unblocking it
  "dependencyMitigations": ["..."], // same length/order as dependencies — plan + impact for each
  "sprintStatus": {
    "completed": ["..."],
    "inProgress": ["..."],
    "nextPlan": ["..."]
  },
  "risks": ["..."],
  "riskMitigations": ["..."],  // same length/order as risks — mitigation plan + impact for each
  "fastFollowItems": ["..."],  // one per line — scope being deferred (see scopeReduced above) and/or
                                // remaining work to fully close out a live/in-production project;
                                // shows a badge on the card and a block in the detail view so it's
                                // tracked and doesn't get forgotten once the project launches
  "escalations": ["..."],      // one per line — things needing a leadership decision/unblock THIS week.
                                // Unlike other fields, a blank submission CLEARS this (it isn't "unchanged"
                                // like most fields — it means nothing to escalate this week). Drives the
                                // Escalations tab (Tab 6), the card's "🚨 N escalated" badge, and the
                                // detail view's escalations block.
  "milestones": [              // OPTIONAL — full schedule for the Hawk-eye Gantt (Tab 3). If omitted,
                                // Hawk-eye falls back to plotting just `nextMilestone` + `goLive`.
    { "name": "Requirements sign-off", "date": "2026-08-01", "status": "green" }
  ]
}
```

Risks and dependencies are tracked as **parallel arrays**: `risks[i]` pairs
with `riskMitigations[i]`, `dependencies[i]` pairs with `dependencyTeams[i]`
and `dependencyMitigations[i]`. The weekly-update issue form asks for all of
these in the same order so PMs can just add a matching line. The dashboard
flags any risk, dependency, or delay that's missing its team label / mitigation
/ impact in amber so it's visible at a glance who still needs to fill it in.
The Dependencies tab uses `dependencyTeams` to group every project's
dependencies into one cross-project board. Meeting feedback issues also
carry an optional `mitigationImpact` field for when leadership flags a
risk/dependency live in the meeting.

`originalGoLive` is system-managed: `scripts/ingest.py` sets it the first time
a PM submits a go-live date for a project and never overwrites it after that,
so it always reflects the original baseline even as `goLive` moves.

Adding a brand-new project: add a matching option to the `project` dropdown
in both `.github/ISSUE_TEMPLATE/*.yml` files, add the id/name mapping in
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

- [ ] Wire Tab 6 up to real GitHub data (PRs, reviews, commits, deploys) per
      project repo.
- [ ] Once fuller project schedule data comes in, add a `milestones` array
      per project (see Hawk-eye, Tab 3) so the Gantt plots the full timeline
      instead of just next-milestone + go-live.
- [x] Add a "resolve" action for follow-ups — click "✓ Resolve" on the
      dashboard, which opens a pre-filled "Resolve a Follow-up" GitHub issue
      that the ingestion bot uses to flip `"status"` to `"resolved"` (stays in
      `notes.json`/git history, just drops off the open list).
- [ ] Consider a GitHub Action that auto-resolves a follow-up when the next
      weekly update for that project explicitly references it.
