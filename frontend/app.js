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
  ttDay: null,          // selected day pill in the week view (defaults to today)
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

// One row per course COMPONENT (type = L/T/P/S), matching the real API shape;
// multiple rows share a course_code + course_name and get grouped in the UI.
const MOCK_ATTENDANCE = [
  { course_name: "Data Structures and Algorithms", course_code: "24CS2101", type: "L", section: "S-35", conducted: 30, attended: 28, absent: 2, percentage: "93.33", register_href: "mock" },
  { course_name: "Data Structures and Algorithms", course_code: "24CS2101", type: "P", section: "S-35", conducted: 12, attended: 11, absent: 1, percentage: "91.67", register_href: "mock" },
  { course_name: "Operating Systems", course_code: "24CS3102", type: "L", section: "S-35", conducted: 28, attended: 24, absent: 4, percentage: "85.71", register_href: "mock" },
  { course_name: "Operating Systems", course_code: "24CS3102", type: "T", section: "S-35", conducted: 12, attended: 11, absent: 1, percentage: "91.67", register_href: "mock" },
  { course_name: "Database Management Systems", course_code: "24CS2103", type: "L", section: "S-36", conducted: 26, attended: 21, absent: 5, percentage: "80.77", register_href: "mock" },
  { course_name: "Computer Networks", course_code: "24CS3104", type: "L", section: "S-35", conducted: 24, attended: 15, absent: 9, percentage: "62.50", register_href: "mock" },
  { course_name: "Computer Networks", course_code: "24CS3104", type: "P", section: "S-35", conducted: 12, attended: 9, absent: 3, percentage: "75.00", register_href: "mock" },
  { course_name: "Computer Networks", course_code: "24CS3104", type: "S", section: "S-35-B", conducted: 8, attended: 2, absent: 6, percentage: "25.00", register_href: "mock" },
  { course_name: "Professional Communication Skills", course_code: "24HS1101", type: "L", section: "S-37", conducted: 30, attended: 26, absent: 4, percentage: "86.67", register_href: "mock" },
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

// Day keys -> slot number -> raw ERP cell text. Identical text in consecutive
// slots exercises the merged-block logic (e.g. Mon slots 3-4 become one block).
const MOCK_TIMETABLE = {
  Mon: { 3: "24CS2101-L - S-35 -RoomNo-C618", 4: "24CS2101-L - S-35 -RoomNo-C618", 5: "24CS3102-L - S-35 -RoomNo-R209C", 7: "24CS3102-L - S-35 -RoomNo-R209C", 8: "24CS3181-P - S-35 -RoomNo-L615", 9: "24CS3181-P - S-35 -RoomNo-L615", 10: "24HS1101-L - S-35 -RoomNo-R404A", 11: "24HS1101-L - S-35 -RoomNo-R404A" },
  Tue: { 1: "24CS2103-L - S-36 -RoomNo-C505", 2: "24CS2103-L - S-36 -RoomNo-C505", 9: "24CS3104-L - S-35 -RoomNo-R310" },
  Wed: { 3: "24CS3104-L - S-35 -RoomNo-R310", 4: "24CS3104-L - S-35 -RoomNo-R310", 6: "24CS2101-L - S-35 -RoomNo-C618" },
  Thu: { 5: "24HS1101-L - S-35 -RoomNo-R404A", 7: "24CS2103-L - S-36 -RoomNo-C505", 8: "24CS2103-L - S-36 -RoomNo-C505" },
  Fri: { 3: "24CS3102-L - S-35 -RoomNo-R209C", 10: "24CS3181-P - S-35 -RoomNo-L615", 11: "24CS3181-P - S-35 -RoomNo-L615" },
  Sat: {},
  Sun: {},
};

function mockApiResponse(path) {
  if (path === "/fetch-attendance") return { success: true, attendance: MOCK_ATTENDANCE };
  if (path === "/fetch-cgpa") return { success: true, data: MOCK_GRADES };
  if (path === "/fetch-seating-plan") return { success: true, seating_plan: MOCK_SEATING };
  if (path === "/fetch-timetable") return { success: true, timetable: MOCK_TIMETABLE };
  if (path === "/fetch-register-detail") {
    return {
      success: true,
      metadata: { "Course": "Mock course", "Faculty": "Dr. Mock", "Section": "S-35" },
      daily_attendance: [
        { date_slot: "28-07-2026 (Slot 3)", status: "P" },
        { date_slot: "30-07-2026 (Slot 5)", status: "P" },
        { date_slot: "01-08-2026 (Slot 3)", status: "A" },
      ],
    };
  }
  if (path === "/fetch-marks-detail") {
    return { success: true, scorecard: { "Mid Sem": "28/30", "Quiz": "09/10", "End Sem": "55/70", "Total": "92/110", "Grade": "S" } };
  }
  return null; // everything else goes to the real backend
}

/* ---------- API ---------- */
function friendlyHttpError(res) {
  if (res.status === 401) return "Invalid username or password.";
  if (res.status === 403) return "Human verification failed. Please retry the checkbox.";
  if (res.status === 422) return "Something was off with that request. Please try again.";
  if (res.status === 500) return "Server hiccup on our side. Try again in a minute.";
  if (res.status === 503) return "The KL ERP portal is down or unreachable right now. Try again later.";
  return `Something went wrong (HTTP ${res.status}). Please try again.`;
}

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
    throw new Error("Can't reach the server. Check your internet and try again.");
  }

  if (res.status === 401) {
    clearSession();
    showLogin();
    toast("Session expired. Please sign in again.", "error");
    throw new Error("unauthorized");
  }
  if (res.status === 503) {
    toast("The KL ERP portal is down right now. Try again later.", "error");
    throw new Error("erp_down");
  }
  if (!res.ok) throw new Error(friendlyHttpError(res));

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
  // Eyebrow line: "TODAY · SUN, AUG 2" (CSS uppercases it)
  const now = new Date();
  const wd = now.toLocaleDateString(undefined, { weekday: "short" });
  const mon = now.toLocaleDateString(undefined, { month: "short" });
  $("#dash-date").textContent = `TODAY · ${wd}, ${mon} ${now.getDate()}`;
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
  // ERP names come surname-first ("Pothuru Deepthanush Chowdary") — the given
  // name is the longest token, so greet with that.
  const parts = String(full || "").trim().split(/\s+/).filter(Boolean);
  const pick = parts.reduce((a, b) => (b.length >= (a || "").length ? b : a), "");
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
    let res;
    try {
      res = await fetch(`${API_BASE}/login`, { method: "POST", body: fd });
    } catch {
      throw new Error("Can't reach the server. Check your internet and try again.");
    }
    if (!res.ok) throw new Error(friendlyHttpError(res));
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

