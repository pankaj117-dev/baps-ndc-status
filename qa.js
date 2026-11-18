/* QA tab: weekly resource-wise QA status, read from qa.json.
 * qa.json = { weeks: [ { weekStart, weekEnd, rows: [ {resource, project,
 *   userStories, tcDesigned, tcModified, tcExecuted, defectsLogged,
 *   defectsClosed, defectsReopen, defectsRejected, leave } ] } ] }
 * Add each new week to the end of `weeks`. The tab opens on the latest
 * week, and a dropdown switches to any earlier one. Totals are computed
 * here, never stored. */
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

  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

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

  function renderTable(week) {
    const rows = (week.rows || []).slice().sort((a, b) =>
      String(a.resource).localeCompare(String(b.resource)) || String(a.project).localeCompare(String(b.project))
    );
    const totals = {};
    COLS.forEach((c) => { totals[c.key] = rows.reduce((s, r) => s + num(r[c.key]), 0); });

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

  function render(root, weeks, idx) {
    const week = weeks[idx];
    const options = weeks
      .map((w, i) => '<option value="' + i + '"' + (i === idx ? " selected" : "") + ">" + esc(weekLabel(w)) + "</option>")
      .reverse()
      .join("");
    root.innerHTML =
      '<div class="qa-card">' +
      '<div class="qa-banner"><h2>Weekly QA Status — Resource-wise</h2>' +
      '<span class="qa-banner-week">' + esc(weekLabel(week)) + "</span></div>" +
      '<div class="qa-toolbar"><label for="qaWeekSelect">Week</label>' +
      '<select id="qaWeekSelect" class="global-filter-select">' + options + "</select>" +
      '<span class="qa-toolbar-note">' + weeks.length + " week" + (weeks.length === 1 ? "" : "s") + " recorded</span></div>" +
      renderTable(week) +
      "</div>";
    root.querySelector("#qaWeekSelect").addEventListener("change", (e) => render(root, weeks, Number(e.target.value)));
  }

  function init(data) {
    const root = document.getElementById("qaPanel");
    if (!root) return;
    const weeks = sortedWeeks(data);
    if (!weeks.length) {
      root.innerHTML = '<p class="qa-empty">No QA data yet. Add a week to qa.json.</p>';
      return;
    }
    render(root, weeks, weeks.length - 1);
  }

  fetch("qa.json")
    .then((r) => (r.ok ? r.json() : { weeks: [] }))
    .catch(() => ({ weeks: [] }))
    .then(init);
})();
