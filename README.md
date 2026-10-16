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

**Filter bar hides controls that don't do anything on the active tab
(2026-09-30).** The bar used to say "Applies to every tab" unconditionally,
but that wasn't actually true:
- **Status History** (Tab 4) filters only by Project/PM (`renderStatusHistory`
  never reads the team filter) — picking a team there silently did nothing.
  The **Team** dropdown, its separator, and the hint text are now hidden on
  this tab; the hint changes to explain Project/PM still apply.
- **Team Performance** (Tab 6) is a disconnected placeholder stub with no
  data wired up at all yet — none of the three filters can affect it, so the
  **entire filter bar** hides on this tab.
On every other tab (Program Status, Grid, Hawk-eye, Dependencies) all three
filters genuinely apply, so the bar — and the "Applies to every tab" hint —
look exactly as before.

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
- **Badges jump straight to their source (2026-09-30, updated 2026-09-30
  once the detail view went tabbed — see below)** — the dependencies /
  risks / follow-ups / escalated count badges on each card now open the
  project's full detail view, switched to whichever **tab** contains that
  section (`detail-deps-section` / `detail-risks-section` /
  `detail-followups-section` / `detail-escalations-section` → the
  "Dependencies & Risks" or "Follow-ups" tab, per `DETAIL_SECTION_TAB_MAP`)
  and scrolled to it, instead of just opening the detail view at the top
  and making you scroll to find it. The informational-only badges
  (fast-follow, scope cut, time-saved) aren't clickable — there's no
  separate section for those to jump to. Clicking a badge doesn't also
  trigger the whole card's own click (which opens the detail view on its
  default tab, unscrolled); a follow-ups badge showing 0 falls back to
  the plain "open at top" behavior since there's nothing to jump to (the
  Follow-ups tab itself still exists and shows "No open follow-ups").
- **Recent change glimpse** — right under the owner line, a small pill row
  shows that project's single most recent status change (e.g. "AT RISK →
  CRITICAL") or go-live/milestone date shift (e.g. "📅 Go-Live moved Sep 16 →
  Oct 5, +19 days"), whichever happened later — same underlying data as the
  **Status History** tab (Tab 4) and this project's own detail view's
  **Week-over-week changes** / **Schedule timeline**, just collapsed to
  "what changed last" so you don't have to open either to see it. Only
  shows up once a project has at least one recorded history snapshot (new
  projects with no history yet show nothing here).

**Clarified: schedule-shift log entries don't sum to a total
(2026-09-30).** A user looking at a stage detail modal's "Schedule shifts
(auto-detected)" log and its "Stage delay" / "Project cumulative" metric
cards above it reasonably asked whether the numbers "added up." They
don't, by design, and that wasn't previously explained anywhere on
screen:
- **The schedule-shift log is a per-event list, not a running total.**
  Each row's `+Nd` is only that one row's own delta. Two different
  tracked dates — **Go-Live** and the **next-milestone target** — are
  interleaved in the same list, so summing every visible row mixes two
  unrelated fields. Even summing just the milestone rows isn't clean: the
  milestone's label itself sometimes gets reworded as scope gets refined
  (confirmed in real data — myBKY 2A's tracked label went "TDD" → "
  Requirement completion + Sprint1 TDD submission & approval" → "
  Requirement + TDD" → "Requirements completion" over 5 weeks), so
  consecutive rows aren't always "the same date slipping again." Also,
  the very first jump from a project's original target (`originalGoLive`
  in `data.json`) to whatever its Go-Live was on the *first* tracked
  weekly snapshot never gets logged as an event at all (there's no prior
  snapshot to diff against) — so even summing only the Go-Live rows can
  under-count the true total slip since `originalGoLive`.
- **"Stage delay" / "Project cumulative" come from a completely different
  calculation** — real elapsed calendar days a project has spent in a
  stage versus that stage's fixed SLA (`cumulativeStageOverageDays()` /
  `computeStageSegments()`), entirely independent of how many times a
  target date got re-planned. Verified against real data: myBKY 2A's
  Requirements stage started 2026-06-12 (`stagePlan.Requirements.
  initialStart`), today is 2026-09-30 (~110 elapsed days), SLA is 10 days
  → `110 - 10 = 100d`, exactly matching what's on screen. It only happens
  to equal "Project cumulative" too because Requirements is the only
  stage this project has been through so far — not because one total
  feeds the other.

Added a short note directly under the schedule-shift log (only when it
has entries) spelling out that it's per-event, that Go-Live/milestone
shifts are separate tracked fields, and that none of it feeds the
Stage delay / Project cumulative figures.

**"Date change log" collapsed by default (2026-09-30).** Inside a
project's full detail view, the Schedule timeline's Date change log used
to always render fully expanded — some projects have 5+ CR/date-shift
entries, which was one of the bigger single contributors to the detail
view feeling too long/dense. It's now collapsed by default under a
"Date change log · N entries" header; click it to expand in place. Scoped
to just this one section for now — the stage detail modal's own
"Schedule shifts (auto-detected)" panel (a filtered subset of the same
data, scoped to one stage) still renders fully expanded, since it's
usually only 0-2 entries and wasn't the thing making the page feel dense.

