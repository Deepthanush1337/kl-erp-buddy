/* ============ KL ERP Buddy — app logic ============ */
/* global API_BASE */

"use strict";

/* ---------- Storage keys ---------- */
const LS_COOKIES = "kl_erp_cookies";
const LS_CREDS = "kl_erp_creds";

/* ---------- State ---------- */
const state = {
  creds: null,          // {username, password}
  cookies: null,        // {PHPSESSID, kl_erp_device_id, SERVERID, _csrf_token, _csrf}
  timetable: null,      // raw timetable object
  attendance: null,     // array
  grades: null,         // array
  seating: null,        // array
  ttKey: null,          // "yearCode-semId" of loaded timetable
  attKey: null,
  activeTab: "dashboard",
};

/* ---------- DOM helpers ---------- */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function num(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

/* ---------- Icons (Lucide) ---------- */
// Re-renders all <i data-lucide> placeholders as SVGs. No-ops when the CDN
// script is unavailable (e.g. offline), leaving the placeholders harmlessly empty.
function refreshIcons() {
  if (window.lucide && typeof window.lucide.createIcons === "function") {
    window.lucide.createIcons();
  }
}

// Every dynamic markup injection goes through here so icons are always re-rendered.
function setHTML(target, html) {
  const el = typeof target === "string" ? $(target) : target;
  el.innerHTML = html;
  refreshIcons();
}

/* ---------- Toasts ---------- */
const TOAST_ICONS = { success: "circle-check-big", error: "triangle-alert", info: "info" };

function toast(msg, type = "info") {
  const box = $("#toast-container");
  const el = document.createElement("div");
  el.className = `toast toast-${type}`;
  const icon = document.createElement("i");
  icon.setAttribute("data-lucide", TOAST_ICONS[type] || TOAST_ICONS.info);
  const text = document.createElement("span");
  text.textContent = msg;
  el.append(icon, text);
  box.appendChild(el);
  refreshIcons();
  setTimeout(() => {
    el.classList.add("toast-out");
    setTimeout(() => el.remove(), 300);
  }, 3500);
}

/* ---------- Modal ---------- */
function openModal(title, bodyHTML) {
  $("#modal-title").textContent = title;
  setHTML("#modal-body", bodyHTML);
  $("#modal-overlay").classList.remove("hidden");
  document.body.style.overflow = "hidden";
}
function closeModal() {
  $("#modal-overlay").classList.add("hidden");
  document.body.style.overflow = "";
}
$("#modal-close").addEventListener("click", closeModal);
$("#modal-overlay").addEventListener("click", (e) => {
  if (e.target === e.currentTarget) closeModal();
});

/* ---------- Storage ---------- */
function saveCreds(c) { state.creds = c; localStorage.setItem(LS_CREDS, JSON.stringify(c)); }
function saveCookies(c) { state.cookies = c; localStorage.setItem(LS_COOKIES, JSON.stringify(c)); }
function loadStored() {
  try {
    state.creds = JSON.parse(localStorage.getItem(LS_CREDS) || "null");
    state.cookies = JSON.parse(localStorage.getItem(LS_COOKIES) || "null");
  } catch { state.creds = null; state.cookies = null; }
}
function clearSession() {
  localStorage.removeItem(LS_CREDS);
  localStorage.removeItem(LS_COOKIES);
  state.creds = null; state.cookies = null;
  state.timetable = null; state.attendance = null;
  state.grades = null; state.seating = null;
  state.ttKey = null; state.attKey = null;
}

/* ---------- API ---------- */
async function api(path, extraFields = {}) {
  const fd = new FormData();
  if (state.creds) {
    fd.set("username", state.creds.username);
    fd.set("password", state.creds.password);
  }
  for (const [k, v] of Object.entries(extraFields)) fd.set(k, v == null ? "" : String(v));

  let res;
  try {
    res = await fetch(`${API_BASE}${path}`, { method: "POST", body: fd });
  } catch {
    throw new Error("Cannot reach the server. Check your connection or API_BASE.");
  }

  if (res.status === 401) {
    clearSession();
    showLogin();
    toast("Session expired. Please sign in again.", "error");
    throw new Error("unauthorized");
  }
  if (res.status === 503) {
    toast("ERP portal is down, try later", "error");
    throw new Error("erp_down");
  }
  if (!res.ok) throw new Error(`Server error (HTTP ${res.status})`);

  const data = await res.json();
  if (data.cookies) saveCookies(data.cookies);   // session_refreshed: just keep new cookies
  if (data.success === false) throw new Error(data.message || "Request failed");
  return data;
}

/* ---------- Academic year / semester ---------- */
function academicYearCode(yearStr) {
  // ERP codes observed: 2024-25 -> 16, 2025-26 -> 19, 2026-27 -> 29
  // (the formula 16 + 3*(startYear-2024) breaks for 2026-27, hence the map)
  const MAP = { "2024-25": "16", "2025-26": "19", "2026-27": "29" };
  if (MAP[yearStr]) return MAP[yearStr];
  const startYear = parseInt(yearStr.slice(0, 4), 10);
  return String(16 + 3 * (startYear - 2024));
}

function currentAcademicYear() {
  const now = new Date();
  const startYear = now.getMonth() >= 6 ? now.getFullYear() : now.getFullYear() - 1; // Jul onwards
  const endShort = String((startYear + 1) % 100).padStart(2, "0");
  return `${startYear}-${endShort}`;
}

function buildYearOptions(sel) {
  const curStart = parseInt(currentAcademicYear().slice(0, 4), 10);
  let html = "";
  for (let y = curStart - 3; y <= curStart; y++) {
    const label = `${y}-${String((y + 1) % 100).padStart(2, "0")}`;
    html += `<option value="${esc(label)}"${y === curStart ? " selected" : ""}>${esc(label)}</option>`;
  }
  setHTML(sel, html);
}

/* ---------- Slot parsing ---------- */
// "26UC1137-P    - S-35    -RoomNo-S708" -> {code, section, room}
function parseSlot(text) {
  const parts = String(text).split(/\s+-/).map((p) => p.trim()).filter(Boolean);
  const code = parts[0] || text;
  const section = parts[1] || "";
  let room = parts.slice(2).join(" - ") || "";
  room = room.replace(/^RoomNo-?/i, "").trim();
  return { code, section, room };
}

const DAY_KEYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const SLOT_COUNT = 24;

function todayKey() {
  // JS: 0=Sun..6=Sat -> "Mon".."Sun"
  return DAY_KEYS[(new Date().getDay() + 6) % 7];
}

// Slots are assumed to be 30-minute blocks starting 08:00 (slot 1 = 08:00-08:30).
function currentSlot() {
  const now = new Date();
  const mins = now.getHours() * 60 + now.getMinutes();
  const idx = Math.floor((mins - 8 * 60) / 30) + 1;
  return idx >= 1 && idx <= SLOT_COUNT ? String(idx) : null;
}

/* ---------- Screens ---------- */
function showLogin() {
  $("#app-screen").classList.add("hidden");
  $("#login-screen").classList.remove("hidden");
  $("#login-btn").disabled = false;
  $("#login-btn .btn-label").textContent = "Sign in";
  $("#login-btn .btn-spinner").classList.add("hidden");
}

function showApp() {
  $("#login-screen").classList.add("hidden");
  $("#app-screen").classList.remove("hidden");
  $("#dash-greeting").textContent = greeting() + ", " + (state.creds ? state.creds.username : "");
  $("#dash-date").textContent = new Date().toLocaleDateString(undefined, {
    weekday: "long", day: "numeric", month: "long", year: "numeric",
  });
  switchTab("dashboard");
  loadDashboard();
  loadTimetable();
}

function greeting() {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  return "Good evening";
}

/* ---------- Tabs ---------- */
function switchTab(tab) {
  state.activeTab = tab;
  $$(".nav-btn").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  $$(".tab-panel").forEach((p) => p.classList.toggle("active", p.id === `tab-${tab}`));
  // Lazy-load data for the tab (loaders render cached data or fetch)
  if (tab === "attendance") loadAttendance();
  if (tab === "grades") loadGrades();
  if (tab === "exams") loadSeating();
  if (tab === "dashboard") renderDashboard();
  window.scrollTo({ top: 0 });
}

$("#main-nav").addEventListener("click", (e) => {
  const btn = e.target.closest(".nav-btn");
  if (btn) switchTab(btn.dataset.tab);
});

document.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-refresh]");
  if (!btn) return;
  const what = btn.dataset.refresh;
  if (what === "dashboard") { state.attendance = null; state.timetable = null; loadDashboard(); loadTimetable(true); }
  if (what === "timetable") loadTimetable(true);
  if (what === "attendance") loadAttendance(true);
  if (what === "grades") loadGrades(true);
  if (what === "exams") loadSeating(true);
});