// One day's classes as merged blocks: consecutive slots with identical raw text
// collapse into one block with a real time range (07:10 – 08:50 etc.).
function blocksForDay(dayKey) {
  const day = state.timetable ? state.timetable[dayKey] : null;
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

function todaysBlocks() { return blocksForDay(todayKey()); }

function slotLabel(b) {
  return b.startSlot === b.endSlot ? `Slot ${b.startSlot}` : `Slot ${b.startSlot}–${b.endSlot}`;
}

// Shared row markup (dashboard "today" list + week day view): big lime start
// time + dim end + slot label on the left, class details on the right.
function classRowHTML(b, isNow) {
  return `<div class="class-row${isNow ? " now" : ""}">
    <div class="cr-time">
      <span class="cr-start">${b.start}</span>
      <span class="cr-end">${b.end}</span>
      <span class="cr-slot">${slotLabel(b)}</span>
    </div>
    <div class="cr-info">
      <span class="cr-code">${esc(b.code)}</span>
      <span class="cr-meta">${esc(b.section)}${b.room ? " · Room " + esc(b.room) : ""}</span>
    </div>
    ${isNow ? `<span class="cr-now">Now</span>` : ""}
  </div>`;
}

function fmtDuration(mins) {
  const h = Math.floor(mins / 60), m = mins % 60;
  if (h > 0 && m > 0) return `${h}h ${m}m`;
  if (h > 0) return `${h}h`;
  return `${m}m`;
}

// Hero banner: current class (pulsing) / next class (with countdown) / all done
// for the day / nothing scheduled at all.
function classHero(blocks) {
  const mins = nowMinutes();
  for (const b of blocks) {
    const s = timeToMin(b.start), e = timeToMin(b.end);
    if (mins >= s && mins < e) {
      return `<div class="dash-hero now">
        <span class="hero-dot" aria-hidden="true"></span>
        <div class="hero-text">
          <span class="hero-eyebrow">In class now · ends ${b.end}</span>
          <span class="hero-title">${esc(b.code)}</span>
          <span class="hero-sub">${esc(b.section)}${b.room ? " · Room " + esc(b.room) : ""} · ${slotLabel(b)}</span>
        </div></div>`;
    }
    if (mins < s) {
      return `<div class="dash-hero next">
        <i data-lucide="clock"></i>
        <div class="hero-text">
          <span class="hero-eyebrow">Up next · in ${fmtDuration(s - mins)}</span>
          <span class="hero-title">${esc(b.code)} <span class="hero-at">${b.start}</span></span>
          <span class="hero-sub">${esc(b.section)}${b.room ? " · Room " + esc(b.room) : ""} · ${slotLabel(b)}</span>
        </div></div>`;
    }
  }
  if (blocks.length > 0) {
    return `<div class="dash-hero done">
      <i data-lucide="circle-check-big"></i>
      <div class="hero-text">
        <span class="hero-eyebrow">All done</span>
        <span class="hero-title">no more classes today.</span>
        <span class="hero-sub">All ${blocks.length} class${blocks.length === 1 ? "" : "es"} done — enjoy the rest of your day</span>
      </div></div>`;
  }
  return `<div class="dash-hero idle">
    <i data-lucide="coffee"></i>
    <div class="hero-text">
      <span class="hero-eyebrow">Nothing right now</span>
      <span class="hero-title">no ongoing class. enjoy the break.</span>
      <span class="hero-sub">No classes scheduled for today</span>
    </div></div>`;
}

function renderDashboard() {
  if (state.activeTab !== "dashboard") return;
  const box = $("#dashboard-content");
  if (state.attendance === null) { setHTML(box, skelCards(3)); return; }
  const pct = weightedAttendance(state.attendance);
  const blocks = todaysBlocks();
  const courseCount = new Set((state.attendance || []).map((r) => `${r.course_code}@@${r.course_name}`)).size;
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
    ${blocks.length === 0 ? "" : `<h3 class="section-title">Today's classes</h3>
    <div class="class-rows">${blocks.map((b) =>
      classRowHTML(b, mins >= timeToMin(b.start) && mins < timeToMin(b.end))
    ).join("")}</div>`}
  `);
}

/* ---------- Render: Timetable ---------- */
// Day-tab view: MON..SUN pills (active = lime, a tiny dot marks today) with the
// merged-block class rows for the selected day below. Defaults to today.
function renderTimetable() {
  const box = $("#timetable-content");
  const tt = state.timetable || {};
  const hasAny = DAY_KEYS.some((d) => tt[d] && Object.values(tt[d]).some((v) => v && v !== "-"));
  if (!hasAny) {
    setHTML(box, emptyState("No timetable data", "Nothing published for this term yet.", "calendar-days"));
    return;
  }
  const today = todayKey();
  const sel = DAY_KEYS.includes(state.ttDay) ? state.ttDay : today;
  state.ttDay = sel;
  const isToday = sel === today;
  const mins = nowMinutes();

  let html = `<div class="day-pills" role="tablist" aria-label="Day of week">` +
    DAY_KEYS.map((d) =>
      `<button type="button" role="tab" aria-selected="${d === sel}"
        class="day-pill${d === sel ? " active" : ""}${d === today ? " today" : ""}"
        data-tt-day="${d}">${d}</button>`
    ).join("") + `</div>`;

  const blocks = blocksForDay(sel);
  if (blocks.length === 0) {
    html += `<div class="day-empty">
      <div class="empty-title">no classes${sel === "Sun" ? " — happy sunday." : "."}</div>
      <div class="empty-sub">Nothing scheduled for ${sel}. Pick another day above.</div>
    </div>`;
  } else {
    html += `<div class="class-rows">` + blocks.map((b) =>
      classRowHTML(b, isToday && mins >= timeToMin(b.start) && mins < timeToMin(b.end))
    ).join("") + `</div>`;
  }
  html += `<p class="tt-note">Breaks 08:50–09:20 · 12:50–13:00 · 14:40–14:50 · 15:40–15:50</p>`;
  setHTML(box, html);
}

/* ---------- Render: Attendance ---------- */
// Component type chip letter: the API sends L/T/P/S etc. (older data may carry
// full words like "Theory"/"Practical") — either way the first letter is right.
function typeLetter(t) {
  const s = String(t || "").trim();
  return s ? s[0].toUpperCase() : "?";
}

// Bunk hint line: hours you must attend to reach 75%, or hours you can still
// miss (75% is the minimum, same thresholds as before).
function bunkHint(row) {
  const attended = num(row.attended), conducted = num(row.conducted);
  if (conducted === 0) return "";
  const pct = (attended / conducted) * 100;
  if (pct >= 75) {
    const n = Math.floor(attended / 0.75 - conducted);
    return `<span class="cmp-hint ok">can miss <b>${n}</b> hr${n === 1 ? "" : "s"}</span>`;
  }
  const n = Math.ceil((0.75 * conducted - attended) / 0.25);
  return `<span class="cmp-hint warn">attend <b>${n}</b> hr${n === 1 ? "" : "s"} for 75%</span>`;
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

  // Group component rows (L/T/P/S) into one card per course.
  const groups = [];
  const byKey = new Map();
  for (const r of rows) {
    const key = `${r.course_code}@@${r.course_name}`;
    let g = byKey.get(key);
    if (!g) {
      g = { code: r.course_code, name: r.course_name, rows: [], attended: 0, conducted: 0 };
      byKey.set(key, g);
      groups.push(g);
    }
    g.rows.push(r);
    g.attended += num(r.attended);
    g.conducted += num(r.conducted);
  }
  for (const g of groups) g.pct = g.conducted > 0 ? (g.attended / g.conducted) * 100 : null;

  const pct = weightedAttendance(rows);
  let attended = 0, conducted = 0;
  for (const r of rows) { attended += num(r.attended); conducted += num(r.conducted); }

  setHTML(sumBox, `
    <div class="sum-banner ${pctClass(pct)}">
      <div class="sum-banner-meta">
        <div class="sum-banner-eyebrow">Overall · weighted</div>
        <div class="sum-banner-sub">${attended}/${conducted} hrs · ${groups.length} course${groups.length === 1 ? "" : "s"} · ${rows.length} component${rows.length === 1 ? "" : "s"}</div>
      </div>
      <div class="sum-banner-pct">${pct == null ? "—" : Math.round(pct) + "%"}</div>
    </div>`);

  const safe = groups.filter((g) => g.pct != null && g.pct >= 75).length;
  let html = `<div class="att-strip">
      <span class="strip-chip ok"><i data-lucide="shield-check"></i>${safe} safe</span>
      <span class="strip-chip warn"><i data-lucide="shield-alert"></i>${groups.length - safe} at risk</span>
    </div>`;

  groups.forEach((g, gi) => {
    const letters = [...new Set(g.rows.map((r) => typeLetter(r.type)))].join("/");
    html += `<div class="course-card">
      <div class="course-head">
        <div class="course-code">${esc(g.code)}</div>
        <div class="course-name">${esc(g.name || g.code)}</div>
      </div>
      <div class="course-overall">
        <div class="co-left">
          <span class="co-eyebrow">Overall</span>
          <span class="co-sub">Weighted (${esc(letters)}) · ${g.rows.length} component${g.rows.length === 1 ? "" : "s"}</span>
        </div>
        <span class="co-pct ${pctClass(g.pct)}">${g.pct == null ? "—" : Math.round(g.pct) + "%"}</span>
      </div>
      <div class="cmp-list">` + g.rows.map((r, ri) => {
        const p = num(r.percentage);
        return `<button type="button" class="cmp-row" data-att-course="${gi}" data-att-row="${ri}">
          <span class="cmp-chip">${esc(typeLetter(r.type))}</span>
          <span class="cmp-sec">${esc(r.section || "—")}</span>
          <span class="cmp-nums">
            <span class="cmp-pct ${pctClass(p)}">${Math.round(p)}% <span class="cmp-exact">(${esc(r.percentage)}%)</span></span>
            <span class="cmp-frac">${esc(r.attended)}/${esc(r.conducted)} · ${esc(r.absent)} absent</span>
            ${bunkHint(r)}
          </span>
        </button>`;
      }).join("") + `</div>
    </div>`;
  });
  html += `<p class="grid-hint">Tap a component for day-by-day details.</p>`;
  setHTML(box, html);

  box.querySelectorAll("[data-att-row]").forEach((el) =>
    el.addEventListener("click", () => {
      const g = groups[+el.dataset.attCourse];
      openRegisterDetail(g.rows[+el.dataset.attRow]);
    }));
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
    <div class="cgpa-hero">
      <span class="cgpa-chip">CGPA</span>
      <div class="cgpa-num">${cgpa.toFixed(2)}</div>
      <div class="cgpa-sub">all semesters · credit-weighted</div>
      <div class="cgpa-meta">${cr} credits · ${rows.length} course${rows.length === 1 ? "" : "s"}</div>
    </div>`);

  let html = `<div class="grade-list">`;
  rows.forEach((r, i) => {
    const term = [r.academic_year, r.semester].filter(Boolean).map(esc).join(" · ");
    const failed = String(r.grade || "").trim().toUpperCase() === "F";
    html += `<button type="button" class="card-btn grade-card" data-grade-idx="${i}">
      <div class="gc-code">${esc(r.course_code)}</div>
      <div class="gc-name">${esc(r.course_name || r.course_code)}</div>
      <div class="gc-strip">
        <div class="gc-cell"><span class="gc-label">Grade</span><span class="gc-val${failed ? " bad" : " accent"}">${esc(r.grade)}</span></div>
        <div class="gc-cell"><span class="gc-label">GP</span><span class="gc-val">${esc(r.grade_point)}</span></div>
        <div class="gc-cell"><span class="gc-label">Credits</span><span class="gc-val">${esc(r.credits)}</span></div>
        <div class="gc-cell"><span class="gc-label">Status</span><span class="gc-val${failed ? " bad" : ""}">${failed ? "F" : "P"}</span></div>
      </div>
      <div class="gc-foot">
        <span class="gc-term">${term}</span>
        <span class="gc-more">More details</span>
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

// Day pills in the week view (rendered into #timetable-content)
$("#timetable-content").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-tt-day]");
  if (!btn) return;
  state.ttDay = btn.dataset.ttDay;
  renderTimetable();
});

/* ---------- Init ---------- */
loadStored();
if (state.creds && state.cookies) {
  showApp();
} else {
  showLogin();
}
refreshIcons(); // static placeholders (nav, buttons) on first paint