**Stage-gate timeline rebuilt as a visual, Hawk-eye-style timeline
(2026-09-30).** The "Stage-gate" tab used to be a flat list of rows (one
per stage, text-only: stage name, date range, day-count/SLA) — a user
asked for it to "look the same way it shows up in Hawk-eye, but better
with dates so it's easy to see." Replaced with `buildStageGateTimeline()`:
a single-project version of the cross-project Hawk-eye visual (same
language — blocks on a real date axis, colored by status, dashed for
not-yet-reached stages, a "Today" line, a 5-item color legend above it,
click-through to each stage's detail) with two things Hawk-eye itself
can't afford once it's showing every project at once:
- **Every future stage is positioned by its own real date**, not
  squeezed into a fixed-size chip strip off to the side — there's only
  one row to make room for here, so a not-yet-reached stage's planned/
  potential target literally sits where it falls on the calendar, same
  axis as the done/current stages before it.
- **Every block's real date range + day-count/SLA is written out
  directly underneath it** (two staggered vertical caption tiers so
  short, back-to-back stages don't overlap each other's text), instead
  of requiring a hover — that was the explicit "easy to see" ask, and the
  one thing Hawk-eye's hover-only tooltips don't give you.

Done/current day-counts and "since before tracking"/"→ now" wording still
come from the exact same `computeStageSegments()` the old flat list used
(real elapsed days) — `buildHawkeyeBlocks()`'s own current-stage `end` is
deliberately padded out to at least that stage's SLA for the block's
*visual* width (so it reads as "expected to land around here" even
mid-stage, same as Hawk-eye), which would've overstated real elapsed time
if used for the day-count text too, so the two are sourced separately.
Horizontally scrollable (own `.stagegantt-scroll` wrapper, not reusing
Hawk-eye's shared multi-project scroll track) since a project's full
done→current→future span can run longer than the panel is wide. The
`stage-gate-timeline-section` anchor id (used by jump-links/"Click a
Stage-gate timeline row" entry points) stayed in place on the wrapping
container, so nothing else needed to change.

Verified headlessly against all 15 real projects in `data.json` (fake-DOM
Node harness): every project renders one block + one caption per pipeline
stage with matching counts, zero negative/clipped block positions, the
5-item legend is always present, the jump-link anchor still exists, and
clicking a block correctly opens that stage's detail modal. Spot-checked
the two outlier projects from an earlier round (`MyBKY (Phase 1)`,
`myBKY 2A`) — their caption text matches the previously-verified overage
math exactly (`229d - 10d SLA = 219d over`; `110d - 10d SLA = 100d over`).

**Fix: caption text was overlapping into unreadable garbage on projects
with several short, back-to-back future stages (2026-09-30).** The first
cut of this used a fixed 2-tier vertical stagger (alternate captions
between two rows) to keep adjacent captions from writing over each other
— that's nowhere near enough once a project has 5+ future stages with
short SLAs (VAPT/Rollout at 5 days each, etc.): their blocks land only a
few px apart on the real date axis, but each caption's text (stage name +
full date range + day-count/SLA) needs ~70-200px of width, so captions 2
rows apart still collided constantly. Replaced the tier stagger with real
collision avoidance: the same forward block-placement pass that already
pushes each block's `left` right past the previous block (`cursorPx`) now
also measures each caption's actual text width (longest of its three
lines × a per-character px estimate for that line's font) and reserves
`max(block width, caption width)` of horizontal room per stage, so every
caption sits in a single row, always directly under its own block,
guaranteed never to overlap its neighbors. The tradeoff: two
calendar-adjacent stages with long captions now get visually spread a
little further apart than their literal dates would place them — judged
a much better outcome than genuinely unreadable overlapping text.
Re-verified against all 15 real projects with an explicit
bounding-box-overlap check (not just "did it render") — zero collisions
across the board, including the previously-worst case (projects with 7-8
future pipeline stages).

**Fix: the caption-collision fix above introduced a worse bug — every
block collapsed to a same-size tiny dot (2026-09-30).** Reserving extra
horizontal room per caption pushes a block's `left` to the right of where
its real date would otherwise place it. The block-width line was
computing width as `end - left` using that already-shifted `left`
instead of the block's own un-shifted start — so once a caption (e.g.
Requirements' `"since before tracking, Aug 31 → Sep 22" / "≥22d / SLA
10d"`) needed more width than its real ~22-day date span, the shift it
caused made every stage *after* it compute a negative `end - left` and
floor out at `MIN_BLOCK_PX` (10px). The result cascaded through the whole
row: the current stage rendered as a near-circle instead of a wide pill,
and every future stage — regardless of whether its real duration was 5
days or 30 — rendered as the same tiny dashed dot. All relative-duration
information (the entire point of a timeline) was gone.

Fixed by computing each block's width from its own real `start`/`end`
*before* any rightward shift, then shifting only `left` to make room for
captions — width and position are now independent, so a block's visual
size always reflects its real date span regardless of how far it got
pushed to avoid a caption collision. Added a regression check to the
verification harness (flags it if 3+ blocks in a row are pinned at the
10px floor, which is the collapse signature, as opposed to a project
genuinely having several back-to-back 1-2 day stages) in addition to the
existing caption-overlap check — both pass clean on all 15 real projects;
widths now visibly vary per project (e.g. `MyBKY (Phase 1)`'s long-overrun
stages render at 1374/762/1062px vs. a healthy project's 30px future
stages).

**Removed the per-project calendar/Gantt from the Schedule tab
(2026-09-30).** The Schedule tab used to show a small calendar/Gantt
visualization (`buildSingleProjectGantt()` — month gridlines, a "Today"
line, Original/Go-Live/milestone markers, a dashed slip-line between
original and current Go-Live) above the Date change log. Removed
entirely, for every project — not just the one it was requested on, since
it was the same shared component everywhere. The Schedule tab is now just
the heading, a one-line description, and the Date change log (collapsible
when it has 1+ entries). Deleted the now-fully-unused
`buildSingleProjectGantt()` / `ganttLabelEdgeStyle()` functions and all
`.project-gantt*` CSS (no other call sites existed). Verified headlessly
against all 15 real projects: the Schedule tab panel no longer contains
any `.project-gantt` element, and the `detailScheduleSection` container
still renders its heading + subhead + Date change log (3 children) with
nothing broken.

**Tab order + default tab (2026-09-30).** Reordered to **Schedule,
Week-over-week, Stage-gate, Dependencies & Risks, Follow-ups, Feedback**
(was Stage-gate first). **Schedule is now the default tab that opens**
instead of Stage-gate — purely a `DETAIL_TABS` array reorder (`i === 0`
in that array drives both which button starts `.is-active` and which
panel does), no functional changes to any tab's content. Jump-links
(badges, Hawk-eye chips, Stage-gate timeline rows) are unaffected — they
still explicitly activate whichever tab their target section lives in via
`DETAIL_SECTION_TAB_MAP`, regardless of display order.

**Week-over-week changes split into its own tab (2026-09-30, follow-up to
the tabbing below).** The week-picker + its live snapshot preview used to
share the "Dependencies & Risks" tab, since picking a week only makes
sense right next to the content it updates. Split into **6 tabs** now
(added **Week-over-week**) because a user wanted to view/click them
independently rather than always scrolling past one to reach the other:
- **"Dependencies & Risks"** is now purely the **live, current** data —
  no time-travel, no week-picker — interactive (real jump-link ids,
  `+ Add a Dependency` / `+ Report a Risk` links, edit/escalate/resolve
  actions). This is where every badge/jump-link still lands.
- **"Week-over-week"** has its own changelog list + its own, separate
  snapshot preview that updates when you click a week. It defaults to
  showing the latest week (same data "Dependencies & Risks" already
  shows), but **always renders read-only** — plain paired lists, no ids,
  no add-links — even when the latest week is selected, since this tab is
  explicitly a historical viewer, not a second place to make live edits.

`renderSnapshotSections()` now takes an `opts.readOnly` flag so it can be
called twice (once per tab) without colliding: the two calls would
otherwise both try to render `id="detail-deps-section"` /
`id="detail-risks-section"` / `id="detail-escalations-section"` into the
DOM at the same time, and duplicate ids break jump-links (`getElementById`
only ever finds one of them). Only the live "Dependencies & Risks" call
gets those ids now; the Week-over-week tab's copy omits them entirely.

Verified headlessly against all 15 real projects in `data.json` (fake-DOM
Node harness, with an id-registry check this time specifically to catch
duplicate ids): every project renders exactly 6 tabs/panels, zero
duplicate ids anywhere in the rendered tree (both before and after
clicking an older week in the new tab), and a jump-link to
`detail-risks-section` still correctly lands on the "Dependencies & Risks"
tab (not "Week-over-week," which no longer has that id at all).

**Project detail view is now tabbed (2026-09-30).** The full detail view
(opened by clicking a card, badge, Hawk-eye row/chip, or a Stage-gate
timeline row) used to be one long flat stack of `<h3>` sections —
Stage-gate timeline, Delay recovery, Time saved, Open follow-ups,
Fast-follow items, Progress over time, Schedule timeline, Dependencies,
Weekly Status, Risks/blockers, Escalations, Week-over-week changes,
Feedback history — meaning you had to scroll past everything you didn't
care about to reach the one thing you actually clicked in for. The
project name, status pill, PM, progress bar, and top-line facts (current
stage, next milestone, go-live, delay) still always show at the top, but
everything below that is now click-to-switch tabs (originally five; see
the "Week-over-week changes split into its own tab" note above — now six):
- **Stage-gate** (default tab) — the Stage-gate timeline, plus Delay
  recovery / Time saved / Fast-follow items when applicable.
- **Dependencies & Risks** — Escalations, Dependencies, Weekly Status
  (sprint completed/in-progress/next), and Risks/blockers for the live,
  current snapshot. (Originally also held the "Week-over-week changes"
  week-picker; that moved to its own tab — see above.)
- **Follow-ups** — Open follow-ups. Always present (with a "No open
  follow-ups" message) rather than only existing when non-empty, so the
  tab strip stays the same shape for every project and a "0 follow-ups"
  jump-link always has somewhere to land.
- **Schedule** — Progress-over-time trend chart and the (now-collapsible,
  see above) Date change log. (Originally also had a per-project
  calendar/Gantt here; removed — see "Removed the per-project
  calendar/Gantt" note above.)
- **Feedback** — Full feedback history.

Every existing anchor id (`stage-gate-timeline-section`,
`detail-deps-section`, `detail-risks-section`, `detail-escalations-section`,
`detail-followups-section`) still exists inside its respective panel
unchanged, so card-badge jump-links and any other direct link keep
working exactly as before — `openProjectDetail()` now just switches to the
right tab first (`DETAIL_SECTION_TAB_MAP` → `activateDetailTab()`) before
scrolling to the anchor, since `scrollIntoView()` on an element inside a
still-hidden (`display: none`) tab panel is a no-op. Tab switching is a
pure class toggle (`.detail-tab-btn.is-active` / `.detail-tab-panel
.is-active`) with no re-fetch or re-render, so it's instant either way.

Verified headlessly against every real project in `data.json` (a Node
harness with a minimal fake DOM, since no browser automation is available
in this environment): for all 15 projects, exactly 5 tab buttons / 5
panels render, exactly one of each is marked active at a time, the active
button and active panel always agree on which tab, and every jump-link
section id correctly activates its mapped tab with the target actually
receiving a `scrollIntoView()` call.

**Two new tabs + three new sections, grounded in a governance playbook
deck (2026-10-15).** A user shared an "IT Application Development Project
Management" slide deck describing a stage-gate process standard — in
particular, slide 15's "five logs every project maintains" (Change log,
Delay log, Decision log, Risk log, Issue log) and slide 13's Go-Live
approval package. Before building anything, I checked `data.json`'s
actual schema and found Risk log (`risks`) and a partial Delay log
(auto-detected shift log + freeform `delayNote`/`delayMitigation`/
`delayTradeoffs` text) already existed, but **Change log and Decision log
did not exist as structured data anywhere** — CRs were previously only
ever mentioned informally inside `delayTradeoffs` free text (e.g. "3 CRs
already approved — CR1 added 10 working days..."). Five new empty array
fields were added to all 15 projects so nothing broke: `changeRequests`,
`decisions`, `goLiveChecklist`, `delayItemLog`, `features`.

**Near-miss worth flagging:** the obvious name for the new narrative
delay log was `delayLog` — but that name is already taken by a
pre-existing, differently-shaped field (per-stage incident log:
`{id, date, stage, reason, team, member, days}`, append-only via
`delayLogSeq`, feeding the stage detail modal's Delay Analysis/Delay Log
tabs). Caught this before shipping by reading the Data model section
below and grepping `app.js` for existing `.delayLog` usages — reusing the
name would have silently corrupted that feature the first time either
field got real data (two incompatible shapes writing through the same
key). Named the new field `delayItemLog` instead; `MyBKY (Phase 1)`'s
pre-existing (empty) `delayLog` field was restored after an intermediate
rename-based script transiently removed it.

- **Change & Decisions** (new tab, after Stage-gate) — two structured
  logs: a **Change Request Log** (`buildChangeRequestLog()`) and a
  **Decision Log** (`buildDecisionLog()`). Both render a clean empty
  state ("No change requests logged yet" / "No decisions logged yet")
  since every project's new fields start empty — populating them with
  real entries is left to whoever maintains `data.json`. A "Five logs
  every project maintains" banner (see below, now clickable) sits above
  both. Both rebuilt (2026-10-15, per
  explicit request after seeing the deck's own "Decision Metrix" and
  "Change Request" table screenshots — slide 19, the same "these and the
  last two are templates on how things should be added" request that
  confirmed the wide-table pattern for every log in this file) as real
  `<table>`s with every column shown distinctly instead of merged into
  shared cells:
  - **Change Request Log**: Change Request, Description, Submitted
    Date, By Whom, Action Item, "Approved for current phase / Moved to
    next phase", Impact — 7 columns.
  - **Decision Log**: Decision, Description, Date Taken, By Whom — 4
    columns (Description used to be merged under the Decision title).
- **Features — removed, then restored, same day (2026-10-15).** A
  "Features" tab (every feature/capability as its own row, with the same
  7 KPI cards the deck's MyBKY example used) was built, shared for
  review, and explicitly pulled ("dont know if we need features") before
  it had even been approved. Following this file's existing
  `milestones`-field precedent for deprecating without deleting,
  `buildFeatureTracker()`/`buildFeatureKpis()` and `data.json`'s
  `features: []` field were left in place, unused — only the tab button,
  its panel, and its `DETAIL_SECTION_TAB_MAP` entry were removed. A few
  turns later, explicitly restored ("Also bring the features back -
  lets keep those") — same functions, same data field, untouched the
  whole time; only the tab wiring needed reinstating. Net effect: the
  Features tab exists in the final build after all, same as before this
  whole back-and-forth. Then audited against the deck's live MyBKY
  example (slide 20) — "anything missing?" — and brought to parity:
  table rebuilt onto the shared `.wide-log-*` scaffolding with the
  deck's own 7 columns (SP, Type, Feature/Capability, Status, Notes,
  Planned/Actual, Delay Reason) instead of merging Notes/Delay Reason
  under the feature name; KPI cards gained a computed subtitle
  (`featureKpiSubtitle()` — the shared `notes`/`delayReason` text if
  every item in that bucket agrees on one, else the distinct sprint
  numbers involved, since there's no dedicated field for this); and the
  deck's own 2-bullet "Reference Note" disclaimer (what Planned/Actual
  dates measure, what's still outstanding before Go-Live) was added
  below the table, static/generic rather than per-project data.
- **Go-Live readiness checklist** (new section inside the existing
  **Stage-gate** tab, below the timeline) — the fixed 7-item "Go-Live -
  Approval Package" from slide 13 (SIT, Regression Testing, UAT, Cyber
  Security Testing, Performance Load Testing, Change Management, RGC
  Approval), via `buildGoLiveChecklist()` / the `GOLIVE_CHECKLIST_ITEMS`
  constant. `p.goLiveChecklist` only needs to list items that have moved
  off "Not started" — anything missing defaults to "Not started," so this
  cost zero data entry for any existing project while still being
  immediately usable once someone starts filling it in.
- **"Who leads each stage" reference** (new static panel inside the
  **Stage-gate** tab, next to the color legend) — `buildRaciReference()` /
  the `RACI_STAGES` constant, from slides 6/11/12's track-ownership
  model (BA leads Requirements, PM leads Planning & Production
  Readiness, Architecture leads Design, Development leads Development,
  QA leads Testing, Cyber Security leads Security Validation, DevOps
  leads Deployment). Deliberately kept the playbook's own stage names
  (not force-mapped onto this dashboard's 9 `PIPELINE_STAGES`) since the
  two models are close but not identical — relabeling them would imply a
  false precision the deck never claimed.
- **Delay (new consolidated tab, 2026-10-15)** — a user explicitly asked
  to pull delay content out of the Schedule tab into "its own tab with
  Logs — things that show up when I click on the grid," so instead of
  needing to click a Grid cell to see one stage's delay breakdown, this
  tab aggregates everything delay-related, project-wide, in one place:
  - A **"Five logs every project maintains"** banner at the top (see
    below, now clickable) — **removed 2026-10-16**, see the dedicated
    note further down for why.
  - **Schedule timeline** (moved here from the Schedule tab, same
    `detailScheduleSection` id/content, unchanged) — the auto-detected
    Go-Live/milestone date-move log.
  - **Reported delay log** (moved here from the Schedule tab,
    `buildDelayLogTable()`, reading `delayItemLog` — see the near-miss
    note above for why it's not called `delayLog`): the narrative
    companion to the auto-detected log above — root cause, who's
    responsible, what action was taken, and open/closed status. Rebuilt
    (2026-10-15) as a real, horizontally-scrollable `<table>` with all 11
    columns from the deck's own sample Delay Log table, shown
    side-by-side rather than merged into fewer card-style cells: Delayed
    Item, Description, Reported Date, Impacted Phase, Impact
    (Time/Cost/Scope), Root Cause, Responsible, Action Item, Action
    Taken, Status, Closure Remarks. The first version of this table
    condensed several of these into shared cells and never displayed
    Reported Date at all — caught after the user shared the deck's actual
    table screenshot.
  - **Delay attribution (all stages)** — `buildStageAnalysisPanel()`,
    the exact same team/member/reason breakdown the stage detail modal
    shows for one stage at a time (reached by clicking a Grid cell),
    now called with the project's full, unfiltered `delayLog` so it
    covers every stage at once.
  - **Delay log entries (all stages)** — the stage detail modal's
    searchable/sortable "Manually reported delay log" table, extracted
    into its own `buildManualDelayLogSearchTable()` function (so it can
    be reused here without double-rendering the auto-shift section
    above it) and called with the same unfiltered `delayLog`. A new
    "Stage" column was added to this table so project-wide rows (which
    now span different stages) are still distinguishable — a harmless,
    always-the-same-value column when this same function renders inside
    the single-stage modal.
  - `DETAIL_SECTION_TAB_MAP["detailScheduleSection"]` now correctly
    points to `"delay"`. (This id wasn't actually a key in that map
    before this change, despite the Grid tab's "click a project name"
    handler jumping to it — meaning that click likely silently fell
    back to the map's `"stagegate"` default instead of landing on
    Schedule. Fixed as a side effect of this move.)
- **"Five logs every project maintains" banner** (`buildFiveLogsBanner()`
  / `FIVE_LOGS` constant, **removed 2026-10-16** — see the dedicated note
  further down) — originally a faithful SVG/CSS reproduction of slide
  15's 5-icon graphic (Change/Delay/Decision/Risk/Issue log), not an
  embedded raster image (consistent with the rest of this dashboard).
  Shown on both the Change & Decisions tab and the new Delay tab.
  **Made clickable, 2026-10-15** ("I like this - why not just make
  these clicable where things show and just nothing if its empty"):
  each `FIVE_LOGS` entry carried a `sectionId` (where that log's
  content actually lives) and a `count(p)` function (how many entries
  the current project has for it) — an icon was only clickable when
  `count(p) > 0` for the project currently open, otherwise genuinely
  inert (dimmed, no listener, not just visually disabled). Superseded
  entirely once the icon-tile strip above these tabs started covering
  the same 5 destinations (see "'Five logs' banner removed" below).

Final tab order: Schedule → Delay → Week-over-week → Stage-gate → Change
& Decisions → Features → Dependencies & Risks → Follow-ups → Feedback (9
tabs total, up from 6 pre-deck — Features was added, removed, and
restored, all the same day, netting out to +2 tabs overall: Delay +
Features; the 9th, Follow-ups, predates this whole deck-driven round).

**Shrunk to icon-only buttons, then to a labeled list, both 2026-10-16.**
First shrunk to icon-only square buttons ("this is a lot of tabs - can
we shrink them - and just put icons for them that people can click and
go to"): each `DETAIL_TABS` entry gained an `icon` (a single
emoji/glyph — 📅 ⏳ 📈 🧭 ⇄ ✨ ⚠ 🔁 💬, in tab order), with the full
label surviving only as a `title` tooltip on hover. Minutes later,
changed again ("I want to see how we can view all the things in the
list and then details can be found when they click on things - so all
the icons show in the list") — the tooltip-only label didn't satisfy
"see all the things in the list" at a glance, so the strip became a
vertical list instead: each row now shows the icon AND the full label
side by side, one row per tab, click anywhere on the row to jump to
that section. Same `.detail-tab-btn`/`.detail-tab-panel` classes and
`activateDetailTab()` switching logic throughout both changes — only
the markup (icon span + label span) and CSS (horizontal icon-only strip
→ vertical bordered list) changed. Where a couple of the icons double up
with icons already used elsewhere (Delay ⏳ matches the Five Logs
banner's Delay log icon; Change & Decisions ⇄ and Dependencies & Risks
⚠ likewise match the banner's Change log and Risk log icons) that's
intentional — those tabs house exactly that content.

**Rebuilt into a single-open accordion, same day (2026-10-16) — the tab
list and the "Weekly status report" widget merged into one.** The
labeled-list version above lasted only a few minutes before a user,
looking at both the tab list and the Weekly Status Report widget above
it side by side, said: *"these are duplicates - all the top should just
link to the icons... merge the top with the icons and just have icons
with 1 row info and when I click on them things expand below to show
all the details."* Confirmed via follow-up questions: single-open
accordion (opening one row collapses any other open row), all rows
start collapsed, and jump-links auto-expand + scroll to the right row.

- Each row was a clickable header (icon + label + a one-line **teaser**
  + a chevron that rotates 90° when open) plus its `.detail-tab-panel`
  body nested directly underneath, collapsed by default. The 9 panels
  (`stagegatePanel`, `depsRisksPanel`, etc.) and their internal content
  were completely unchanged from the tab-list version — only how
  they're shown/hidden and where they live in the DOM changed.

**Rebuilt again, same day, into a HORIZONTAL icon-tile strip.** Minutes
later a user, pointing at the vertical accordion's icon+label rows next
to a screenshot of the Five Logs banner, said: *"make these horizontal
and I want icons like these (second image) horizontally."* The 9
`.detail-tab-tile` buttons now sit side by side in a wrapping flex row
— each one a circular icon badge above its label above its one-line
teaser, deliberately styled to match `.five-logs-item`/`.five-logs-icon`
(same 34px circle, soft-accent default fill, solid-accent fill +
card background/shadow when selected) so the two icon strips in this
view read as one visual language. Structurally this meant splitting
tiles and panels into two separate flat sibling lists instead of one
nested accordion row per tab — a tile and a panel no longer live next
to each other in the DOM, since there's no room for a panel to expand
directly under a tile once tiles sit side by side:
- `.detail-tabs-h` (`role="list"`) holds the 9 `.detail-tab-tile`
  buttons, each with a `.detail-tab-tile-icon` circle, a
  `.detail-tab-tile-label`, and a `.detail-tab-tile-teaser` (reusing the
  exact same `tabTeaser()` output as before — Schedule's mini progress
  bar included, just shrunk further to fit under a 96px-wide tile).
- `.detail-tab-panels` holds the 9 `.detail-tab-panel` divs as flat
  siblings, below the whole tile strip. The panels and their internal
  content are completely unchanged from both prior versions.
- `activateDetailTab(root, tabId)` (same signature) now toggles
  `.detail-tab-tile`s and `.detail-tab-panel`s as two separate
  `querySelectorAll` passes matched by `data-tab`, instead of walking
  nested accordion rows — same single-open / all-collapsed-by-default
  behavior, same jump-link auto-expand (`openProjectDetail` still
  scrolls straight to the target anchor inside whichever panel just
  got activated).
- **`tabTeaser(tabId, p)`** (new) computes each row's one-line summary —
  deliberately a count or status, never a content preview, so a row
  never grows past one line no matter how much data a project has
  ("share high level delay counts or details... when the user clicks on
  it - it shows all the delay logs things that are present"):
  - **Schedule** — the Progress bar + percentage itself (*"schedule
    should show progress"*), via `.detail-tab-btn-progress` (a shrunk
    version of the same `.progress-track`/`.progress-fill` markup used
    everywhere else). Expanding Schedule now also shows the full
    Current Stage/Next Milestone/Go-Live/Status fact list
    (`buildProgressFactsList(p)`, moved in from the deleted Weekly
    Status Report widget's old Progress row) above the existing
    Milestones list and Progress-over-time trend graph.
  - **Delay** — status ("On schedule" / "+N days") plus a count of
    logged delay-log entries (`delayItemLog.length + delayLog.length`,
    the same count `FIVE_LOGS` already used for the Five Logs banner's
    Delay icon).
  - **Week-over-week** — count of weekly snapshots logged (or "No
    history logged yet").
  - **Stage-gate** — current stage name + its target date (reuses
    `currentStageTargetDate()`).
  - **Change & Decisions** — "N change requests · M decisions".
  - **Features** — "X of Y features done" (or "No features tracked
    yet").
  - **Dependencies & Risks** — "N risks · M dependencies · K issues"
    (merging what used to be three separate Weekly Status Report rows
    — Risks, Issues, Dependencies — into one row's teaser, since they
    all expand into the same panel anyway).
  - **Follow-ups** — count of open follow-ups (`openNotesFor(p.id)`).
  - **Feedback** — count of feedback entries logged for the project.
- `activateDetailTab(root, tabId)` (same name, rewritten body): opens
  the row matching `tabId`, closes every other row, and toggles each
  row's panel `.is-active` state to match — pass a falsy `tabId` to
  collapse everything. The click handler on each header computes
  whether the row *will* open (i.e. it's currently closed) before
  calling this, so clicking an already-open row's header toggles it
  closed instead of doing nothing.
- `openProjectDetail(id, focusSectionId)` (jump-links from card badges,
  etc.) is unchanged — it already called `activateDetailTab(root,
  DETAIL_SECTION_TAB_MAP[focusSectionId])` before scrolling, which maps
  perfectly onto "auto-expand the right row, close everything else."
- `buildWeeklyStatusReport()` and its helpers were deleted outright (see
  the superseded note above) rather than kept as dead code.

Verified two ways, re-run after the horizontal-tile rebuild too: (1)
headlessly against all 15 real projects — exactly 9 tiles in the
documented order, all starting collapsed (`aria-expanded="false"`, no
matching panel `.is-active`), every tile's teaser non-empty, the
Schedule tile's teaser specifically rendering the mini progress bar
(not plain text), `activateDetailTab()` opening exactly one tile +
its matching panel and closing/deactivating the rest (and collapsing
everything when passed a falsy tabId), every jump-linkable anchor id
present and inside the right panel, the Current Stage/.../Status fact
list appearing exactly once in the entire detail root (inside the
Schedule panel, not duplicated), no leftover `.weekly-report` nodes
anywhere, no duplicate DOM ids, and the stage detail modal's Delay
Analysis/Delay Log (reached via Grid cell click) still rendering
unchanged; (2) against synthetic populated data (a project temporarily
given real-shaped CR/decision/delay-log/RAID/feature entries, not
committed to `data.json`) — confirmed every tile's teaser reflects the
synthetic counts correctly (e.g. "3 risks · 1 dependency · 1 issue",
"1 of 3 features done"), CR
approval-status badges and Go-Live checklist completion counting still
render correctly inside their now-nested panels, and
`openProjectDetail(id, "raid-log-section")` auto-expands the
Dependencies & Risks row (and only that row) before scrolling.

**Current-stage overview card, embedded in the Stage-gate panel
(2026-10-16).** A user shared a screenshot of the per-stage detail
modal's Overview tab (opened by clicking a stage cell in the Grid tab —
Start Date / Completion Date boxes with initial/latest/actual dates and
a variance pill, a Stage Progress bar, and 3 KPI cards for stage
duration / log entries / project delay) and asked: *"I want this image
view in the details too - wherever it make sense."* Confirmed via
follow-up questions: embed it for the **current stage only**, inside
the **Stage-gate** panel, above the existing stage-gate timeline — and
keep the Schedule panel's existing Current Stage/Next Milestone/
Go-Live/Status facts list exactly as-is rather than replacing it with
this (the two serve different purposes: Schedule's facts list is a
compact one-paragraph summary across the whole project; this card is a
richer, stage-scoped breakdown with real planned-vs-actual date
tracking).
- New `buildCurrentStageOverviewCard(p)` computes the same inputs
  `buildStageDetail(p, stage)` already computes for the modal (stage
  segment from `computeStageSegments()`, elapsed days, `stagePlan`
  entry, `stageDelayLog()` entries) for `p.stage` specifically, then
  calls the exact same `buildStageOverviewPanel()` the modal's Overview
  tab uses — so the date boxes, progress bar, and KPI cards are
  pixel-for-pixel the same rendering code, not a reimplementation.
  Wrapped in a `.current-stage-card` with a kicker ("CURRENT STAGE · N
  OF 9") + the stage name as a title, and a "View full stage history →"
  line underneath that leads to the real per-stage modal
  (`openStageDetail`) for anyone who wants the modal's other 3 tabs
  (Date History, Delay Analysis, Delay Log) — this card is an
  at-a-glance summary, not a replacement for that drill-down.
- Returns `null` (renders nothing, no "Current stage" heading either)
  for a project with no valid current stage on record — i.e. `p.stage`
  unset or not one of the 9 `PIPELINE_STAGES` (the "Unstaged" case).
  Every one of the 15 real projects has a valid stage today, so this
  path is only exercised by a synthetic test.

**Whole card made clickable, same day.** Originally only the small
"View full stage history →" link opened the per-stage modal — a user
clicked one of the date boxes/KPI cards expecting that to work too:
*"when i click on the boxes the top pop up shows up anyways. make it
such a way that people know they can click on it."* Confirmed via
follow-up questions: the **entire card** became one click target
(not just the 3 KPI boxes), with a **hover cursor + border/shadow
highlight** as the "you can click this" signal. The card itself now
carries `role="button"`, `tabindex="0"`, and both `click`/`keydown`
(Enter/Space) listeners calling `openStageDetail(p.id, stage)`; the
"View full stage history →" text became a plain non-interactive
`<span>` (no listener of its own — the surrounding card handles the
click, so there's exactly one way this action gets triggered, not two
competing handlers that could double-render the modal).

Verified: all 15 real projects render exactly one `.current-stage-card`
inside the Stage-gate panel, titled with that project's actual
`p.stage` value, containing the reused `.stagedetail-datebox-row`/
`.stagedetail-stat-row` structure, correct `role="button"`/
`tabindex="0"`/click-listener attributes on the card itself (and
confirmed the "View full stage history" text has **no** listener of
its own), and — invoking that click listener directly — the real
per-stage modal (`#stageDetailContent`) actually gets populated with
that project's current stage; a synthetic unstaged project
(`stage: "Unstaged"`) renders zero cards and
`buildCurrentStageOverviewCard()` returns `null` directly, confirmed
both via a direct function call and via the full `buildProjectDetail()`
render.

**"Five logs" banner removed; icon-tile strip now a single row
(2026-10-16).** With the horizontal icon-tile strip now covering all 9
destinations up top, a user looked at the Change & Decisions tile
expanded (teaser: "0 change requests · 0 decisions") with the old
"Five logs" banner showing underneath it and pointed out: *"changes and
decisions and risk too and then the icon below takes them to risks
again - don't need duplicates. And I want all icons in one row."*
- **Banner removed outright.** Every single one of its 5 icons had
  become a duplicate of a tile already in the main strip — Change log
  and Decision log duplicated the very "Change & Decisions" tile the
  banner lived inside (clicking either just scrolled within the same
  already-open panel), Risk log and Issue log duplicated "Dependencies
  & Risks," Delay log duplicated "Delay." `buildFiveLogsBanner()` and
  the `FIVE_LOGS` constant were deleted outright (not kept as dead
  code), along with both call sites (`changeDecisionsPanel`/
  `delayPanel`) and all `.five-logs-*` CSS.
- **Icon-tile strip forced into one row.** `.detail-tabs-h` switched
  from `flex-wrap: wrap` (which let 9 tiles spill onto a second row of
  3 at typical widths) to `flex-wrap: nowrap` with each
  `.detail-tab-tile` set to `flex: 1 1 0; min-width: 82px` — tiles
  shrink evenly to fit the available width instead of wrapping.
  `overflow-x: auto` on the strip is a safety net for very narrow
  viewports where even the `min-width` floor can't fit all 9 (scrolls
  horizontally instead of wrapping).

Verified: all 15 real projects' Change & Decisions and Delay panels
confirmed to no longer contain any `.five-logs-banner` node (both via
the real-project loop and a repeat check against the synthetic
populated-data project), and the tile strip container still carries
`.detail-tabs-h` (now `flex-wrap: nowrap` per the stylesheet) with all
9 tiles present and correctly ordered.

**"Weekly status report" summary widget — superseded, 2026-10-16.** For
about an hour this session there was a standalone 6-row widget
(`buildWeeklyStatusReport()`, Progress/Risks/Issues/Decisions/
Dependencies/Upcoming milestones) sitting above the tab list, built per
slide 15 of the governance deck. It went through two rounds of fixes
(Issues no longer blending with Risks; Progress gaining the full
Current Stage/Next Milestone/Go-Live/Status fact list) before a user
pointed out it now duplicated the tab list right below it and asked for
the two to merge into one — see "Single-open accordion" below for what
replaced it. `buildWeeklyStatusReport()`/`weeklyReportRow()`/
`weeklyReportTeaser()` were deleted outright (not deprecated-in-place
like the `milestones`/`features` fields elsewhere in this file) since
nothing else referenced them.

**Grid card "Current Stage" clamped to 2 lines (2026-10-16).** A
project's optional free-text `phase` field is meant to be a short
secondary detail (e.g. `Pledge – 1.0`'s `"Hypercare (90% complete)"`),
but nothing stopped it from being much longer — `Pledge - 1.x`'s `phase`
is an audit-trail-style rationale paragraph (why its stage was advanced,
dated, with a caveat about unconfirmed reports), and on the Grid card
that blew the card's height way out, making it feel cluttered ("there is
a lot of info in current state - this card needs to be clean and
clear"). Fixed with CSS only — `.phase-fact-detail` is now clamped to 2
lines with an ellipsis on the Grid card specifically
(`.card-facts:not(.detail-facts)`, so the full, un-clamped detail view
is unaffected), and the full text is still available via a native
`title` tooltip on hover so nothing is actually lost, just hidden until
you ask for it.

**"Delay" fact relabeled to "Status" (2026-10-16).** A user pointed at
this row showing "On schedule" under the label "Delay" and flagged
`delay = Status` — the value here has always been a status-like signal
("On schedule" or "+N days"), so a label of "Delay" read oddly when
there wasn't one. Relabeled the `dt` from "Delay" to "Status" in both
places it appears (the Grid card's fact list and
`buildProgressFactsList()`); the underlying `p.delayDays`/`isLate` logic,
CSS classes (`delay-flag`/`is-late`/`is-ontime`), and the separate
"Impact of delay" row (only shown when late) are all unchanged — this
was a label-only fix (note: this fact row now lives inside the Schedule
accordion row, not a separate "Weekly status report" widget — see
"Single-open accordion" below).

**`milestones` field revived (2026-10-15).** This field existed in the
schema/README since 2026-09-30 (documented as "CURRENTLY UNUSED... left
in as-is in case a future feature wants it back") but, on inspection, had
actually never been added to any of the 15 projects in `data.json` — the
README's claim that it was "left in the sample data" was stale. Added
`milestones: []` to all 15 projects to back the Schedule tab's
Milestones section (and, briefly, the now-superseded Weekly Status
Report widget's "Upcoming milestones" row).

**RAID Log, added to the Dependencies & Risks tab (2026-10-15).** A user
shared slide 18's sample table (same "Weekly Status Updates" slide series
the Delay Log table came from) — Risks, Assumptions, Issues, Dependencies
consolidated into one log: Item, Description, Reported Date, Action
Item, Targeted Completion Date, Responsible, Status, Closure Remarks.
This dashboard already had separate `risks`/`dependencies`/`escalations`
fields feeding their own sections, none shaped like this table and none
able to track **Assumptions** at all — so this is a genuinely new,
separate `raidLog` field (`buildRaidLogTable()`), appended below the
existing Dependencies/Risks/Escalations sections rather than replacing
them: those stay as the structured per-category views, RAID Log is the
single-table rollup across all four categories. Reuses the shared
wide-table scaffolding (`.wide-log-table-scroll` / `.wide-log-full-table`
— renamed generic the same day once the Change Request and Decision
logs were rebuilt onto it too), plus its own per-row **Type** pill
(Risk/Assumption/Issue/Dependency) —
the deck's own sample table has no such column, added anyway per
explicit request, since without it "RAID" is just a label with no way
to tell which letter a given row actually is. Verified against synthetic
data (an Assumption and a Resolved Issue entry, not committed to
`data.json`) — confirmed all 9 columns and type-pill styling render
correctly.

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

**"Cumulative Delay by Project" donut chart (2026-09-30)** sits right below
the KPI strip — the same total as the **Cumulative SLA Overage** KPI above
it, broken down by *which* projects are contributing to it instead of one
summed number. Only projects with overage > 0 get a slice (biggest
contributor first, clockwise from 12 o'clock); if nothing's over SLA across
the filtered set, it shows a "🎉 nothing over SLA" empty state instead of an
empty ring. Click a project in the legend to jump straight to its
Stage-gate timeline. Built on a new reusable `buildDonutChart()` — the same
component now also renders the stage detail modal's **Delay Analysis** tab
(see Tab 2's stage detail section below): the By Team / By Member / By
Reason breakdowns there used to be text-only bar lists; each now gets an
actual donut above its bar list too, matching the internal
admin-dashboard-mockup look those bar lists were already modeled on but
never got the visual chart for.

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

**"Portfolio total" row (2026-10-04)** — a bolded summary row pinned right
under the column headers, before any project rows, answering "how much has
each stage-gate cost me overall, across every project that's been through
it?" (a user asked for exactly this, aggregated per stage-gate column
rather than per project). Each cell shows the total real elapsed days spent
in that stage summed across every project that's reached it, plus — if any
of them went over — the combined SLA overage ("+Xd over, combined"); a
grey "—" if no visible project has reached that stage yet. Built from
`computeStageCostTotals()`, which sums the exact same per-project
`computeStageSegments()` output each individual cell above it is built
from, so the totals row and the column of cells beneath it always
reconcile. Visually distinguished from project rows with a bolder bottom
border and a tinted name cell, and intentionally not clickable (it's a
sum across projects, not a single project's cell) — hover/focus styles are
suppressed on it for that reason.

Verified against a fully independent re-derivation (summing raw
`computeStageSegments()` output directly, bypassing both the totals-row
code and the grid-cell rendering) for all 9 stage columns against the real
portfolio — every column's total days, overage, and project count matched
exactly (e.g. Requirements: 545d total / 475d over across 7 projects;
Development: 316d / 212d across 5; the two most expensive stage-gates in
the current portfolio).

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

**Data-accuracy pass (2026-09-30):** re-verified every `stagePlan` date
against the source deck (22-Sep-2026 review PDF) after suspiciously round
"+100d"-style overage numbers turned up on the Hawk-eye tab. Found and
fixed: (1) `webnext-2`'s `stage` was stuck on "Requirements" though the
deck said it was already complete — was accumulating fake elapsed-to-today
overage; (2) `mybky-phase1`'s `stagePlan.UAT` actually held VAPT's dates (no
VAPT entry existed at all) and `stage` was one stage behind what the deck's
own dependency notes described; (3) `baps-sso` had no `stagePlan.Development`
entry at all, so its overage calc silently fell back to "the first week we
happened to see it" instead of the deck's real (earlier) start date,
*under*-reporting the delay. `mymandir`'s `stagePlan.UAT`/`VAPT` were also
corrected (same swapped-dates issue) though not yet visible in the UI since
that project hasn't reached UAT yet. Lesson: a `stage` field is only as
trustworthy as it is kept in sync with `stagePlan`/history — a stage that's
actually complete but never advanced will make its overage grow forever
against "today" instead of stopping at its real end date.

Also fixed as part of the same pass: `baps-sso`'s `goLive` was stale leftover
data from before it was renamed to "SSO V2" (`2027-01-04` vs. the deck's
actual `02-Nov-2026 → 06-Nov-2026` Go-Live window — corrected to
`2026-11-06`), and `mymandir`'s `goLive` was off by one day (`2026-10-31` vs.
the deck's `2026-10-30`).

**Not verifiable against the 22-Sep-2026 deck:** `webnext` (plain),
`pledge` (Pledge – 1.0), `spm`, `bkms`, `mis`, `mysatsang-bapsid`, and
`mymandir-1c` don't have a section in that particular week's review — no
data in it to cross-check them against. `gms`'s Development/QA/UAT/VAPT
rows had a table structure that didn't survive the deck's PDF text
extraction cleanly (line-wrapped multi-value cells with no reliable column
separators) and GMS's own deck also uses a bespoke stage list ("QA" as its
own row, separate from "Development") that doesn't map 1:1 onto this
dashboard's canonical 9 stages — left as-is rather than guessing. The
deck's "SPM 1A (Dashboard – One Screen)" section also doesn't match the
existing `spm` project's state (SPM 1A's own plan hasn't even started TDD
yet, while `spm` is already in Hypercare from an earlier release) — it's
very likely SPM 1A needs to be tracked as its own new project rather than
merged into `spm`, but that's a scope decision, not something to silently
assume.

**Hidden (not deleted) projects (2026-09-30):** cross-checked both the
15-Sep-2026 and 22-Sep-2026 weekly decks — `webnext` (plain "WebNext"),
`pledge` (plain "Pledge – 1.0"), `bkms`, `mis`, and `mysatsang-bapsid` don't
have an individual project status section in *either* week (not just a
one-week fluke). Set `hidden: true` on each (plus a `hiddenNote` explaining
why) rather than removing them — they're excluded from `visibleProjects()`
and every filter dropdown (project/owner/team/feedback-form), but the
underlying record and history are untouched, so un-hiding is just flipping
the flag back if one of them shows up in a future deck. `mymandir-1c` and
`spm` were double-checked too — both do have a section in at least one of
the two decks, so they stayed visible.

**`pledge-1a` fully populated (2026-09-30):** this project had *no*
`stagePlan` at all despite the deck having a fully-dated 8-row table for it
(zero delays reported anywhere) — its Hawk-eye row was barely rendering
anything. Populated the full plan from the deck and advanced `stage` from
"Tech. Design" to "Development" (today's date falls inside the deck's own
un-delayed Development & QA window; there's no fresher report confirming
this actually happened on schedule, which is noted directly in the
project's `phase` field as a caveat).

That exposed a more general gap: `computeStageSegments()` closes out a
stage segment at "today" whenever the live `stage` has moved past the last
real weekly snapshot with no fresher snapshot to mark exactly when — which
is right when a transition was genuinely just reported, but wrong when
we're inferring an advance purely from `stagePlan`'s own forward dates
outrunning the last snapshot (as with `pledge-1a`: its last real snapshot
was 3+ weeks old). Added a correction: when that synthetic "today" boundary
had to be injected, and the closed-out stage has a real `stagePlan` end
date on record, use that instead of "today" for its segment end. This
doesn't fix an imprecise *start* date inherited from history (that would
require rewriting historical snapshots, which risks fabricating certainty
about what an earlier week's deck actually said — left alone) — only the
end.

**`track` field on dependencies/risks (SSO V2 only, 2026-09-30):** SSO V2's
source deck actually has two separate tables — "SSO V2 (Development)" and
"SSO V2 (Implementation)" (the app-onboarding rollout schedule) — each with
its own dependency/risk list, both merged into the single `baps-sso`
project record. Rather than splitting SSO V2 into two project cards (it
doesn't cleanly fit two Hawk-eye rows — the Implementation track's
`Phase 1/2/3 × Onboarding/Implementation/Review` structure doesn't map onto
the standard 9-stage pipeline at all), each dependency/risk that came from
one of these two tables has a `track: "Development" | "Implementation"`
field, rendered as a small amber tag next to the item (list row and the
item-detail modal). Optional on every project; only set where the source
deck actually had more than one such table to merge.

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
- **Dashed outlined chip strip** — every stage the project hasn't
  reached yet, grouped into one compact strip right after the current
  stage's block, in pipeline order. These are **not date-plotted on the
  board** — with 9 possible stages, chaining each remaining one
  individually by its own (often tiny, 5-14d) SLA width at a multi-month
  calendar zoom made them squeeze into unreadable, overlapping slivers, so
  they're rendered as fixed-size chips sized by content instead. Each
  chip's **hover tooltip and click-through do carry a potential target
  date**, though (see below) — the strip itself just isn't positioned by
  it.
- Any *dated* block (done/current) gets a small red **"+Xd"** appended to
  its label if that stage ran (or is running) over its own SLA.
- A per-row **"Xd cumulative delay"** line under each project's name sums
  the SLA overage across every stage it's been through — the per-project
  version of the Grid tab's portfolio-wide "Cumulative SLA Overage" KPI.
- A blue "Today" line runs through every row.
- The calendar plots the **full, real date range** — nothing is capped,
  clipped, or squeezed. It's laid out in real pixels-per-day and lives
  inside a horizontally scrollable panel (`.hawkeye-scroll-inner`), so a
  long-running outlier stage widens the *scrollable* area instead of
  squeezing every other project's activity into an unreadable sliver.
  The row-name/cumulative-delay label column stays pinned to the left
  edge (`position: sticky`) while you scroll. On load, the board
  auto-scrolls so "today" sits a comfortable distance from the left edge
  of the visible area rather than opening at the very start of the range.
- A **Month / Week zoom toggle** in the toolbar switches the whole board
  between two densities: **Month** (5px/day, quarter gridlines — the
  default) and **Week** (16px/day, weekly gridlines, Monday-anchored) for
  anyone who wants finer-grained precision at the cost of more scrolling.
- The future-stage chip strip (see below) always has enough room
  reserved after each row's last dated block — never overlapping or
  competing with it — because it's included in the same width
  computation as everything else on the board.

Click any row or block to open the full detail view, scrolled straight to
the Stage-gate timeline. Adapted from the same "Project States in Calendar"
concept in the internal admin-dashboard mockup mentioned in Tab 2, rebuilt
with our real stage-gate data instead of copying its design system.

**Header/gridlines: quarters, not months (2026-09-30).** The top header
row and the vertical gridlines behind the rows used to mark every
individual month (e.g. Jul/Aug/Sep/Oct/Nov/Dec 2026 — 6 labels competing
for space with the row content). At the calendar's ~130-167-day span,
that's overkill — chunked to quarter boundaries instead ("Q3 2026", "Q4
2026", ...), which is normally just 2-3 labels, leaving the row content
in the center of the board much more room to read clearly.

**Dashed "planned" chips made legible (2026-09-30).** The not-yet-reached
future-stage chip strip was rendered with a transparent background and a
very light border/text color (`var(--line-strong)` / `var(--ink-faint)`)
that nearly disappeared against the board's light background, especially
at the strip's small chip size. Chips now get a subtly tinted background,
a darker dashed border, and darker text (still visually distinct from the
solid done/current blocks, so the "this is a plan, not a real date range"
meaning is preserved) plus a slightly larger font/padding so the stage
codes are actually readable at a glance.

**Potential target dates for upcoming stages (2026-09-30).** Future
(not-yet-reached) stage chips used to say only "planned, not started" on
hover, with no date at all — `buildHawkeyeBlocks()`'s SLA-chain estimate
for each future stage existed internally (used to size the placeholder
chip strip) but was never surfaced. Now:
- **Hovering** a future chip in Hawk-eye shows its potential target date
  range in the tooltip.
- **Clicking** a future chip opens that specific stage's detail modal
  (same `openStageDetail()` used elsewhere) instead of just the row's
  general project detail.
- The per-project detail view's **Stage-gate timeline** section now lists
  every not-yet-reached stage below the real done/current rows (dashed,
  "Not started"), each clickable the same way.
- The stage detail modal's Start/Completion date boxes fall back to the
  same estimate, suffixed `(estimated)`, when a future stage has no real
  `stagePlan` entry yet.

Target-date sourcing prefers a **real `stagePlan[stage]` entry** when the
deck already has one on record for a stage the project hasn't reached yet
(confirmed to exist for several projects — e.g. `pledge-1a`'s UAT/VAPT/
Rollout/Hypercare, `mymandir`'s UAT/VAPT/Rollout — via `stagePlan`'s
`latestStart`/`latestEnd` or `initialStart`/`initialEnd`), shown as
"Planned target" with no estimate caveat. Only falls back to the
SLA-chain guess ("Potential target ... (estimated)") when no such entry
exists. Both Hawk-eye and the project-detail timeline pull from the same
`buildHawkeyeBlocks()` output, so the two views can never disagree with
each other about a given stage's target.

**No more hidden/clipped blocks — scrollable timeline + Month/Week zoom
(2026-09-30).** The previous "130-day span, capped to the recent side"
design silently hid data: any block starting before the calendar's
left-hand cutoff got rendered from the cutoff edge rather than its true
start, with the real range only visible on hover (e.g. `MyBKY (Phase 1)`'s
Requirements stage — real range `Nov 8 → Jun 25`, `+219d over SLA` — was
showing as a barely-there sliver labeled just "TD"). That cap existed
because `.hawkeye-row-track` used to be an *elastic* flex child
(`flex: 1 1 auto`) that always stretched to fill whatever width its row
had, so without a cap, one outlier project would squeeze every other
project's real (usually recent) activity down to unreadable slivers too.

Fixed by rebuilding the whole board around **real pixel-per-day
positioning inside a horizontally scrollable panel** instead of
percentage-of-elastic-container positioning:
- `.hawkeye-scroll-inner` (new) wraps the header + all rows and scrolls
  horizontally (`overflow-x: auto`); `.hawkeye-row-track` is now
  `flex: 0 0 auto` — a fixed pixel width, never stretched or squeezed.
- `.hawkeye-row-label` (the project name / cumulative-delay column) is
  `position: sticky; left: 0;` so it stays pinned and readable while the
  timeline scrolls underneath/beside it.
- Layout is computed in two passes: pass 1 walks every row to figure out
  each block's real pixel position/width and the widest any row needs to
  be; pass 2 builds the DOM using that shared final width for every row,
  the header, and the gridlines, so everything stays aligned no matter
  which row happens to be the widest.
- A new **Month / Week zoom toggle** (`.hawkeye-toolbar`) lets you switch
  between the default month-ish view (quarter gridlines, 5px/day) and a
  week view (weekly Monday-anchored gridlines, 16px/day) for finer
  precision — same underlying data, just replotted at a different scale.
- The board auto-scrolls to a sensible starting position (today, with a
  little lead-in) on load/re-render, rather than opening at the very
  start of the (now much wider) scrollable range.

No date range is ever capped or clipped anymore — scroll left/right (or
switch to Week zoom) to reach anything that doesn't fit in the initial
view. Verified headlessly against real `data.json` (a Node harness with a
minimal fake DOM exercising `renderHawkeye()` end-to-end): all 63 stage
blocks across the 10 visible projects render with non-negative,
un-clamped pixel positions, including the previously-clipped `MyBKY
(Phase 1)` Requirements block, which now renders at its full real width;
the Month↔Week zoom toggle was also exercised via a simulated click and
correctly re-renders at the new density.

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
"Weekly Project Update" template, from the repo's Issues tab. (The
dashboard's own **"Submit weekly update"** button was removed 2026-10-16
per explicit request — *"remove all the buttons for weekly updates. Except
for feedback and risks and dependencies and escalations"* — the
`pm-weekly-update` skill below is the dashboard-side path now; the issue
form still exists and still works if you'd rather file it by hand or you're
not using the skill.) Leave any field blank to keep last week's value for
that field.

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

### Alternative: the `pm-weekly-update` Q&A skill (2026-10-16)

A user asked: *"I need to create a skill that is used like a Q and A that
will allow PMs to fill in all the details. They invoke the skill and talk
with it to add alll the data week over week"* — clarified to be: a
project skill usable from **both Cursor and Claude** ("do A but it can be
used with claude or cursor"), covering **every** field including the newer
ones the issue form doesn't have yet ("yes cover it all" —
`changeRequests`, `decisions`, `goLiveChecklist`, `raidLog`, `features`,
`milestones`, `delayItemLog`), and writing straight into the dashboard
rather than filing an issue and waiting for the scheduled bot ("it should
just load all the data into the dashboard").

Lives at `.cursor/skills/pm-weekly-update/` (`SKILL.md` + `reference.md`),
with `.claude/skills/pm-weekly-update` symlinked to it so either tool
discovers the same content — one canonical copy, no drift. The skill
interviews the PM field-by-field (same labels/order/conditional-required
rules as the issue form above, including the same status-downgrade-needs-
a-reason gate), then writes a `fields.json` and runs
`scripts/apply_weekly_update_direct.py --fields ...`, a new script that
calls `ingest.py`'s own `apply_weekly_update()`/`snapshot_history()`
unchanged for every core field (so the merge/validation logic lives in
exactly one place, not duplicated), and adds `upsert_by_id()` /
`upsert_by_key()` helpers for the six extended fields — entries with a
matching `id` (or `item`/`name`/`sprint`+`feature` key, for the three
fields that aren't id-based) are merged in place; entries without one are
appended with a freshly minted id. This updates `data.json`/`history.json`
immediately — no issue, no bot run, no waiting for the next scheduled
ingest — but the PM still needs to `git pull` first and commit/push the
result afterward, since the scheduled bot commits independently and can
otherwise race a direct write to the same file (see `scripts/
apply_weekly_update_direct.py`'s docstring and the skill's own
"before you start" step).

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
  "milestones": [              // REVIVED (2026-10-15) — originally fed a per-project mini Gantt in
                                // the Schedule tab (`buildSingleProjectGantt()`), removed 2026-09-30
                                // per explicit request; the field itself was marked "left in as-is
                                // for later" at the time, but had actually never been added to any
                                // project's real data until now. Now feeds the header's "Weekly
                                // status report" summary's "Upcoming milestones" row (top 2, date >=
                                // today) and the Schedule tab's "Milestones" section (full list,
                                // `id="milestones-section"`). `status` is one of the same
                                // green/amber/red/black values as a project's own `status`.
                                // (Hawk-eye/Tab 3 plots pipeline stages instead, built entirely from
                                // history — never reads this field.)
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
                                 // Also feeds the detail view's **Delay** tab's "Delay attribution
                                 // (all stages)" and "Delay log entries (all stages)" sections
                                 // (2026-10-15) — same two renderers, called unfiltered instead of
                                 // filtered to one stage.
    { "id": "DL-101", "date": "2026-01-10", "stage": "Development", "reason": "Review defects resolution", "team": "Team2", "member": "V. Mehta", "days": 2 }
  ],
  "changeRequests": [            // OPTIONAL (2026-10-15) — structured Change Request Log (Change &
                                  // Decisions tab). Only entries that have moved off "TBD" need to be
                                  // added; nothing here is auto-generated.
    {
      "id": "CR-1",
      "title": "Rooming Validation Enhancements",
      "description": "...",
      "submittedDate": "2026-06-09",
      "by": "Aksharbhai",
      "actionItem": "Review requirements, assess effort, obtain CR approval",
      "approvalStatus": "Approved for current phase",  // free text; "approved"/"pending"/"tbd" (case-
                                                          // insensitive substring) drive the badge color
      "impact": "Go-Live date impacted by 10 days"
    }
  ],
  "decisions": [                 // OPTIONAL (2026-10-15) — structured Decision Log (Change &
                                  // Decisions tab). Distinct from Dependencies/Risks: a decision is a
                                  // closed-door call that was made, not an open item being resolved.
    { "id": "DEC-1", "decision": "Go-Live Date Extension by 1 Month", "description": "...", "dateTaken": "2026-04-09", "by": "Aksharbhai Patel" }
  ],
  "goLiveChecklist": [           // OPTIONAL (2026-10-15) — Stage-gate tab's "Go-Live readiness"
                                  // section. Only needs entries for items that have moved off
                                  // "Not started" — see GOLIVE_CHECKLIST_ITEMS in app.js for the
                                  // fixed 7-item list (SIT, Regression, UAT, Cyber Security,
                                  // Performance, Change Management, RGC Approval); anything not
                                  // listed here defaults to "Not started."
    { "item": "System Integration Testing (SIT)", "status": "Complete", "notes": "" } // status: "Not started" | "In progress" | "Complete"
  ],
  "delayItemLog": [              // OPTIONAL (2026-10-15) — the detail view's **Delay** tab's
                                  // "Reported delay log" section (moved there from the Schedule tab
                                  // the same day it was added). NOT the same field as `delayLog`
                                  // above (different shape, different feature — see the "near-miss"
                                  // note in Tab 1's writeup for why these are two separate fields
                                  // even though both are "delay logs"). This one is the
                                  // narrative/root-cause/ownership version, modeled on the
                                  // slide-deck's own Delay Log table.
    {
      "id": "DL-ITEM-1",
      "delayedItem": "Web UI/UX Readiness",
      "description": "...",
      "reportedDate": "2026-03-26",
      "impactedPhase": "Development",
      "impact": "Lost 3 weeks",            // free text (Time/Cost/Scope impact)
      "rootCause": "Vendor onboarding delays",
      "responsible": "Satish Buddhadev",
      "actionItem": "Cancel vendor contract",
      "actionTaken": "Proceeded with internal design team",
      "status": "Closed",                  // free text; "closed"/"resolved" (case-insensitive) renders green
      "closureRemarks": "Go-Live date extended from 07/31 to 08/28/2026"
    }
  ],
  "features": [                  // OPTIONAL (2026-10-15) — CURRENTLY UNUSED, same day it was added
                                  // (2026-10-15): fed a "Features" tab/feature-sprint tracker that
                                  // was built, reviewed, and then explicitly removed before
                                  // approval ("dont know if we need features"). Following this
                                  // file's `milestones`-field precedent, left here unused rather
                                  // than deleted — `buildFeatureTracker()`/`buildFeatureKpis()` in
                                  // app.js are similarly kept, just no longer wired to a tab — in
                                  // case the feature is revived later. Was the most granular view in
                                  // the dashboard (every feature/capability as its own row, not one
                                  // project-level status); its Change Request KPI was never a
                                  // separate field — it read `changeRequests.length` live.
    {
      "sprint": 1,
      "type": "Web",             // free text, shown as-is (e.g. "Web", "Mobile", "Web/Mob.")
      "feature": "Login & Profile Management",
      "status": "Done",          // "Done" | "In Progress" | "Partially Done" | "Excluded" | "Blocked" | "Upcoming"
      "notes": "Read-only profile for now; full profile mgmt in Phase 3",
      "plannedDate": "2026-04-20",
      "actualDate": "2026-04-24",
      "delayReason": "Design delay (4 days)"
    }
  ],
  "raidLog": [                   // OPTIONAL (2026-10-15) — Dependencies & Risks tab's "RAID Log"
                                  // section: Risks, Assumptions, Issues, Dependencies consolidated
                                  // into one log (slide 18). Distinct from `risks`/`dependencies`/
                                  // `escalations` above (different shape, different section) — this
                                  // is the only place "Assumption"-type entries can be tracked.
                                  // `type` is one of RAID_TYPES in app.js: "Risk" | "Assumption" |
                                  // "Issue" | "Dependency" — not in the deck's own sample table,
                                  // added so each row's RAID letter is actually distinguishable.
    {
      "id": "RAID-1",
      "type": "Issue",
      "item": "QA tasks getting delayed due to unavailability of QA resource",
      "description": "QA task on hold due to QA resource not yet finalized, delaying requirement understanding and test case design",
      "reportedDate": "2026-03-24",
      "actionItem": "Kishanbhai to conduct QA interviews this week; onboard QA resource from 1-Apr-26; resume requirement understanding and test case design immediately after onboarding",
      "targetedCompletionDate": "2026-04-03",
      "responsible": "Nimeshbhai / Kishanbhai",
      "status": "Resolved",             // free text; "closed"/"resolved" (case-insensitive) renders green
      "closureRemarks": "QA resouce onboarded on project from 06/04/2026"
    }
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
      for that anymore. `milestones` is currently unused altogether (its
      only consumer, the detail view's mini Gantt, was removed 2026-09-30)
      — kept in the schema for now in case a future feature wants to
      hand-track sub-milestones within a stage.
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