/* ---------- Skeletons ---------- */
function skelRows(n) {
  return `<div class="spinner-center"><div class="spinner"></div></div>` +
    Array.from({ length: n }, () => `<div class="skeleton skel-row"></div>`).join("");
}
function skelCards(n) {
  return Array.from({ length: n }, () => `<div class="skeleton skel-card"></div>`).join("");
}
function emptyState(title, sub, icon = "inbox") {
  return `<div class="empty-state"><div class="empty-icon"><i data-lucide="${esc(icon)}"></i></div>
    <div class="empty-title">${esc(title)}</div><div class="empty-sub">${esc(sub)}</div></div>`;
}

/* ---------- Login ---------- */
$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const username = $("#login-username").value.trim();
  const password = $("#login-password").value;
  const errEl = $("#login-error");
  errEl.classList.add("hidden");

  const btn = $("#login-btn");
  btn.disabled = true;
  btn.querySelector(".btn-label").textContent = "Signing in";
  btn.querySelector(".btn-spinner").classList.remove("hidden");

  try {
    const fd = new FormData();
    fd.set("username", username);
    fd.set("password", password);
    const res = await fetch(`${API_BASE}/login`, { method: "POST", body: fd });
    if (res.status === 503) throw new Error("ERP portal is down, try later");
    if (!res.ok) throw new Error(`Server error (HTTP ${res.status})`);
    const data = await res.json();
    if (!data.success) throw new Error(data.message || "Login failed");
    saveCreds({ username, password });
    if (data.cookies) saveCookies(data.cookies);
    toast(data.message || "Signed in", "success");
    showApp();
  } catch (err) {
    errEl.textContent = err.message || "Login failed";
    errEl.classList.remove("hidden");
    btn.disabled = false;
    btn.querySelector(".btn-label").textContent = "Sign in";
    btn.querySelector(".btn-spinner").classList.add("hidden");
  }
});

