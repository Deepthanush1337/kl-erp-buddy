/* ============ KL ERP Buddy — app logic ============ */
/* global API_BASE, TURNSTILE_SITE_KEY */

"use strict";

/* ---------- Storage keys ---------- */
const LS_COOKIES = "kl_erp_cookies";
const LS_CREDS = "kl_erp_creds";
const LS_PROFILE = "kl_erp_profile";

/* ---------- State ---------- */
const state = {
  creds: null,          // {username, password}
  cookies: null,        // {PHPSESSID, kl_erp_device_id, SERVERID, _csrf_token, _csrf}
  profile: null,        // {name, roll_no, department} from /login or /fetch-profile
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
function saveProfile(p) { state.profile = p; localStorage.setItem(LS_PROFILE, JSON.stringify(p)); }
function loadStored() {
  try {
    state.creds = JSON.parse(localStorage.getItem(LS_CREDS) || "null");
    state.cookies = JSON.parse(localStorage.getItem(LS_COOKIES) || "null");
    state.profile = JSON.parse(localStorage.getItem(LS_PROFILE) || "null");
  } catch { state.creds = null; state.cookies = null; state.profile = null; }
}
function clearSession() {
  localStorage.removeItem(LS_CREDS);
  localStorage.removeItem(LS_COOKIES);
  localStorage.removeItem(LS_PROFILE);
  state.creds = null; state.cookies = null; state.profile = null;
  state.timetable = null; state.attendance = null;
  state.grades = null; state.seating = null;
  state.ttKey = null; state.attKey = null;
}

/* ---------- Mock data (visual testing) ---------- */
// Append ?mock=1 to the URL to render realistic fake rows. Inactive otherwise;
// login and the detail endpoints always hit the real backend.
const MOCK_MODE = new URLSearchParams(location.search).has("mock");

const MOCK_ATTENDANCE = [
  { course_name: "Data Structures and Algorithms", course_code: "24CS2101", type: "Theory", section: "S-35", conducted: 42, attended: 39, absent: 3, percentage: "92.86", register_href: "mock" },
  { course_name: "Operating Systems", course_code: "24CS3102", type: "Theory", section: "S-35", conducted: 40, attended: 35, absent: 5, percentage: "87.50", register_href: "mock" },
  { course_name: "Database Management Systems", course_code: "24CS2103", type: "Theory", section: "S-36", conducted: 38, attended: 30, absent: 8, percentage: "78.95", register_href: "mock" },
  { course_name: "Computer Networks", course_code: "24CS3104", type: "Theory", section: "S-35", conducted: 36, attended: 24, absent: 12, percentage: "66.67", register_href: "mock" },
  { course_name: "Operating Systems Laboratory", course_code: "24CS3181", type: "Practical", section: "S-35", conducted: 20, attended: 19, absent: 1, percentage: "95.00", register_href: "mock" },
  { course_name: "Professional Communication Skills", course_code: "24HS1101", type: "Theory", section: "S-37", conducted: 30, attended: 26, absent: 4, percentage: "86.67", register_href: "mock" },
];

const MOCK_GRADES = [
  { course_name: "Mathematics I", course_code: "24MT1101", academic_year: "2024-25", semester: "Odd", credits: 4, grade: "O", grade_point: 10, target_href: "mock" },
  { course_name: "Programming for Problem Solving", course_code: "24CS1101", academic_year: "2024-25", semester: "Odd", credits: 4, grade: "S", grade_point: 9, target_href: "mock" },
  { course_name: "Engineering Physics", course_code: "24PH1102", academic_year: "2024-25", semester: "Odd", credits: 3, grade: "A", grade_point: 8, target_href: "mock" },
  { course_name: "Basic Electrical Engineering", course_code: "24EE1101", academic_year: "2024-25", semester: "Odd", credits: 3, grade: "B", grade_point: 7, target_href: "mock" },
  { course_name: "Environmental Science", course_code: "24ES1101", academic_year: "2024-25", semester: "Even", credits: 2, grade: "C", grade_point: 6, target_href: "mock" },
  { course_name: "Workshop Practice", course_code: "24ME1181", academic_year: "2024-25", semester: "Even", credits: 2, grade: "A", grade_point: 8, target_href: "mock" },
];

const MOCK_SEATING = [
  { date: "12-08-2026", course_code: "24CS2101", university_id: "2600031735", exam_type: "Mid Semester", time_slot: "09:00 - 11:00", room_no: "S708" },
  { date: "14-08-2026", course_code: "24CS3102", university_id: "2600031735", exam_type: "Mid Semester", time_slot: "13:00 - 15:00", room_no: "R412" },
  { date: "18-08-2026", course_code: "24CS2103", university_id: "2600031735", exam_type: "Quiz", time_slot: "09:00 - 10:00", room_no: "C305" },
];

function mockApiResponse(path) {
  if (path === "/fetch-attendance") return { success: true, attendance: MOCK_ATTENDANCE };
  if (path === "/fetch-cgpa") return { success: true, data: MOCK_GRADES };
  if (path === "/fetch-seating-plan") return { success: true, seating_plan: MOCK_SEATING };
  return null; // everything else goes to the real backend
}

/* ---------- API ---------- */
async function api(path, extraFields = {}) {
  if (MOCK_MODE) {
    const canned = mockApiResponse(path);
    if (canned) return canned;
  }
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

// Official KL slot timings (50 min each). ERP slot keys go up to 24, but only
// these 11 slots are real — anything above 11 is ignored everywhere.
const SLOT_TIMES = {
  1: ["07:10", "08:00"],
  2: ["08:00", "08:50"],
  3: ["09:20", "10:10"],
  4: ["10:10", "11:00"],
  5: ["11:10", "12:00"],
  6: ["12:00", "12:50"],
  7: ["13:00", "13:50"],
  8: ["13:50", "14:40"],
  9: ["14:50", "15:40"],
  10: ["15:50", "16:40"],
  11: ["16:40", "17:30"],
};
const SLOT_NUMBERS = Object.keys(SLOT_TIMES).map(Number).sort((a, b) => a - b);

function timeToMin(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

function nowMinutes() {
  const now = new Date();
  return now.getHours() * 60 + now.getMinutes();
}

function todayKey() {
  // JS: 0=Sun..6=Sat -> "Mon".."Sun"
  return DAY_KEYS[(new Date().getDay() + 6) % 7];
}

// Slot happening right now per SLOT_TIMES (device clock), or null during breaks/off-hours.
function currentSlot() {
  const mins = nowMinutes();
  for (const n of SLOT_NUMBERS) {
    if (mins >= timeToMin(SLOT_TIMES[n][0]) && mins < timeToMin(SLOT_TIMES[n][1])) return n;
  }
  return null;
}

/* ---------- Turnstile (Cloudflare human verification) ---------- */
// The widget div lives on the login screen; the site key is injected here so it
// only ever lives in config.js. api.js is async: if it finished loading before
// we set the key, its implicit render already skipped the div — render explicitly.
(function initTurnstile() {
  const el = $(".cf-turnstile");
  if (!el) return;
  el.dataset.sitekey = TURNSTILE_SITE_KEY;
  if (window.turnstile && typeof window.turnstile.render === "function" && !el.hasChildNodes()) {
    try { window.turnstile.render(el); } catch { /* already rendered */ }
  }
})();

// Tokens are single-use; reset so the checkbox is fresh whenever the login
// screen is (re-)shown (logout, session expiry, failed attempt).
function resetTurnstile() {
  if (window.turnstile && typeof window.turnstile.reset === "function") {
    try { window.turnstile.reset(); } catch { /* widget not rendered yet */ }
  }
}

/* ---------- Screens ---------- */
function showLogin() {
  $("#app-screen").classList.add("hidden");
  $("#login-screen").classList.remove("hidden");
  $("#login-btn").disabled = false;
  $("#login-btn .btn-label").textContent = "Sign in";
  $("#login-btn .btn-spinner").classList.add("hidden");
  resetTurnstile();
}

function showApp() {
  $("#login-screen").classList.add("hidden");
  $("#app-screen").classList.remove("hidden");
  renderGreeting();
  $("#dash-date").textContent = new Date().toLocaleDateString(undefined, {
    weekday: "long", day: "numeric", month: "long", year: "numeric",
  });
  ensureProfile();
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

// KL ERP stores names surname-first ("Pothuru Deepthanush Chowdary"), so the
// given name is the second token; single-token names just use what they have.
function firstName(full) {
  const parts = String(full || "").trim().split(/\s+/).filter(Boolean);
  const pick = parts.length > 1 ? parts[1] : parts[0] || "";
  return pick ? pick[0].toUpperCase() + pick.slice(1).toLowerCase() : "";
}

// Department strings are long ("1 - KLVZA - Department of ... -1"). The tail
// after the last " - " is the readable part; drop the trailing section marker
// and the "Department of" prefix to keep the subtitle tidy.
function deptShort(dept) {
  const s = String(dept || "").trim();
  if (!s) return "";
  const parts = s.split(" - ").map((p) => p.trim()).filter(Boolean);
  let short = parts.length > 1 ? parts[parts.length - 1] : s;
  short = short.replace(/-\d+$/, "").replace(/^department of\s+/i, "").trim();
  return short ? short[0].toUpperCase() + short.slice(1) : s;
}

function renderGreeting() {
  const p = state.profile;
  const name = p && p.name ? firstName(p.name) : state.creds ? state.creds.username : "";
  $("#dash-greeting").textContent = greeting() + (name ? ", " + name : "");
  const sub = $("#dash-profile");
  const bits = p ? [p.roll_no, deptShort(p.department)].filter(Boolean) : [];
  sub.textContent = bits.join(" · ");
  sub.classList.toggle("hidden", bits.length === 0);
}

// Lazily fill in a missing profile (e.g. a session restored from before this
// field existed). Failure is harmless: the greeting keeps the username fallback.
let profileFetchInFlight = false;
async function ensureProfile() {
  if ((state.profile && state.profile.name) || profileFetchInFlight || !state.creds) return;
  profileFetchInFlight = true;
  try {
    const data = await api("/fetch-profile", { ...cookieOnlyFields() });
    if (data.profile && data.profile.name) {
      saveProfile(data.profile);
      renderGreeting();
    }
  } catch { /* keep the fallback greeting */ }
  finally { profileFetchInFlight = false; }
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

  // Human verification (Cloudflare Turnstile)
  if (!window.turnstile || typeof window.turnstile.getResponse !== "function") {
    errEl.textContent = "Verification failed to load — check your connection and reload the page.";
    errEl.classList.remove("hidden");
    return;
  }
  const turnstileToken = window.turnstile.getResponse();
  if (!turnstileToken) {
    errEl.textContent = "Please tick the verification checkbox before signing in.";
    errEl.classList.remove("hidden");
    return;
  }

  const btn = $("#login-btn");
  btn.disabled = true;
  btn.querySelector(".btn-label").textContent = "Signing in";
  btn.querySelector(".btn-spinner").classList.remove("hidden");

  try {
    const fd = new FormData();
    fd.set("username", username);
    fd.set("password", password);
    fd.set("turnstile_token", turnstileToken);
    const res = await fetch(`${API_BASE}/login`, { method: "POST", body: fd });
    if (res.status === 403) throw new Error("Human verification failed. Please retry the checkbox.");
    if (res.status === 503) throw new Error("ERP portal is down, try later");
    if (!res.ok) throw new Error(`Server error (HTTP ${res.status})`);
    const data = await res.json();
    if (!data.success) throw new Error(data.message || "Login failed");
    saveCreds({ username, password });
    if (data.cookies) saveCookies(data.cookies);
    if (data.profile && data.profile.name) saveProfile(data.profile);
    toast(data.message || "Signed in", "success");
    showApp();
  } catch (err) {
    errEl.textContent = err.message || "Login failed";
    errEl.classList.remove("hidden");
    btn.disabled = false;
    btn.querySelector(".btn-label").textContent = "Sign in";
    btn.querySelector(".btn-spinner").classList.add("hidden");
    resetTurnstile(); // the burnt token can't be reused — give the user a fresh checkbox
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

// Today's classes as merged blocks: consecutive slots with identical raw text
// collapse into one block with a real time range (07:10 – 08:50 etc.).
function todaysBlocks() {
  const day = state.timetable ? state.timetable[todayKey()] : null;
  if (!day) return [];
  const out = [];
  let i = 0;
  while (i < SLOT_NUMBERS.length) {
    const startSlot = SLOT_NUMBERS[i];
    const txt = day[String(startSlot)];
    if (!txt || txt === "-") { i++; continue; }
    let j = i;
    while (
      j + 1 < SLOT_NUMBERS.length &&
      SLOT_NUMBERS[j + 1] === SLOT_NUMBERS[j] + 1 &&
      day[String(SLOT_NUMBERS[j + 1])] === txt
    ) j++;
    const endSlot = SLOT_NUMBERS[j];
    out.push({
      startSlot, endSlot,
      start: SLOT_TIMES[startSlot][0],
      end: SLOT_TIMES[endSlot][1],
      ...parseSlot(txt),
    });
    i = j + 1;
  }
  return out;
}

function fmtDuration(mins) {
  const h = Math.floor(mins / 60), m = mins % 60;
  if (h > 0 && m > 0) return `${h}h ${m}m`;
  if (h > 0) return `${h}h`;
  return `${m}m`;
}

// Hero banner: current class (pulsing) / next class (with countdown) / all done.
// Returns "" when there are no classes at all today (the empty state covers that).
function classHero(blocks) {
  if (blocks.length === 0) return "";
  const mins = nowMinutes();
  for (const b of blocks) {
    const s = timeToMin(b.start), e = timeToMin(b.end);
    if (mins >= s && mins < e) {
      return `<div class="dash-hero now">
        <span class="hero-dot" aria-hidden="true"></span>
        <div class="hero-text">
          <span class="hero-title">In class now: <b>${esc(b.code)}</b></span>
          <span class="hero-sub">${esc(b.section)}${b.room ? " · " + esc(b.room) : ""} · ends ${b.end}</span>
        </div></div>`;
    }
    if (mins < s) {
      return `<div class="dash-hero next">
        <i data-lucide="clock"></i>
        <div class="hero-text">
          <span class="hero-title">Next up: <b>${esc(b.code)}</b> at ${b.start}</span>
          <span class="hero-sub">${b.room ? esc(b.room) + " " : ""}(in ${fmtDuration(s - mins)})</span>
        </div></div>`;
    }
  }
  return `<div class="dash-hero done">
    <i data-lucide="circle-check-big"></i>
    <div class="hero-text">
      <span class="hero-title">No more classes today</span>
      <span class="hero-sub">All ${blocks.length} class${blocks.length === 1 ? "" : "es"} done — enjoy the rest of your day</span>
    </div></div>`;
}

function renderDashboard() {
  if (state.activeTab !== "dashboard") return;
  const box = $("#dashboard-content");
  if (state.attendance === null) { setHTML(box, skelCards(3)); return; }
  const pct = weightedAttendance(state.attendance);
  const blocks = todaysBlocks();
  const courseCount = (state.attendance || []).length;
  const cls = pctClass(pct);
  const mins = nowMinutes();

  setHTML(box, `
    ${classHero(blocks)}
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
        <div class="stat-value">${blocks.length}</div>
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
    ${blocks.length === 0
      ? emptyState("No classes today", "Your schedule is clear — or the timetable isn't published yet.", "calendar-check")
      : `<div class="card today-list">${blocks.map((b) => {
          const isNow = mins >= timeToMin(b.start) && mins < timeToMin(b.end);
          return `<div class="today-row${isNow ? " now" : ""}">
            <span class="today-time">${b.start} – ${b.end}</span>
            <span class="today-code">${esc(b.code)}</span>
            <span class="today-meta">${esc(b.section)}${b.room ? " · " + esc(b.room) : ""}</span>
          </div>`;
        }).join("")}
        </div>`}
  `);
}

/* ---------- Render: Timetable ---------- */
// Columns actually present in the fetched data, intersected with the 11 real
// KL slots and sorted numerically (robust if the ERP omits trailing empties).
function timetableColumns(tt) {
  const present = new Set();
  for (const day of DAY_KEYS) {
    for (const k of Object.keys(tt[day] || {})) {
      const n = Number(k);
      if (SLOT_TIMES[n]) present.add(n);
    }
  }
  return [...present].sort((a, b) => a - b);
}

function renderTimetable() {
  const box = $("#timetable-content");
  const tt = state.timetable || {};
  const hasAny = DAY_KEYS.some((d) => tt[d] && Object.values(tt[d]).some((v) => v && v !== "-"));
  if (!hasAny) {
    setHTML(box, emptyState("No timetable data", "Nothing published for this term yet.", "calendar-days"));
    return;
  }
  const cols = timetableColumns(tt);
  if (cols.length === 0) {
    setHTML(box, emptyState("No timetable data", "Nothing published for this term yet.", "calendar-days"));
    return;
  }
  const today = todayKey();
  const nowSlot = currentSlot();

  let html = `<div class="tt-wrap"><table class="tt-table"><thead><tr><th>Day</th>`;
  for (const n of cols) {
    html += `<th><span class="tt-slot-num">${n}</span><span class="tt-slot-time">${SLOT_TIMES[n][0]}</span></th>`;
  }
  html += `</tr></thead><tbody>`;

  for (const day of DAY_KEYS) {
    const slots = tt[day] || {};
    const isToday = day === today;
    html += `<tr${isToday ? ' class="tt-today-row"' : ""}><td class="tt-day${isToday ? " today" : ""}">${day}</td>`;
    // Merge consecutive identical cells (raw text compare) into one colspan.
    let i = 0;
    while (i < cols.length) {
      const startSlot = cols[i];
      const txt = slots[String(startSlot)] || "-";
      let span = 1;
      while (
        i + span < cols.length &&
        cols[i + span] === cols[i + span - 1] + 1 && // only merge truly adjacent slots
        (slots[String(cols[i + span])] || "-") === txt
      ) span++;
      const endSlot = cols[i + span - 1];
      const spanLabel = `${SLOT_TIMES[startSlot][0]} – ${SLOT_TIMES[endSlot][1]}`;
      const isNow = isToday && nowSlot != null && nowSlot >= startSlot && nowSlot <= endSlot;
      if (txt === "-") {
        html += `<td colspan="${span}"><span class="tt-cell-free${isNow ? " now" : ""}">Free</span></td>`;
      } else {
        const p = parseSlot(txt);
        html += `<td colspan="${span}"><div class="tt-cell-class${isNow ? " now" : ""}">
          <span class="tt-code">${esc(p.code)}</span>
          <span class="tt-meta">${esc(p.section)}${p.room ? " · " + esc(p.room) : ""}</span>
          <span class="tt-time">${spanLabel}</span>
        </div></td>`;
      }
      i += span;
    }
    html += `</tr>`;
  }
  html += `</tbody></table></div>
  <p style="color:var(--text-faint);font-size:0.76rem;margin-top:10px">
    Current day &amp; slot are highlighted. Breaks 08:50–09:20 · 12:50–13:00 · 14:40–14:50 · 15:40–15:50.</p>`;
  setHTML(box, html);
}

/* ---------- Render: Attendance ---------- */
// SVG progress ring. pct in [0,100]; null renders an empty ring with "—".
function ringSVG(pct, { size = 64, stroke = 6, label = null } = {}) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const p = pct == null ? 0 : Math.max(0, Math.min(100, pct));
  const off = c * (1 - p / 100);
  const text = label != null ? label : pct == null ? "—" : `${p.toFixed(1)}%`;
  return `<svg class="ring" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" aria-hidden="true">
    <circle class="ring-track" cx="${size / 2}" cy="${size / 2}" r="${r}" stroke-width="${stroke}"></circle>
    <circle class="ring-fill" cx="${size / 2}" cy="${size / 2}" r="${r}" stroke-width="${stroke}"
      stroke-dasharray="${c.toFixed(2)}" stroke-dashoffset="${off.toFixed(2)}"
      transform="rotate(-90 ${size / 2} ${size / 2})"></circle>
    <text class="ring-text" x="50%" y="50%" text-anchor="middle" dominant-baseline="central">${esc(text)}</text>
  </svg>`;
}

// Bunk hint as a pill badge (same thresholds as before: 75% is the minimum).
function bunkPill(row) {
  const attended = num(row.attended), conducted = num(row.conducted);
  if (conducted === 0) return "";
  const pct = (attended / conducted) * 100;
  if (pct >= 75) {
    const n = Math.floor(attended / 0.75 - conducted);
    return `<span class="bunk-pill ok"><i data-lucide="circle-check-big"></i>You can miss ${n} more class${n === 1 ? "" : "es"}</span>`;
  }
  const n = Math.ceil((0.75 * conducted - attended) / 0.25);
  return `<span class="bunk-pill warn"><i data-lucide="triangle-alert"></i>Attend the next ${n} class${n === 1 ? "" : "es"} to recover</span>`;
}

function renderAttendance() {
  const rows = state.attendance || [];
  const sumBox = $("#attendance-summary");
  const box = $("#attendance-content");

  if (rows.length === 0) {
    setHTML(sumBox, "");
    setHTML(box, emptyState("No attendance records", "Nothing to show for this term yet.", "chart-column"));
    return;
  }

  const pct = weightedAttendance(rows);
  let attended = 0, conducted = 0;
  for (const r of rows) { attended += num(r.attended); conducted += num(r.conducted); }

  setHTML(sumBox, `
    <div class="ring-banner ${pctClass(pct)}">
      ${ringSVG(pct, { size: 84, stroke: 7 })}
      <div class="ring-banner-meta">
        <div class="ring-banner-title">Overall attendance (weighted)</div>
        <div class="ring-banner-sub">${attended}/${conducted} classes · ${rows.length} course${rows.length === 1 ? "" : "s"}</div>
      </div>
    </div>`);

  const safe = rows.filter((r) => num(r.percentage) >= 75).length;
  let html = `<div class="att-strip">
      <span class="strip-chip ok"><i data-lucide="shield-check"></i>${safe} safe</span>
      <span class="strip-chip warn"><i data-lucide="shield-alert"></i>${rows.length - safe} at risk</span>
    </div>
    <div class="card-grid">`;

  rows.forEach((r, i) => {
    const p = num(r.percentage);
    const sub = [r.course_code, r.type, r.section].filter(Boolean).map(esc).join(" · ");
    html += `<button type="button" class="card-btn att-card ${pctClass(p)}" data-att-idx="${i}">
      <div class="cc-head">
        <div class="cc-course">
          <div class="cc-name">${esc(r.course_name || r.course_code)}</div>
          <div class="cc-sub">${sub}</div>
        </div>
        ${ringSVG(p)}
      </div>
      <div class="att-stats">
        <div class="att-stat"><b>${esc(r.conducted)}</b><span>Conducted</span></div>
        <div class="att-stat"><b>${esc(r.attended)}</b><span>Attended</span></div>
        <div class="att-stat"><b>${esc(r.absent)}</b><span>Absent</span></div>
      </div>
      ${bunkPill(r)}
    </button>`;
  });
  html += `</div><p class="grid-hint">Tap a course for day-by-day details.</p>`;
  setHTML(box, html);

  box.querySelectorAll("[data-att-idx]").forEach((el) =>
    el.addEventListener("click", () => openRegisterDetail(rows[+el.dataset.attIdx])));
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
// Chip color per grade letter: O/S gold-ish, A green, B blue, F red, rest muted.
function gradeChipClass(g) {
  const t = String(g || "").trim().toUpperCase();
  if (t === "O" || t === "S") return "grade-top";
  if (t === "A") return "grade-a";
  if (t === "B") return "grade-b";
  if (t === "F") return "grade-f";
  return "";
}

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
    <div class="ring-banner">
      ${ringSVG(cgpa * 10, { size: 84, stroke: 7, label: cgpa.toFixed(2) })}
      <div class="ring-banner-meta">
        <div class="ring-banner-title">CGPA</div>
        <div class="ring-banner-sub">${cr} credits · ${rows.length} course${rows.length === 1 ? "" : "s"}</div>
      </div>
    </div>`);

  let html = `<div class="card-grid">`;
  rows.forEach((r, i) => {
    const term = [r.academic_year, r.semester].filter(Boolean).map(esc).join(" ");
    html += `<button type="button" class="card-btn" data-grade-idx="${i}">
      <div class="cc-head">
        <div class="cc-course">
          <div class="cc-name">${esc(r.course_name || r.course_code)}</div>
          <div class="cc-sub">${esc(r.course_code)}</div>
        </div>
        <span class="grade-chip ${gradeChipClass(r.grade)}">${esc(r.grade)}</span>
      </div>
      <div class="meta-row">
        <span class="meta-item"><i data-lucide="layers"></i>${esc(r.credits)} credits</span>
        <span class="meta-item"><i data-lucide="star"></i>${esc(r.grade_point)} grade points</span>
        ${term ? `<span class="meta-item"><i data-lucide="calendar-days"></i>${term}</span>` : ""}
      </div>
    </button>`;
  });
  html += `</div><p class="grid-hint">Tap a course for the full scorecard.</p>`;
  setHTML(box, html);

  box.querySelectorAll("[data-grade-idx]").forEach((el) =>
    el.addEventListener("click", () => openMarksDetail(rows[+el.dataset.gradeIdx])));
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
// Tolerant exam-date parsing for the calendar tile: ISO (2026-08-14),
// dd-mm-yyyy / dd/mm/yyyy, or anything Date.parse understands ("14 Aug 2026").
function examDateParts(s) {
  const str = String(s || "").trim();
  if (!str) return null;
  let d = null;
  let m = str.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) d = new Date(+m[1], +m[2] - 1, +m[3]);
  if (!d) {
    m = str.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/);
    if (m) {
      const yy = +m[3] < 100 ? 2000 + +m[3] : +m[3];
      d = new Date(yy, +m[2] - 1, +m[1]);
    }
  }
  if (!d) {
    const t = Date.parse(str);
    if (!Number.isNaN(t)) d = new Date(t);
  }
  if (!d || Number.isNaN(d.getTime())) return null;
  return { day: d.getDate(), mon: d.toLocaleString(undefined, { month: "short" }) };
}

function renderSeating() {
  const rows = state.seating || [];
  const box = $("#exams-content");
  if (rows.length === 0) {
    setHTML(box, emptyState("No exams scheduled", "Your seating plan will appear here before exams.", "armchair"));
    return;
  }
  let html = `<div class="card-grid">`;
  for (const r of rows) {
    const d = examDateParts(r.date);
    html += `<div class="card exam-card">
      <div class="exam-date">${d
        ? `<span class="exam-day">${d.day}</span><span class="exam-mon">${esc(d.mon)}</span>`
        : `<span class="exam-date-raw">${esc(r.date)}</span>`}</div>
      <div class="exam-info">
        <div class="exam-head">
          <span class="exam-code">${esc(r.course_code)}</span>
          <span class="chip-accent">${esc(r.exam_type)}</span>
        </div>
        <div class="meta-row">
          <span class="meta-item"><i data-lucide="clock"></i>${esc(r.time_slot)}</span>
          <span class="meta-item"><i data-lucide="door-open"></i>${esc(r.room_no)}</span>
        </div>
      </div>
    </div>`;
  }
  html += `</div>`;
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
