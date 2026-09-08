# BAPS NDC · Program Status

A single-page status dashboard for the BAPS NDC project portfolio, replacing the
weekly slide-deck review. Built as a static site — no backend, no build step —
so any PM can update it by editing one JSON file and pushing.

**Live site:** `https://pankaj117.github.io/baps-ndc-status/` (enabled via GitHub Pages on the `main` branch)

## Global project filter

A **"🔎 Project" dropdown** sits right under the tab bar, visible on every
tab. Pick a project and Program Status, Pipeline Stages, Go-live Tracker,
Status History, and Dependencies all narrow down to just that project (the
metrics row recomputes for the filtered set too). Set it back to "All
projects" to see everything again. This is separate from — and stacks
with — the per-tab filters (PM, team, status-history project) already on
some tabs.

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

## Tab 3 — Go-live Tracker (live)

Every project with a scheduled go-live, sorted by date, showing the original
planned date struck through next to the current date whenever it's slipped,
plus a delay pill (green/amber/red by severity). Projects without a go-live
yet are listed underneath as "not yet scheduled." Click any row to open that
project's full detail view.

## Tab 4 — Status History (live)

A flat, chronological feed of every time a project moved between
**On Track → At Risk / Delay → Critical → Non-Recoverable** (in either
direction), across the whole portfolio, newest first. Each row shows the
date, the from → to status pills, the project name (click to jump into its
full detail view), what stage/progress the project was tracking at when it
happened, and whatever context was captured that moment — the reason for the
change (required for any downgrade — see below), delay note, days delayed,
or current phase. Filter to a single project with the dropdown. This answers
"when did SPM go red, and why?" without digging through every project's
individual change log. Built from `history.json` snapshots, so it fills in
automatically as weekly updates get ingested; the same status-change is also
highlighted (as colored pills) inside each project's own week-over-week
change log in its detail view.

## Tab 5 — Dependencies (live)

Every dependency across every project, flattened into one cross-project
board and grouped by the **owning team** (DevOps, Security, GMS Team,
Business/Stakeholder, etc. — whatever the PM labels it as in their weekly
update). Each card shows which project it's blocking, the dependency text,
and its mitigation plan / impact — with anything missing a team label or a
mitigation plan flagged in amber so it's obvious what to chase down. Filter
by team or by "missing info" status; click a project name to jump straight
into its full detail view. This is the fastest way to answer "what's DevOps
blocking us on this week?" without reading every project card individually.

Week-over-week history for an individual project (progress-over-time chart,
a **schedule timeline** tracking every time the go-live or next-milestone
date moved — e.g. from a CR — with the date it happened, plain-English
change log, and full feedback history) lives inside that project's full
detail view — click any project card to open it. If the project is live/in
production but not fully closed out, a **"Fast-follow items to close"**
block also shows up there listing what's left.

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
closed automatically; it stays "open" in `notes.json` until someone flips
it to `"status": "resolved"` (currently a manual edit — see Roadmap).

**Note:** this means every PM (and anyone logging feedback) needs a GitHub
account with access to open issues on this repo. That's the trade-off for
zero custom backend/hosting.

## Data model

Everything lives in three files:

- **`data.json`** — current live state, one object per project in the
  `projects` array.
- **`history.json`** — one snapshot per `asOf` date, keyed by date, used by
  the Week-over-Week tab.
- **`notes.json`** — flat array of feedback/follow-up entries, each tied to
  a `projectId`, with `status: "open" | "resolved"`.

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
                                   // slips so the go-live tracker can show the delta
  "delayDays": 0,              // 0 if on schedule, positive integer if late
  "delayNote": "No delay reported",
  "delayImpact": "",           // required in the form whenever delayDays > 0
  "delayMitigation": ["..."],  // one per line — what's being done to recover the delay
  "delayTradeoffs": "",        // any scope/resource/date trade-offs made because of the delay
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
  "fastFollowItems": ["..."]   // one per line — remaining work to fully close out a live/in-production
                                // project; shows a badge on the card and a block in the detail view
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
- [ ] Add a "resolve" action for follow-ups (currently a manual edit to
      `notes.json` — flip `"status": "open"` to `"resolved"`).
- [ ] Consider a GitHub Action that auto-resolves a follow-up when the next
      weekly update for that project explicitly references it.