/* ---------- Logout ---------- */
$("#logout-btn").addEventListener("click", () => {
  clearSession();
  closeModal();
  showLogin();
  toast("Logged out", "success");
});

/* ---------- Data loaders ---------- */
function semParams(yearSel, semSel) {
  return {
    academic_year_code: academicYearCode($(yearSel).value),
    semester_id: $(semSel).value,
  };
}

async function loadTimetable(force) {
  const key = `${$("#tt-year").value}-${$("#tt-semester").value}`;
  if (!force && state.timetable && state.ttKey === key) { renderTimetable(); return; }
  setHTML("#timetable-content", skelRows(5));
  try {
    const data = await api("/fetch-timetable", { ...semParams("#tt-year", "#tt-semester"), ...cookieOnlyFields() });
    state.timetable = data.timetable || {};
    state.ttKey = key;
    renderTimetable();
    renderDashboard();
  } catch (err) {
    if (err.message !== "unauthorized") {
      setHTML("#timetable-content", emptyState("Could not load timetable", err.message, "calendar-days"));
    }
  }
}

function cookieOnlyFields() {
  // cookie fields are added inside api() via FormData? No — endpoints expect them as fields.
  const fd = {};
  const c = state.cookies || {};
  fd.php_sess_id = c.PHPSESSID || "";
  fd.csrf_cookie = c._csrf_token || c._csrf || "";
  fd.device_id = c.kl_erp_device_id || "";
  fd.server_id = c.SERVERID || "erp3";
  return fd;
}

