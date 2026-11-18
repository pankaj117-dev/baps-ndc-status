/* QA tab: weekly QA status, read from qa.json.
 * qa.json = { weeks: [ { weekStart, weekEnd, rows: [ {resource, project,
 *   userStories, tcDesigned, tcModified, tcExecuted, defectsLogged,
 *   defectsClosed, defectsReopen, defectsRejected, leave } ] } ] }
 * Add each new week to the end of `weeks`. The tab opens on the latest
 * week, and a dropdown switches to any earlier one. Totals are computed
 * here, never stored.
 *
 * Two views share the Week dropdown (2026-11-18):
 *  - Resource-wise: the table, one row per resource and project.
 *  - Project-wise: KPI tiles for the week, plus a grouped bar chart of
 *    TC Designed / TC Modified / TC Executed / Defects Logged per project
 *    (rows summed by project name). */
(function () {
  "use strict";

  const COLS = [
    { key: "userStories", label: "User Stories", group: null },
    { key: "tcDesigned", label: "TC Designed", group: "tc" },
    { key: "tcModified", label: "TC Modified", group: "tc" },
    { key: "tcExecuted", label: "TC Executed", group: "tc" },
    { key: "defectsLogged", label: "Logged", group: "def" },
    { key: "defectsClosed", label: "Closed", group: "def" },
    { key: "defectsReopen", label: "Reopen", group: "def" },
    { key: "defectsRejected", label: "Rejected", group: "def" },
    { key: "leave", label: "Leave", group: null },
  ];

  // Project-wise KPI tiles, in the order of the weekly QA deck.
  const TILES = [
    { key: "tcModified", label: "TC Modified", cls: "qa-tile-modified" },
    { key: "tcDesigned", label: "TC Designed", cls: "qa-tile-designed" },
    { key: "tcExecuted", label: "TC Executed", cls: "qa-tile-executed" },
    { key: "defectsLogged", label: "Defects Logged", cls: "qa-tile-logged" },
    { key: "defectsClosed", label: "Defects Closed", cls: "qa-tile-closed" },
    { key: "defectsReopen", label: "Defects Reopen", cls: "qa-tile-reopen" },
    { key: "defectsRejected", label: "Defects Rejected", cls: "qa-tile-rejected" },
  ];

  // Chart series. Colors follow the deck's scheme; the teal is brightened
  // from the deck's #17665e so it passes the colorblind/contrast checks
  // next to the blue.
  const SERIES = [
    { key: "tcDesigned", label: "TC Designed", color: "#2e6db4" },
    { key: "tcModified", label: "TC Modified", color: "#139a84" },
    { key: "tcExecuted", label: "TC Executed", color: "#6b4c9a" },
    { key: "defectsLogged", label: "Defects Logged", color: "#c5600c" },
  ];

  const VIEWS = [
    { id: "resource", label: "Resource-wise" },
    { id: "project", label: "Project-wise" },
  ];

  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const SVG_NS = "http://www.w3.org/2000/svg";

  const state = { weeks: [], idx: 0, view: "resource" };

  function fmtDate(iso) {
    if (!iso) return "—";
    const [y, m, d] = iso.split("-").map(Number);
    return String(d).padStart(2, "0") + "-" + MONTHS[m - 1] + "-" + y;
  }

  function weekLabel(w) {
    return fmtDate(w.weekStart) + " to " + fmtDate(w.weekEnd);
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function num(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }

  function sortedWeeks(data) {
    return ((data && data.weeks) || []).slice().sort((a, b) => String(a.weekStart).localeCompare(String(b.weekStart)));
  }

  function weekTotals(rows) {
    const totals = {};
    COLS.forEach((c) => { totals[c.key] = rows.reduce((s, r) => s + num(r[c.key]), 0); });
    return totals;
  }

  // Sum each project's rows. Sorted the way the deck sorts them: plain
  // character order, so "My Mandir" comes before "MyBKY" and "WFS"
  // before "Webnext".
  function byProject(rows) {
    const map = new Map();
    rows.forEach((r) => {
      const name = String(r.project || "Unassigned").trim();
      if (!map.has(name)) {
        const blank = { project: name };
        COLS.forEach((c) => { blank[c.key] = 0; });
        map.set(name, blank);
      }
      const p = map.get(name);
      COLS.forEach((c) => { p[c.key] += num(r[c.key]); });
    });
    return Array.from(map.values()).sort((a, b) => (a.project < b.project ? -1 : a.project > b.project ? 1 : 0));
  }

  /* ---------- Resource-wise ---------- */

  function renderTable(week) {
    const rows = (week.rows || []).slice().sort((a, b) =>
      String(a.resource).localeCompare(String(b.resource)) || String(a.project).localeCompare(String(b.project))
    );
    const totals = weekTotals(rows);

    const head1 =
      '<tr>' +
      '<th rowspan="2" class="qa-th-left">Name of Resource</th>' +
      '<th rowspan="2" class="qa-th-left">Project</th>' +
      '<th rowspan="2">User Stories</th>' +
      '<th colspan="3" class="qa-grp-tc">Test Cases</th>' +
      '<th colspan="4" class="qa-grp-def">Defects</th>' +
      '<th rowspan="2">Leave</th>' +
      '</tr>';
    const head2 = '<tr>' + COLS.filter((c) => c.group).map((c) => "<th>" + esc(c.label) + "</th>").join("") + "</tr>";

    const body = rows.length
      ? rows.map((r) =>
          "<tr><td class=\"qa-td-left\">" + esc(r.resource) + "</td><td class=\"qa-td-left\">" + esc(r.project) + "</td>" +
          COLS.map((c) => "<td>" + num(r[c.key]) + "</td>").join("") + "</tr>"
        ).join("")
      : '<tr><td colspan="11" class="qa-empty">No rows for this week.</td></tr>';

    const foot =
      '<tr class="qa-total"><td class="qa-td-left">Total (all resources)</td><td></td>' +
      COLS.map((c) => "<td>" + totals[c.key] + "</td>").join("") + "</tr>";

    return '<div class="qa-table-wrap"><table class="qa-table"><thead>' + head1 + head2 +
      "</thead><tbody>" + body + "</tbody><tfoot>" + foot + "</tfoot></table></div>";
  }

  /* ---------- Project-wise ---------- */

  function renderTiles(totals) {
    return '<div class="qa-tiles">' +
      TILES.map((t) =>
        '<div class="qa-tile ' + t.cls + '"><div class="qa-tile-value">' + totals[t.key] +
        '</div><div class="qa-tile-label">' + esc(t.label) + "</div></div>"
      ).join("") + "</div>";
  }

  // Round the axis top up to a 1/2/2.5/5 × 10^n step so gridlines land on
  // tidy numbers (250 for a 212 max, as in the deck).
  function niceScale(max) {
    if (max <= 0) return { top: 10, step: 2 };
    const rough = max / 5;
    const pow = Math.pow(10, Math.floor(Math.log10(rough)));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= rough);
    return { top: Math.ceil(max / step) * step, step };
  }

  function svgEl(tag, attrs, text) {
    const el = document.createElementNS(SVG_NS, tag);
    Object.keys(attrs || {}).forEach((k) => el.setAttribute(k, attrs[k]));
    if (text != null) el.textContent = text;
    return el;
  }

  // Bar with a 4px rounded top, square at the baseline.
  function barPath(x, y, w, h) {
    const r = Math.min(4, w / 2, h);
    return "M" + x + "," + (y + h) + "V" + (y + r) + "Q" + x + "," + y + " " + (x + r) + "," + y +
      "H" + (x + w - r) + "Q" + (x + w) + "," + y + " " + (x + w) + "," + (y + r) + "V" + (y + h) + "Z";
  }

  function buildChart(projects) {
    const wrap = document.createElement("div");
    wrap.className = "qa-chart";

    const W = 1080, H = 380, m = { t: 28, r: 12, b: 40, l: 44 };
    const plotW = W - m.l - m.r, plotH = H - m.t - m.b;
    const maxVal = Math.max(0, ...projects.map((p) => Math.max(...SERIES.map((s) => p[s.key]))));
    const { top, step } = niceScale(maxVal);
    const y = (v) => m.t + plotH - (v / top) * plotH;

    const svg = svgEl("svg", { viewBox: "0 0 " + W + " " + H, role: "img", "aria-label": "Test cases and defects logged per project" });

    for (let v = 0; v <= top + 1e-9; v += step) {
      const yy = y(v);
      svg.appendChild(svgEl("line", { x1: m.l, x2: W - m.r, y1: yy, y2: yy, class: v === 0 ? "qa-axis" : "qa-grid" }));
      svg.appendChild(svgEl("text", { x: m.l - 8, y: yy + 4, class: "qa-tick", "text-anchor": "end" }, String(Math.round(v * 100) / 100)));
    }

    const groupW = plotW / Math.max(projects.length, 1);
    const pad = Math.min(14, groupW * 0.12);
    const gap = 2;
    const barW = Math.max(4, (groupW - pad * 2 - gap * (SERIES.length - 1)) / SERIES.length);

    projects.forEach((p, i) => {
      const gx = m.l + i * groupW;
      const g = svgEl("g", { class: "qa-group", "data-idx": i });
      g.appendChild(svgEl("rect", { x: gx, y: m.t, width: groupW, height: plotH, class: "qa-hit" }));
      SERIES.forEach((s, j) => {
        const v = p[s.key];
        const bx = gx + pad + j * (barW + gap);
        if (v > 0) {
          const by = y(v);
          g.appendChild(svgEl("path", { d: barPath(bx, by, barW, m.t + plotH - by), fill: s.color, class: "qa-bar" }));
          g.appendChild(svgEl("text", { x: bx + barW / 2, y: by - 6, class: "qa-bar-label", "text-anchor": "middle" }, String(v)));
        }
      });
      g.appendChild(svgEl("text", { x: gx + groupW / 2, y: H - m.b + 22, class: "qa-xlabel", "text-anchor": "middle" }, p.project));
      svg.appendChild(g);
    });

    wrap.appendChild(svg);

    const legend = document.createElement("div");
    legend.className = "qa-legend";
    legend.innerHTML = SERIES.map((s) =>
      '<span class="qa-legend-item"><span class="qa-swatch" style="background:' + s.color + '"></span>' + esc(s.label) + "</span>"
    ).join("");
    wrap.appendChild(legend);

    const tip = document.createElement("div");
    tip.className = "qa-tooltip";
    tip.hidden = true;
    wrap.appendChild(tip);

    svg.querySelectorAll(".qa-group").forEach((g) => {
      const p = projects[Number(g.getAttribute("data-idx"))];
      g.addEventListener("mouseenter", () => {
        g.classList.add("is-hover");
        tip.innerHTML = '<div class="qa-tooltip-title">' + esc(p.project) + "</div>" +
          SERIES.map((s) =>
            '<div class="qa-tooltip-row"><span class="qa-swatch" style="background:' + s.color + '"></span>' +
            esc(s.label) + "<b>" + p[s.key] + "</b></div>"
          ).join("");
        tip.hidden = false;
      });
      g.addEventListener("mousemove", (e) => {
        const box = wrap.getBoundingClientRect();
        let x = e.clientX - box.left + 14;
        if (x + 190 > box.width) x = e.clientX - box.left - 190;
        tip.style.left = x + "px";
        tip.style.top = Math.max(0, e.clientY - box.top - 20) + "px";
      });
      g.addEventListener("mouseleave", () => {
        g.classList.remove("is-hover");
        tip.hidden = true;
      });
    });

    return wrap;
  }

  function renderProjectTable(projects, totals) {
    const keys = SERIES.map((s) => s.key);
    return '<details class="qa-details"><summary>Show as table</summary><div class="qa-table-wrap qa-table-wrap-tight">' +
      '<table class="qa-table qa-table-compact"><thead><tr><th class="qa-th-left">Project</th>' +
      SERIES.map((s) => "<th>" + esc(s.label) + "</th>").join("") + "</tr></thead><tbody>" +
      projects.map((p) => '<tr><td class="qa-td-left">' + esc(p.project) + "</td>" + keys.map((k) => "<td>" + p[k] + "</td>").join("") + "</tr>").join("") +
      '</tbody><tfoot><tr class="qa-total"><td class="qa-td-left">Total</td>' + keys.map((k) => "<td>" + totals[k] + "</td>").join("") +
      "</tr></tfoot></table></div></details>";
  }

  function renderProjectView(container, week) {
    const rows = week.rows || [];
    const totals = weekTotals(rows);
    const projects = byProject(rows);
    container.innerHTML = renderTiles(totals);
    if (!projects.length) {
      container.insertAdjacentHTML("beforeend", '<p class="qa-empty">No rows for this week.</p>');
      return;
    }
    const body = document.createElement("div");
    body.className = "qa-chart-wrap";
    body.appendChild(buildChart(projects));
    body.insertAdjacentHTML("beforeend", renderProjectTable(projects, totals));
    container.appendChild(body);
  }

  /* ---------- Shell ---------- */

  function render(root) {
    const weeks = state.weeks;
    const week = weeks[state.idx];
    const view = VIEWS.find((v) => v.id === state.view) || VIEWS[0];
    const options = weeks
      .map((w, i) => '<option value="' + i + '"' + (i === state.idx ? " selected" : "") + ">" + esc(weekLabel(w)) + "</option>")
      .reverse()
      .join("");
    const viewBtns = VIEWS.map((v) =>
      '<button type="button" class="qa-view-btn' + (v.id === view.id ? " is-active" : "") + '" data-view="' + v.id +
      '" role="tab" aria-selected="' + (v.id === view.id) + '">' + esc(v.label) + "</button>"
    ).join("");

    root.innerHTML =
      '<div class="qa-card">' +
      '<div class="qa-banner"><h2>Weekly QA Status — ' + esc(view.label) + "</h2>" +
      '<span class="qa-banner-week">' + esc(weekLabel(week)) + "</span></div>" +
      '<div class="qa-toolbar">' +
      '<div class="qa-view-toggle" role="tablist">' + viewBtns + "</div>" +
      '<label for="qaWeekSelect">Week</label>' +
      '<select id="qaWeekSelect" class="global-filter-select">' + options + "</select>" +
      '<span class="qa-toolbar-note">' + weeks.length + " week" + (weeks.length === 1 ? "" : "s") + " recorded</span></div>" +
      '<div id="qaViewBody"></div>' +
      "</div>";

    const body = root.querySelector("#qaViewBody");
    if (view.id === "project") renderProjectView(body, week);
    else body.innerHTML = renderTable(week);

    root.querySelector("#qaWeekSelect").addEventListener("change", (e) => {
      state.idx = Number(e.target.value);
      render(root);
    });
    root.querySelectorAll(".qa-view-btn").forEach((b) =>
      b.addEventListener("click", () => {
        state.view = b.getAttribute("data-view");
        render(root);
      })
    );
  }

  function init(data) {
    const root = document.getElementById("qaPanel");
    if (!root) return;
    state.weeks = sortedWeeks(data);
    if (!state.weeks.length) {
      root.innerHTML = '<p class="qa-empty">No QA data yet. Add a week to qa.json.</p>';
      return;
    }
    state.idx = state.weeks.length - 1;
    render(root);
  }

  fetch("qa.json")
    .then((r) => (r.ok ? r.json() : { weeks: [] }))
    .catch(() => ({ weeks: [] }))
    .then(init);
})();
