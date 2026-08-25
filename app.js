(function () {
  "use strict";

  const STATUS_LABEL = { green: "On Track", amber: "At Risk", red: "Critical" };
  let DATA = null;
  let activeFilter = "all";

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

  function renderHeader() {
    document.getElementById("asOf").textContent = "As of " + fmtDate(DATA.asOf);
    const d = new Date(DATA.lastUpdated);
    document.getElementById("lastUpdated").textContent =
      "Data last updated " + d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  }

  function renderMetrics() {
    const projects = DATA.projects;
    const counts = { green: 0, amber: 0, red: 0 };
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
      { label: "Avg Delay (days)", num: avgDelay, tone: "tone-accent" },
      { label: "Open Risks", num: riskCount, tone: "tone-accent" },
    ];

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

  function renderTimeline() {
    const withDates = DATA.projects
      .filter((p) => p.nextMilestone && p.nextMilestone.date)
      .slice()
      .sort((a, b) => new Date(a.nextMilestone.date) - new Date(b.nextMilestone.date));

    const box = document.getElementById("timeline");
    box.innerHTML = "";
    withDates.forEach((p) => {
      box.appendChild(
        el("div", { class: "timeline-row" }, [
          el("div", { class: "timeline-date" }, [fmtDateShort(p.nextMilestone.date)]),
          el("div", { class: "timeline-dot", style: `background:var(--${p.status === "amber" ? "amber" : p.status})` }),
          el("div", { class: "timeline-what" }, [
            el("strong", null, [p.name + " — "]),
            el("span", null, [p.nextMilestone.name]),
          ]),
          el("div", { class: "timeline-status pill-" + p.status + " timeline-status" }, [STATUS_LABEL[p.status]]),
        ])
      );
    });
  }

  function renderCards() {
    const box = document.getElementById("cards");
    box.innerHTML = "";
    const projects = DATA.projects.filter((p) => activeFilter === "all" || p.status === activeFilter);

    projects.forEach((p) => {
      const isLate = p.delayDays > 0;
      const detailId = "detail-" + p.id;

      const card = el("div", { class: "card status-" + p.status }, [
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
        ]),
        el("button", { class: "card-toggle", "data-target": detailId }, ["Show details ▾"]),
        el("div", { class: "card-detail", id: detailId }, [
          el("div", { class: "detail-block deps" }, [
            el("h4", null, ["Dependencies"]),
            el("ul", null, (p.dependencies || []).map((d) => el("li", null, [d]))),
          ]),
          el("div", { class: "detail-block" }, [
            el("h4", null, ["Completed"]),
            el("ul", null, (p.sprintStatus.completed || []).map((d) => el("li", null, [d])) .length
              ? (p.sprintStatus.completed || []).map((d) => el("li", null, [d]))
              : [el("li", null, ["—"])]),
          ]),
          el("div", { class: "detail-block" }, [
            el("h4", null, ["In progress"]),
            el("ul", null, (p.sprintStatus.inProgress || []).length
              ? (p.sprintStatus.inProgress || []).map((d) => el("li", null, [d]))
              : [el("li", null, ["—"])]),
          ]),
          el("div", { class: "detail-block" }, [
            el("h4", null, ["Next plan"]),
            el("ul", null, (p.sprintStatus.nextPlan || []).length
              ? (p.sprintStatus.nextPlan || []).map((d) => el("li", null, [d]))
              : [el("li", null, ["—"])]),
          ]),
          el("div", { class: "detail-block risks" }, [
            el("h4", null, ["Risks / blockers"]),
            el("ul", null, (p.risks || []).length
              ? (p.risks || []).map((d) => el("li", null, [d]))
              : [el("li", null, ["None reported"])]),
          ]),
        ]),
      ]);

      box.appendChild(card);
    });

    box.querySelectorAll(".card-toggle").forEach((btn) => {
      btn.addEventListener("click", () => {
        const target = document.getElementById(btn.getAttribute("data-target"));
        const open = target.classList.toggle("is-open");
        btn.textContent = open ? "Hide details ▴" : "Show details ▾";
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

  function init(data) {
    DATA = data;
    renderHeader();
    renderMetrics();
    renderTimeline();
    renderCards();
    wireFilters();
    wireTabs();
  }

  fetch("data.json")
    .then((r) => r.json())
    .then(init)
    .catch((err) => {
      document.getElementById("cards").textContent = "Could not load data.json: " + err.message;
    });
})();