async function loadAttendance(force) {
  const key = `${$("#att-year").value}-${$("#att-semester").value}`;
  if (!force && state.attendance && state.attKey === key) { renderAttendance(); return; }
  setHTML("#attendance-content", skelRows(5));
  setHTML("#attendance-summary", "");
  try {
    const data = await api("/fetch-attendance", { ...semParams("#att-year", "#att-semester"), ...cookieOnlyFields() });
    state.attendance = data.attendance || [];
    state.attKey = key;
    renderAttendance();
    renderDashboard();
  } catch (err) {
    if (err.message !== "unauthorized") {
      setHTML("#attendance-content", emptyState("Could not load attendance", err.message, "chart-column"));
    }
  }
}

async function loadGrades(force) {
  if (!force && state.grades) { renderGrades(); return; }
  setHTML("#grades-content", skelRows(5));
  setHTML("#grades-summary", "");
  try {
    const data = await api("/fetch-cgpa", { ...cookieOnlyFields() });
    state.grades = data.data || [];
    renderGrades();
  } catch (err) {
    if (err.message !== "unauthorized") {
      setHTML("#grades-content", emptyState("Could not load grades", err.message, "graduation-cap"));
    }
  }
}

async function loadSeating(force) {
  if (!force && state.seating) { renderSeating(); return; }
  setHTML("#exams-content", skelRows(4));
  try {
    const data = await api("/fetch-seating-plan", { ...cookieOnlyFields() });
    state.seating = data.seating_plan || [];
    renderSeating();
  } catch (err) {
    if (err.message !== "unauthorized") {
      setHTML("#exams-content", emptyState("Could not load seating plan", err.message, "armchair"));
    }
  }
}

async function loadDashboard() {
  setHTML("#dashboard-content", skelCards(3));
  // Dashboard composes timetable + attendance; fetch attendance for current term if needed
  if (!state.attendance) {
    try {
      const data = await api("/fetch-attendance", { ...semParams("#att-year", "#att-semester"), ...cookieOnlyFields() });
      state.attendance = data.attendance || [];
      state.attKey = `${$("#att-year").value}-${$("#att-semester").value}`;
    } catch { state.attendance = []; }
  }
  if (!state.timetable) {
    try {
      const data = await api("/fetch-timetable", { ...semParams("#tt-year", "#tt-semester"), ...cookieOnlyFields() });
      state.timetable = data.timetable || {};
      state.ttKey = `${$("#tt-year").value}-${$("#tt-semester").value}`;
    } catch { state.timetable = {}; }
  }
  renderDashboard();
}

/* ---------- Render: Dashboard ---------- */
function weightedAttendance(rows) {
  let attended = 0, conducted = 0;
  for (const r of rows || []) { attended += num(r.attended); conducted += num(r.conducted); }
  return conducted > 0 ? (attended / conducted) * 100 : null;
}

function pctClass(pct) {
  if (pct == null) return "";
  if (pct >= 85) return "pct-good";
  if (pct >= 75) return "pct-mid";
  return "pct-bad";
}

function todaysClasses() {
  const day = state.timetable ? state.timetable[todayKey()] : null;
  if (!day) return [];
  const out = [];
  for (let i = 1; i <= SLOT_COUNT; i++) {
    const txt = day[String(i)];
    if (txt && txt !== "-") out.push({ slot: i, ...parseSlot(txt) });
  }
  return out;
}

