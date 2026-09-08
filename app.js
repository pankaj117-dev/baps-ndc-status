(function () {
  "use strict";

  const REPO = "pankaj117-dev/baps-ndc-status";
  const STATUS_LABEL = { green: "On Track", amber: "At Risk", red: "Critical", black: "Non-Recoverable" };
  const STATUS_RANK = { green: 0, amber: 1, red: 2, black: 3 };

  let DATA = null;
  let HISTORY = {};
  let NOTES = [];
  let activeFilter = "all";
  let activeOwner = "all";
  let globalProjectFilter = "all";

  function visibleProjects() {
    if (globalProjectFilter === "all") return DATA.projects;
    return DATA.projects.filter((p) => p.id === globalProjectFilter);
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
    return NOTES.filter((n) => n.projectId === projectId && n.status === "open");
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
      riskCount += (p.risks || []).length;
    });
    const avgDelay = projects.length ? Math.round((delaySum / projects.length) * 10) / 10 : 0;

    const metrics = [
      { label: "Total Projects", num: projects.length, tone: "" },
      { label: "On Track", num: counts.green, tone: "tone-green" },
      { label: "At Risk", num: counts.amber, tone: "tone-amber" },
      { label: "Critical", num: counts.red, tone: "tone-red" },
    ];
    if (counts.black) metrics.push({ label: "Non-Recoverable", num: counts.black, tone: "tone-black" });
    metrics.push(
      { label: "Avg Delay (days)", num: avgDelay, tone: "tone-accent" },
      { label: "Open Follow-ups", num: NOTES.filter((n) => n.status === "open").length, tone: "tone-accent" }
    );

    const row = document.getElementById("metricsRow");
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

  const PIPELINE_STAGES = [
    "Requirements",
    "Design / Estimation",
    "Development",
    "QA / UAT",
    "Production Release",
    "Hypercare / Post-Launch",
  ];

  function renderStageBoard() {
    const board = document.getElementById("stageBoard");
    board.innerHTML = "";

    const byStage = {};
    PIPELINE_STAGES.forEach((s) => (byStage[s] = []));
    const unstaged = [];
    visibleProjects().forEach((p) => {
      if (p.stage && byStage[p.stage]) byStage[p.stage].push(p);
      else unstaged.push(p);
    });

    PIPELINE_STAGES.forEach((stage) => {
      const projects = byStage[stage];
      const cardsWrap = el("div", { class: "stage-lane-cards" });
      if (!projects.length) {
        cardsWrap.appendChild(el("div", { class: "stage-col-empty" }, ["No projects in this stage"]));
      } else {
        projects.forEach((p) => {
          cardsWrap.appendChild(
            el("div", { class: "stage-card", "data-project-id": p.id, tabindex: "0", role: "button" }, [
              el("div", { class: "stage-card-top" }, [
                el("span", { class: "timeline-dot", style: `background:var(--${p.status === "amber" ? "amber" : p.status})` }),
                el("strong", null, [p.name]),
              ]),
              el("div", { class: "stage-card-owner" }, [p.owner || "Unassigned"]),
              el("div", { class: "progress-row stage-card-progress" }, [
                el("div", { class: "progress-track" }, [
                  el("div", { class: "progress-fill status-" + p.status, style: "width:" + p.progress + "%" }),
                ]),
                el("div", { class: "progress-pct" }, [p.progress + "%"]),
              ]),
            ])
          );
        });
      }
      const lane = el("div", { class: "stage-lane" }, [
        el("div", { class: "stage-lane-label" }, [
          el("h3", null, [stage]),
          el("span", { class: "stage-col-count" }, [String(projects.length)]),
        ]),
        cardsWrap,
      ]);
      board.appendChild(lane);
    });

    if (unstaged.length) {
      const cardsWrap = el("div", { class: "stage-lane-cards" });
      unstaged.forEach((p) => {
        cardsWrap.appendChild(
          el("div", { class: "stage-card", "data-project-id": p.id, tabindex: "0", role: "button" }, [
            el("div", { class: "stage-card-top" }, [
              el("span", { class: "timeline-dot", style: `background:var(--${p.status === "amber" ? "amber" : p.status})` }),
              el("strong", null, [p.name]),
            ]),
            el("div", { class: "stage-card-owner" }, [p.owner || "Unassigned"]),
          ])
        );
      });
      const lane = el("div", { class: "stage-lane stage-lane-unstaged" }, [
        el("div", { class: "stage-lane-label" }, [
          el("h3", null, ["Unstaged"]),
          el("span", { class: "stage-col-count" }, [String(unstaged.length)]),
        ]),
        cardsWrap,
      ]);
      board.appendChild(lane);
    }

    board.querySelectorAll(".stage-card").forEach((card) => {
      card.addEventListener("click", () => openProjectDetail(card.getAttribute("data-project-id")));
      card.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          openProjectDetail(card.getAttribute("data-project-id"));
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
    const projects = visibleProjects().filter((p) => {
      const statusOk = activeFilter === "all" || p.status === activeFilter;
      const owner = p.owner || "Unassigned";
      const ownerOk = activeOwner === "all" || owner === activeOwner;
      return statusOk && ownerOk;
    });

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
        ]),
        el("div", { class: "card-badges" }, [
          el("span", { class: "badge" }, [(p.dependencies || []).length + " dependencies"]),
          el("span", { class: "badge" + ((p.risks || []).length ? " has-risk" : "") }, [(p.risks || []).length + " risks"]),
          el("span", { class: "badge" + (notes.length ? " has-followup" : "") }, [notes.length + " follow-ups"]),
          ...((p.fastFollowItems || []).length
            ? [el("span", { class: "badge has-fastfollow" }, [(p.fastFollowItems || []).length + " fast-follow"])]
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

  function wireFilters() {
    document.getElementById("filterRow").querySelectorAll(".chip").forEach((chip) => {
      chip.addEventListener("click", () => {
        activeFilter = chip.getAttribute("data-filter");
        document.querySelectorAll("#filterRow .chip").forEach((c) => c.classList.remove("is-on"));
        chip.classList.add("is-on");
        renderCards();
      });
    });
  }

  function wireOwnerFilter() {
    const select = document.getElementById("ownerFilter");
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

    select.addEventListener("change", () => {
      activeOwner = select.value;
      renderCards();
    });
  }

  /* ---------------- Hawk-eye (cross-project Gantt) ---------------- */

  function renderHawkeye() {
    const board = document.getElementById("hawkeyeGantt");
    board.innerHTML = "";

    const projects = visibleProjects();
    const DAY = 86400000;
    const todayIso = todayISO();

    const allDates = [todayIso];
    projects.forEach((p) => {
      if (p.originalGoLive) allDates.push(p.originalGoLive);
      if (p.goLive) allDates.push(p.goLive);
      if (p.nextMilestone && p.nextMilestone.date) allDates.push(p.nextMilestone.date);
      (p.milestones || []).forEach((m) => {
        if (m.date) allDates.push(m.date);
      });
    });

    if (!projects.length || allDates.length < 2) {
      board.appendChild(el("p", { class: "empty-note" }, ["No dates to plot yet."]));
      return;
    }

    const times = allDates.map((d) => new Date(d + "T00:00:00").getTime());
    let minTime = Math.min(...times) - 10 * DAY;
    let maxTime = Math.max(...times) + 14 * DAY;
    if (maxTime - minTime < 30 * DAY) maxTime = minTime + 30 * DAY;

    const xPct = (iso) => {
      const t = new Date(iso + "T00:00:00").getTime();
      return Math.max(0, Math.min(100, ((t - minTime) / (maxTime - minTime)) * 100));
    };

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

    projects
      .slice()
      .sort((a, b) => {
        const ta = a.goLive ? new Date(a.goLive).getTime() : Infinity;
        const tb = b.goLive ? new Date(b.goLive).getTime() : Infinity;
        return ta - tb;
      })
      .forEach((p) => {
        const row = el("div", { class: "hawkeye-row", "data-project-id": p.id, tabindex: "0", role: "button" }, [
          el("div", { class: "hawkeye-row-label" }, [
            el("span", { class: "timeline-dot", style: `background:var(--${p.status})` }),
            el("div", null, [
              el("strong", null, [p.name]),
              el("div", { class: "hawkeye-row-sub" }, [p.owner || "Unassigned"]),
            ]),
          ]),
        ]);

        const track = el("div", { class: "hawkeye-row-track" });

        if (p.originalGoLive && p.goLive && p.originalGoLive !== p.goLive) {
          const a = xPct(p.originalGoLive);
          const b = xPct(p.goLive);
          const left = Math.min(a, b);
          const width = Math.abs(b - a);
          track.appendChild(el("div", { class: "hawkeye-slip-line", style: `left:${left}%;width:${width}%` }));
          track.appendChild(
            el("div", {
              class: "hawkeye-marker hawkeye-marker-ghost",
              style: `left:${a}%`,
              title: `Original Go-Live · ${fmtDate(p.originalGoLive)}`,
            })
          );
        }

        const milestones =
          p.milestones && p.milestones.length
            ? p.milestones
            : p.nextMilestone && p.nextMilestone.date
            ? [{ name: p.nextMilestone.name || "Milestone", date: p.nextMilestone.date, status: p.status }]
            : [];

        milestones.forEach((m) => {
          if (!m.date) return;
          track.appendChild(
            el(
              "div",
              {
                class: "hawkeye-marker hawkeye-marker-milestone status-" + (m.status || p.status),
                style: `left:${xPct(m.date)}%`,
                title: `${m.name} · ${fmtDate(m.date)}`,
              },
              [el("span", { class: "hawkeye-marker-label" }, [m.name])]
            )
          );
        });

        if (p.goLive) {
          track.appendChild(
            el(
              "div",
              {
                class: "hawkeye-marker hawkeye-marker-golive status-" + p.status,
                style: `left:${xPct(p.goLive)}%`,
                title: `Go-Live · ${fmtDate(p.goLive)}`,
              },
              [el("span", { class: "hawkeye-marker-label" }, ["Go-Live"])]
            )
          );
        }

        row.appendChild(track);
        rowsWrap.appendChild(row);
      });

    board.appendChild(rowsWrap);

    board.querySelectorAll(".hawkeye-row").forEach((row) => {
      row.addEventListener("click", () => openProjectDetail(row.getAttribute("data-project-id"), "detailScheduleSection"));
      row.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          openProjectDetail(row.getAttribute("data-project-id"), "detailScheduleSection");
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
    renderStageBoard();
    renderHawkeye();
    renderCards();
    renderDependenciesTab();
    renderStatusHistory();
  }

  function updateGlobalFilterUI() {
    const bar = document.getElementById("globalFilterBar");
    const clearBtn = document.getElementById("globalFilterClear");
    const isActive = globalProjectFilter !== "all";
    bar.classList.toggle("is-active", isActive);
    clearBtn.hidden = !isActive;
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

  let depsTeamFilter = "all";
  let depsStatusFilter = "all";

  function collectDependencies() {
    const rows = [];
    visibleProjects().forEach((p) => {
      (p.dependencies || []).forEach((text, i) => {
        if (!text || /^(none|no dependency)$/i.test(text.trim())) return;
        rows.push({
          projectId: p.id,
          projectName: p.name,
          status: p.status,
          text,
          team: (p.dependencyTeams && p.dependencyTeams[i]) || "",
          mitigation: (p.dependencyMitigations && p.dependencyMitigations[i]) || "",
        });
      });
    });
    return rows;
  }

  function renderDependenciesMetrics(rows) {
    const teams = new Set(rows.map((r) => r.team).filter(Boolean));
    const missingTeam = rows.filter((r) => !r.team).length;
    const missingMitigation = rows.filter((r) => !r.mitigation).length;

    const metrics = [
      { label: "Total Dependencies", num: rows.length, tone: "" },
      { label: "Teams Involved", num: teams.size, tone: "tone-accent" },
      { label: "Missing Team Label", num: missingTeam, tone: missingTeam ? "tone-amber" : "tone-green" },
      { label: "Missing Mitigation", num: missingMitigation, tone: missingMitigation ? "tone-amber" : "tone-green" },
    ];

    const row = document.getElementById("depsMetricsRow");
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

  function populateDepsTeamFilter(rows) {
    const select = document.getElementById("depsTeamFilter");
    const existing = new Set(Array.from(select.options).map((o) => o.value));
    const teams = Array.from(new Set(rows.map((r) => r.team || "Unlabeled"))).sort((a, b) => {
      if (a === "Unlabeled") return 1;
      if (b === "Unlabeled") return -1;
      return a.localeCompare(b);
    });
    teams.forEach((team) => {
      if (!existing.has(team)) select.appendChild(el("option", { value: team }, [team]));
    });
  }

  function renderDependenciesBoard(rows) {
    const board = document.getElementById("depsBoard");
    board.innerHTML = "";

    const filtered = rows.filter((r) => {
      const teamKey = r.team || "Unlabeled";
      const teamOk = depsTeamFilter === "all" || teamKey === depsTeamFilter;
      const statusOk =
        depsStatusFilter === "all" ||
        (depsStatusFilter === "missing-team" && !r.team) ||
        (depsStatusFilter === "missing-mitigation" && !r.mitigation);
      return teamOk && statusOk;
    });

    if (!filtered.length) {
      board.appendChild(el("div", { class: "deps-empty-group" }, ["No dependencies match this filter."]));
      return;
    }

    const groups = {};
    filtered.forEach((r) => {
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

  let statusHistoryFilter = "all";

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

  function populateStatusHistoryFilter(transitions) {
    const select = document.getElementById("statusHistoryFilter");
    const existing = new Set(Array.from(select.options).map((o) => o.value));
    const names = Array.from(new Set(transitions.map((t) => t.projectName))).sort((a, b) => a.localeCompare(b));
    names.forEach((name) => {
      if (!existing.has(name)) select.appendChild(el("option", { value: name }, [name]));
    });
  }

  function renderStatusHistory() {
    const transitions = computeStatusTransitions();
    populateStatusHistoryFilter(transitions);

    const list = document.getElementById("statusHistoryList");
    list.innerHTML = "";

    const filtered = transitions.filter(
      (t) =>
        (statusHistoryFilter === "all" || t.projectName === statusHistoryFilter) &&
        (globalProjectFilter === "all" || t.projectId === globalProjectFilter)
    );

    if (!filtered.length) {
      list.appendChild(
        el("div", { class: "deps-empty-group" }, [
          transitions.length
            ? "No status changes match this filter."
            : "No status changes recorded yet — once weekly updates move a project between On Track, At Risk, and Critical, they'll show up here with dates.",
        ])
      );
      return;
    }

    filtered.forEach((t) => {
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

  function wireStatusHistoryFilter() {
    document.getElementById("statusHistoryFilter").addEventListener("change", (e) => {
      statusHistoryFilter = e.target.value;
      renderStatusHistory();
    });
  }

  function renderDependenciesTab() {
    const rows = collectDependencies();
    renderDependenciesMetrics(rows);
    populateDepsTeamFilter(rows);
    renderDependenciesBoard(rows);
  }

  function wireDependenciesFilters() {
    document.getElementById("depsTeamFilter").addEventListener("change", (e) => {
      depsTeamFilter = e.target.value;
      renderDependenciesBoard(collectDependencies());
    });
    document.getElementById("depsStatusFilter").addEventListener("change", (e) => {
      depsStatusFilter = e.target.value;
      renderDependenciesBoard(collectDependencies());
    });
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
    });

    return events.reverse(); // newest first
  }

  function renderScheduleTimeline(events) {
    if (!events.length) {
      return el("p", { class: "empty-note" }, [
        "No schedule changes recorded yet — this fills in automatically whenever a go-live or " +
          "milestone date moves (e.g. because of a CR), with the date it happened.",
      ]);
    }

    const box = el("div", { class: "schedule-timeline" });
    events.forEach((e) => {
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
          [el("span", { class: "project-gantt-marker-label above" }, ["Original · " + fmtDateShort(p.originalGoLive)])]
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
      track.appendChild(
        el(
          "div",
          {
            class: `project-gantt-marker milestone status-${m.status || p.status}`,
            style: `left:${xPct(m.date)}%`,
            title: `${m.name} · ${fmtDate(m.date)}`,
          },
          [
            el("span", { class: "project-gantt-marker-label " + (above ? "above" : "below") }, [
              m.name + " · " + fmtDateShort(m.date),
            ]),
          ]
        )
      );
    });

    if (p.goLive) {
      track.appendChild(
        el(
          "div",
          {
            class: `project-gantt-marker golive status-${p.status}`,
            style: `left:${xPct(p.goLive)}%`,
            title: `Go-Live · ${fmtDate(p.goLive)}`,
          },
          [el("span", { class: "project-gantt-marker-label below" }, ["Go-Live · " + fmtDateShort(p.goLive)])]
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
      ])
    );

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

    if (openFollowUps.length) {
      root.appendChild(el("h3", { class: "weekly-subhead" }, ["Open follow-ups"]));
      root.appendChild(
        el("div", { class: "detail-block followups" }, [
          el("ul", null, openFollowUps.map((n) => el("li", null, [n.text + (n.raisedBy ? ` — ${n.raisedBy}` : "")]))),
        ])
      );
    }

    if ((p.fastFollowItems || []).length) {
      root.appendChild(el("h3", { class: "weekly-subhead" }, ["Fast-follow items to close"]));
      root.appendChild(
        el("div", { class: "detail-block fast-follow" }, [
          el("p", { class: "empty-note" }, ["Live / in production, but not fully closed out until these ship:"]),
          el("ul", null, listOrDash(p.fastFollowItems)),
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

    // Change log
    if (weeks.length) {
      root.appendChild(el("h3", { class: "weekly-subhead" }, ["Week-over-week changes"]));
      const changeLog = el("div", { class: "changelog" });
      for (let i = weeks.length - 1; i >= 0; i--) {
        const cur = weeks[i];
        const prev = weeks[i - 1];
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
        changeLog.appendChild(
          el("div", { class: "changelog-row" + (statusChanged ? " has-status-change" : "") }, [
            el("div", { class: "changelog-date" }, [fmtDate(cur.asOf)]),
            el("div", { class: "changelog-body" }, bodyChildren),
          ])
        );
      }
      root.appendChild(changeLog);
    }

    // Current details
    root.appendChild(el("h3", { class: "weekly-subhead" }, ["Dependencies"]));
    root.appendChild(
      el("div", { class: "detail-block deps" }, [
        el("ul", { class: "paired-list" }, pairedList(p.dependencies || [], p.dependencyMitigations || [], "Mitigation / impact", p.dependencyTeams || [])),
      ])
    );

    root.appendChild(el("h3", { class: "weekly-subhead" }, ["Sprint status"]));
    root.appendChild(
      el("div", { class: "sprint-grid" }, [
        el("div", { class: "detail-block" }, [
          el("h4", null, ["Completed"]),
          el("ul", null, listOrDash(p.sprintStatus.completed || [])),
        ]),
        el("div", { class: "detail-block" }, [
          el("h4", null, ["In progress"]),
          el("ul", null, listOrDash(p.sprintStatus.inProgress || [])),
        ]),
        el("div", { class: "detail-block" }, [
          el("h4", null, ["Next plan"]),
          el("ul", null, listOrDash(p.sprintStatus.nextPlan || [])),
        ]),
      ])
    );

    root.appendChild(el("h3", { class: "weekly-subhead" }, ["Risks / blockers"]));
    root.appendChild(
      el("div", { class: "detail-block risks" }, [
        p.risks && p.risks.length
          ? el("ul", { class: "paired-list" }, pairedList(p.risks, p.riskMitigations || [], "Mitigation plan"))
          : el("ul", null, [el("li", null, ["None reported"])]),
      ])
    );

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
          notesList.appendChild(
            el("div", { class: "note-row " + (n.status === "open" ? "is-open" : "is-resolved") }, [
              el("span", { class: "note-status" }, [n.status === "open" ? "OPEN" : "RESOLVED"]),
              el("span", { class: "note-text" }, [n.text]),
              ...(n.mitigationImpact
                ? [el("span", { class: "note-mitigation" }, ["Mitigation / impact: " + n.mitigationImpact])]
                : []),
              el("span", { class: "note-meta" }, [
                (n.raisedBy ? n.raisedBy + " · " : "") + fmtDate((n.createdAt || "").slice(0, 10)),
              ]),
            ])
          );
        });
      root.appendChild(notesList);
    }

    return root;
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
    renderMetrics();
    renderStageBoard();
    renderHawkeye();
    renderCards();
    wireFilters();
    wireOwnerFilter();

    renderDependenciesTab();
    wireDependenciesFilters();

    renderStatusHistory();
    wireStatusHistoryFilter();

    wireProjectDetail();
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
