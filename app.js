(function () {
  "use strict";

  const REPO = "pankaj117-dev/baps-ndc-status";
  const STATUS_LABEL = { green: "On Track", amber: "At Risk", red: "Critical", black: "Non-Recoverable" };
  const STATUS_RANK = { green: 0, amber: 1, red: 2, black: 3 };

  let DATA = null;
  let HISTORY = {};
  let NOTES = [];

  // Resolving a follow-up on the dashboard is instant (no GitHub round trip) —
  // it's tracked as a locally-resolved override in this browser's
  // localStorage. The underlying note is never touched/deleted; it still
  // exists exactly as-is in notes.json/git. When you're ready to make the
  // resolution permanent (so it also shows resolved for everyone else / in
  // git history), use the "Sync to GitHub ↗" link that appears once
  // something's been resolved locally.
  const LOCAL_RESOLVED_KEY = "baps-ndc-status:locally-resolved";

  function loadLocalResolved() {
    try {
      return new Set(JSON.parse(localStorage.getItem(LOCAL_RESOLVED_KEY) || "[]"));
    } catch (e) {
      return new Set();
    }
  }

  function saveLocalResolved(set) {
    try {
      localStorage.setItem(LOCAL_RESOLVED_KEY, JSON.stringify(Array.from(set)));
    } catch (e) {
      /* localStorage unavailable — resolve still works for this page view */
    }
  }

  let LOCAL_RESOLVED = loadLocalResolved();

  function isLocallyResolved(noteId) {
    return LOCAL_RESOLVED.has(noteId);
  }

  function setLocallyResolved(noteId, resolved) {
    if (resolved) LOCAL_RESOLVED.add(noteId);
    else LOCAL_RESOLVED.delete(noteId);
    saveLocalResolved(LOCAL_RESOLVED);
  }

  // A note's effective status, folding in any local-only resolve/undo.
  function noteStatus(note) {
    if (note.status === "resolved") return "resolved";
    return isLocallyResolved(note.id) ? "resolved" : "open";
  }
  let activeFilter = "all";
  let activeOwner = "all";
  let globalProjectFilter = "all";
  let globalTeamFilter = "all";
  let depsPivotGroupBy = "project"; // "project" | "team" — which rollup the Dependencies tab shows first
  let depsPivotCompact = false;
  let depsPortfolioFilter = "all"; // deps-tab project scope (projects with open deps only)
  let depsCycleFilter = "all"; // calendar year string from dueBy, e.g. "2026"
  let lastDepsPivotExport = null;

  function visibleProjects() {
    let projects = DATA.projects;
    if (globalProjectFilter !== "all") {
      projects = projects.filter((p) => p.id === globalProjectFilter);
    }
    if (activeOwner !== "all") {
      projects = projects.filter((p) => (p.owner || "Unassigned") === activeOwner);
    }
    if (globalTeamFilter !== "all") {
      projects = projects.filter((p) =>
        getDependencyObjects(p).some((d) => !d.resolved && d.team === globalTeamFilter)
      );
    }
    return projects;
  }

  function fmtDate(iso) {
    if (!iso) return "—";
    const d = new Date(iso + "T00:00:00");
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  }

  function fmtDateShort(iso) {
    if (!iso) return "—";
    const d = new Date(iso + "T00:00:00");
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  }

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach((k) => {
        if (k === "class") node.className = attrs[k];
        else if (k === "html") node.innerHTML = attrs[k];
        else node.setAttribute(k, attrs[k]);
      });
    }
    (children || []).forEach((c) => {
      if (c) node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    });
    return node;
  }

  function openNotesFor(projectId) {
    return NOTES.filter((n) => n.projectId === projectId && noteStatus(n) === "open");
  }

  function todayISO() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  function issueUrl(template, params) {
    const base = `https://github.com/${REPO}/issues/new`;
    const search = new URLSearchParams({ template, ...params });
    return `${base}?${search.toString()}`;
  }

  // "Resolve" is instant and local — no GitHub tab, no form. The note itself
  // is left completely as-is in notes.json; this just remembers (in this
  // browser's localStorage) that it should be treated as resolved. Use the
  // "Sync to GitHub ↗" link (only shown once something's resolved locally)
  // when you want that to become permanent / visible to everyone else — that
  // opens a pre-filled "resolve-feedback" issue that the bot uses to flip
  // notes.json's real status, so it's still fully preserved in git.
  function resolveUrl(note, projectName) {
    return issueUrl("resolve-feedback.yml", {
      note_id: note.id || "",
      project: projectName || "",
      summary: (note.text || "").slice(0, 120),
    });
  }

  function resolveLink(note, projectName) {
    const wrap = el("span", { class: "resolve-actions" });

    const resolveBtn = el(
      "button",
      { type: "button", class: "resolve-link", title: "Close this out — no GitHub needed, just hides it here" },
      ["✓ Resolve"]
    );
    resolveBtn.addEventListener("click", () => {
      setLocallyResolved(note.id, true);
      refreshProjectViews(note.projectId);
    });
    wrap.appendChild(resolveBtn);

    return wrap;
  }

  // Shown next to already-resolved (locally) notes in the full feedback
  // history: an "Undo" in case it was closed by mistake, and a "Sync to
  // GitHub" for making the resolution permanent in notes.json/git.
  function resolvedActions(note, projectName) {
    const wrap = el("span", { class: "resolve-actions" });

    const undoBtn = el(
      "button",
      { type: "button", class: "resolve-link is-undo", title: "Put this back in the open list" },
      ["↺ Undo"]
    );
    undoBtn.addEventListener("click", () => {
      setLocallyResolved(note.id, false);
      refreshProjectViews(note.projectId);
    });
    wrap.appendChild(undoBtn);

    wrap.appendChild(
      el(
        "a",
        {
          class: "resolve-link is-sync",
          target: "_blank",
          rel: "noopener",
          title: "Make this resolution permanent in notes.json/git (visible to everyone, not just this browser)",
          href: resolveUrl(note, projectName),
        },
        ["Sync to GitHub ↗"]
      )
    );

    return wrap;
  }

  // Re-render whatever's currently on screen after a resolve/undo so the
  // change shows up immediately without a full page reload.
  function refreshProjectViews(projectId) {
    renderMetrics();
    renderCards();
    const overlay = document.getElementById("projectDetail");
    if (!overlay.hidden) {
      const project = DATA.projects.find((p) => p.id === projectId);
      if (project) {
        const content = document.getElementById("detailContent");
        const scrollTop = overlay.scrollTop;
        content.innerHTML = "";
        content.appendChild(buildProjectDetail(project));
        overlay.scrollTop = scrollTop;
      }
    }
  }

  /* ---------------- Header ---------------- */

  function renderHeader() {
    document.getElementById("asOf").textContent = "As of " + fmtDate(DATA.asOf);
    const d = new Date(DATA.lastUpdated);
    document.getElementById("lastUpdated").textContent =
      "Data last updated " + d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  }

  /* ---------------- Tab 1: Program Status ---------------- */

  function renderMetrics() {
    const projects = visibleProjects();
    const counts = { green: 0, amber: 0, red: 0, black: 0 };
    let delaySum = 0;
    let riskCount = 0;
    projects.forEach((p) => {
      counts[p.status] = (counts[p.status] || 0) + 1;
      delaySum += p.delayDays || 0;
      riskCount += countOpenRisks(p);
    });
    const avgDelay = projects.length ? Math.round((delaySum / projects.length) * 10) / 10 : 0;

    const metrics = [
      { label: "Total Projects", num: projects.length, tone: "", filter: "all" },
      { label: "On Track", num: counts.green, tone: "tone-green", filter: "green" },
      { label: "At Risk", num: counts.amber, tone: "tone-amber", filter: "amber" },
      { label: "Critical", num: counts.red, tone: "tone-red", filter: "red" },
    ];
    if (counts.black) metrics.push({ label: "Non-Recoverable", num: counts.black, tone: "tone-black", filter: "black" });
    metrics.push(
      { label: "Avg Delay (days)", num: avgDelay, tone: "tone-accent" },
      { label: "Open Follow-ups", num: NOTES.filter((n) => noteStatus(n) === "open").length, tone: "tone-accent" }
    );

    const row = document.getElementById("metricsRow");
    row.innerHTML = "";
    metrics.forEach((m) => {
      const isClickable = !!m.filter;
      const classes = [
        "metric-card",
        m.tone,
        isClickable ? "is-clickable" : "",
        isClickable && activeFilter === m.filter ? "is-active" : "",
      ]
        .filter(Boolean)
        .join(" ");
      const card = el(
        "div",
        isClickable
          ? { class: classes, "data-filter": m.filter, tabindex: "0", role: "button", title: "Filter projects by " + m.label }
          : { class: classes },
        [
          el("div", { class: "num" }, [String(m.num)]),
          el("div", { class: "label" }, [m.label]),
        ]
      );
      row.appendChild(card);
    });

    row.querySelectorAll(".metric-card.is-clickable").forEach((card) => {
      const applyFilter = () => {
        activeFilter = card.getAttribute("data-filter");
        renderMetrics();
        renderCards();
      };
      card.addEventListener("click", applyFilter);
      card.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          applyFilter();
        }
      });
    });
  }

  const PIPELINE_STAGES = [
    "Requirements",
    "Design / Estimation",
    "Development",
    "QA / UAT",
    "Production Release",
    "Hypercare / Post-Launch",
  ];

  // Short column headers for the Grid tab — same stages, tighter labels so
  // 6 columns + the project name column fit without too much horizontal
  // scroll.
  const STAGE_GRID_SHORT = {
    "Requirements": "Requirements",
    "Design / Estimation": "Design / Est.",
    "Development": "Development",
    "QA / UAT": "QA / UAT",
    "Production Release": "Prod. Release",
    "Hypercare / Post-Launch": "Hypercare",
  };

  function renderStageGridLegend() {
    const box = document.getElementById("stageGridLegend");
    if (!box) return;
    box.innerHTML = "";
    [
      { cls: "is-done", label: "Done — on time" },
      { cls: "is-done is-was-breach", label: "Done — blew its SLA" },
      { cls: "is-current", label: "Current stage — on track" },
      { cls: "is-current is-warn", label: "Current stage — approaching SLA" },
      { cls: "is-current is-breach", label: "Current stage — over SLA" },
      { cls: "is-none", label: "Not reached yet" },
    ].forEach((it) => {
      box.appendChild(
        el("span", { class: "stage-grid-legend-item" }, [
          el("span", { class: "stage-grid-swatch " + it.cls }),
          it.label,
        ])
      );
    });
  }

  // KPI strip above the grid — portfolio-wide stage-gate health at a glance,
  // reusing the same .metric-card look as the Program Status tab's metrics
  // row. All numbers respect the global Project/PM/Team filters.
  function renderStageGridMetrics() {
    const row = document.getElementById("stageGridMetrics");
    if (!row) return;
    row.innerHTML = "";

    const projects = visibleProjects();
    const pmCount = new Set(projects.map((p) => p.owner || "Unassigned")).size;

    let breachCount = 0;
    let hypercareCount = 0;
    let cumulativeSlaOverage = 0;

    projects.forEach((p) => {
      cumulativeSlaOverage += cumulativeStageOverageDays(p);
      const info = currentStageInfo(p);
      if (info && info.flag === "breach") breachCount += 1;
      if ((p.stage || "") === "Hypercare / Post-Launch") hypercareCount += 1;
    });

    const metrics = [
      { label: "Active Projects", num: projects.length, sub: `across ${pmCount} PM${pmCount === 1 ? "" : "s"}`, tone: "" },
      { label: "Stages Over SLA", num: breachCount, sub: breachCount ? "need escalation" : "none right now", tone: breachCount ? "tone-red" : "tone-green" },
      { label: "Cumulative SLA Overage", num: cumulativeSlaOverage + "d", sub: "summed across every stage", tone: cumulativeSlaOverage ? "tone-amber" : "tone-green" },
      { label: "In Hypercare / Post-Launch", num: hypercareCount, sub: "live, post go-live", tone: "tone-accent" },
    ];

    metrics.forEach((m) => {
      row.appendChild(
        el("div", { class: ["metric-card", m.tone].filter(Boolean).join(" ") }, [
          el("div", { class: "num" }, [String(m.num)]),
          el("div", { class: "label" }, [m.label]),
          el("div", { class: "stage-grid-metric-sub" }, [m.sub]),
        ])
      );
    });
  }

  // Portfolio-wide matrix: every visible project as a row, every pipeline
  // stage as a column. Reuses the same stage-segment reconstruction and SLA
  // logic as the per-project "Stage-gate timeline" (see computeStageSegments
  // / stageSlaDays / stageFlagLevel above) so the two views never disagree.
  // Each cell carries the actual date range it covered plus whether that
  // stage blew its SLA (not just the current one) — the fuller "stage-gate"
  // picture, not just a status dot.
  function renderStageGrid() {
    renderStageGridMetrics();
    renderStageGridLegend();
    const wrap = document.getElementById("stageGrid");
    if (!wrap) return;
    wrap.innerHTML = "";

    const projects = visibleProjects();
    if (!projects.length) {
      wrap.appendChild(el("div", { class: "stage-col-empty" }, ["No projects match the current filters"]));
      return;
    }

    const grid = el("div", { class: "stage-grid" });

    const headerRow = el("div", { class: "stage-grid-row stage-grid-header" }, [
      el("div", { class: "stage-grid-cell stage-grid-name-cell" }, ["Project"]),
    ]);
    PIPELINE_STAGES.forEach((stage) => {
      const sla = stageSlaDays(stage);
      headerRow.appendChild(
        el("div", { class: "stage-grid-cell stage-grid-col-head", title: stage }, [
          STAGE_GRID_SHORT[stage] || stage,
          sla != null ? el("span", { class: "stage-grid-col-sla" }, ["SLA " + sla + "d"]) : null,
        ])
      );
    });
    grid.appendChild(headerRow);

    projects.forEach((p) => {
      const segByStage = {};
      computeStageSegments(p).forEach((seg) => {
        segByStage[seg.stage] = seg;
      });
      const currentIndex = PIPELINE_STAGES.indexOf(p.stage || "Unstaged");

      const row = el("div", { class: "stage-grid-row" });

      const nameCell = el(
        "div",
        { class: "stage-grid-name-cell stage-grid-cell", "data-project-id": p.id, tabindex: "0", role: "button" },
        [
          el("span", { class: "timeline-dot", style: `background:var(--${p.status === "amber" ? "amber" : p.status})` }),
          el("div", { class: "stage-grid-name-text" }, [
            el("strong", null, [p.name]),
            el("span", { class: "stage-grid-name-meta" }, [
              (p.owner || "Unassigned") + (currentIndex === -1 ? " · Unstaged" : ""),
            ]),
          ]),
        ]
      );
      row.appendChild(nameCell);

      PIPELINE_STAGES.forEach((stage, i) => {
        let cell;
        if (currentIndex === -1 || i > currentIndex) {
          cell = el("div", { class: "stage-grid-cell stage-grid-status-cell is-none" }, ["—"]);
        } else if (i < currentIndex) {
          // Already passed through this stage — show how long it took, the
          // actual date range, and (the part the old version was missing)
          // whether THIS stage blew its own SLA back when it was current,
          // regardless of how the project is doing today.
          const seg = segByStage[stage];
          const sla = stageSlaDays(stage);
          const over = seg && sla != null ? seg.days - sla : null;
          const wasBreach = over != null && over > 0;
          cell = el(
            "div",
            {
              class: "stage-grid-cell stage-grid-status-cell is-done" + (wasBreach ? " is-was-breach" : ""),
              title: seg
                ? `${stage}: ${seg.approxStart ? "≥" : ""}${seg.days}d (${fmtDateShort(seg.start)} \u2192 ${fmtDateShort(seg.end)})` +
                  (sla != null ? ` — SLA ${sla}d${wasBreach ? `, ${over}d over` : ""}` : "")
                : `${stage}: done`,
            },
            [
              el("span", { class: "stage-grid-days" }, [
                "✓ " + (seg ? (seg.approxStart ? "≥" : "") + seg.days + "d" : "Done"),
              ]),
              seg
                ? el("span", { class: "stage-grid-daterange" + (wasBreach ? " is-was-breach" : "") }, [
                    wasBreach
                      ? `+${over}d over SLA`
                      : `${fmtDateShort(seg.start)} → ${fmtDateShort(seg.end)}`,
                  ])
                : null,
            ]
          );
        } else {
          const seg = segByStage[stage];
          const sla = stageSlaDays(stage);
          const flag = seg ? stageFlagLevel(seg.days, sla) : null;
          const flagClass = flag && flag !== "ok" ? " is-" + flag : "";
          const days = seg ? seg.days : null;
          const over = days != null && sla != null ? days - sla : null;
          cell = el(
            "div",
            {
              class: "stage-grid-cell stage-grid-status-cell is-current" + flagClass,
              title:
                days != null
                  ? `${stage}: ${seg.approxStart ? "≥" : ""}${days}d so far (since ${fmtDateShort(seg.start)})` +
                    (sla != null ? ` — SLA ${sla}d${over > 0 ? `, ${over}d over` : ""}` : "")
                  : `${stage}: in progress`,
            },
            [
              el("span", { class: "stage-grid-days" }, [
                days != null ? (seg.approxStart ? "≥" : "") + days + "d" : "In progress",
              ]),
              sla != null
                ? el("span", { class: "stage-grid-sla" }, [
                    "SLA " + sla + "d" + (over > 0 ? ` · +${over}d over` : ""),
                  ])
                : seg
                ? el("span", { class: "stage-grid-daterange" }, ["since " + fmtDateShort(seg.start)])
                : null,
            ]
          );
        }
        row.appendChild(cell);
      });

      grid.appendChild(row);
    });

    wrap.appendChild(grid);

    wrap.querySelectorAll("[data-project-id]").forEach((node) => {
      node.addEventListener("click", () => openProjectDetail(node.getAttribute("data-project-id"), "stage-gate-timeline-section"));
      node.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          openProjectDetail(node.getAttribute("data-project-id"), "stage-gate-timeline-section");
        }
      });
    });
  }

  function listOrDash(items) {
    return items.length ? items.map((d) => el("li", null, [d])) : [el("li", null, ["—"])];
  }

  function pairedList(items, mitigations, label, teams) {
    if (!items.length) return [el("li", null, ["—"])];
    return items.map((text, i) => {
      const mitigation = (mitigations && mitigations[i]) || "";
      const team = (teams && teams[i]) || "";
      return el("li", { class: "paired-item" }, [
        el("div", { class: "paired-item-text" }, [
          text,
          ...(teams
            ? [el("span", { class: "team-tag" + (team ? "" : " is-missing") }, [team || "No team labeled"])]
            : []),
        ]),
        el("div", { class: "paired-item-mitigation" + (mitigation ? "" : " is-missing") }, [
          el("span", { class: "mitigation-label" }, [label + ": "]),
          mitigation || "Not yet documented",
        ]),
      ]);
    });
  }

  function renderCards() {
    const box = document.getElementById("cards");
    box.innerHTML = "";
    const projects = visibleProjects().filter((p) => activeFilter === "all" || p.status === activeFilter);

    if (!projects.length) {
      box.appendChild(el("div", { class: "empty-note" }, ["No projects match this filter."]));
      return;
    }

    projects.forEach((p) => {
      const isLate = p.delayDays > 0;
      const notes = openNotesFor(p.id);

      const card = el("div", { class: "card status-" + p.status, "data-project-id": p.id, tabindex: "0", role: "button" }, [
        el("div", { class: "card-head" }, [
          el("h3", null, [p.name]),
          el("span", { class: "pill pill-" + p.status }, [STATUS_LABEL[p.status]]),
        ]),
        el("div", { class: "card-owner" }, [p.owner ? "PM: " + p.owner : "PM: unassigned"]),
        el("div", { class: "progress-row" }, [
          el("div", { class: "progress-track" }, [
            el("div", { class: "progress-fill status-" + p.status, style: "width:" + p.progress + "%" }),
          ]),
          el("div", { class: "progress-pct" }, [p.progress + "%"]),
        ]),
        el("dl", { class: "card-facts" }, [
          el("dt", null, ["Phase"]),
          el("dd", null, [p.phase || "—"]),
          el("dt", null, ["Next milestone"]),
          el("dd", null, [(p.nextMilestone && p.nextMilestone.name || "—") + (p.nextMilestone && p.nextMilestone.date ? " · " + fmtDateShort(p.nextMilestone.date) : "")]),
          el("dt", null, ["Go-live"]),
          el("dd", null, [fmtDate(p.goLive)]),
          el("dt", null, ["Delay"]),
          el("dd", { class: "delay-flag " + (isLate ? "is-late" : "is-ontime") }, [
            isLate ? "+" + p.delayDays + " days" : "On schedule",
          ]),
          ...((p.timeSavedDays || 0) > 0
            ? [
                el("dt", null, ["Time saved"]),
                el("dd", { class: "delay-flag is-saved" }, ["-" + p.timeSavedDays + " days"]),
              ]
            : []),
        ]),
        el("div", { class: "card-badges" }, [
          el("span", { class: "badge" }, [countOpenDependencies(p) + " dependencies"]),
          el("span", { class: "badge" + (countOpenRisks(p) ? " has-risk" : "") }, [countOpenRisks(p) + " risks"]),
          el("span", { class: "badge" + (notes.length ? " has-followup" : "") }, [notes.length + " follow-ups"]),
          ...((p.fastFollowItems || []).length
            ? [el("span", { class: "badge has-fastfollow" }, [(p.fastFollowItems || []).length + " fast-follow"])]
            : []),
          ...(p.scopeReduced
            ? [el("span", { class: "badge has-scopecut" }, ["✂️ scope cut"])]
            : []),
          ...((p.timeSavedDays || 0) > 0
            ? [el("span", { class: "badge has-timesaved" }, ["⏱ +" + p.timeSavedDays + "d saved"])]
            : []),
          ...((p.escalations || []).length
            ? [el("span", { class: "badge has-escalation" }, ["🚨 " + (p.escalations || []).length + " escalated"])]
            : []),
        ]),
        el("button", { class: "card-expand" }, ["View full details →"]),
      ]);

      box.appendChild(card);
    });

    box.querySelectorAll(".card").forEach((card) => {
      card.addEventListener("click", () => openProjectDetail(card.getAttribute("data-project-id")));
      card.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          openProjectDetail(card.getAttribute("data-project-id"));
        }
      });
    });
  }

  function populateGlobalOwnerFilter() {
    const select = document.getElementById("globalOwnerFilter");
    const owners = Array.from(
      new Set(DATA.projects.map((p) => p.owner || "Unassigned"))
    ).sort((a, b) => {
      if (a === "Unassigned") return 1;
      if (b === "Unassigned") return -1;
      return a.localeCompare(b);
    });

    owners.forEach((owner) => {
      select.appendChild(el("option", { value: owner }, [owner]));
    });
  }

  function updateGlobalOwnerFilterUI() {
    const clearBtn = document.getElementById("globalOwnerClear");
    clearBtn.hidden = activeOwner === "all";
    updateGlobalFilterUI();
  }

  function wireGlobalOwnerFilter() {
    const select = document.getElementById("globalOwnerFilter");
    select.addEventListener("change", () => {
      activeOwner = select.value;
      updateGlobalOwnerFilterUI();
      renderAllTabs();
    });

    document.getElementById("globalOwnerClear").addEventListener("click", () => {
      activeOwner = "all";
      select.value = "all";
      updateGlobalOwnerFilterUI();
      renderAllTabs();
    });
  }

  // Filters to projects that have a dependency owned by another team
  // (DevOps, BAPS ID Team, SSO Team, etc. — whatever's actually been entered
  // in `dependencyTeams` across the portfolio). Useful for someone from one
  // of those teams to jump straight to "what do I need to look at."
  function populateGlobalTeamFilter() {
    const select = document.getElementById("globalTeamFilter");
    const teams = Array.from(
      new Set(
        DATA.projects.flatMap((p) =>
          getDependencyObjects(p)
            .filter((d) => !d.resolved && d.team)
            .map((d) => d.team)
        )
      )
    ).sort((a, b) => a.localeCompare(b));

    teams.forEach((team) => {
      select.appendChild(el("option", { value: team }, [team]));
    });
  }

  function updateGlobalTeamFilterUI() {
    const clearBtn = document.getElementById("globalTeamClear");
    clearBtn.hidden = globalTeamFilter === "all";
    updateGlobalFilterUI();
  }

  function wireGlobalTeamFilter() {
    const select = document.getElementById("globalTeamFilter");
    select.addEventListener("change", () => {
      globalTeamFilter = select.value;
      updateGlobalTeamFilterUI();
      renderAllTabs();
    });

    document.getElementById("globalTeamClear").addEventListener("click", () => {
      globalTeamFilter = "all";
      select.value = "all";
      updateGlobalTeamFilterUI();
      renderAllTabs();
    });
  }

  /* ---------------- Hawk-eye (cross-project stage-gate calendar) ---------------- */

  const STAGE_SHORT_CODE = {
    "Requirements": "REQ",
    "Design / Estimation": "DES",
    "Development": "DEV",
    "QA / UAT": "QA",
    "Production Release": "REL",
    "Hypercare / Post-Launch": "HC",
  };

  // Fallback planned width (calendar days) for a future stage with no
  // configured SLA — shouldn't normally hit since every real pipeline
  // stage has one in DEFAULT_STAGE_SLA_DAYS, but keeps the chain from
  // collapsing to zero-width if data.json ever removes one.
  const DEFAULT_FUTURE_STAGE_DAYS = 14;

  function addDaysIso(iso, days) {
    const d = new Date(iso + "T00:00:00");
    d.setDate(d.getDate() + days);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  // Total days a project has spent over-SLA, summed across every stage
  // segment it's been through (including its current one) — the
  // per-project version of the Grid tab's portfolio-wide "Cumulative SLA
  // Overage" KPI.
  function cumulativeStageOverageDays(p) {
    return computeStageSegments(p).reduce((sum, seg) => {
      const sla = stageSlaDays(seg.stage);
      return sum + (sla != null ? Math.max(0, seg.days - sla) : 0);
    }, 0);
  }

  // Builds the full sequence of stage blocks for one project's Hawk-eye
  // row: real start/end dates for stages already passed through (from the
  // same history reconstruction as the Grid tab / the per-project
  // Stage-gate timeline), the current stage sized to at least its SLA (so
  // it reads as "expected to land around here" even mid-stage), then every
  // remaining stage chained forward using its SLA as a planned-only
  // placeholder width. Returns [] for a project with no recognized stage
  // (e.g. "Unstaged") — nothing real to plot yet.
  function buildHawkeyeBlocks(p) {
    const today = todayISO();
    const segments = computeStageSegments(p);
    const segByStage = {};
    segments.forEach((seg) => {
      segByStage[seg.stage] = seg;
    });
    const currentIndex = PIPELINE_STAGES.indexOf(p.stage || "Unstaged");
    if (currentIndex === -1) return [];

    const blocks = [];
    PIPELINE_STAGES.forEach((stage, i) => {
      if (i < currentIndex) {
        const seg = segByStage[stage];
        if (!seg) return;
        const sla = stageSlaDays(stage);
        blocks.push({
          stage,
          start: seg.start,
          end: seg.end,
          kind: "done",
          overDays: sla != null ? Math.max(0, seg.days - sla) : 0,
        });
      } else if (i === currentIndex) {
        const seg = segByStage[stage] || { start: today, days: 0 };
        const sla = stageSlaDays(stage);
        const plannedEnd = sla != null ? addDaysIso(seg.start, sla) : null;
        const end = plannedEnd && plannedEnd > today ? plannedEnd : today;
        blocks.push({
          stage,
          start: seg.start,
          end,
          kind: "current",
          flag: stageFlagLevel(seg.days, sla),
          overDays: sla != null ? Math.max(0, seg.days - sla) : 0,
        });
      } else {
        const sla = stageSlaDays(stage) || DEFAULT_FUTURE_STAGE_DAYS;
        const prev = blocks[blocks.length - 1];
        const start = prev ? prev.end : today;
        blocks.push({ stage, start, end: addDaysIso(start, sla), kind: "future" });
      }
    });
    return blocks;
  }

  function renderHawkeye() {
    const board = document.getElementById("hawkeyeGantt");
    board.innerHTML = "";

    const projects = visibleProjects();
    if (!projects.length) {
      board.appendChild(el("p", { class: "empty-note" }, ["No projects match the current filters."]));
      return;
    }

    const DAY = 86400000;
    const todayIso = todayISO();
    const rows = projects.map((p) => ({ p, blocks: buildHawkeyeBlocks(p) }));
    const withBlocks = rows.filter((r) => r.blocks.length);

    if (!withBlocks.length) {
      board.appendChild(el("p", { class: "empty-note" }, ["No pipeline stage data to plot yet."]));
      return;
    }

    const allDates = [todayIso];
    withBlocks.forEach(({ blocks }) => {
      blocks.forEach((b) => {
        allDates.push(b.start);
        allDates.push(b.end);
      });
    });

    const times = allDates.map((d) => new Date(d + "T00:00:00").getTime());
    let minTime = Math.min(...times) - 7 * DAY;
    let maxTime = Math.max(...times) + 7 * DAY;
    if (maxTime - minTime < 30 * DAY) maxTime = minTime + 30 * DAY;

    const xPct = (iso) => {
      const t = new Date(iso + "T00:00:00").getTime();
      return Math.max(0, Math.min(100, ((t - minTime) / (maxTime - minTime)) * 100));
    };

    board.appendChild(
      el("div", { class: "hawkeye-legend" }, [
        el("span", { class: "hawkeye-legend-item" }, [el("span", { class: "hawkeye-legend-swatch is-done" }), "Done"]),
        el("span", { class: "hawkeye-legend-item" }, [
          el("span", { class: "hawkeye-legend-swatch is-current" }),
          "Current — on track",
        ]),
        el("span", { class: "hawkeye-legend-item" }, [el("span", { class: "hawkeye-legend-swatch is-warn" }), "At risk"]),
        el("span", { class: "hawkeye-legend-item" }, [
          el("span", { class: "hawkeye-legend-swatch is-breach" }),
          "Blocked / over SLA",
        ]),
        el("span", { class: "hawkeye-legend-item" }, [
          el("span", { class: "hawkeye-legend-swatch is-future" }),
          "Not started (planned)",
        ]),
      ])
    );

    // Month gridlines spanning the whole board
    const monthMarks = [];
    const cursor = new Date(minTime);
    cursor.setDate(1);
    cursor.setHours(0, 0, 0, 0);
    while (cursor.getTime() <= maxTime) {
      if (cursor.getTime() >= minTime) {
        monthMarks.push({
          pct: ((cursor.getTime() - minTime) / (maxTime - minTime)) * 100,
          label: cursor.toLocaleDateString("en-US", { month: "short", year: "numeric" }),
        });
      }
      cursor.setMonth(cursor.getMonth() + 1);
    }

    const header = el("div", { class: "hawkeye-months" });
    monthMarks.forEach((m) => {
      header.appendChild(el("div", { class: "hawkeye-month-mark", style: `left:${m.pct}%` }, [m.label]));
    });
    board.appendChild(header);

    const rowsWrap = el("div", { class: "hawkeye-rows" });

    monthMarks.forEach((m) => {
      rowsWrap.appendChild(el("div", { class: "hawkeye-grid-line", style: `left:${m.pct}%` }));
    });

    rowsWrap.appendChild(
      el("div", { class: "hawkeye-today-line", style: `left:${xPct(todayIso)}%` }, [
        el("span", { class: "hawkeye-today-label" }, ["Today"]),
      ])
    );

    rows
      .slice()
      .sort((a, b) => {
        const ta = a.p.goLive ? new Date(a.p.goLive).getTime() : Infinity;
        const tb = b.p.goLive ? new Date(b.p.goLive).getTime() : Infinity;
        return ta - tb;
      })
      .forEach(({ p, blocks }) => {
        const cumulativeDelay = cumulativeStageOverageDays(p);
        const row = el("div", { class: "hawkeye-row", "data-project-id": p.id, tabindex: "0", role: "button" }, [
          el("div", { class: "hawkeye-row-label" }, [
            el("span", { class: "timeline-dot", style: `background:var(--${p.status})` }),
            el("div", null, [
              el("strong", null, [p.name]),
              el("div", { class: "hawkeye-row-sub" }, [
                cumulativeDelay > 0 ? `${cumulativeDelay}d cumulative delay` : "On pace — no SLA overage",
              ]),
            ]),
          ]),
        ]);

        if (!blocks.length) {
          row.appendChild(
            el("div", { class: "hawkeye-row-track hawkeye-row-track-empty" }, ["No pipeline stage set yet"])
          );
          rowsWrap.appendChild(row);
          return;
        }

        const track = el("div", { class: "hawkeye-row-track" });

        blocks.forEach((b) => {
          const left = xPct(b.start);
          const width = Math.max(xPct(b.end) - left, 0.6);
          const kindClass =
            b.kind === "done"
              ? "is-done"
              : b.kind === "future"
              ? "is-future"
              : "is-current" + (b.flag && b.flag !== "ok" ? " is-" + b.flag : "");
          const code = STAGE_SHORT_CODE[b.stage] || b.stage;
          const label = code + (b.overDays ? ` +${b.overDays}d` : "");
          const title =
            `${p.name} — ${b.stage}: ${fmtDateShort(b.start)} → ${fmtDateShort(b.end)}` +
            (b.overDays ? ` (+${b.overDays}d over SLA)` : b.kind === "future" ? " (planned, not started)" : "");
          track.appendChild(
            el(
              "div",
              { class: "hawkeye-stage-block " + kindClass, style: `left:${left}%;width:${width}%`, title },
              [label]
            )
          );
        });

        row.appendChild(track);
        rowsWrap.appendChild(row);
      });

    board.appendChild(rowsWrap);

    board.querySelectorAll(".hawkeye-row").forEach((row) => {
      row.addEventListener("click", () => openProjectDetail(row.getAttribute("data-project-id"), "stage-gate-timeline-section"));
      row.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          openProjectDetail(row.getAttribute("data-project-id"), "stage-gate-timeline-section");
        }
      });
    });
  }

  /* ---------------- Global project filter (applies to every tab) ---------------- */

  function populateGlobalProjectFilter() {
    const select = document.getElementById("globalProjectFilter");
    const names = DATA.projects.slice().sort((a, b) => a.name.localeCompare(b.name));
    names.forEach((p) => {
      select.appendChild(el("option", { value: p.id }, [p.name]));
    });
  }

  function renderAllTabs() {
    renderMetrics();
    renderStageGrid();
    renderHawkeye();
    renderCards();
    renderDependenciesTab();
    renderEscalationsTab();
    renderStatusHistory();
  }

  function updateGlobalFilterUI() {
    const bar = document.getElementById("globalFilterBar");
    const clearBtn = document.getElementById("globalFilterClear");
    const isActive = globalProjectFilter !== "all";
    clearBtn.hidden = !isActive;
    bar.classList.toggle(
      "is-active",
      isActive || activeOwner !== "all" || globalTeamFilter !== "all"
    );
  }

  function wireGlobalProjectFilter() {
    const select = document.getElementById("globalProjectFilter");
    select.addEventListener("change", (e) => {
      globalProjectFilter = e.target.value;
      updateGlobalFilterUI();
      renderAllTabs();
    });

    document.getElementById("globalFilterClear").addEventListener("click", () => {
      globalProjectFilter = "all";
      select.value = "all";
      updateGlobalFilterUI();
      renderAllTabs();
    });
  }

  /* ---------------- Tab: Dependencies ---------------- */

  // Due-window buckets for a dependency's "needed by" date, relative to
  // today — drives card badges and pivot due-window columns. Matches the
  // leadership mockup (Today → Next Month) plus Overdue as a 7th column so
  // past-due work is never folded into "Today". Dependencies with no date use
  // internal key `no-date` (counted in row totals only, not in window cols).
  const DUE_WINDOWS = [
    { key: "overdue", label: "Overdue", rank: 0 },
    { key: "today", label: "Today", rank: 1 },
    { key: "tomorrow", label: "Tomorrow", rank: 2 },
    { key: "this-week", label: "This Week", rank: 3 },
    { key: "next-week", label: "Next Week", rank: 4 },
    { key: "this-month", label: "This Month", rank: 5 },
    { key: "next-month", label: "Next Month", rank: 6 },
  ];
  const DUE_WINDOW_BY_KEY = {
    "no-date": { key: "no-date", label: "No date set", rank: 99 },
  };
  DUE_WINDOWS.forEach((w) => (DUE_WINDOW_BY_KEY[w.key] = w));

  function endOfWeekSunday(fromIso) {
    const d = new Date(fromIso + "T00:00:00");
    const dow = d.getDay();
    const daysUntilSunday = dow === 0 ? 0 : 7 - dow;
    return addDaysIso(fromIso, daysUntilSunday);
  }

  function endOfMonthIso(fromIso) {
    const d = new Date(fromIso + "T00:00:00");
    const y = d.getFullYear();
    const m = d.getMonth();
    const last = new Date(y, m + 1, 0);
    const mm = String(last.getMonth() + 1).padStart(2, "0");
    const dd = String(last.getDate()).padStart(2, "0");
    return `${last.getFullYear()}-${mm}-${dd}`;
  }

  function startOfNextMonthIso(fromIso) {
    const d = new Date(fromIso + "T00:00:00");
    d.setDate(1);
    d.setMonth(d.getMonth() + 1);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    return `${y}-${m}-01`;
  }

  function dueWindowFor(dueBy, today) {
    if (!dueBy) return DUE_WINDOW_BY_KEY["no-date"];
    if (dueBy < today) return DUE_WINDOW_BY_KEY.overdue;
    if (dueBy === today) return DUE_WINDOW_BY_KEY.today;
    const tomorrow = addDaysIso(today, 1);
    if (dueBy === tomorrow) return DUE_WINDOW_BY_KEY.tomorrow;
    const weekEnd = endOfWeekSunday(today);
    if (dueBy > tomorrow && dueBy <= weekEnd) return DUE_WINDOW_BY_KEY["this-week"];
    const nextWeekEnd = addDaysIso(weekEnd, 7);
    if (dueBy <= nextWeekEnd) return DUE_WINDOW_BY_KEY["next-week"];
    const monthEnd = endOfMonthIso(today);
    if (dueBy <= monthEnd) return DUE_WINDOW_BY_KEY["this-month"];
    const nextMonthEnd = endOfMonthIso(startOfNextMonthIso(today));
    if (dueBy <= nextMonthEnd) return DUE_WINDOW_BY_KEY["next-month"];
    return DUE_WINDOW_BY_KEY["next-month"];
  }

  function dueByCalendarYear(dueBy) {
    if (!dueBy) return null;
    return String(new Date(dueBy + "T00:00:00").getFullYear());
  }

  const POST_UAT_STAGES = new Set(["Production Release", "Hypercare / Post-Launch"]);

  const PRIORITY_ORDER = ["Critical", "High", "Medium", "Low"];

  function isPlaceholderDependencyText(text) {
    return !text || /^(none|no dependency)$/i.test(String(text).trim());
  }

  /** Read dependencies as objects — supports legacy parallel-array snapshots in history.json. */
  function getDependencyObjects(source) {
    const raw = source.dependencies || [];
    if (!raw.length) return [];
    if (typeof raw[0] === "object" && raw[0] !== null && "text" in raw[0]) {
      return raw.map((d) => ({
        id: d.id || "",
        text: d.text || "",
        team: d.team || "",
        mitigation: d.mitigation || "",
        dueBy: d.dueBy || "",
        priority: PRIORITY_ORDER.includes(d.priority) ? d.priority : "Medium",
        escalated: !!d.escalated,
        resolved: !!d.resolved,
      }));
    }
    return raw.map((text, i) => ({
      id: "",
      text,
      team: (source.dependencyTeams && source.dependencyTeams[i]) || "",
      mitigation: (source.dependencyMitigations && source.dependencyMitigations[i]) || "",
      dueBy: (source.dependencyDueBy && source.dependencyDueBy[i]) || "",
      priority: PRIORITY_ORDER.includes(
        (source.dependencyPriority && source.dependencyPriority[i]) || "Medium"
      )
        ? (source.dependencyPriority && source.dependencyPriority[i]) || "Medium"
        : "Medium",
      escalated: !!(source.dependencyEscalated && source.dependencyEscalated[i]),
      resolved: false,
    }));
  }

  function countOpenDependencies(project) {
    return getDependencyObjects(project).filter(
      (d) => !d.resolved && !isPlaceholderDependencyText(d.text)
    ).length;
  }

  function isPlaceholderRiskText(text) {
    return !text || /^(none|no risk|no risks|no blocker|no blockers)$/i.test(String(text).trim());
  }

  /** Read risks as objects — supports legacy parallel-array snapshots in history.json. */
  function getRiskObjects(source) {
    const raw = source.risks || [];
    if (!raw.length) return [];
    if (typeof raw[0] === "object" && raw[0] !== null && "text" in raw[0]) {
      return raw.map((r) => ({
        id: r.id || "",
        text: r.text || "",
        mitigation: r.mitigation || "",
        resolved: !!r.resolved,
      }));
    }
    const mitigations = source.riskMitigations || [];
    return raw.map((text, i) => ({
      id: "",
      text,
      mitigation: mitigations[i] || "",
      resolved: false,
    }));
  }

  function countOpenRisks(project) {
    return getRiskObjects(project).filter(
      (r) => !r.resolved && !isPlaceholderRiskText(r.text)
    ).length;
  }

  function detailSectionIssueLink(template, projectName, label) {
    return el("a", {
      class: "btn-ghost btn-small detail-section-link",
      target: "_blank",
      rel: "noopener",
      href: issueUrl(template, { project: projectName }),
    }, [label + " ↗"]);
  }

  function collectDependencies(opts) {
    const skipCycle = opts && opts.skipCycle;
    const rows = [];
    const today = todayISO();
    visibleProjects().forEach((p) => {
      if (depsPortfolioFilter !== "all" && p.id !== depsPortfolioFilter) return;
      getDependencyObjects(p).forEach((dep) => {
        if (dep.resolved || isPlaceholderDependencyText(dep.text)) return;
        const dueBy = dep.dueBy || "";
        if (!skipCycle && depsCycleFilter !== "all" && dueBy) {
          if (dueByCalendarYear(dueBy) !== depsCycleFilter) return;
        }
        rows.push({
          projectId: p.id,
          projectName: p.name,
          status: p.status,
          id: dep.id,
          text: dep.text,
          team: dep.team || "",
          mitigation: dep.mitigation || "",
          dueBy,
          priority: dep.priority,
          dueWindow: dueWindowFor(dueBy, today),
          escalated: !!dep.escalated,
        });
      });
    });
    return rows;
  }

  function projectsWithOpenDependencies() {
    return visibleProjects().filter((p) => countOpenDependencies(p) > 0);
  }

  function dependencyCycleYears(rows) {
    const years = new Set();
    rows.forEach((r) => {
      const y = dueByCalendarYear(r.dueBy);
      if (y) years.add(y);
    });
    return Array.from(years).sort();
  }

  // Four KPIs aligned to the Dependencies mockup, grounded in this app's data:
  // active projects/teams from open deps; blocked stages = current stage over SLA
  // (same breach flag as Grid/Hawk-eye); cumulative delay = summed stage SLA
  // overage across filtered projects; rollout/hypercare = post-UAT pipeline stages.
  function renderDependenciesMetrics(rows) {
    const activeProjects = new Set(rows.map((r) => r.projectId)).size;
    const activeTeams = new Set(rows.map((r) => r.team || "Unlabeled")).size;

    const scopedProjects = projectsWithOpenDependencies().filter(
      (p) => depsPortfolioFilter === "all" || p.id === depsPortfolioFilter
    );

    let blockedStages = 0;
    let cumulativeDelay = 0;
    let rolloutHypercare = 0;
    scopedProjects.forEach((p) => {
      cumulativeDelay += cumulativeStageOverageDays(p);
      const info = currentStageInfo(p);
      if (info && info.flag === "breach") blockedStages += 1;
      if (POST_UAT_STAGES.has(p.stage || "")) rolloutHypercare += 1;
    });

    const metrics = [
      {
        label: "Active Projects",
        num: activeProjects,
        sub: `across ${activeTeams} team${activeTeams === 1 ? "" : "s"}`,
        tone: "",
      },
      {
        label: "Blocked Stages",
        num: blockedStages,
        sub: blockedStages ? "need escalation" : "none right now",
        tone: blockedStages ? "tone-red" : "tone-green",
      },
      {
        label: "Cumulative Delay",
        num: cumulativeDelay + "d",
        sub: "all stages",
        tone: cumulativeDelay ? "tone-amber" : "tone-green",
      },
      {
        label: "In Rollout / Hypercare",
        num: rolloutHypercare,
        sub: "post-UAT",
        tone: rolloutHypercare ? "tone-accent" : "",
      },
    ];

    const row = document.getElementById("depsMetricsRow");
    row.innerHTML = "";
    metrics.forEach((m) => {
      row.appendChild(
        el("div", { class: ["metric-card", m.tone].filter(Boolean).join(" ") }, [
          el("div", { class: "num" }, [String(m.num)]),
          el("div", { class: "label" }, [m.label]),
          el("div", { class: "stage-grid-metric-sub" }, [m.sub]),
        ])
      );
    });
  }

  function renderDependenciesBoard(rows) {
    const board = document.getElementById("depsBoard");
    board.innerHTML = "";

    if (!rows.length) {
      board.appendChild(el("div", { class: "deps-empty-group" }, ["No dependencies recorded yet."]));
      return;
    }

    const groups = {};
    rows.forEach((r) => {
      const key = r.team || "Unlabeled";
      (groups[key] = groups[key] || []).push(r);
    });

    const groupNames = Object.keys(groups).sort((a, b) => {
      if (a === "Unlabeled") return 1;
      if (b === "Unlabeled") return -1;
      return groups[b].length - groups[a].length || a.localeCompare(b);
    });

    groupNames.forEach((team) => {
      const entries = groups[team];
      const group = el("div", { class: "deps-group" }, [
        el("div", { class: "deps-group-head" }, [
          el("h3", null, [team]),
          el("span", { class: "deps-group-count" }, [entries.length + (entries.length === 1 ? " dependency" : " dependencies")]),
        ]),
      ]);
      entries.forEach((r) => {
        const card = el("div", { class: "deps-card" }, [
          el("div", { class: "deps-card-project", "data-project-id": r.projectId }, [
            el("span", { class: "timeline-dot", style: `background:var(--${r.status === "amber" ? "amber" : r.status})` }),
            r.projectName,
          ]),
          el("div", { class: "deps-card-badges" }, [
            el("span", { class: "deps-badge deps-badge-priority is-" + r.priority.toLowerCase() }, [r.priority]),
            el("span", { class: "deps-badge deps-badge-due is-" + r.dueWindow.key }, [
              r.dueBy ? `${r.dueWindow.label} · ${fmtDate(r.dueBy)}` : "No date set",
            ]),
            ...(r.escalated
              ? [el("span", { class: "deps-badge deps-badge-escalated" }, ["🚨 Escalated"])]
              : []),
          ]),
          el("div", { class: "deps-card-text" }, [r.text]),
          el("div", { class: "deps-card-mitigation" + (r.mitigation ? "" : " is-missing") }, [
            r.mitigation || "Mitigation / impact not yet documented",
          ]),
        ]);
        group.appendChild(card);
      });
      board.appendChild(group);
    });

    board.querySelectorAll(".deps-card-project").forEach((node) => {
      node.addEventListener("click", () => openProjectDetail(node.getAttribute("data-project-id")));
    });
  }

  /* ---------------- Status History ---------------- */

  function computeStatusTransitions() {
    const dates = Object.keys(HISTORY).sort();
    const nameById = {};
    DATA.projects.forEach((p) => (nameById[p.id] = p.name));

    const prevStatus = {};
    const transitions = [];

    dates.forEach((asOf) => {
      (HISTORY[asOf].projects || []).forEach((snap) => {
        nameById[snap.id] = nameById[snap.id] || snap.name;
        const prev = prevStatus[snap.id];
        if (prev !== undefined && prev !== snap.status) {
          transitions.push({
            projectId: snap.id,
            projectName: nameById[snap.id] || snap.id,
            date: asOf,
            from: prev,
            to: snap.status,
            phase: snap.phase || "",
            stage: snap.stage || "",
            progress: typeof snap.progress === "number" ? snap.progress : null,
            delayNote: snap.delayNote || "",
            delayDays: snap.delayDays || 0,
            statusChangeReason: snap.statusChangeReason || "",
          });
        }
        prevStatus[snap.id] = snap.status;
      });
    });

    return transitions.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.projectName.localeCompare(b.projectName)));
  }

  // Every time a go-live or milestone date moved (e.g. because of a CR),
  // across every project — the same diffing logic as the per-project
  // schedule timeline, just run over all projects at once.
  function computeScheduleShifts() {
    const dates = Object.keys(HISTORY).sort();
    const nameById = {};
    DATA.projects.forEach((p) => (nameById[p.id] = p.name));

    const prevGoLive = {};
    const prevMilestoneDate = {};
    const prevMilestoneName = {};
    const shifts = [];

    dates.forEach((asOf) => {
      (HISTORY[asOf].projects || []).forEach((snap) => {
        nameById[snap.id] = nameById[snap.id] || snap.name;
        const goLive = snap.goLive || null;
        const milestoneName = (snap.nextMilestone && snap.nextMilestone.name) || null;
        const milestoneDate = (snap.nextMilestone && snap.nextMilestone.date) || null;

        const pg = prevGoLive[snap.id];
        if (pg && goLive && goLive !== pg) {
          shifts.push({
            projectId: snap.id,
            projectName: nameById[snap.id] || snap.id,
            date: asOf,
            label: "Go-Live",
            from: pg,
            to: goLive,
            status: snap.status,
          });
        }

        const pmd = prevMilestoneDate[snap.id];
        const pmn = prevMilestoneName[snap.id];
        if (pmd && milestoneDate && (milestoneDate !== pmd || milestoneName !== pmn)) {
          shifts.push({
            projectId: snap.id,
            projectName: nameById[snap.id] || snap.id,
            date: asOf,
            label: milestoneName || pmn || "Milestone",
            from: pmd,
            to: milestoneDate,
            status: snap.status,
          });
        }

        if (goLive) prevGoLive[snap.id] = goLive;
        if (milestoneDate) {
          prevMilestoneDate[snap.id] = milestoneDate;
          prevMilestoneName[snap.id] = milestoneName;
        }
      });
    });

    return shifts;
  }

  // Every week a project reported time pulled back IN (timeSavedDays > 0) —
  // tracked the same way delayDays/statusChangeReason are: a this-week's-news
  // value on the snapshot, not a diff, so it shows up once per week it's
  // reported (same treatment escalations get).
  function computeTimeSavedEvents() {
    const dates = Object.keys(HISTORY).sort();
    const nameById = {};
    DATA.projects.forEach((p) => (nameById[p.id] = p.name));
    const events = [];

    dates.forEach((asOf) => {
      (HISTORY[asOf].projects || []).forEach((snap) => {
        nameById[snap.id] = nameById[snap.id] || snap.name;
        const days = snap.timeSavedDays || 0;
        if (days > 0) {
          events.push({
            projectId: snap.id,
            projectName: nameById[snap.id] || snap.id,
            date: asOf,
            days,
            note: snap.timeSavedNote || [],
            status: snap.status,
          });
        }
      });
    });

    return events;
  }

  function renderStatusHistory() {
    const transitions = computeStatusTransitions().map((t) => Object.assign({ kind: "status" }, t));
    const shifts = computeScheduleShifts().map((s) => Object.assign({ kind: "schedule" }, s));
    const timeSaved = computeTimeSavedEvents().map((s) => Object.assign({ kind: "timesaved" }, s));
    const combined = transitions.concat(shifts, timeSaved).sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

    const list = document.getElementById("statusHistoryList");
    list.innerHTML = "";

    const ownerById = {};
    DATA.projects.forEach((p) => (ownerById[p.id] = p.owner || "Unassigned"));

    const filtered = combined.filter(
      (t) =>
        (globalProjectFilter === "all" || t.projectId === globalProjectFilter) &&
        (activeOwner === "all" || ownerById[t.projectId] === activeOwner)
    );

    if (!filtered.length) {
      list.appendChild(
        el("div", { class: "deps-empty-group" }, [
          combined.length
            ? "Nothing to show for this project/PM filter."
            : "No status changes or date shifts recorded yet — once weekly updates move a project's status, go-live, or milestone dates, they'll show up here with dates and the why.",
        ])
      );
      return;
    }

    filtered.forEach((t) => {
      if (t.kind === "schedule") {
        const deltaDays = Math.round((new Date(t.to + "T00:00:00") - new Date(t.from + "T00:00:00")) / 86400000);
        const row = el("div", { class: "status-history-row kind-schedule" }, [
          el("div", { class: "status-history-date" }, [fmtDate(t.date)]),
          el("div", { class: "status-history-main" }, [
            el("div", { class: "status-history-transition" }, [
              el("span", { class: "schedule-shift-badge" }, ["📅 " + t.label + " moved"]),
              el("span", { class: "golive-date-original" }, [fmtDateShort(t.from)]),
              el("span", { class: "status-history-arrow" }, ["→"]),
              el("span", { class: "golive-date-current" }, [fmtDate(t.to)]),
              el(
                "span",
                { class: "schedule-timeline-delta " + (deltaDays > 0 ? "is-late" : deltaDays < 0 ? "is-early" : "") },
                [deltaDays === 0 ? "No change in days" : (deltaDays > 0 ? "+" : "") + deltaDays + " days"]
              ),
              el("button", { class: "status-history-project", "data-project-id": t.projectId }, [t.projectName]),
            ]),
          ]),
        ]);
        list.appendChild(row);
        return;
      }

      if (t.kind === "timesaved") {
        const row = el("div", { class: "status-history-row kind-timesaved" }, [
          el("div", { class: "status-history-date" }, [fmtDate(t.date)]),
          el("div", { class: "status-history-main" }, [
            el("div", { class: "status-history-transition" }, [
              el("span", { class: "schedule-shift-badge is-saved" }, ["⏱ Time saved"]),
              el("span", { class: "schedule-timeline-delta is-early" }, ["-" + t.days + " days"]),
              el("button", { class: "status-history-project", "data-project-id": t.projectId }, [t.projectName]),
            ]),
            t.note && t.note.length
              ? el("div", { class: "status-history-context" }, [t.note.join(" · ")])
              : null,
          ]),
        ]);
        list.appendChild(row);
        return;
      }

      const worsened = STATUS_RANK[t.to] > STATUS_RANK[t.from];
      const missingReason = worsened && !t.statusChangeReason;
      const row = el("div", { class: "status-history-row" + (worsened ? " is-worse" : " is-better") }, [
        el("div", { class: "status-history-date" }, [fmtDate(t.date)]),
        el("div", { class: "status-history-main" }, [
          el("div", { class: "status-history-transition" }, [
            el("span", { class: "pill pill-" + t.from }, [STATUS_LABEL[t.from]]),
            el("span", { class: "status-history-arrow" }, ["→"]),
            el("span", { class: "pill pill-" + t.to }, [STATUS_LABEL[t.to]]),
            el("button", { class: "status-history-project", "data-project-id": t.projectId }, [t.projectName]),
          ]),
        ]),
      ]);

      const main = row.querySelector(".status-history-main");

      // Project tracking at the time of this change: stage + progress
      const trackingBits = [];
      if (t.stage) trackingBits.push(t.stage);
      if (t.progress !== null) trackingBits.push(t.progress + "% complete");
      if (trackingBits.length) {
        main.appendChild(
          el("div", { class: "status-history-tracking" }, [
            el("span", { class: "status-history-tracking-label" }, ["Tracking at the time:"]),
            " " + trackingBits.join(" · "),
          ])
        );
      }

      const contextBits = [];
      if (t.delayDays > 0) contextBits.push(`${t.delayDays} day${t.delayDays === 1 ? "" : "s"} delayed`);
      if (t.delayNote) contextBits.push(t.delayNote);
      else if (t.phase) contextBits.push(t.phase);
      if (contextBits.length) {
        main.appendChild(el("div", { class: "status-history-context" }, [contextBits.join(" — ")]));
      }

      if (t.statusChangeReason) {
        main.appendChild(
          el("div", { class: "status-history-reason" }, [
            el("span", { class: "status-history-reason-label" }, ["Reason for change:"]),
            " " + t.statusChangeReason,
          ])
        );
      } else if (missingReason) {
        main.appendChild(
          el("div", { class: "status-history-reason status-history-reason-missing" }, [
            "⚠️ No reason was provided for this status change — please add one on the next weekly update.",
          ])
        );
      }

      list.appendChild(row);
    });

    list.querySelectorAll(".status-history-project").forEach((btn) => {
      btn.addEventListener("click", () => openProjectDetail(btn.getAttribute("data-project-id")));
    });
  }

  // Builds the nested rollup rows for the pivot table: primary group (either
  // "project" or "team") -> secondary group (the other one) -> counts. A
  // primary-group subtotal row sits above its secondary rows, mirroring the
  // mockup's nested Project -> Team pivot (just usable in either direction,
  // since teams like DevOps need the mirror image of that same table to see
  // everything they're on the hook for across every project in one place).
  function buildDependenciesPivot(rows, groupBy) {
    const primaryKey = groupBy === "team" ? "team" : "projectId";
    const primaryLabel = groupBy === "team" ? "team" : "projectName";
    const secondaryLabel = groupBy === "team" ? "projectName" : "team";

    function emptyCounts() {
      const c = { total: 0, escalated: 0 };
      PRIORITY_ORDER.forEach((p) => (c[p] = 0));
      DUE_WINDOWS.forEach((w) => (c[w.key] = 0));
      return c;
    }

    function tally(counts, r) {
      counts.total += 1;
      counts[r.priority] += 1;
      if (r.dueWindow.key !== "no-date" && counts[r.dueWindow.key] != null) counts[r.dueWindow.key] += 1;
      if (r.escalated) counts.escalated += 1;
    }

    const primaries = {};
    rows.forEach((r) => {
      const pKey = r[primaryKey] || "Unlabeled";
      const pLabel = r[primaryLabel] || "Unlabeled";
      const group =
        primaries[pKey] ||
        (primaries[pKey] = { primaryKey: pKey, label: pLabel, counts: emptyCounts(), secondaries: {} });
      tally(group.counts, r);
      const sKey = r[secondaryLabel] || "Unlabeled";
      const sub =
        group.secondaries[sKey] ||
        (group.secondaries[sKey] = { secondaryKey: sKey, label: sKey, counts: emptyCounts() });
      tally(sub.counts, r);
    });

    return Object.keys(primaries)
      .map((k) => primaries[k])
      .sort((a, b) => b.counts.total - a.counts.total || a.label.localeCompare(b.label))
      .map((group) => ({
        ...group,
        secondaries: Object.keys(group.secondaries)
          .map((k) => group.secondaries[k])
          .sort((a, b) => b.counts.total - a.counts.total || a.label.localeCompare(b.label)),
      }));
  }

  function depsPivotPrimaryKey(r) {
    return depsPivotGroupBy === "team" ? r.team || "Unlabeled" : r.projectId;
  }

  function depsPivotSecondaryKey(r) {
    return depsPivotGroupBy === "team" ? r.projectName || "Unlabeled" : r.team || "Unlabeled";
  }

  function filterDepsForDrill(rows, spec) {
    return rows.filter((r) => {
      if (spec.primaryKey != null && depsPivotPrimaryKey(r) !== spec.primaryKey) return false;
      if (spec.secondaryKey != null && depsPivotSecondaryKey(r) !== spec.secondaryKey) return false;
      if (spec.metric === "total") return true;
      if (spec.metric === "priority") return r.priority === spec.value;
      if (spec.metric === "dueWindow") return r.dueWindow.key === spec.value;
      return true;
    });
  }

  function depsPivotCountCellClass(n, kind, key) {
    let cls = "deps-pivot-num";
    if (!n) cls += " is-zero";
    else cls += " is-clickable";
    if (kind === "priority" && key) cls += " is-priority is-" + key.toLowerCase();
    if (kind === "dueWindow" && key === "overdue" && n) cls += " is-overdue";
    if (kind === "dueWindow" && key === "today" && n) cls += " is-due-soon";
    if (kind === "dueWindow" && key === "tomorrow" && n) cls += " is-due-soon";
    if (kind === "total" && n) cls += " deps-pivot-total";
    return cls;
  }

  function depsPivotCountCell(n, drill) {
    const attrs = {
      class: depsPivotCountCellClass(n, drill.kind, drill.value),
    };
    if (n) {
      attrs["data-drill"] = "1";
      attrs["data-drill-metric"] = drill.metric;
      if (drill.value) attrs["data-drill-value"] = drill.value;
      if (drill.primaryKey != null) attrs["data-drill-primary"] = drill.primaryKey;
      if (drill.secondaryKey != null) attrs["data-drill-secondary"] = drill.secondaryKey;
    }
    return el("td", attrs, [n ? String(n) : "—"]);
  }

  function renderDependenciesPivot(rows) {
    const wrap = document.getElementById("depsPivotWrap");
    wrap.innerHTML = "";
    wrap.classList.toggle("is-compact", depsPivotCompact);

    if (!rows.length) {
      wrap.appendChild(el("div", { class: "deps-empty-group" }, ["No dependencies recorded yet."]));
      lastDepsPivotExport = null;
      return;
    }

    const groups = buildDependenciesPivot(rows, depsPivotGroupBy);
    lastDepsPivotExport = { rows, groups, groupBy: depsPivotGroupBy };

    const colPrimary = depsPivotGroupBy === "team" ? "Team" : "Project";
    const colSecondary = depsPivotGroupBy === "team" ? "Project" : "Team";

    const headRow1 = el("tr", null, [
      el("th", { rowspan: "2", class: "deps-pivot-group-head" }, [colPrimary]),
      el("th", { rowspan: "2", class: "deps-pivot-group-head" }, [colSecondary]),
      el("th", { rowspan: "2" }, ["Total"]),
      el("th", { colspan: String(PRIORITY_ORDER.length) }, ["By Priority"]),
      el("th", { colspan: String(DUE_WINDOWS.length) }, ["By Due Window"]),
    ]);
    const headRow2 = el("tr", null, [
      ...PRIORITY_ORDER.map((p) => el("th", { class: "deps-pivot-sub-head is-" + p.toLowerCase() }, [p])),
      ...DUE_WINDOWS.map((w) => el("th", { class: "deps-pivot-sub-head is-" + w.key }, [w.label])),
    ]);

    function countCells(counts, drillBase) {
      return [
        depsPivotCountCell(counts.total, { ...drillBase, metric: "total", kind: "total" }),
        ...PRIORITY_ORDER.map((p) =>
          depsPivotCountCell(counts[p], { ...drillBase, metric: "priority", value: p, kind: "priority" })
        ),
        ...DUE_WINDOWS.map((w) =>
          depsPivotCountCell(counts[w.key], { ...drillBase, metric: "dueWindow", value: w.key, kind: "dueWindow" })
        ),
      ];
    }

    const tbody = el("tbody");
    groups.forEach((group) => {
      const primaryKey = group.primaryKey;
      const subCount = group.secondaries.length;
      const rowSpan = subCount + 1;

      tbody.appendChild(
        el("tr", {
          class: "deps-pivot-primary-row deps-pivot-group-total-row",
          "data-pivot-row": "group-total",
        }, [
          el("td", { class: "deps-pivot-group-cell deps-pivot-primary-label", rowspan: String(rowSpan) }, [
            group.label,
            group.counts.escalated
              ? el("span", { class: "deps-pivot-escalated-flag", title: "Has escalated dependencies" }, [" 🚨"])
              : null,
          ]),
          el("td", { class: "deps-pivot-group-cell deps-pivot-total-meta-cell" }, [
            el("span", { class: "deps-pivot-total-badge" }, ["Group total"]),
          ]),
          ...countCells(group.counts, { primaryKey, secondaryKey: null }),
        ])
      );

      group.secondaries.forEach((sub, idx) => {
        const isLast = idx === subCount - 1;
        const rowClass =
          "deps-pivot-secondary-row deps-pivot-breakdown-row" + (isLast ? " deps-pivot-group-end" : "");
        const tr = el("tr", { class: rowClass, "data-pivot-row": "breakdown" }, [
          el("td", { class: "deps-pivot-group-cell deps-pivot-sub-cell" }, [
            el("span", { class: "deps-pivot-breakdown-label" }, [sub.label]),
          ]),
          ...countCells(sub.counts, {
            primaryKey,
            secondaryKey: sub.secondaryKey,
          }),
        ]);
        tbody.appendChild(tr);
      });
    });

    const table = el("table", { class: "deps-pivot" }, [el("thead", null, [headRow1, headRow2]), tbody]);
    wrap.appendChild(table);

    table.querySelectorAll("[data-drill]").forEach((cell) => {
      cell.addEventListener("click", () => {
        const spec = {
          primaryKey: cell.getAttribute("data-drill-primary"),
          secondaryKey: cell.getAttribute("data-drill-secondary") || null,
          metric: cell.getAttribute("data-drill-metric"),
          value: cell.getAttribute("data-drill-value") || null,
        };
        openDepsDrillModal(filterDepsForDrill(rows, spec), spec);
      });
    });
  }

  function openDepsDrillModal(items, spec) {
    const modal = document.getElementById("depsDrillModal");
    const title = document.getElementById("depsDrillTitle");
    const sub = document.getElementById("depsDrillSub");
    const list = document.getElementById("depsDrillList");
    list.innerHTML = "";

    const bits = [];
    if (spec.primaryKey != null) bits.push(depsPivotGroupBy === "team" ? "Team" : "Project");
    if (spec.secondaryKey != null) bits.push(depsPivotGroupBy === "team" ? "Project" : "Team");
    if (spec.metric === "priority") bits.push(spec.value + " priority");
    else if (spec.metric === "dueWindow") bits.push(DUE_WINDOW_BY_KEY[spec.value].label);
    else if (spec.metric === "total") bits.push("all items in row");

    title.textContent = items.length + (items.length === 1 ? " dependency" : " dependencies");
    sub.textContent = bits.length ? bits.join(" · ") : "Filtered list";

    if (!items.length) {
      list.appendChild(el("p", { class: "deps-empty-group" }, ["No matching items."]));
    } else {
      const table = el("table", { class: "deps-drill-table" }, [
        el("thead", null, [
          el("tr", null, [
            el("th", null, ["Project"]),
            el("th", null, ["Team"]),
            el("th", null, ["Priority"]),
            el("th", null, ["Needed by"]),
            el("th", null, ["Escalated"]),
            el("th", null, ["Description"]),
          ]),
        ]),
        el(
          "tbody",
          null,
          items.map((r) =>
            el("tr", null, [
              el("td", null, [r.projectName]),
              el("td", null, [r.team || "—"]),
              el("td", null, [
                el("span", { class: "deps-badge deps-badge-priority is-" + r.priority.toLowerCase() }, [r.priority]),
              ]),
              el("td", null, [r.dueBy ? fmtDate(r.dueBy) : "No date"]),
              el("td", null, [r.escalated ? "Yes" : "—"]),
              el("td", { class: "deps-drill-desc" }, [r.text]),
            ])
          )
        ),
      ]);
      list.appendChild(table);
    }

    modal.hidden = false;
  }

  function closeDepsDrillModal() {
    document.getElementById("depsDrillModal").hidden = true;
  }

  function csvEscapeField(val) {
    const s = String(val == null ? "" : val);
    if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  function exportDependenciesPivotCsv() {
    if (!lastDepsPivotExport || !lastDepsPivotExport.groups.length) return;
    const { groups, groupBy } = lastDepsPivotExport;
    const colPrimary = groupBy === "team" ? "Team" : "Project";
    const colSecondary = groupBy === "team" ? "Project" : "Team";
    const headers = [colPrimary, colSecondary, "Total", ...PRIORITY_ORDER, ...DUE_WINDOWS.map((w) => w.label)];
    const lines = [headers.map(csvEscapeField).join(",")];

    groups.forEach((group) => {
      group.secondaries.forEach((sub) => {
        lines.push(
          [
            group.label,
            sub.label,
            sub.counts.total,
            ...PRIORITY_ORDER.map((p) => sub.counts[p]),
            ...DUE_WINDOWS.map((w) => sub.counts[w.key]),
          ]
            .map(csvEscapeField)
            .join(",")
        );
      });
      lines.push(
        [
          group.label,
          "Total · " + group.label,
          group.counts.total,
          ...PRIORITY_ORDER.map((p) => group.counts[p]),
          ...DUE_WINDOWS.map((w) => group.counts[w.key]),
        ]
          .map(csvEscapeField)
          .join(",")
      );
    });

    const blob = new Blob([lines.join("\n") + "\n"], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "dependencies-pivot-" + groupBy + "-" + todayISO() + ".csv";
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function populateDepsPortfolioFilter() {
    const select = document.getElementById("depsPortfolioFilter");
    if (!select) return;
    const projects = projectsWithOpenDependencies();
    const prev = depsPortfolioFilter;
    select.innerHTML = "";
    select.appendChild(
      el("option", { value: "all" }, ["All (" + projects.length + ")"])
    );
    projects.forEach((p) => {
      select.appendChild(el("option", { value: p.id }, [p.name]));
    });
    if (prev !== "all" && projects.some((p) => p.id === prev)) select.value = prev;
    else {
      depsPortfolioFilter = "all";
      select.value = "all";
    }
  }

  function populateDepsCycleFilter(rows) {
    const select = document.getElementById("depsCycleFilter");
    if (!select) return;
    const years = dependencyCycleYears(rows);
    const prev = depsCycleFilter;
    select.innerHTML = "";
    select.appendChild(el("option", { value: "all" }, ["All cycles"]));
    years.forEach((y) => {
      select.appendChild(el("option", { value: y }, ["FY " + y]));
    });
    if (prev !== "all" && years.includes(prev)) select.value = prev;
    else {
      depsCycleFilter = "all";
      select.value = "all";
    }
  }

  function updateDepsPivotSectionTitle() {
    const node = document.getElementById("depsPivotSectionTitle");
    if (!node) return;
    node.textContent =
      depsPivotGroupBy === "team" ? "Team-wise dependencies" : "Project-wise dependencies";
  }

  function wireDepsPivotControls() {
    const toggle = document.getElementById("depsViewToggle");
    if (toggle && !toggle.dataset.wired) {
      toggle.dataset.wired = "1";
      toggle.querySelectorAll(".deps-view-btn").forEach((btn) => {
        btn.addEventListener("click", () => {
          depsPivotGroupBy = btn.getAttribute("data-group");
          toggle.querySelectorAll(".deps-view-btn").forEach((b) => b.classList.toggle("is-active", b === btn));
          updateDepsPivotSectionTitle();
          renderDependenciesTab();
        });
      });
    }

    const portfolio = document.getElementById("depsPortfolioFilter");
    if (portfolio && !portfolio.dataset.wired) {
      portfolio.dataset.wired = "1";
      portfolio.addEventListener("change", () => {
        depsPortfolioFilter = portfolio.value;
        renderDependenciesTab();
      });
    }

    const cycle = document.getElementById("depsCycleFilter");
    if (cycle && !cycle.dataset.wired) {
      cycle.dataset.wired = "1";
      cycle.addEventListener("change", () => {
        depsCycleFilter = cycle.value;
        renderDependenciesTab();
      });
    }

    const compactBtn = document.getElementById("depsCompactToggle");
    if (compactBtn && !compactBtn.dataset.wired) {
      compactBtn.dataset.wired = "1";
      compactBtn.addEventListener("click", () => {
        depsPivotCompact = !depsPivotCompact;
        compactBtn.classList.toggle("is-active", depsPivotCompact);
        compactBtn.setAttribute("aria-pressed", depsPivotCompact ? "true" : "false");
        renderDependenciesPivot(collectDependencies());
      });
    }

    const exportBtn = document.getElementById("depsExportBtn");
    if (exportBtn && !exportBtn.dataset.wired) {
      exportBtn.dataset.wired = "1";
      exportBtn.addEventListener("click", exportDependenciesPivotCsv);
    }
  }

  function wireDepsDrillModal() {
    const modal = document.getElementById("depsDrillModal");
    if (!modal || modal.dataset.wired) return;
    modal.dataset.wired = "1";
    document.getElementById("depsDrillClose").addEventListener("click", closeDepsDrillModal);
    modal.addEventListener("click", (e) => {
      if (e.target === modal) closeDepsDrillModal();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !modal.hidden) closeDepsDrillModal();
    });
  }

  function renderDependenciesTab() {
    populateDepsPortfolioFilter();
    const rowsPreCycle = collectDependencies({ skipCycle: true });
    populateDepsCycleFilter(rowsPreCycle);
    const rows = collectDependencies();
    renderDependenciesMetrics(rows);
    renderDependenciesPivot(rows);
    renderDependenciesBoard(rows);
    updateDepsPivotSectionTitle();
    wireDepsPivotControls();
    wireDepsDrillModal();
  }

  /* ---------------- Tab: Escalations ---------------- */

  function collectEscalations() {
    const rows = [];
    visibleProjects().forEach((p) => {
      (p.escalations || []).forEach((text) => {
        if (!text) return;
        rows.push({ projectId: p.id, projectName: p.name, owner: p.owner || "Unassigned", status: p.status, text });
      });
    });
    return rows;
  }

  function renderEscalationsMetrics(rows) {
    const projects = new Set(rows.map((r) => r.projectId));
    const metrics = [
      { label: "Total Escalations", num: rows.length, tone: rows.length ? "tone-red" : "tone-green" },
      { label: "Projects Escalating", num: projects.size, tone: projects.size ? "tone-amber" : "tone-green" },
    ];
    const row = document.getElementById("escalationsMetricsRow");
    row.innerHTML = "";
    metrics.forEach((m) => {
      row.appendChild(
        el("div", { class: "metric-card " + m.tone }, [
          el("div", { class: "num" }, [String(m.num)]),
          el("div", { class: "label" }, [m.label]),
        ])
      );
    });
  }

  function renderEscalationsBoard(rows) {
    const board = document.getElementById("escalationsBoard");
    board.innerHTML = "";

    if (!rows.length) {
      board.appendChild(
        el("div", { class: "deps-empty-group" }, ["Nothing currently escalated to leadership. 🎉"])
      );
      return;
    }

    const groups = {};
    rows.forEach((r) => {
      (groups[r.projectId] = groups[r.projectId] || { projectName: r.projectName, owner: r.owner, status: r.status, items: [] }).items.push(r.text);
    });

    Object.keys(groups)
      .sort((a, b) => groups[b].items.length - groups[a].items.length || groups[a].projectName.localeCompare(groups[b].projectName))
      .forEach((projectId) => {
        const g = groups[projectId];
        const group = el("div", { class: "deps-group escalations-group" }, [
          el("div", { class: "deps-group-head" }, [
            el("div", { class: "deps-card-project escalations-project", "data-project-id": projectId }, [
              el("span", { class: "timeline-dot", style: `background:var(--${g.status === "amber" ? "amber" : g.status})` }),
              g.projectName,
              el("span", { class: "escalations-owner" }, [" · " + g.owner]),
            ]),
            el("span", { class: "deps-group-count" }, [g.items.length + (g.items.length === 1 ? " escalation" : " escalations")]),
          ]),
        ]);
        const list = el("ul", { class: "escalations-list" }, g.items.map((text) => el("li", null, [text])));
        group.appendChild(list);
        board.appendChild(group);
      });

    board.querySelectorAll(".deps-card-project").forEach((node) => {
      node.addEventListener("click", () => openProjectDetail(node.getAttribute("data-project-id")));
    });
  }

  function copyEscalationsSummary(rows) {
    const btn = document.getElementById("copyEscalationsBtn");
    if (!rows.length) {
      btn.textContent = "Nothing to copy";
      setTimeout(() => (btn.textContent = "📋 Copy summary to share"), 1500);
      return;
    }
    const groups = {};
    rows.forEach((r) => {
      (groups[r.projectName] = groups[r.projectName] || []).push(r.text);
    });
    const asOf = DATA.asOf ? fmtDate(DATA.asOf) : "";
    const lines = [`Escalations to leadership — as of ${asOf}`, ""];
    Object.keys(groups).forEach((name) => {
      lines.push(`${name}:`);
      groups[name].forEach((text) => lines.push(`  • ${text}`));
      lines.push("");
    });
    const text = lines.join("\n").trim();

    const done = () => {
      btn.textContent = "✅ Copied!";
      setTimeout(() => (btn.textContent = "📋 Copy summary to share"), 1500);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(done);
    } else {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
      } catch (e) {
        // ignore
      }
      document.body.removeChild(ta);
      done();
    }
  }

  function renderEscalationsTab() {
    const rows = collectEscalations();
    renderEscalationsMetrics(rows);
    renderEscalationsBoard(rows);
    const btn = document.getElementById("copyEscalationsBtn");
    if (btn) btn.onclick = () => copyEscalationsSummary(rows);
  }

  /* ---------------- Project detail overlay ---------------- */

  function historyForProject(projectId) {
    return Object.keys(HISTORY)
      .sort()
      .map((asOf) => {
        const snap = HISTORY[asOf].projects.find((p) => p.id === projectId);
        return snap ? { asOf, ...snap } : null;
      })
      .filter(Boolean);
  }

  /* ---------------- Stage-gate timeline + SLA ---------------- */

  // Fallback SLAs (business days aren't tracked here, just calendar days —
  // close enough for a weekly cadence). data.json's top-level `stageSlaDays`
  // always wins if present, so these can be tuned without touching code.
  const DEFAULT_STAGE_SLA_DAYS = {
    "Requirements": 10,
    "Design / Estimation": 10,
    "Development": 30,
    "QA / UAT": 14,
    "Production Release": 5,
    "Hypercare / Post-Launch": 21,
  };

  function stageSlaDays(stage) {
    const configured = DATA && DATA.stageSlaDays;
    if (configured && configured[stage] != null) return configured[stage];
    return DEFAULT_STAGE_SLA_DAYS[stage] != null ? DEFAULT_STAGE_SLA_DAYS[stage] : null;
  }

  function daysBetweenIso(aIso, bIso) {
    const DAY = 86400000;
    return Math.round((new Date(bIso + "T00:00:00") - new Date(aIso + "T00:00:00")) / DAY);
  }

  // "ok" | "warn" (>=80% of SLA) | "breach" (over SLA) | null (no SLA tracked
  // for this stage, e.g. "Unstaged").
  function stageFlagLevel(days, sla) {
    if (sla == null) return null;
    if (days > sla) return "breach";
    if (days >= sla * 0.8) return "warn";
    return "ok";
  }

  // Reconstructs how long a project has spent in each pipeline stage, using
  // the weekly history snapshots (only granularity we have — this isn't
  // exact to the day, but good enough for a weekly leadership review).
  // Returns an ordered list of segments: { stage, start, end, ongoing,
  // approxStart }. `approxStart` marks the very first segment, since we
  // don't know how long the project was in that stage before tracking began.
  function computeStageSegments(p) {
    const today = todayISO();
    const points = historyForProject(p.id).map((w) => ({ asOf: w.asOf, stage: w.stage || "Unstaged" }));
    const currentStage = p.stage || "Unstaged";
    if (!points.length || points[points.length - 1].stage !== currentStage) {
      points.push({ asOf: today, stage: currentStage });
    }

    const segments = [];
    points.forEach((pt) => {
      const last = segments[segments.length - 1];
      if (!last || last.stage !== pt.stage) {
        if (last) last.end = pt.asOf;
        segments.push({ stage: pt.stage, start: pt.asOf, end: null });
      }
    });

    const finalSeg = segments[segments.length - 1];
    if (finalSeg) {
      finalSeg.end = today;
      finalSeg.ongoing = true;
    }
    if (segments.length) segments[0].approxStart = true;

    return segments.map((seg) => ({ ...seg, days: Math.max(0, daysBetweenIso(seg.start, seg.end)) }));
  }

  function currentStageInfo(p) {
    const segments = computeStageSegments(p);
    const seg = segments[segments.length - 1];
    if (!seg) return null;
    const sla = stageSlaDays(seg.stage);
    return { ...seg, sla, flag: stageFlagLevel(seg.days, sla) };
  }

  /* ---------------- Stage detail modal (per-stage planned/actual dates,
     delay attribution, delay log) ---------------- */

  // Diffs `stagePlan[stage].latestStart` / `.latestEnd` across every weekly
  // history snapshot for this project, building a revision log: the first
  // time a field is seen is its "Baseline" row, every later change is a
  // numbered revision with the day-shift from the immediately preceding
  // value (not the baseline) — same semantics as computeScheduleShifts, just
  // scoped to one stage's planned dates instead of goLive/milestones.
  function stagePlanRevisions(p, stage) {
    const weeks = historyForProject(p.id);
    const revisions = [];
    let prevStart = null;
    let prevEnd = null;
    let startRevNum = 0;
    let endRevNum = 0;

    weeks.forEach((w) => {
      const plan = (w.stagePlan && w.stagePlan[stage]) || null;
      const start = plan ? plan.latestStart : null;
      const end = plan ? plan.latestEnd : null;

      if (start && start !== prevStart) {
        revisions.push({
          revision: prevStart === null ? "Baseline" : "Rev " + ++startRevNum,
          changedOn: w.asOf,
          field: "Planned Start",
          from: prevStart,
          to: start,
          shiftDays: prevStart === null ? null : daysBetweenIso(prevStart, start),
        });
        prevStart = start;
      }
      if (end && end !== prevEnd) {
        revisions.push({
          revision: prevEnd === null ? "Baseline" : "Rev " + ++endRevNum,
          changedOn: w.asOf,
          field: "Planned Completion",
          from: prevEnd,
          to: end,
          shiftDays: prevEnd === null ? null : daysBetweenIso(prevEnd, end),
        });
        prevEnd = end;
      }
    });

    // Live data.json may be ahead of the last captured snapshot (this
    // week's update hasn't been through a snapshot yet) — include it too.
    const livePlan = (p.stagePlan && p.stagePlan[stage]) || null;
    if (livePlan) {
      if (livePlan.latestStart && livePlan.latestStart !== prevStart) {
        revisions.push({
          revision: prevStart === null ? "Baseline" : "Rev " + ++startRevNum,
          changedOn: DATA.asOf,
          field: "Planned Start",
          from: prevStart,
          to: livePlan.latestStart,
          shiftDays: prevStart === null ? null : daysBetweenIso(prevStart, livePlan.latestStart),
        });
      }
      if (livePlan.latestEnd && livePlan.latestEnd !== prevEnd) {
        revisions.push({
          revision: prevEnd === null ? "Baseline" : "Rev " + ++endRevNum,
          changedOn: DATA.asOf,
          field: "Planned Completion",
          from: prevEnd,
          to: livePlan.latestEnd,
          shiftDays: prevEnd === null ? null : daysBetweenIso(prevEnd, livePlan.latestEnd),
        });
      }
    }

    return revisions;
  }

  function stageDelayLog(p, stage) {
    return (p.delayLog || []).filter((e) => e.stage === stage);
  }

  // Groups delay-log entries by a key (team/member/reason) and sums days —
  // the data behind the stage detail modal's "Delay Analysis" tab. Sorted
  // by days descending so the biggest contributor leads.
  function aggregateDelayLog(entries, keyField) {
    const groups = {};
    entries.forEach((e) => {
      const key = e[keyField] || "Unlabeled";
      const g = groups[key] || (groups[key] = { label: key, days: 0, count: 0 });
      g.days += e.days || 0;
      g.count += 1;
    });
    return Object.values(groups).sort((a, b) => b.days - a.days || a.label.localeCompare(b.label));
  }

  const STATUS_COLOR = { green: "#2f6b4f", amber: "#a6650f", red: "#b5342a", black: "#1c1d24" };

  function buildTrendGraph(weeks) {
    const width = 700;
    const height = 210;
    const padL = 38;
    const padR = 16;
    const padT = 30;
    const padB = 30;
    const plotW = width - padL - padR;
    const plotH = height - padT - padB;

    const xFor = (i) => (weeks.length === 1 ? padL + plotW / 2 : padL + (i / (weeks.length - 1)) * plotW);
    const yFor = (pct) => padT + plotH - (pct / 100) * plotH;

    const points = weeks.map((w, i) => ({ x: xFor(i), y: yFor(w.progress), w }));
    const lineD = points.map((p, i) => (i === 0 ? `M ${p.x} ${p.y}` : `L ${p.x} ${p.y}`)).join(" ");
    const areaD = `${lineD} L ${points[points.length - 1].x} ${padT + plotH} L ${points[0].x} ${padT + plotH} Z`;

    const gridLines = [0, 25, 50, 75, 100].map((pct) => {
      const y = yFor(pct);
      return `<line x1="${padL}" y1="${y}" x2="${width - padR}" y2="${y}" stroke="var(--line)" stroke-width="1" />` +
        `<text x="${padL - 8}" y="${y}" text-anchor="end" dominant-baseline="middle" class="graph-axis-label">${pct}</text>`;
    }).join("");

    const xLabels = points.map((p, i) =>
      `<text x="${p.x}" y="${height - 8}" text-anchor="middle" class="graph-axis-label">${fmtDateShort(p.w.asOf)}</text>`
    ).join("");

    const latestColor = STATUS_COLOR[weeks[weeks.length - 1].status] || "var(--accent)";

    const dots = points.map((p) => {
      // Flip the label below the dot when it's too close to the top edge
      // (and thus the "100" axis label) to avoid the two overlapping.
      const tooHigh = p.y - 12 < padT + 10;
      const labelY = tooHigh ? p.y + 18 : p.y - 12;
      return `<circle cx="${p.x}" cy="${p.y}" r="4.5" fill="${STATUS_COLOR[p.w.status] || latestColor}" stroke="#fff" stroke-width="2" />` +
        `<text x="${p.x}" y="${labelY}" text-anchor="middle" class="graph-point-label">${p.w.progress}%</text>`;
    }).join("");

    const svg = `
      <svg viewBox="0 0 ${width} ${height}" class="trend-graph" preserveAspectRatio="none">
        <defs>
          <linearGradient id="trendFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="${latestColor}" stop-opacity="0.16" />
            <stop offset="100%" stop-color="${latestColor}" stop-opacity="0" />
          </linearGradient>
        </defs>
        ${gridLines}
        <path d="${areaD}" fill="url(#trendFill)" stroke="none" />
        <path d="${lineD}" fill="none" stroke="${latestColor}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round" />
        ${dots}
        ${xLabels}
      </svg>`;

    return el("div", { class: "trend-graph-wrap", html: svg });
  }

  function buildScheduleTimeline(weeks) {
    const events = [];
    let prevGoLive = null;
    let prevMilestoneName = null;
    let prevMilestoneDate = null;

    weeks.forEach((w) => {
      const goLive = w.goLive || null;
      const milestoneName = (w.nextMilestone && w.nextMilestone.name) || null;
      const milestoneDate = (w.nextMilestone && w.nextMilestone.date) || null;

      if (prevGoLive && goLive && goLive !== prevGoLive) {
        events.push({ date: w.asOf, label: "Go-Live", from: prevGoLive, to: goLive });
      }
      if (
        prevMilestoneDate &&
        milestoneDate &&
        (milestoneDate !== prevMilestoneDate || milestoneName !== prevMilestoneName)
      ) {
        events.push({
          date: w.asOf,
          label: milestoneName || prevMilestoneName || "Milestone",
          from: prevMilestoneDate,
          to: milestoneDate,
        });
      }

      if (goLive) prevGoLive = goLive;
      if (milestoneDate) {
        prevMilestoneDate = milestoneDate;
        prevMilestoneName = milestoneName;
      }

      // Time pulled back IN this week — tracked the same way as a delay:
      // one event per week it's reported, not a diff.
      if ((w.timeSavedDays || 0) > 0) {
        events.push({
          date: w.asOf,
          label: "Time saved",
          kind: "timesaved",
          days: w.timeSavedDays,
          note: w.timeSavedNote || [],
        });
      }
    });

    return events.reverse(); // newest first
  }

  function renderScheduleTimeline(events) {
    if (!events.length) {
      return el("p", { class: "empty-note" }, [
        "No schedule changes recorded yet — this fills in automatically whenever a go-live or " +
          "milestone date moves (e.g. because of a CR), or time gets saved, with the date it happened.",
      ]);
    }

    const box = el("div", { class: "schedule-timeline" });
    events.forEach((e) => {
      if (e.kind === "timesaved") {
        box.appendChild(
          el("div", { class: "schedule-timeline-row kind-timesaved" }, [
            el("div", { class: "schedule-timeline-date" }, [fmtDate(e.date)]),
            el("div", { class: "schedule-timeline-main" }, [
              el("span", { class: "schedule-timeline-label" }, [e.label]),
              el("span", { class: "schedule-timeline-delta is-early" }, ["-" + e.days + " days"]),
              e.note && e.note.length
                ? el("span", { class: "schedule-timeline-note" }, [e.note.join(" · ")])
                : null,
            ]),
          ])
        );
        return;
      }

      const deltaDays = Math.round(
        (new Date(e.to + "T00:00:00") - new Date(e.from + "T00:00:00")) / 86400000
      );
      box.appendChild(
        el("div", { class: "schedule-timeline-row" }, [
          el("div", { class: "schedule-timeline-date" }, [fmtDate(e.date)]),
          el("div", { class: "schedule-timeline-main" }, [
            el("span", { class: "schedule-timeline-label" }, [e.label]),
            el("span", { class: "golive-date-original" }, [fmtDateShort(e.from)]),
            el("span", { class: "golive-arrow" }, ["→"]),
            el("span", { class: "golive-date-current" }, [fmtDate(e.to)]),
            el("span", { class: "schedule-timeline-delta " + (deltaDays > 0 ? "is-late" : deltaDays < 0 ? "is-early" : "") }, [
              deltaDays === 0 ? "No change in days" : (deltaDays > 0 ? "+" : "") + deltaDays + " days",
            ]),
          ]),
        ])
      );
    });
    return box;
  }

  // Keeps marker labels from spilling past the left/right edge of the Gantt
  // track (which would otherwise get clipped since there's nothing to
  // scroll to beyond the track boundaries).
  function ganttLabelEdgeStyle(pct) {
    if (pct < 14) return "left:0;transform:translateX(0);";
    if (pct > 86) return "left:auto;right:0;transform:translateX(0);";
    return "";
  }

  function buildSingleProjectGantt(p) {
    const DAY = 86400000;
    const todayIso = todayISO();
    const dates = [todayIso];
    if (p.originalGoLive) dates.push(p.originalGoLive);
    if (p.goLive) dates.push(p.goLive);
    if (p.nextMilestone && p.nextMilestone.date) dates.push(p.nextMilestone.date);
    (p.milestones || []).forEach((m) => {
      if (m.date) dates.push(m.date);
    });

    if (dates.length < 2) {
      return el("p", { class: "empty-note" }, ["No dates to plot yet for this project's timeline."]);
    }

    const times = dates.map((d) => new Date(d + "T00:00:00").getTime());
    let minTime = Math.min(...times) - 10 * DAY;
    let maxTime = Math.max(...times) + 14 * DAY;
    if (maxTime - minTime < 30 * DAY) maxTime = minTime + 30 * DAY;

    const xPct = (iso) => {
      const t = new Date(iso + "T00:00:00").getTime();
      return Math.max(0, Math.min(100, ((t - minTime) / (maxTime - minTime)) * 100));
    };

    const monthMarks = [];
    const cursor = new Date(minTime);
    cursor.setDate(1);
    cursor.setHours(0, 0, 0, 0);
    while (cursor.getTime() <= maxTime) {
      if (cursor.getTime() >= minTime) {
        monthMarks.push({
          pct: ((cursor.getTime() - minTime) / (maxTime - minTime)) * 100,
          label: cursor.toLocaleDateString("en-US", { month: "short", year: "numeric" }),
        });
      }
      cursor.setMonth(cursor.getMonth() + 1);
    }

    const wrap = el("div", { class: "project-gantt" });

    const header = el("div", { class: "project-gantt-months" });
    monthMarks.forEach((m) => {
      header.appendChild(el("div", { class: "project-gantt-month-mark", style: `left:${m.pct}%` }, [m.label]));
    });
    wrap.appendChild(header);

    const track = el("div", { class: "project-gantt-track" });
    monthMarks.forEach((m) => {
      track.appendChild(el("div", { class: "project-gantt-grid-line", style: `left:${m.pct}%` }));
    });
    track.appendChild(
      el("div", { class: "project-gantt-today-line", style: `left:${xPct(todayIso)}%` }, [
        el("span", { class: "project-gantt-today-label" }, ["Today"]),
      ])
    );
    track.appendChild(el("div", { class: "project-gantt-baseline" }));

    if (p.originalGoLive && p.goLive && p.originalGoLive !== p.goLive) {
      const a = xPct(p.originalGoLive);
      const b = xPct(p.goLive);
      track.appendChild(
        el("div", { class: "project-gantt-slip-line", style: `left:${Math.min(a, b)}%;width:${Math.abs(b - a)}%` })
      );
      track.appendChild(
        el(
          "div",
          {
            class: "project-gantt-marker ghost",
            style: `left:${a}%`,
            title: `Original Go-Live · ${fmtDate(p.originalGoLive)}`,
          },
          [
            el(
              "span",
              { class: "project-gantt-marker-label above", style: ganttLabelEdgeStyle(a) },
              ["Original · " + fmtDateShort(p.originalGoLive)]
            ),
          ]
        )
      );
    }

    const milestones =
      p.milestones && p.milestones.length
        ? p.milestones
        : p.nextMilestone && p.nextMilestone.date
        ? [{ name: p.nextMilestone.name || "Milestone", date: p.nextMilestone.date, status: p.status }]
        : [];

    milestones.forEach((m, i) => {
      if (!m.date) return;
      const above = i % 2 === 0;
      const pct = xPct(m.date);
      track.appendChild(
        el(
          "div",
          {
            class: `project-gantt-marker milestone status-${m.status || p.status}`,
            style: `left:${pct}%`,
            title: `${m.name} · ${fmtDate(m.date)}`,
          },
          [
            el(
              "span",
              { class: "project-gantt-marker-label " + (above ? "above" : "below"), style: ganttLabelEdgeStyle(pct) },
              [m.name + " · " + fmtDateShort(m.date)]
            ),
          ]
        )
      );
    });

    if (p.goLive) {
      const golivePct = xPct(p.goLive);
      track.appendChild(
        el(
          "div",
          {
            class: `project-gantt-marker golive status-${p.status}`,
            style: `left:${golivePct}%`,
            title: `Go-Live · ${fmtDate(p.goLive)}`,
          },
          [
            el(
              "span",
              { class: "project-gantt-marker-label below", style: ganttLabelEdgeStyle(golivePct) },
              ["Go-Live · " + fmtDateShort(p.goLive)]
            ),
          ]
        )
      );
    }

    wrap.appendChild(track);
    return wrap;
  }

  function openProjectDetail(projectId, focusSectionId) {
    const project = DATA.projects.find((p) => p.id === projectId);
    if (!project) return;

    const overlay = document.getElementById("projectDetail");
    const content = document.getElementById("detailContent");
    content.innerHTML = "";
    content.appendChild(buildProjectDetail(project));
    overlay.hidden = false;
    document.body.classList.add("no-scroll");

    if (focusSectionId) {
      requestAnimationFrame(() => {
        const target = document.getElementById(focusSectionId);
        if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    } else {
      overlay.scrollTop = 0;
    }
  }

  function closeProjectDetail() {
    document.getElementById("projectDetail").hidden = true;
    document.body.classList.remove("no-scroll");
  }

  function buildProjectDetail(p) {
    const isLate = p.delayDays > 0;
    const openFollowUps = openNotesFor(p.id);
    const allNotes = NOTES.filter((n) => n.projectId === p.id);
    const weeks = historyForProject(p.id);

    const root = el("div", { class: "detail-root" });

    // Header
    root.appendChild(
      el("div", { class: "detail-head" }, [
        el("div", null, [
          el("span", { class: "pill pill-" + p.status }, [STATUS_LABEL[p.status]]),
          el("h1", null, [p.name]),
          el("div", { class: "card-owner" }, [p.owner ? "PM: " + p.owner : "PM: unassigned"]),
        ]),
        el("div", { class: "detail-action-row" }, [
          el("a", {
            class: "btn-primary btn-small",
            target: "_blank",
            rel: "noopener",
            href: issueUrl("weekly-update.yml", { project: p.name, as_of: todayISO(), owner: p.owner || "" }),
          }, ["Submit weekly update ↗"]),
          el("a", {
            class: "btn-ghost btn-small",
            target: "_blank",
            rel: "noopener",
            href: issueUrl("meeting-feedback.yml", { project: p.name }),
          }, ["Add feedback ↗"]),
        ]),
      ])
    );

    root.appendChild(
      el("div", { class: "progress-row detail-progress" }, [
        el("div", { class: "progress-track" }, [
          el("div", { class: "progress-fill status-" + p.status, style: "width:" + p.progress + "%" }),
        ]),
        el("div", { class: "progress-pct" }, [p.progress + "%"]),
      ])
    );

    root.appendChild(
      el("dl", { class: "card-facts detail-facts" }, [
        el("dt", null, ["Phase"]),
        el("dd", null, [p.phase || "—"]),
        el("dt", null, ["Next milestone"]),
        el("dd", null, [(p.nextMilestone && p.nextMilestone.name || "—") + (p.nextMilestone && p.nextMilestone.date ? " · " + fmtDateShort(p.nextMilestone.date) : "")]),
        el("dt", null, ["Go-live"]),
        el("dd", null, [
          p.originalGoLive && p.originalGoLive !== p.goLive
            ? `${fmtDate(p.originalGoLive)} → ${fmtDate(p.goLive)}`
            : fmtDate(p.goLive),
        ]),
        el("dt", null, ["Delay"]),
        el("dd", { class: "delay-flag " + (isLate ? "is-late" : "is-ontime") }, [
          isLate ? "+" + p.delayDays + " days" : "On schedule",
        ]),
        ...(isLate
          ? [
              el("dt", null, ["Impact of delay"]),
              el("dd", { class: p.delayImpact ? "" : "is-missing" }, [
                p.delayImpact || "Not yet documented",
              ]),
            ]
          : []),
        ...((p.timeSavedDays || 0) > 0
          ? [
              el("dt", null, ["Time saved"]),
              el("dd", { class: "delay-flag is-saved" }, ["-" + p.timeSavedDays + " days"]),
            ]
          : []),
      ])
    );

    // Stage-gate timeline — how long the project has spent in each pipeline
    // stage, reconstructed from weekly history snapshots, flagged against
    // each stage's SLA (from data.json's stageSlaDays, tunable per stage).
    root.appendChild(el("h3", { class: "weekly-subhead" }, ["Stage-gate timeline"]));
    root.appendChild(
      el(
        "div",
        { id: "stage-gate-timeline-section", class: "stage-timeline" },
        computeStageSegments(p).map((seg) => {
          const sla = stageSlaDays(seg.stage);
          const flag = stageFlagLevel(seg.days, sla);
          return el(
            "div",
            {
              class: "stage-timeline-row" + (seg.ongoing ? " is-ongoing" : ""),
              "data-project-id": p.id,
              "data-stage": seg.stage,
              title: "Click for stage detail",
            },
            [
              el("span", { class: "stage-timeline-stage" }, [seg.stage]),
              el("span", { class: "stage-timeline-range" }, [
                (seg.approxStart ? "since before tracking, " : "") +
                  fmtDateShort(seg.start) +
                  (seg.ongoing ? " → now" : " → " + fmtDateShort(seg.end)),
              ]),
              el("span", { class: "stage-timeline-duration" + (flag ? " is-" + flag : "") }, [
                (seg.approxStart ? "≥" : "") + seg.days + "d" + (sla != null ? " / SLA " + sla + "d" : ""),
              ]),
            ]
          );
        })
      )
    );
    root.querySelectorAll(".stage-timeline-row").forEach((row) => {
      row.addEventListener("click", () => {
        openStageDetail(row.getAttribute("data-project-id"), row.getAttribute("data-stage"));
      });
    });

    if (isLate) {
      root.appendChild(el("h3", { class: "weekly-subhead" }, ["Delay recovery"]));
      root.appendChild(
        el("div", { class: "detail-block delay-recovery" }, [
          el("h4", null, ["Mitigation steps taken"]),
          p.delayMitigation && p.delayMitigation.length
            ? el("ul", null, listOrDash(p.delayMitigation))
            : el("p", { class: "empty-note is-missing" }, ["Not yet documented"]),
          el("h4", null, ["Trade-off conversations"]),
          el("p", { class: p.delayTradeoffs ? "" : "empty-note" }, [
            p.delayTradeoffs || "None recorded — assumed no scope/resource trade-offs made yet.",
          ]),
        ])
      );
    }

    if ((p.timeSavedDays || 0) > 0) {
      root.appendChild(el("h3", { class: "weekly-subhead" }, ["Time saved"]));
      root.appendChild(
        el("div", { class: "detail-block time-saved" }, [
          el("h4", null, ["+" + p.timeSavedDays + " day" + (p.timeSavedDays === 1 ? "" : "s") + " ahead of plan"]),
          p.timeSavedNote && p.timeSavedNote.length
            ? el("ul", null, listOrDash(p.timeSavedNote))
            : el("p", { class: "empty-note is-missing" }, ["Not yet documented"]),
        ])
      );
    }

    if (openFollowUps.length) {
      root.appendChild(el("h3", { class: "weekly-subhead" }, ["Open follow-ups"]));
      root.appendChild(
        el("div", { class: "detail-block followups" }, [
          el(
            "ul",
            null,
            openFollowUps.map((n) =>
              el("li", { class: "followup-item" }, [
                el("span", null, [n.text + (n.raisedBy ? ` — ${n.raisedBy}` : "")]),
                resolveLink(n, p.name),
              ])
            )
          ),
        ])
      );
    }

    if ((p.fastFollowItems || []).length || p.scopeReduced) {
      root.appendChild(el("h3", { class: "weekly-subhead" }, ["Fast-follow items (planned or remaining)"]));
      root.appendChild(
        el("div", { class: "detail-block fast-follow" }, [
          el("p", { class: "empty-note" }, [
            p.scopeReduced
              ? "Scope is being cut/deferred to hold the current date. Live / in production, but not fully closed out until these ship:"
              : "Live / in production, but not fully closed out until these ship:",
          ]),
          el("ul", null, listOrDash(p.fastFollowItems || [])),
        ])
      );
    }

    // Progress trend chart
    root.appendChild(el("h3", { class: "weekly-subhead" }, ["Progress over time"]));
    if (!weeks.length) {
      root.appendChild(el("p", { class: "empty-note" }, ["No history yet — it'll build up week over week as updates get ingested."]));
    } else {
      root.appendChild(buildTrendGraph(weeks));
    }

    // Schedule timeline — visual Gantt for this project, plus a log of every date move (e.g. a CR)
    const scheduleSection = el("div", { id: "detailScheduleSection" });
    scheduleSection.appendChild(el("h3", { class: "weekly-subhead" }, ["Schedule timeline"]));
    scheduleSection.appendChild(
      el("p", { class: "section-subhead" }, [
        "This project's milestones and go-live plotted on a calendar, plus a log of every time a date moved — e.g. a CR pushing the timeline.",
      ])
    );
    scheduleSection.appendChild(buildSingleProjectGantt(p));
    const scheduleEvents = buildScheduleTimeline(weeks);
    if (scheduleEvents.length) {
      scheduleSection.appendChild(el("h4", { class: "schedule-changelog-subhead" }, ["Date change log"]));
    }
    scheduleSection.appendChild(renderScheduleTimeline(scheduleEvents));
    root.appendChild(scheduleSection);

    // Renders the Dependencies / Weekly Status / Risks blocks for a given
    // week's data (either the live project `p` or a historical snapshot),
    // into the shared container below the change log.
    function renderSnapshotSections(container, snap, label, isLatest) {
      container.innerHTML = "";

      container.appendChild(
        el("div", { class: "snapshot-sections-label" }, [
          isLatest ? "Showing current data" : "Showing snapshot as of " + fmtDate(label),
        ])
      );

      if (snap.escalations && snap.escalations.length) {
        container.appendChild(el("h3", { class: "weekly-subhead" }, ["🚨 Escalated to leadership"]));
        container.appendChild(
          el("div", { class: "detail-block escalations" }, [
            el("ul", null, snap.escalations.map((text) => el("li", null, [text]))),
          ])
        );
      }

      container.appendChild(
        el("h3", { class: "weekly-subhead detail-section-head" }, [
          el("span", null, ["Dependencies"]),
          isLatest
            ? detailSectionIssueLink("new-dependency.yml", p.name, "+ Add a Dependency")
            : null,
        ].filter(Boolean))
      );
      const snapDeps = getDependencyObjects(snap).filter(
        (d) => !d.resolved && !isPlaceholderDependencyText(d.text)
      );
      container.appendChild(
        el("div", { class: "detail-block deps" }, [
          el(
            "ul",
            { class: "paired-list" },
            pairedList(
              snapDeps.map((d) => d.text),
              snapDeps.map((d) => d.mitigation),
              "Mitigation / impact",
              snapDeps.map((d) => d.team)
            )
          ),
        ])
      );

      container.appendChild(el("h3", { class: "weekly-subhead" }, ["Weekly Status"]));
      if (!snap.sprintStatus) {
        container.appendChild(
          el("p", { class: "empty-note" }, ["Sprint work detail wasn't captured for this week's snapshot yet."])
        );
      } else {
        container.appendChild(
          el("div", { class: "sprint-grid" }, [
            el("div", { class: "detail-block" }, [
              el("h4", null, ["Completed"]),
              el("ul", null, listOrDash(snap.sprintStatus.completed || [])),
            ]),
            el("div", { class: "detail-block" }, [
              el("h4", null, ["In progress"]),
              el("ul", null, listOrDash(snap.sprintStatus.inProgress || [])),
            ]),
            el("div", { class: "detail-block" }, [
              el("h4", null, ["Next plan"]),
              el("ul", null, listOrDash(snap.sprintStatus.nextPlan || [])),
            ]),
          ])
        );
      }

      const snapRisks = getRiskObjects(snap).filter(
        (r) => !r.resolved && !isPlaceholderRiskText(r.text)
      );
      container.appendChild(
        el("h3", { class: "weekly-subhead detail-section-head" }, [
          el("span", null, ["Risks / blockers"]),
          isLatest
            ? detailSectionIssueLink("new-risk.yml", p.name, "+ Report a Risk")
            : null,
        ].filter(Boolean))
      );
      container.appendChild(
        el("div", { class: "detail-block risks" }, [
          snapRisks.length
            ? el("ul", { class: "paired-list" }, pairedList(
                snapRisks.map((r) => r.text),
                snapRisks.map((r) => r.mitigation),
                "Mitigation plan"
              ))
            : el("ul", null, [el("li", null, ["None reported"])]),
        ])
      );
    }

    const snapshotSections = el("div", { class: "snapshot-sections" });

    // Change log — click a week to load its Dependencies / Weekly Status /
    // Risks below as they were that week, instead of always showing current.
    if (weeks.length) {
      root.appendChild(el("h3", { class: "weekly-subhead" }, ["Week-over-week changes"]));
      root.appendChild(el("p", { class: "section-subhead", style: "margin:-6px 0 12px;" }, ["Click a week to see dependencies, sprint status, and risks as they stood that week."]));
      const changeLog = el("div", { class: "changelog" });
      for (let i = weeks.length - 1; i >= 0; i--) {
        const cur = weeks[i];
        const prev = weeks[i - 1];
        const isLatest = i === weeks.length - 1;
        const changes = [];
        const statusChanged = !!(prev && prev.status !== cur.status);
        if (prev) {
          if (prev.progress !== cur.progress) changes.push(`Progress ${prev.progress}% → ${cur.progress}%`);
          if (prev.delayDays !== cur.delayDays) changes.push(`Delay ${prev.delayDays}d → ${cur.delayDays}d`);
          if ((prev.phase || "") !== (cur.phase || "")) changes.push(`Phase → ${cur.phase || "—"}`);
          if ((prev.stage || "") !== (cur.stage || "")) changes.push(`Stage → ${cur.stage || "—"}`);
        } else {
          changes.push("First recorded snapshot");
        }
        const bodyChildren = [];
        if (statusChanged) {
          bodyChildren.push(
            el("div", { class: "changelog-status-change" }, [
              el("span", { class: "pill pill-" + prev.status }, [STATUS_LABEL[prev.status]]),
              el("span", { class: "status-history-arrow" }, ["→"]),
              el("span", { class: "pill pill-" + cur.status }, [STATUS_LABEL[cur.status]]),
            ])
          );
        }
        if (changes.length) bodyChildren.push(el("div", null, [changes.join(" · ")]));

        const rowEl = el(
          "div",
          {
            class: "changelog-row" + (statusChanged ? " has-status-change" : "") + (isLatest ? " is-selected" : ""),
            "data-week-index": String(i),
            tabindex: "0",
            role: "button",
          },
          [
            el("div", { class: "changelog-date" }, [fmtDate(cur.asOf)]),
            el("div", { class: "changelog-body" }, bodyChildren),
          ]
        );
        changeLog.appendChild(rowEl);
      }
      root.appendChild(changeLog);

      changeLog.querySelectorAll(".changelog-row").forEach((rowEl) => {
        const selectWeek = () => {
          const idx = Number(rowEl.getAttribute("data-week-index"));
          const isLatest = idx === weeks.length - 1;
          changeLog.querySelectorAll(".changelog-row").forEach((r) => r.classList.remove("is-selected"));
          rowEl.classList.add("is-selected");
          renderSnapshotSections(snapshotSections, isLatest ? p : weeks[idx], weeks[idx].asOf, isLatest);
        };
        rowEl.addEventListener("click", selectWeek);
        rowEl.addEventListener("keydown", (e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            selectWeek();
          }
        });
      });
    }

    // Current details (defaults to the latest week; click a row above to change)
    renderSnapshotSections(snapshotSections, p, weeks.length ? weeks[weeks.length - 1].asOf : null, true);
    root.appendChild(snapshotSections);

    // Full feedback history
    root.appendChild(el("h3", { class: "weekly-subhead" }, ["Feedback history"]));
    if (!allNotes.length) {
      root.appendChild(el("p", { class: "empty-note" }, ["No feedback logged for this project yet."]));
    } else {
      const notesList = el("div", { class: "notes-list" });
      allNotes
        .slice()
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
        .forEach((n) => {
          const effective = noteStatus(n);
          const locallyOnly = effective === "resolved" && n.status !== "resolved";
          notesList.appendChild(
            el("div", { class: "note-row " + (effective === "open" ? "is-open" : "is-resolved") }, [
              el("span", { class: "note-status" }, [effective === "open" ? "OPEN" : "RESOLVED"]),
              el("span", { class: "note-text" }, [n.text]),
              ...(n.mitigationImpact
                ? [el("span", { class: "note-mitigation" }, ["Mitigation / impact: " + n.mitigationImpact])]
                : []),
              ...(n.status === "resolved" && n.resolutionNote
                ? [el("span", { class: "note-mitigation" }, ["Resolution: " + n.resolutionNote])]
                : []),
              el("span", { class: "note-meta" }, [
                (n.raisedBy ? n.raisedBy + " · " : "") + fmtDate((n.createdAt || "").slice(0, 10)),
                n.status === "resolved" && n.resolvedBy
                  ? " · resolved by " + n.resolvedBy + (n.resolvedAt ? " " + fmtDate((n.resolvedAt || "").slice(0, 10)) : "")
                  : "",
                locallyOnly ? " · resolved in your browser, not yet synced" : "",
              ]),
              ...(effective === "open" ? [resolveLink(n, p.name)] : []),
              ...(locallyOnly ? [resolvedActions(n, p.name)] : []),
            ])
          );
        });
      root.appendChild(notesList);
    }

    return root;
  }

  /* ---------------- Stage detail modal ---------------- */

  function openStageDetail(projectId, stage) {
    const project = DATA.projects.find((p) => p.id === projectId);
    if (!project) return;

    const overlay = document.getElementById("stageDetail");
    const content = document.getElementById("stageDetailContent");
    content.innerHTML = "";
    content.appendChild(buildStageDetail(project, stage));
    overlay.hidden = false;
    overlay.scrollTop = 0;
  }

  function closeStageDetail() {
    document.getElementById("stageDetail").hidden = true;
  }

  function stageStatusBadge(kind) {
    return { done: "Done", current: "In Progress", future: "Not Started" }[kind] || kind;
  }

  function buildStageDetail(p, stage) {
    const stageIndex = PIPELINE_STAGES.indexOf(stage);
    const segments = computeStageSegments(p);
    const seg = segments.find((s) => s.stage === stage) || null;
    const currentIndex = PIPELINE_STAGES.indexOf(p.stage || "Unstaged");
    const kind = stageIndex < currentIndex ? "done" : stageIndex === currentIndex ? "current" : "future";
    const sla = stageSlaDays(stage);
    const days = seg ? seg.days : 0;
    const flag = seg ? stageFlagLevel(days, sla) : null;
    const plan = (p.stagePlan && p.stagePlan[stage]) || {};
    const delayEntries = stageDelayLog(p, stage);
    const revisions = stagePlanRevisions(p, stage);

    const root = el("div", { class: "stagedetail-root" });

    root.appendChild(
      el("div", { class: "stagedetail-head" }, [
        el("div", null, [
          el("div", { class: "stagedetail-kicker" }, [
            p.name.toUpperCase() + " · STAGE " + (stageIndex + 1) + " OF " + PIPELINE_STAGES.length,
          ]),
          el("h2", null, [stage]),
          el("div", { class: "stagedetail-sub" }, [
            stageStatusBadge(kind) + (p.owner ? " · PM " + p.owner : ""),
          ]),
        ]),
      ])
    );

    root.appendChild(
      el("div", { class: "stagedetail-tabs", role: "tablist" }, [
        el("button", { class: "stagedetail-tab-btn is-active", "data-panel": "overview", type: "button" }, ["Overview"]),
        el("button", { class: "stagedetail-tab-btn", "data-panel": "history", type: "button" }, ["Date History"]),
        el("button", { class: "stagedetail-tab-btn", "data-panel": "analysis", type: "button" }, ["Delay Analysis"]),
        el("button", { class: "stagedetail-tab-btn", "data-panel": "log", type: "button" }, ["Delay Log"]),
      ])
    );

    const panels = el("div", { class: "stagedetail-panels" }, [
      el("div", { class: "stagedetail-panel is-active", "data-panel": "overview" }, [
        buildStageOverviewPanel(p, stage, seg, sla, days, flag, kind, plan, delayEntries),
      ]),
      el("div", { class: "stagedetail-panel", "data-panel": "history" }, [buildStageHistoryPanel(revisions)]),
      el("div", { class: "stagedetail-panel", "data-panel": "analysis" }, [buildStageAnalysisPanel(delayEntries)]),
      el("div", { class: "stagedetail-panel", "data-panel": "log" }, [buildStageLogPanel(delayEntries)]),
    ]);
    root.appendChild(panels);

    root.querySelectorAll(".stagedetail-tab-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        root.querySelectorAll(".stagedetail-tab-btn").forEach((b) => b.classList.remove("is-active"));
        root.querySelectorAll(".stagedetail-panel").forEach((pnl) => pnl.classList.remove("is-active"));
        btn.classList.add("is-active");
        root.querySelector('.stagedetail-panel[data-panel="' + btn.getAttribute("data-panel") + '"]').classList.add("is-active");
      });
    });

    return root;
  }

  function dateVarianceCell(initial, latest, actual) {
    let varianceLabel = "—";
    let varianceClass = "";
    if (actual && latest) {
      const delta = daysBetweenIso(latest, actual);
      if (delta === 0) {
        varianceLabel = "On schedule";
        varianceClass = "is-ontime";
      } else if (delta > 0) {
        varianceLabel = "+" + delta + "d late";
        varianceClass = "is-late";
      } else {
        varianceLabel = delta + "d early";
        varianceClass = "is-early";
      }
    } else if (!latest) {
      varianceLabel = "Not planned yet";
    } else {
      varianceLabel = "Pending";
    }
    return el("span", { class: "stagedetail-variance" + (varianceClass ? " " + varianceClass : "") }, [varianceLabel]);
  }

  function buildStageOverviewPanel(p, stage, seg, sla, days, flag, kind, plan, delayEntries) {
    // `seg` can be null even for a "done" stage — computeStageSegments()
    // only reconstructs stages actually captured in history.json, so a
    // project whose tracking began mid-pipeline has no segment for stages
    // before that point, even though they're clearly in the past by index.
    const actualStart = seg ? seg.start : null;
    const actualEnd = kind === "done" && seg ? seg.end : null;

    const pct = kind === "done" ? 100 : kind === "future" ? 0 : sla != null ? Math.max(0, Math.min(100, Math.round((days / sla) * 100))) : null;
    const cumulativeOverage = cumulativeStageOverageDays(p);
    const overDays = sla != null ? Math.max(0, days - sla) : 0;

    return el("div", null, [
      el("div", { class: "stagedetail-datebox-row" }, [
        el("div", { class: "stagedetail-datebox" }, [
          el("h4", null, ["Start Date"]),
          el("dl", null, [
            el("dt", null, ["Initial Planned Start Date"]),
            el("dd", null, [fmtDate(plan.initialStart)]),
            el("dt", null, ["Latest Planned Start Date"]),
            el("dd", null, [fmtDate(plan.latestStart)]),
            el("dt", null, ["Actual Start Date"]),
            el("dd", { class: "stagedetail-actual" }, [fmtDate(actualStart)]),
          ]),
          el("div", { class: "stagedetail-variance-row" }, [
            el("span", { class: "stagedetail-variance-label" }, ["Variance"]),
            dateVarianceCell(plan.initialStart, plan.latestStart, actualStart),
          ]),
        ]),
        el("div", { class: "stagedetail-datebox" }, [
          el("h4", null, ["Completion Date"]),
          el("dl", null, [
            el("dt", null, ["Initial Planned Completion Date"]),
            el("dd", null, [fmtDate(plan.initialEnd)]),
            el("dt", null, ["Latest Planned Completion Date"]),
            el("dd", null, [fmtDate(plan.latestEnd)]),
            el("dt", null, ["Actual Completion Date"]),
            el("dd", { class: "stagedetail-actual" }, [actualEnd ? fmtDate(actualEnd) : "—"]),
          ]),
          el("div", { class: "stagedetail-variance-row" }, [
            el("span", { class: "stagedetail-variance-label" }, ["Variance"]),
            dateVarianceCell(plan.initialEnd, plan.latestEnd, actualEnd),
          ]),
        ]),
      ]),

      el("div", { class: "stagedetail-completion" }, [
        el("div", { class: "stagedetail-completion-head" }, [
          el("h4", null, ["SLA Elapsed"]),
          el("span", { class: "stagedetail-completion-pct" }, [pct == null ? "—" : pct + "%"]),
        ]),
        el("div", { class: "progress-track" }, [
          el("div", { class: "progress-fill status-" + (flag === "breach" ? "red" : flag === "warn" ? "amber" : "green"), style: "width:" + (pct || 0) + "%" }),
        ]),
        el("div", { class: "stagedetail-completion-foot" }, [
          el("span", null, [kind === "done" ? "Closed out" : kind === "current" ? "In progress" : "Not started"]),
          el("span", null, ["Status: " + stageStatusBadge(kind)]),
        ]),
      ]),

      el("div", { class: "stagedetail-stat-row" }, [
        el("div", { class: "metric-card" + (flag === "breach" ? " tone-red" : flag === "warn" ? " tone-amber" : " tone-green") }, [
          el("div", { class: "num" }, [(overDays > 0 ? "+" + overDays : "0") + "d"]),
          el("div", { class: "label" }, ["Stage delay"]),
          el("div", { class: "stage-grid-metric-sub" }, [overDays > 0 ? "over SLA" : "on time"]),
        ]),
        el("div", { class: "metric-card" }, [
          el("div", { class: "num" }, [String(delayEntries.length)]),
          el("div", { class: "label" }, ["Log entries"]),
          el("div", { class: "stage-grid-metric-sub" }, ["recorded"]),
        ]),
        el("div", { class: "metric-card" + (cumulativeOverage ? " tone-amber" : " tone-green") }, [
          el("div", { class: "num" }, [cumulativeOverage + "d"]),
          el("div", { class: "label" }, ["Project cumulative"]),
          el("div", { class: "stage-grid-metric-sub" }, ["all " + PIPELINE_STAGES.length + " stages"]),
        ]),
      ]),
    ]);
  }

  function buildStageHistoryPanel(revisions) {
    if (!revisions.length) {
      return el("div", { class: "deps-empty-group" }, ["No planned-date revisions recorded yet — submit a planned start/completion date on a weekly update for this stage to start tracking."]);
    }
    return el("div", null, [
      el("table", { class: "stagedetail-history-table" }, [
        el("thead", null, [
          el("tr", null, [
            el("th", null, ["Revision"]),
            el("th", null, ["Changed On"]),
            el("th", null, ["Field"]),
            el("th", null, ["From → To"]),
            el("th", null, ["Shift"]),
          ]),
        ]),
        el(
          "tbody",
          null,
          revisions.map((r) =>
            el("tr", null, [
              el("td", { class: "stagedetail-rev-cell" }, [r.revision]),
              el("td", null, [fmtDate(r.changedOn)]),
              el("td", null, [r.field]),
              el("td", null, [(r.from ? fmtDateShort(r.from) : "—") + " → " + fmtDateShort(r.to)]),
              el("td", { class: "stagedetail-shift-cell" }, [r.shiftDays == null ? "—" : (r.shiftDays > 0 ? "+" : "") + r.shiftDays + "d"]),
            ])
          )
        ),
      ]),
      el("ul", { class: "stagedetail-history-notes" }, [
        el("li", null, ["Baseline is the first planned date submitted for this stage; every later change is tracked as a revision."]),
        el("li", null, ["Shift is measured against the immediately preceding revision, not the baseline."]),
      ]),
    ]);
  }

  function buildStageAnalysisPanel(entries) {
    if (!entries.length) {
      return el("div", { class: "deps-empty-group" }, ["No delay log entries recorded for this stage."]);
    }
    const totalDays = entries.reduce((sum, e) => sum + (e.days || 0), 0);
    const breakdowns = [
      { title: "By Team", groups: aggregateDelayLog(entries, "team") },
      { title: "By Member", groups: aggregateDelayLog(entries, "member") },
      { title: "By Reason", groups: aggregateDelayLog(entries, "reason") },
    ];
    return el(
      "div",
      { class: "stagedetail-analysis-head" }, [
      el("div", { class: "stagedetail-analysis-total" }, [
        el("span", { class: "num" }, [String(totalDays)]),
        el("span", { class: "label" }, ["days total"]),
      ]),
      el(
        "div",
        { class: "stagedetail-analysis-cols" },
        breakdowns.map((b) =>
          el("div", { class: "stagedetail-analysis-col" }, [
            el("h4", null, [b.title]),
            el(
              "div",
              { class: "stagedetail-bar-list" },
              b.groups.map((g, i) =>
                el("div", { class: "stagedetail-bar-row" }, [
                  el("span", { class: "stagedetail-bar-dot", style: `background:${BREAKDOWN_COLORS[i % BREAKDOWN_COLORS.length]}` }),
                  el("span", { class: "stagedetail-bar-label" }, [g.label]),
                  el("span", { class: "stagedetail-bar-days" }, [g.days + "d"]),
                ])
              )
            ),
          ])
        )
      ),
    ]);
  }

  const BREAKDOWN_COLORS = ["#c1502e", "#5a3b30", "#dfa23a", "#3562e8", "#1a9f6b", "#8a5fd6"];

  function buildStageLogPanel(entries) {
    const wrap = el("div", { class: "stagedetail-log-wrap" });

    const reasons = Array.from(new Set(entries.map((e) => e.reason).filter(Boolean))).sort();
    const teams = Array.from(new Set(entries.map((e) => e.team).filter(Boolean))).sort();

    const searchInput = el("input", { type: "text", class: "stagedetail-log-search", placeholder: "Search delay log..." });
    const reasonSelect = el("select", { class: "stagedetail-log-filter" }, [
      el("option", { value: "all" }, ["All Reasons"]),
      ...reasons.map((r) => el("option", { value: r }, [r])),
    ]);
    const teamSelect = el("select", { class: "stagedetail-log-filter" }, [
      el("option", { value: "all" }, ["All Teams"]),
      ...teams.map((t) => el("option", { value: t }, [t])),
    ]);

    wrap.appendChild(
      el("div", { class: "stagedetail-log-controls" }, [searchInput, reasonSelect, teamSelect])
    );

    const tableHolder = el("div");
    wrap.appendChild(tableHolder);

    let sortDesc = true;

    function render() {
      const q = searchInput.value.trim().toLowerCase();
      const reasonFilter = reasonSelect.value;
      const teamFilter = teamSelect.value;
      let filtered = entries.filter((e) => {
        if (reasonFilter !== "all" && e.reason !== reasonFilter) return false;
        if (teamFilter !== "all" && e.team !== teamFilter) return false;
        if (q && !(e.reason + " " + e.member + " " + e.team + " " + e.id).toLowerCase().includes(q)) return false;
        return true;
      });
      filtered = filtered.slice().sort((a, b) => (sortDesc ? b.days - a.days : a.days - b.days));

      tableHolder.innerHTML = "";
      if (!filtered.length) {
        tableHolder.appendChild(el("div", { class: "deps-empty-group" }, ["No matching delay log entries."]));
        return;
      }

      const sortArrow = el("span", { class: "stagedetail-sort-arrow" }, [sortDesc ? "▼" : "▲"]);
      const daysHeader = el("th", { class: "stagedetail-days-header" }, ["Days ", sortArrow]);
      daysHeader.addEventListener("click", () => {
        sortDesc = !sortDesc;
        render();
      });

      tableHolder.appendChild(
        el("table", { class: "stagedetail-log-table" }, [
          el("thead", null, [
            el("tr", null, [
              el("th", null, ["ID"]),
              el("th", null, ["Date"]),
              el("th", null, ["Reason"]),
              el("th", null, ["Member"]),
              el("th", null, ["Team"]),
              daysHeader,
            ]),
          ]),
          el(
            "tbody",
            null,
            filtered.map((e) =>
              el("tr", null, [
                el("td", { class: "stagedetail-id-cell" }, [e.id || "—"]),
                el("td", null, [fmtDateShort(e.date)]),
                el("td", null, [e.reason]),
                el("td", null, [e.member]),
                el("td", null, [e.team]),
                el("td", null, [el("span", { class: "stagedetail-days-pill" }, [e.days + "d"])]),
              ])
            )
          ),
        ])
      );
    }

    [searchInput, reasonSelect, teamSelect].forEach((input) => {
      input.addEventListener("input", render);
      input.addEventListener("change", render);
    });
    render();

    return wrap;
  }

  function wireStageDetailModal() {
    document.getElementById("stageDetailClose").addEventListener("click", closeStageDetail);
    document.getElementById("stageDetail").addEventListener("click", (e) => {
      if (e.target.id === "stageDetail") closeStageDetail();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !document.getElementById("stageDetail").hidden) closeStageDetail();
    });
  }

  function wireProjectDetail() {
    document.getElementById("detailClose").addEventListener("click", closeProjectDetail);
    document.getElementById("projectDetail").addEventListener("click", (e) => {
      if (e.target.id === "projectDetail") closeProjectDetail();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !document.getElementById("projectDetail").hidden) closeProjectDetail();
    });
  }

  /* ---------------- Feedback modal ---------------- */

  function wireFeedbackModal() {
    const modal = document.getElementById("feedbackModal");
    const projectSelect = document.getElementById("fbProject");
    DATA.projects.forEach((p) => {
      projectSelect.appendChild(el("option", { value: p.name }, [p.name]));
    });

    document.getElementById("openFeedbackBtn").addEventListener("click", () => {
      modal.hidden = false;
    });
    document.getElementById("fbCancel").addEventListener("click", () => {
      modal.hidden = true;
    });
    modal.addEventListener("click", (e) => {
      if (e.target === modal) modal.hidden = true;
    });
    document.getElementById("fbSubmit").addEventListener("click", () => {
      const project = projectSelect.value;
      const note = document.getElementById("fbNote").value.trim();
      const mitigationImpact = document.getElementById("fbMitigation").value.trim();
      const raisedBy = document.getElementById("fbRaisedBy").value.trim();
      if (!note) {
        document.getElementById("fbNote").focus();
        return;
      }
      const url = issueUrl("meeting-feedback.yml", {
        project,
        note,
        mitigation_impact: mitigationImpact,
        raised_by: raisedBy,
      });
      window.open(url, "_blank", "noopener");
      modal.hidden = true;
      document.getElementById("fbNote").value = "";
      document.getElementById("fbMitigation").value = "";
      document.getElementById("fbRaisedBy").value = "";
    });
  }

  /* ---------------- Tabs ---------------- */

  function wireTabs() {
    document.querySelectorAll(".tab-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".tab-btn").forEach((b) => {
          b.classList.remove("is-active");
          b.setAttribute("aria-selected", "false");
        });
        document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("is-active"));
        btn.classList.add("is-active");
        btn.setAttribute("aria-selected", "true");
        document.getElementById("panel-" + btn.getAttribute("data-tab")).classList.add("is-active");
      });
    });
  }

  /* ---------------- Init ---------------- */

  function init([data, history, notes]) {
    DATA = data;
    HISTORY = history;
    NOTES = notes;

    renderHeader();
    populateGlobalProjectFilter();
    wireGlobalProjectFilter();
    populateGlobalOwnerFilter();
    wireGlobalOwnerFilter();
    populateGlobalTeamFilter();
    wireGlobalTeamFilter();
    renderMetrics();
    renderStageGrid();
    renderHawkeye();
    renderCards();

    renderDependenciesTab();
    renderEscalationsTab();

    renderStatusHistory();

    wireProjectDetail();
    wireStageDetailModal();
    wireFeedbackModal();
    wireTabs();
  }

  function safeFetchJson(path, fallback) {
    return fetch(path)
      .then((r) => (r.ok ? r.json() : fallback))
      .catch(() => fallback);
  }

  Promise.all([
    safeFetchJson("data.json", { asOf: null, lastUpdated: null, projects: [] }),
    safeFetchJson("history.json", {}),
    safeFetchJson("notes.json", []),
  ])
    .then(init)
    .catch((err) => {
      document.getElementById("cards").textContent = "Could not load dashboard data: " + err.message;
    });
})();