function renderDashboard() {
  if (state.activeTab !== "dashboard") return;
  const box = $("#dashboard-content");
  if (state.attendance === null) { setHTML(box, skelCards(3)); return; }
  const pct = weightedAttendance(state.attendance);
  const classes = todaysClasses();
  const courseCount = (state.attendance || []).length;
  const cls = pctClass(pct);

  setHTML(box, `
    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-icon"><i data-lucide="percent"></i></div>
        <div class="stat-label">Overall attendance</div>
        <div class="stat-value ${cls}">${pct == null ? "—" : pct.toFixed(1) + "%"}</div>
        <div class="stat-hint">${courseCount} course${courseCount === 1 ? "" : "s"} this term</div>
      </div>
      <div class="stat-card">
        <div class="stat-icon"><i data-lucide="calendar-days"></i></div>
        <div class="stat-label">Classes today</div>
        <div class="stat-value">${classes.length}</div>
        <div class="stat-hint">${todayKey() === "Sun" ? "Enjoy your Sunday" : "Scheduled for today"}</div>
      </div>
      <div class="stat-card">
        <div class="stat-icon"><i data-lucide="shield-alert"></i></div>
        <div class="stat-label">Attendance risk</div>
        <div class="stat-value ${pct == null ? "" : pct < 75 ? "pct-bad" : "pct-good"}">
          ${pct == null ? "—" : pct < 75 ? "At risk" : "Safe"}</div>
        <div class="stat-hint">75% is the minimum</div>
      </div>
      <div class="stat-card">
        <div class="stat-icon"><i data-lucide="book-open"></i></div>
        <div class="stat-label">Term</div>
        <div class="stat-value" style="font-size:1.15rem">${esc($("#tt-year").value)}</div>
        <div class="stat-hint">${esc($("#tt-semester option:checked").textContent)} semester</div>
      </div>
    </div>
    <h3 class="section-title">Today's classes</h3>
    ${classes.length === 0
      ? emptyState("No classes today", "Your schedule is clear — or the timetable isn't published yet.", "calendar-check")
      : `<div class="card today-list">${classes.map((c) => `
          <div class="today-row">
            <span class="today-slot">S${c.slot}</span>
            <span class="today-code">${esc(c.code)}</span>
            <span class="today-meta">${esc(c.section)}${c.room ? " · " + esc(c.room) : ""}</span>
          </div>`).join("")}
        </div>`}
  `);
}

/* ---------- Render: Timetable ---------- */
function renderTimetable() {
  const box = $("#timetable-content");
  const tt = state.timetable || {};
  const hasAny = DAY_KEYS.some((d) => tt[d] && Object.values(tt[d]).some((v) => v && v !== "-"));
  if (!hasAny) {
    setHTML(box, emptyState("No timetable data", "Nothing published for this term yet.", "calendar-days"));
    return;
  }
  const today = todayKey();
  const nowSlot = currentSlot();

  let html = `<div class="tt-wrap"><table class="tt-table"><thead><tr><th>Day</th>`;
  for (let i = 1; i <= SLOT_COUNT; i++) html += `<th>${i}</th>`;
  html += `</tr></thead><tbody>`;

  for (const day of DAY_KEYS) {
    const slots = tt[day] || {};
    html += `<tr><td class="tt-day${day === today ? " today" : ""}">${day}</td>`;
    for (let i = 1; i <= SLOT_COUNT; i++) {
      const key = String(i);
      const txt = slots[key];
      const isNow = day === today && key === nowSlot;
      if (!txt || txt === "-") {
        html += `<td><span class="tt-cell-free${isNow ? " now" : ""}">·</span></td>`;
      } else {
        const p = parseSlot(txt);
        html += `<td><div class="tt-cell-class${isNow ? " now" : ""}">
          <span class="tt-code">${esc(p.code)}</span>
          <span class="tt-meta">${esc(p.section)}${p.room ? "<br>" + esc(p.room) : ""}</span>
        </div></td>`;
      }
    }
    html += `</tr>`;
  }
  html += `</tbody></table></div>
  <p style="color:var(--text-faint);font-size:0.76rem;margin-top:10px">
    Current day &amp; slot are highlighted. Scroll sideways to see all 24 slots.</p>`;
  setHTML(box, html);
}

/* ---------- Render: Attendance ---------- */
function bunkText(row) {
  const attended = num(row.attended), conducted = num(row.conducted);
  const pct = conducted > 0 ? (attended / conducted) * 100 : 0;
  if (conducted === 0) return "";
  if (pct >= 75) {
    const n = Math.floor(attended / 0.75 - conducted);
    return `<div class="bunk-hint ok">You can miss ${n} more class${n === 1 ? "" : "es"}</div>`;
  }
  const n = Math.ceil((0.75 * conducted - attended) / 0.25);
  return `<div class="bunk-hint warn">Attend the next ${n} class${n === 1 ? "" : "es"} to recover</div>`;
}

function renderAttendance() {
  const rows = state.attendance || [];
  const sumBox = $("#attendance-summary");
  const box = $("#attendance-content");

  const pct = weightedAttendance(rows);
  setHTML(sumBox, rows.length === 0 ? "" : `
    <div class="cgpa-banner" style="margin-bottom:16px">
      <span class="cgpa-value">${pct == null ? "—" : pct.toFixed(1) + "%"}</span>
      <span class="cgpa-label">Overall attendance (weighted)</span>
    </div>`);

  if (rows.length === 0) {
    setHTML(box, emptyState("No attendance records", "Nothing to show for this term yet.", "chart-column"));
    return;
  }

  let html = `<div class="table-wrap"><table class="data-table"><thead><tr>
    <th>Course</th><th class="num">Conducted</th><th class="num">Attended</th>
    <th class="num">Absent</th><th class="num">%</th></tr></thead><tbody>`;

  rows.forEach((r, i) => {
    const p = num(r.percentage);
    const badge = p >= 85 ? "pct-good" : p >= 75 ? "pct-mid" : "pct-bad";
    html += `<tr class="clickable" data-att-idx="${i}">
      <td class="course-cell">
        <div class="course-name">${esc(r.course_name || r.course_code)}</div>
        <div class="course-sub">${esc(r.course_code)} · ${esc(r.type || "")} ${esc(r.section || "")}</div>
        ${bunkText(r)}
      </td>
      <td class="num">${esc(r.conducted)}</td>
      <td class="num">${esc(r.attended)}</td>
      <td class="num">${esc(r.absent)}</td>
      <td class="num"><span class="pct-badge ${badge}">${esc(r.percentage)}%</span></td>
    </tr>`;
  });
  html += `</tbody></table></div>
  <p style="color:var(--text-faint);font-size:0.76rem;margin-top:10px">Tap a course for day-by-day details.</p>`;
  setHTML(box, html);

  box.querySelectorAll("[data-att-idx]").forEach((tr) =>
    tr.addEventListener("click", () => openRegisterDetail(rows[+tr.dataset.attIdx])));
}

async function openRegisterDetail(row) {
  openModal(row.course_name || row.course_code, `<div class="spinner-center"><div class="spinner"></div></div>`);
  try {
    const data = await api("/fetch-register-detail", {
      ...cookieOnlyFields(), register_href: row.register_href,
    });
    const meta = data.metadata || {};
    const days = data.daily_attendance || [];

    let html = `<div class="modal-section-title">Course info</div><div class="kv-grid">`;
    for (const [k, v] of Object.entries(meta)) {
      html += `<div class="kv-row"><span class="kv-key">${esc(k)}</span><span class="kv-val">${esc(v)}</span></div>`;
    }
    html += `</div><div class="modal-section-title">Day-by-day</div>`;
    if (days.length === 0) {
      html += emptyState("No daily records", "No register entries found.", "notebook-pen");
    } else {
      html += `<div class="day-grid">` + days.map((d) => {
        const st = d.status === "P" ? "st-P" : d.status === "A" ? "st-A" : "st-other";
        const label = d.status === "P" ? "Present" : d.status === "A" ? "Absent" : (d.status || "—");
        return `<div class="day-chip ${st}"><span class="day-date">${esc(d.date_slot)}</span>
          <span class="day-status">${esc(label)}</span></div>`;
      }).join("") + `</div>`;
    }
    setHTML("#modal-body", html);
  } catch (err) {
    if (err.message !== "unauthorized") {
      setHTML("#modal-body", emptyState("Could not load details", err.message, "triangle-alert"));
    } else closeModal();
  }
}

/* ---------- Render: Grades ---------- */
function renderGrades() {
  const rows = state.grades || [];
  const sumBox = $("#grades-summary");
  const box = $("#grades-content");

  if (rows.length === 0) {
    setHTML(sumBox, "");
    setHTML(box, emptyState("No results yet", "Grades will appear here once published.", "graduation-cap"));
    return;
  }

  let gp = 0, cr = 0;
  for (const r of rows) { gp += num(r.grade_point) * num(r.credits); cr += num(r.credits); }
  const cgpa = cr > 0 ? gp / cr : null;

  setHTML(sumBox, cgpa == null ? "" : `
    <div class="cgpa-banner">
      <span class="cgpa-value">${cgpa.toFixed(2)}</span>
      <span class="cgpa-label">CGPA · ${cr} credits</span>
    </div>`);

  let html = `<div class="table-wrap"><table class="data-table"><thead><tr>
    <th>Course</th><th>Term</th><th class="num">Credits</th><th>Grade</th>
    </tr></thead><tbody>`;
  rows.forEach((r, i) => {
    html += `<tr class="clickable" data-grade-idx="${i}">
      <td class="course-cell">
        <div class="course-name">${esc(r.course_name || r.course_code)}</div>
        <div class="course-sub">${esc(r.course_code)}</div>
      </td>
      <td>${esc(r.academic_year)} ${esc(r.semester)}</td>
      <td class="num">${esc(r.credits)}</td>
      <td><span class="grade-chip">${esc(r.grade)}</span></td>
    </tr>`;
  });
  html += `</tbody></table></div>
  <p style="color:var(--text-faint);font-size:0.76rem;margin-top:10px">Tap a course for the full scorecard.</p>`;
  setHTML(box, html);

  box.querySelectorAll("[data-grade-idx]").forEach((tr) =>
    tr.addEventListener("click", () => openMarksDetail(rows[+tr.dataset.gradeIdx])));
}

async function openMarksDetail(row) {
  openModal(row.course_name || row.course_code, `<div class="spinner-center"><div class="spinner"></div></div>`);
  try {
    const data = await api("/fetch-marks-detail", {
      ...cookieOnlyFields(), target_href: row.target_href,
    });
    const sc = data.scorecard || {};
    const entries = Object.entries(sc);
    let html = `<div class="modal-section-title">Scorecard</div>`;
    if (entries.length === 0) {
      html += emptyState("No scorecard data", "Details are not available yet.", "file-text");
    } else {
      html += `<div class="kv-grid">` + entries.map(([k, v]) =>
        `<div class="kv-row"><span class="kv-key">${esc(k)}</span><span class="kv-val">${esc(v)}</span></div>`
      ).join("") + `</div>`;
    }
    setHTML("#modal-body", html);
  } catch (err) {
    if (err.message !== "unauthorized") {
      setHTML("#modal-body", emptyState("Could not load scorecard", err.message, "triangle-alert"));
    } else closeModal();
  }
}

/* ---------- Render: Exams ---------- */
function renderSeating() {
  const rows = state.seating || [];
  const box = $("#exams-content");
  if (rows.length === 0) {
    setHTML(box, emptyState("No exams scheduled", "Your seating plan will appear here before exams.", "armchair"));
    return;
  }
  let html = `<div class="table-wrap"><table class="data-table"><thead><tr>
    <th>Date</th><th>Course</th><th>Exam</th><th>Time slot</th><th>Room</th>
    </tr></thead><tbody>`;
  for (const r of rows) {
    html += `<tr>
      <td style="font-weight:600">${esc(r.date)}</td>
      <td class="course-cell"><div class="course-name">${esc(r.course_code)}</div>
        <div class="course-sub">${esc(r.university_id || "")}</div></td>
      <td>${esc(r.exam_type)}</td>
      <td>${esc(r.time_slot)}</td>
      <td><span class="grade-chip">${esc(r.room_no)}</span></td>
    </tr>`;
  }
  html += `</tbody></table></div>`;
  setHTML(box, html);
}

/* ---------- Selectors ---------- */
["#tt-year", "#att-year"].forEach((s) => buildYearOptions($(s)));

$("#tt-year").addEventListener("change", () => loadTimetable(true));
$("#tt-semester").addEventListener("change", () => loadTimetable(true));
$("#att-year").addEventListener("change", () => loadAttendance(true));
$("#att-semester").addEventListener("change", () => loadAttendance(true));

/* ---------- Init ---------- */
loadStored();
if (state.creds && state.cookies) {
  showApp();
} else {
  showLogin();
}
refreshIcons(); // static placeholders (nav, buttons) on first paint
