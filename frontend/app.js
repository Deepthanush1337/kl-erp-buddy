/* ============ KL ERP Buddy — app logic ============ */
/* global API_BASE, TURNSTILE_SITE_KEY */

"use strict";

/* ---------- Storage keys ---------- */
const LS_COOKIES = "kl_erp_cookies";
const LS_CREDS = "kl_erp_creds";
const LS_PROFILE = "kl_erp_profile";
const LS_TOKEN = "kl_erp_token";
const LS_AI_HISTORY = "kl_erp_ai_history";
const LS_PREFS = "kl_erp_prefs";
const LS_TRACK_DISMISSED = "kl_erp_track_dismissed";

/* ---------- State ---------- */
const state = {
  creds: null,          // {username, password}
  cookies: null,        // {PHPSESSID, kl_erp_device_id, SERVERID, _csrf_token, _csrf}
  profile: null,        // {name, roll_no, department} from /login or /fetch-profile
  appToken: null,       // HMAC-signed data-API token from /login (x-app-token header)
  courses: {},          // course code -> {t: full title, a: acronym} from courses.json
  timetable: null,      // raw timetable object
  attendance: null,     // array
  grades: null,         // array
  seating: null,        // array
  ttKey: null,          // "yearCode-semId" of loaded timetable
  attKey: null,
  ttValidatedKey: null, // SWR: key already revalidated this session
  attValidatedKey: null,
  gradesValidated: false,
  seatingValidated: false,
  ttDay: null,          // selected day pill in the week view (defaults to today)
  activeTab: "dashboard",
  planTasks: null,      // tasks rows (backend data API) or mock
  planBlocks: null,     // study_blocks rows
  planGoals: null,      // goals rows
  planDay: null,        // selected day in the plan view (ISO date, defaults to today)
  planLoaded: false,    // plan data fetched at least once
  taskPriority: 1,      // selected priority in the add-task form (0/1/2)
  aiStatus: null,       // null = unchecked, "on", "off"
  aiSending: false,
  aiHistory: [],        // [{role: "user"|"assistant"|"error", content}] — capped at 20
  prefs: null,          // {goal, interests, weekly_hours, onboarded} — backend prefs row / LS cache
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
// Direct children of the main content boxes also get a staggered fade-and-rise
// entrance (.rise + incremental delay). Skeletons are skipped so their shimmer
// keeps sweeping; the whole effect is off under prefers-reduced-motion.
const STAGGER_BOXES = new Set([
  "dashboard-content", "timetable-content", "attendance-summary", "attendance-content",
  "plan-content", "grades-summary", "grades-content", "exams-content", "ai-content",
]);
const REDUCE_MOTION = typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function setHTML(target, html) {
  const el = typeof target === "string" ? $(target) : target;
  el.innerHTML = html;
  refreshIcons();
  if (!REDUCE_MOTION && el.id && STAGGER_BOXES.has(el.id)) {
    let i = 0;
    for (const child of el.children) {
      if (child.classList.contains("skeleton")) continue;
      child.classList.add("rise");
      child.style.animationDelay = `${Math.min(i, 8) * 45}ms`;
      i++;
    }
  }
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
function saveToken(t) { state.appToken = t; try { localStorage.setItem(LS_TOKEN, t); } catch { /* private mode — memory only */ } }
function loadStored() {
  try {
    state.creds = JSON.parse(localStorage.getItem(LS_CREDS) || "null");
    state.cookies = JSON.parse(localStorage.getItem(LS_COOKIES) || "null");
    state.profile = JSON.parse(localStorage.getItem(LS_PROFILE) || "null");
  } catch { state.creds = null; state.cookies = null; state.profile = null; }
  state.appToken = localStorage.getItem(LS_TOKEN) || null;
}
function clearSession() {
  localStorage.removeItem(LS_CREDS);
  localStorage.removeItem(LS_COOKIES);
  localStorage.removeItem(LS_PROFILE);
  localStorage.removeItem(LS_TOKEN);
  clearDataCaches();
  state.creds = null; state.cookies = null; state.profile = null;
  state.appToken = null;
  state.timetable = null; state.attendance = null;
  state.grades = null; state.seating = null;
  state.ttKey = null; state.attKey = null;
  state.ttValidatedKey = null; state.attValidatedKey = null;
  state.gradesValidated = false; state.seatingValidated = false;
  state.planTasks = null; state.planBlocks = null; state.planGoals = null;
  state.planDay = null; state.planLoaded = false;
  state.aiStatus = null; state.aiSending = false;
  state.aiHistory = []; // stored histories stay on disk — other accounts keep theirs
}

/* ---------- SWR data cache (stale-while-revalidate) ---------- */
// Per-dataset localStorage snapshots so returning visits paint instantly.
// Entry shape: {k: scope key ("year-sem" for timetable/attendance, "" for
// grades/seating), t: write time (ms epoch), d: payload}. Loaders render a
// cache hit immediately, then revalidate in the background and re-render only
// when the fresh payload differs (JSON compare).
function cacheRead(name, key) {
  try {
    const e = JSON.parse(localStorage.getItem("kl_erp_cache_" + name) || "null");
    if (!e || typeof e !== "object" || e.d == null) return null;
    if (key != null && e.k !== key) return null;
    return e;
  } catch { return null; }
}

function cacheWrite(name, key, data) {
  try {
    localStorage.setItem("kl_erp_cache_" + name, JSON.stringify({ k: key, t: Date.now(), d: data }));
  } catch { /* storage full — caching is best-effort */ }
}

function clearDataCaches() {
  for (const n of ["timetable", "attendance", "grades", "seating"]) {
    localStorage.removeItem("kl_erp_cache_" + n);
  }
}

// Tiny dim "updated HH:MM" label next to the refresh buttons.
function stampShow(name, ts) {
  const el = document.getElementById("stamp-" + name);
  if (!el) return;
  const d = new Date(ts);
  el.textContent = `updated ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  el.classList.remove("hidden");
}

// In-flight request dedupe: the dashboard and the individual tabs boot
// together and would otherwise fire the same request twice.
const inFlight = Object.create(null);
function dedup(name, fn) {
  if (inFlight[name]) return inFlight[name];
  const p = Promise.resolve().then(fn).then(
    (v) => { delete inFlight[name]; return v; },
    (e) => { delete inFlight[name]; throw e; },
  );
  inFlight[name] = p;
  return p;
}

/* ---------- Mock data (visual testing) ---------- */
// Append ?mock=1 to the URL to render realistic fake rows. Inactive otherwise;
// login and the detail endpoints always hit the real backend. In mock mode the
// Plan tab uses canned tasks/blocks/goals (the data API is never touched) and the
// AI tab replies with a canned message (no /ai/chat call).
const MOCK_MODE = new URLSearchParams(location.search).has("mock");

// One row per course COMPONENT (type = L/T/P/S), matching the real API shape;
// multiple rows share a course_code + course_name and get grouped in the UI.
// Codes are real entries from courses.json so course titles resolve in mock mode.
const MOCK_ATTENDANCE = [
  { course_name: "Data Structures & Algorithms – 1", course_code: "26SC1203", type: "L", section: "S-35", conducted: 30, attended: 28, absent: 2, percentage: "93.33", register_href: "mock" },
  { course_name: "Data Structures & Algorithms – 1", course_code: "26SC1203", type: "P", section: "S-35", conducted: 12, attended: 11, absent: 1, percentage: "91.67", register_href: "mock" },
  { course_name: "Operating Systems & Systems Programming", course_code: "26CS2101", type: "L", section: "S-35", conducted: 28, attended: 24, absent: 4, percentage: "85.71", register_href: "mock" },
  { course_name: "Operating Systems & Systems Programming", course_code: "26CS2101", type: "T", section: "S-35", conducted: 12, attended: 11, absent: 1, percentage: "91.67", register_href: "mock" },
  { course_name: "Full Stack Development – Database Systems & Back End", course_code: "26SC1307", type: "L", section: "S-36", conducted: 26, attended: 21, absent: 5, percentage: "80.77", register_href: "mock" },
  { course_name: "Computer Networks & Network Programming", course_code: "26CS2203", type: "L", section: "S-35", conducted: 24, attended: 15, absent: 9, percentage: "62.50", register_href: "mock" },
  { course_name: "Computer Networks & Network Programming", course_code: "26CS2203", type: "P", section: "S-35", conducted: 12, attended: 9, absent: 3, percentage: "75.00", register_href: "mock" },
  { course_name: "Computer Networks & Network Programming", course_code: "26CS2203", type: "S", section: "S-35-B", conducted: 8, attended: 2, absent: 6, percentage: "25.00", register_href: "mock" },
  { course_name: "Communication Skills for Engineers", course_code: "26UC1204", type: "L", section: "S-37", conducted: 30, attended: 26, absent: 4, percentage: "86.67", register_href: "mock" },
];

const MOCK_GRADES = [
  { course_name: "Mathematics for Computation", course_code: "26MT1101", academic_year: "2026-27", semester: "Odd", credits: 4, grade: "O", grade_point: 10, target_href: "mock" },
  { course_name: "Problem Solving Using Programming (Java)", course_code: "26SC1101", academic_year: "2026-27", semester: "Odd", credits: 4, grade: "S", grade_point: 9, target_href: "mock" },
  { course_name: "Digital Design & Computer Architecture", course_code: "26EC1202", academic_year: "2026-27", semester: "Odd", credits: 3, grade: "A", grade_point: 8, target_href: "mock" },
  { course_name: "Fundamentals of IoT & Sensors", course_code: "26EC1101", academic_year: "2026-27", semester: "Odd", credits: 3, grade: "B", grade_point: 7, target_href: "mock" },
  { course_name: "Ecology & Environment", course_code: "26UC0009", academic_year: "2026-27", semester: "Even", credits: 2, grade: "C", grade_point: 6, target_href: "mock" },
  { course_name: "Mechanical Engineering Workshop", course_code: "26ME1101", academic_year: "2026-27", semester: "Even", credits: 2, grade: "A", grade_point: 8, target_href: "mock" },
];

const MOCK_SEATING = [
  { date: "12-08-2026", course_code: "26SC1203", university_id: "2600031735", exam_type: "Mid Semester", time_slot: "09:00 - 11:00", room_no: "S708" },
  { date: "14-08-2026", course_code: "26CS2101", university_id: "2600031735", exam_type: "Mid Semester", time_slot: "13:00 - 15:00", room_no: "R412" },
  { date: "18-08-2026", course_code: "26SC1307", university_id: "2600031735", exam_type: "Quiz", time_slot: "09:00 - 10:00", room_no: "C305" },
];

// Day keys -> slot number -> raw ERP cell text. Identical text in consecutive
// slots exercises the merged-block logic (e.g. Mon slots 3-4 become one block).
const MOCK_TIMETABLE = {
  Mon: { 3: "26SC1203-L - S-35 -RoomNo-C618", 4: "26SC1203-L - S-35 -RoomNo-C618", 5: "26CS2101-L - S-35 -RoomNo-R209C", 7: "26CS2101-L - S-35 -RoomNo-R209C", 8: "26SC1203-P - S-35 -RoomNo-L615", 9: "26SC1203-P - S-35 -RoomNo-L615", 10: "26UC1204-L - S-35 -RoomNo-R404A", 11: "26UC1204-L - S-35 -RoomNo-R404A" },
  Tue: { 1: "26SC1307-L - S-36 -RoomNo-C505", 2: "26SC1307-L - S-36 -RoomNo-C505", 9: "26CS2203-L - S-35 -RoomNo-R310" },
  Wed: { 3: "26CS2203-L - S-35 -RoomNo-R310", 4: "26CS2203-L - S-35 -RoomNo-R310", 6: "26SC1203-L - S-35 -RoomNo-C618" },
  Thu: { 5: "26UC1204-L - S-35 -RoomNo-R404A", 7: "26SC1307-L - S-36 -RoomNo-C505", 8: "26SC1307-L - S-36 -RoomNo-C505" },
  Fri: { 3: "26CS2101-L - S-35 -RoomNo-R209C", 10: "26SC1203-P - S-35 -RoomNo-L615", 11: "26SC1203-P - S-35 -RoomNo-L615" },
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

// Plan tab canned rows — dates are generated relative to today so the
// overdue/today/upcoming groups always have something to show.
function mockPlanData() {
  return {
    tasks: [
      { id: "mock-t1", title: "DSA assignment 4 — graph traversals", course: "26SC1203", due_date: shiftISO(-1), priority: 2, done: false },
      { id: "mock-t2", title: "OS lab record submission", course: "26CS2101", due_date: shiftISO(0), priority: 1, done: false },
      { id: "mock-t3", title: "CN quiz prep — subnetting", course: "26CS2203", due_date: shiftISO(3), priority: 0, done: false },
      { id: "mock-t4", title: "Print DBMS notes", course: "26SC1307", due_date: shiftISO(-2), priority: 0, done: true },
    ],
    blocks: [
      { id: "mock-b1", course: "26SC1203", day: shiftISO(0), start_time: "18:00", end_time: "19:30", note: "Graph problem set", done: false },
      { id: "mock-b2", course: "26CS2203", day: shiftISO(0), start_time: "20:00", end_time: "21:00", note: "Subnetting drills", done: true },
      { id: "mock-b3", course: "26CS2101", day: shiftISO(1), start_time: "17:30", end_time: "18:30", note: "Lab record", done: false },
    ],
    goals: [
      { course: "26SC1203", weekly_hours: 5 },
      { course: "26CS2203", weekly_hours: 3 },
    ],
  };
}

const MOCK_AI_REPLY = "Here's a plan for today (mock):\n\n• 12:00–13:00 — DSA graph problems\n• 17:30–19:00 — OS lab record (due today)\n• 20:00–21:00 — CN subnetting revision\n\nHeads-up: CN attendance is 62.5% — don't miss the next class.";

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

// JSON helper for the per-account data store (/data/tasks, /data/study_blocks,
// /data/goals, /data/prefs). Auth is the app token from /login (x-app-token
// header) — rows are scoped to the roll number server-side, so there is no
// owner field to send. Same error mapping as api(). Mock-mode callers bypass
// this entirely, exactly like they bypassed direct planner storage before.
async function dataApi(table, { method = "GET", id, body } = {}) {
  let res;
  try {
    res = await fetch(`${API_BASE}/data/${table}${id ? `/${id}` : ""}`, {
      method,
      headers: { "Content-Type": "application/json", "x-app-token": state.appToken || "" },
      body: body == null ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new Error("Can't reach the server. Check your internet and try again.");
  }

  if (res.status === 401) {
    clearSession();
    showLogin();
    toast("Session expired. Please sign in again.", "error");
    throw new Error("unauthorized");
  }
  if (!res.ok) throw new Error(friendlyHttpError(res));

  const data = await res.json();
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

/* ---------- Course catalog (courses.json) ---------- */
// Map of KL course code -> {t: full title, a: acronym} covering the 2026 batch
// catalog. Fetched once at startup; a missing/failed fetch leaves an empty map
// and the app simply keeps showing raw codes.
async function loadCourses() {
  try {
    const res = await fetch("courses.json");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    state.courses = data && typeof data === "object" && !Array.isArray(data) ? data : {};
  } catch { state.courses = {}; }
}

// Slot codes carry a component suffix ("26UC1137-P") — strip it (same rule as
// knownCourses) and look the base code up in the catalog.
// Returns {title, acronym, base} or null when the code is unknown.
function courseInfo(code) {
  const raw = String(code || "").trim();
  if (!raw) return null;
  const base = raw.replace(/-[A-Za-z]$/, "");
  const hit = state.courses[base];
  if (!hit || !hit.t) return null;
  return { title: String(hit.t), acronym: String(hit.a || ""), base };
}

// "26UC1137 (Design Thinking for Innovation & Entrepreneurship)" — AI context.
function courseLabel(code) {
  const ci = courseInfo(code);
  return ci ? `${ci.base} (${ci.title})` : String(code || "");
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

function minToTime(mins) {
  return `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;
}

// Local-date ISO strings ("2026-08-03") — never toISOString (that would be UTC).
function dateISO(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function todayISO() { return dateISO(new Date()); }
function shiftISO(n) { const d = new Date(); d.setDate(d.getDate() + n); return dateISO(d); }

// Postgres time columns come back as "13:00:00" — keep HH:MM only.
function hhmm(t) { return String(t || "").slice(0, 5); }

/* ---------- Prefs & onboarding (backend prefs table) ---------- */
// One prefs row per account (roll number): goal, interests (comma string),
// weekly_hours target, onboarded flag. Cached in localStorage after a
// finish/skip or a remote hit so the app never refetches on every boot.
function cachePrefs(p) {
  state.prefs = p;
  try { localStorage.setItem(LS_PREFS, JSON.stringify(p)); } catch { /* full — keep in memory */ }
}

function readCachedPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem(LS_PREFS) || "null");
    return p && typeof p === "object" && typeof p.onboarded === "boolean" ? p : null;
  } catch { return null; }
}

// Entry point from showApp(): decides whether the one-time onboarding overlay
// opens. Never blocks the app — any network trouble skips it for this session.
async function initOnboarding() {
  const cached = readCachedPrefs();
  if (cached) {
    state.prefs = cached;
    if (cached.onboarded) { renderDashboard(); return; }
    openOnboarding();
    return;
  }
  if (MOCK_MODE) { openOnboarding(); return; }  // planner storage is never touched in mock mode
  // A session restored from before token auth is still minting its app token —
  // wait for it, but treat failure like any other network trouble and skip.
  if (!state.appToken) await ensureProfile();
  if (!state.appToken) return;
  try {
    const data = await dataApi("prefs");
    const row = (data.rows || [])[0];
    if (row && row.onboarded) {
      cachePrefs({
        goal: row.goal || "",
        interests: row.interests || "",
        weekly_hours: row.weekly_hours == null ? null : num(row.weekly_hours),
        onboarded: true,
      });
      renderDashboard();
    } else {
      openOnboarding();
    }
  } catch { /* server unreachable — skip onboarding this session */ }
}

async function upsertPrefs(p) {
  if (MOCK_MODE) return;
  await dataApi("prefs", {
    method: "POST",
    body: { goal: p.goal, interests: p.interests, weekly_hours: p.weekly_hours, onboarded: p.onboarded },
  });
}

const ONB_GOALS = [
  { id: "Product placements (SDE)", icon: "code-xml", blurb: "Crack SDE interviews — DSA, projects, referrals." },
  { id: "Higher studies (GATE·MS)", icon: "graduation-cap", blurb: "GATE or MS abroad — strong fundamentals first." },
  { id: "Startup", icon: "rocket", blurb: "Build and ship your own thing while in college." },
  { id: "Govt & core jobs", icon: "landmark", blurb: "PSUs, govt exams and core engineering roles." },
  { id: "Just survive sem", icon: "life-buoy", blurb: "Pass everything and keep attendance above 75%." },
];
const ONB_EXTRA_LANES = ["Web dev", "AI/ML", "Design", "Open source", "Competitive programming"];

// Interest lanes derived from the student's actual courses (ERP course names +
// courses.json titles), keyword-mapped to broader areas.
function courseLanes() {
  const lanes = [];
  const add = (l) => { if (!lanes.includes(l)) lanes.push(l); };
  for (const [code, name] of knownCourses()) {
    const ci = courseInfo(code);
    const t = `${name || ""} ${ci ? ci.title : ""}`.toLowerCase();
    if (/data struct|algorithm/.test(t)) add("Algorithms & problem solving");
    if (/java/.test(t)) add("Java dev");
    if (/python/.test(t)) add("Python dev");
    if (/math|calculus|algebra|probability|statistics/.test(t)) add("Math & theory");
    if (/operating system/.test(t)) add("Systems & OS");
    if (/network/.test(t)) add("Computer networks");
    if (/database|dbms|sql/.test(t)) add("Databases");
    if (/machine learning|artificial intelligence/.test(t)) add("AI/ML");
    if (/web|full ?stack/.test(t)) add("Web dev");
    if (/design/.test(t)) add("Design");
    if (/iot|embedded|sensor/.test(t)) add("IoT & embedded");
    if (/communication|soft skill/.test(t)) add("Communication skills");
  }
  return lanes;
}

// Weekly free hours estimated from timetable gaps (same rule as the plan tab:
// gaps between merged blocks + after the last class until 21:00, >= 20 min).
// Days with no classes contribute nothing — a conservative estimate.
function weeklyFreeHours() {
  if (!state.timetable) return null;
  let mins = 0;
  for (const d of DAY_KEYS) mins += freeSlotsForBlocks(blocksForDay(d)).reduce((s, g) => s + g.mins, 0);
  return mins / 60;
}

const onb = { step: 1, goal: "", lanes: [], hours: 8 };

function openOnboarding() {
  const p = state.prefs || {};
  onb.step = 1;
  onb.goal = p.goal || "";
  onb.lanes = String(p.interests || "").split(",").map((s) => s.trim()).filter(Boolean);
  const free = weeklyFreeHours();
  const def = free ? Math.min(10, Math.max(2, Math.round(free / 2))) : 8;
  onb.hours = Math.min(20, Math.max(2, num(p.weekly_hours) || def));
  $("#onboarding-overlay").classList.remove("hidden");
  document.body.style.overflow = "hidden";
  renderOnboarding();
}

function closeOnboarding() {
  $("#onboarding-overlay").classList.add("hidden");
  document.body.style.overflow = "";
}

function renderOnboarding() {
  $("#onb-dots").innerHTML = [1, 2, 3].map((i) =>
    `<span class="onb-dot${i === onb.step ? " active" : i < onb.step ? " done" : ""}"></span>`).join("");
  let body = "";
  if (onb.step === 1) {
    body = `<h2 class="onb-title">what's the goal<span class="pdot">?</span></h2>
      <p class="onb-sub">Plans, nudges and the AI copilot tune themselves around this.</p>
      <div class="onb-goals">` + ONB_GOALS.map((g) => `
        <button type="button" class="onb-goal${onb.goal === g.id ? " active" : ""}" data-onb-goal="${esc(g.id)}">
          <i data-lucide="${esc(g.icon)}"></i>
          <span class="onb-goal-text">
            <span class="onb-goal-name">${esc(g.id)}</span>
            <span class="onb-goal-blurb">${esc(g.blurb)}</span>
          </span>
        </button>`).join("") + `</div>`;
  } else if (onb.step === 2) {
    const derived = courseLanes();
    const lanes = [...derived, ...ONB_EXTRA_LANES.filter((l) => !derived.includes(l))];
    body = `<h2 class="onb-title">pick your lanes<span class="pdot">.</span></h2>
      <p class="onb-sub">Built from your current courses, plus a few extras. Pick at least one.</p>
      <div class="onb-chips">` + lanes.map((l) => `
        <button type="button" class="onb-chip${onb.lanes.includes(l) ? " active" : ""}" data-onb-lane="${esc(l)}" aria-pressed="${onb.lanes.includes(l)}">${esc(l)}</button>`).join("") + `</div>`;
  } else {
    const free = weeklyFreeHours();
    body = `<h2 class="onb-title">weekly hours<span class="pdot">.</span></h2>
      <p class="onb-sub">How many focused study hours can you give outside class?</p>
      <div class="onb-hours"><span class="onb-hours-num" id="onb-hours-num">${onb.hours}</span><span class="onb-hours-unit">hrs / week</span></div>
      <input type="range" id="onb-range" class="onb-range" min="2" max="20" step="1" value="${onb.hours}" aria-label="Weekly study hours target" />
      ${free ? `<p class="onb-hint">from my free slots · ~${free.toFixed(1)}h free between and after classes each week</p>` : ""}`;
  }
  body += `<div class="onb-foot">
      <div class="onb-foot-left">
        ${onb.step > 1 ? `<button type="button" class="btn btn-ghost" data-onb-back><i data-lucide="arrow-left"></i>Back</button>` : ""}
        <button type="button" class="btn btn-ghost" data-onb-skip>skip for now</button>
      </div>
      ${onb.step < 3
        ? `<button type="button" class="btn btn-primary" data-onb-next${onb.step === 1 && !onb.goal ? " disabled" : ""}${onb.step === 2 && onb.lanes.length === 0 ? " disabled" : ""}>Next<i data-lucide="arrow-right"></i></button>`
        : `<button type="button" class="btn btn-primary" data-onb-finish><i data-lucide="check"></i>Finish</button>`}
    </div>`;
  setHTML("#onb-body", body);
}

$("#onboarding-overlay").addEventListener("click", (e) => {
  const goalBtn = e.target.closest("[data-onb-goal]");
  if (goalBtn) { onb.goal = goalBtn.dataset.onbGoal; renderOnboarding(); return; }
  const laneBtn = e.target.closest("[data-onb-lane]");
  if (laneBtn) {
    const l = laneBtn.dataset.onbLane;
    onb.lanes = onb.lanes.includes(l) ? onb.lanes.filter((x) => x !== l) : [...onb.lanes, l];
    renderOnboarding();
    return;
  }
  if (e.target.closest("[data-onb-back]")) { onb.step = Math.max(1, onb.step - 1); renderOnboarding(); return; }
  if (e.target.closest("[data-onb-next]")) {
    if (onb.step === 1 && !onb.goal) return;
    if (onb.step === 2 && onb.lanes.length === 0) return;
    onb.step = Math.min(3, onb.step + 1);
    renderOnboarding();
    return;
  }
  if (e.target.closest("[data-onb-skip]")) { skipOnboarding(); return; }
  if (e.target.closest("[data-onb-finish]")) { finishOnboarding(); }
});

$("#onboarding-overlay").addEventListener("input", (e) => {
  if (e.target.id !== "onb-range") return;
  onb.hours = +e.target.value || 2;
  const numEl = document.getElementById("onb-hours-num");
  if (numEl) numEl.textContent = String(onb.hours);
});

async function finishOnboarding() {
  const p = { goal: onb.goal, interests: onb.lanes.join(", "), weekly_hours: onb.hours, onboarded: true };
  cachePrefs(p);
  closeOnboarding();
  try {
    await upsertPrefs(p);
    toast("Setup done — your copilot is personalized", "success");
  } catch {
    toast("Saved on this device — will sync when the connection is back.", "info");
  }
  renderDashboard();
}

function skipOnboarding() {
  const p = { goal: "", interests: "", weekly_hours: null, onboarded: true };
  cachePrefs(p);
  closeOnboarding();
  upsertPrefs(p).catch(() => { /* stays local — user can redo via the AI tab */ });
  toast("Skipped — personalize anytime from the AI tab.", "info");
  renderDashboard();
}

/* ---------- Dashboard "your track." card ---------- */
// Dismissal is keyed to the prefs content, so the card resurfaces when the
// user re-personalizes (the signature changes).
function trackSig(p) { return `${p.goal}|${p.interests}|${p.weekly_hours}`; }

// Rule-based focus chips from goal + current courses + attendance risk.
function trackChips(p) {
  const chips = [];
  const add = (c) => { if (chips.length < 3 && !chips.includes(c)) chips.push(c); };
  const titles = knownCourses().map(([code, name]) => {
    const ci = courseInfo(code);
    return `${name || ""} ${ci ? ci.title : ""}`.toLowerCase();
  });
  const has = (re) => titles.some((t) => re.test(t));
  const goal = String(p.goal || "").toLowerCase();
  // Goal-specific, course-derived chips first…
  if (goal.includes("placement")) {
    if (has(/data struct|algorithm/)) add("DSA grind");
    if (has(/java|python|full ?stack|web/)) add("Build projects");
  } else if (goal.includes("higher studies")) {
    if (has(/math/)) add("Math fundamentals");
    if (has(/data struct|algorithm/)) add("DSA for GATE");
  } else if (goal.includes("startup")) {
    add("Ship a side project");
    if (has(/full ?stack|web/)) add("Full-stack reps");
  } else if (goal.includes("govt") || goal.includes("core")) {
    if (has(/math/)) add("Aptitude & math");
    add("Core notes revision");
  }
  // …then any course under 80% attendance…
  for (const g of attendanceGroups()) {
    if (g.pct != null && g.pct < 80) {
      const ci = courseInfo(g.code);
      add(`Fix ${ci && ci.acronym ? ci.acronym : g.code} attendance`);
    }
  }
  // …then generic fillers for the goal.
  if (goal.includes("placement")) add("Aptitude & DSA reps");
  else if (goal.includes("higher studies")) add("PYQ practice");
  else if (goal.includes("startup")) add("Build in public");
  else if (goal.includes("govt") || goal.includes("core")) add("PYQ practice");
  else add("Stay ahead of deadlines");
  add("Weekly revision block");
  return chips.slice(0, 3);
}

function trackCardHTML() {
  const p = state.prefs;
  if (!p || !p.onboarded || !p.goal) return "";
  try { if (localStorage.getItem(LS_TRACK_DISMISSED) === trackSig(p)) return ""; } catch { /* private mode */ }
  return `<div class="track-card">
    <button type="button" class="btn-icon track-dismiss" data-track-dismiss aria-label="Dismiss"><i data-lucide="x"></i></button>
    <span class="hero-eyebrow">your track</span>
    <div class="track-title">${esc(p.goal)}</div>
    <div class="track-chips">${trackChips(p).map((c) => `<span class="track-chip">${esc(c)}</span>`).join("")}</div>
    <button type="button" class="track-ai-link" data-track-roadmap>ask ai to build your roadmap &rarr;</button>
  </div>`;
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
  loadAiHistory(); // restore this account's chat log (login + session restore)
  // Eyebrow line: "TODAY · SUN, AUG 2" (CSS uppercases it)
  const now = new Date();
  const wd = now.toLocaleDateString(undefined, { weekday: "short" });
  const mon = now.toLocaleDateString(undefined, { month: "short" });
  $("#dash-date").textContent = `TODAY · ${wd}, ${mon} ${now.getDate()}`;
  hydrateFromCache(); // paint cached snapshots before any network round-trip
  ensureProfile();
  switchTab("dashboard");
  loadDashboard();
  loadTimetable();
  initOnboarding();
  scheduleIdlePrefetch();
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
  renderAvatar();
  renderDrawerProfile();
}

/* ---------- Avatar & drawer ---------- */
// Two-letter uppercase initials for the lime fallback tile.
function initials(name) {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  const first = parts[0][0];
  const last = parts.length > 1 ? parts[parts.length - 1][0] : "";
  return (first + last).toUpperCase();
}

// Round header avatar: the ERP photo when the backend scraped one, else a
// lime initials tile derived from the profile name.
function renderAvatar() {
  const btn = $("#avatar-btn");
  if (!btn) return;
  const p = state.profile || {};
  if (p.photo) {
    btn.innerHTML = `<img src="${esc(p.photo)}" alt="" class="avatar-img" />`;
  } else {
    const nm = p.name || (state.creds ? state.creds.username : "");
    btn.innerHTML = `<span class="avatar-initials" aria-hidden="true">${esc(initials(nm))}</span>`;
  }
}

// Profile card at the top of the drawer: bigger avatar, name, roll · dept.
function renderDrawerProfile() {
  const box = $("#drawer-profile");
  if (!box) return;
  const p = state.profile || {};
  const name = p.name || (state.creds ? state.creds.username : "");
  const bits = [p.roll_no, deptShort(p.department)].filter(Boolean).join(" · ");
  const av = p.photo
    ? `<img src="${esc(p.photo)}" alt="" class="drawer-avatar" />`
    : `<span class="drawer-avatar avatar-initials" aria-hidden="true">${esc(initials(name))}</span>`;
  setHTML(box, `${av}
    <div class="dp-text">
      <span class="dp-name">${esc(name)}</span>
      ${bits ? `<span class="dp-sub">${esc(bits)}</span>` : ""}
    </div>`);
}

function openDrawer() {
  renderDrawerProfile();
  $("#drawer-overlay").classList.remove("hidden");
  $("#drawer").classList.remove("hidden");
  document.body.style.overflow = "hidden";
  const first = $("#drawer .drawer-link");
  if (first) first.focus();
}

function closeDrawer() {
  $("#drawer").classList.add("hidden");
  $("#drawer-overlay").classList.add("hidden");
  document.body.style.overflow = "";
}

$("#menu-btn").addEventListener("click", openDrawer);
$("#avatar-btn").addEventListener("click", openDrawer);
$("#nav-menu-btn").addEventListener("click", openDrawer);
$("#drawer-overlay").addEventListener("click", closeDrawer);

$("#drawer").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-tab]");
  if (btn) { switchTab(btn.dataset.tab); closeDrawer(); }
});

// Loose focus trap: keep Tab cycling inside the open drawer.
$("#drawer").addEventListener("keydown", (e) => {
  if (e.key !== "Tab") return;
  const items = $$("#drawer button");
  if (!items.length) return;
  const first = items[0], last = items[items.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
});

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (!$("#drawer").classList.contains("hidden")) closeDrawer();
  else if (!$("#about-overlay").classList.contains("hidden")) closeAbout();
  else if (!$("#admin-overlay").classList.contains("hidden")) closeAdmin();
});

/* ---------- About (the crew) ---------- */
function openAbout() {
  closeDrawer();
  $("#about-overlay").classList.remove("hidden");
  document.body.style.overflow = "hidden";
  refreshIcons();
}
function closeAbout() {
  $("#about-overlay").classList.add("hidden");
  document.body.style.overflow = "";
}
$("#about-btn").addEventListener("click", openAbout);
$("#about-close").addEventListener("click", closeAbout);
$("#about-overlay").addEventListener("click", (e) => { if (e.target.id === "about-overlay") closeAbout(); });

// Lazily fill in a missing profile (e.g. a session restored from before this
// field existed) or one that predates photo support (no photo key yet) — one
// call, then the greeting/avatar re-render. Failure is harmless: the greeting
// keeps the username fallback.
// The same call mints the data-API app token for sessions restored from before
// token auth existed (/fetch-profile returns app_token alongside the profile),
// so plan/onboarding loaders can await this when state.appToken is missing.
let profileFetchPromise = null;
function ensureProfile() {
  const p = state.profile;
  const complete = p && p.name && typeof p.photo === "string";
  if ((complete && state.appToken) || !state.creds) return Promise.resolve();
  if (profileFetchPromise) return profileFetchPromise;
  profileFetchPromise = (async () => {
    try {
      const data = await api("/fetch-profile", { ...cookieOnlyFields() });
      if (data.app_token) saveToken(data.app_token);
      if (data.profile && data.profile.name) {
        saveProfile(data.profile);
        renderGreeting();
      }
    } catch { /* keep the fallback greeting */ }
    finally { profileFetchPromise = null; }
  })();
  return profileFetchPromise;
}

/* ---------- Tabs ---------- */
function switchTab(tab) {
  state.activeTab = tab;
  $$(".nav-btn").forEach((b) => {
    const on = b.dataset.tab === tab;
    b.classList.toggle("active", on);
    if (on) {
      // The mobile bottom nav scrolls sideways — keep the active tab visible.
      const nav = $("#main-nav");
      nav.scrollTo({ left: b.offsetLeft - nav.clientWidth / 2 + b.clientWidth / 2 });
    }
  });
  $$(".drawer-link[data-tab]").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  $$(".tab-panel").forEach((p) => p.classList.toggle("active", p.id === `tab-${tab}`));
  // Lazy-load data for the tab (loaders render cached data or fetch)
  if (tab === "attendance") loadAttendance();
  if (tab === "grades") loadGrades();
  if (tab === "exams") loadSeating();
  if (tab === "dashboard") renderDashboard();
  if (tab === "plan") loadPlan();
  if (tab === "ai") loadAi();
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
  if (what === "plan") loadPlan(true);
  if (what === "ai") loadAi(true);
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
// Same shell plus a Retry button that reuses the global data-refresh handler.
function retryState(title, sub, refreshKey) {
  return `<div class="empty-state"><div class="empty-icon"><i data-lucide="cloud-off"></i></div>
    <div class="empty-title">${esc(title)}</div><div class="empty-sub">${esc(sub)}</div>
    <div style="margin-top:16px"><button class="btn btn-ghost" data-refresh="${esc(refreshKey)}"><i data-lucide="refresh-cw"></i>Retry</button></div></div>`;
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
    if (data.app_token) saveToken(data.app_token);
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
  closeDrawer();
  showLogin();
  toast("Logged out", "success");
});

/* ---------- Hidden admin page (owner only) ---------- */
// Entry: 5 quick taps on the login-screen logo within a 2s window. The
// passcode is verified by the backend on every unlock and kept only in
// memory — closing the overlay (or refreshing the page) locks it again.
const admin = { token: null, data: null };

let logoTaps = 0;
let logoTapStart = 0;
$("#login-screen .brand-logo").addEventListener("click", () => {
  const now = Date.now();
  if (now - logoTapStart > 2000) { logoTaps = 0; logoTapStart = now; }
  logoTaps += 1;
  if (logoTaps >= 5) { logoTaps = 0; openAdmin(); }
});

function openAdmin() {
  $("#admin-overlay").classList.remove("hidden");
  document.body.style.overflow = "hidden";
  if (admin.token && admin.data) renderAdminDash();
  else renderAdminLock();
}

function closeAdmin() {
  $("#admin-overlay").classList.add("hidden");
  document.body.style.overflow = "";
  admin.token = null;
  admin.data = null;
}

$("#admin-close").addEventListener("click", closeAdmin);

// Direct admin URL: /klu/#admin opens the lock screen straight away.
if (location.hash === "#admin") openAdmin();

// "2h ago"-style relative timestamps for the users table and the event feed.
function timeAgo(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "—";
  const s = Math.max(0, Math.floor((Date.now() - d.getTime()) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.floor(h / 24);
  if (days < 30) return `${days}d ago`;
  return d.toLocaleDateString();
}

function renderAdminLock() {
  setHTML("#admin-body", `
    <div class="admin-lock">
      <h2 class="admin-title">admin<span class="pdot">.</span></h2>
      <p class="admin-sub">Owner access only. The passcode is checked against the server every time and is never stored on this device.</p>
      <form id="admin-form">
        <label class="field">
          <span>Passcode</span>
          <input type="password" id="admin-token" autocomplete="off" required />
        </label>
        <button type="submit" id="admin-unlock" class="btn btn-primary btn-block">
          <span class="btn-label">Unlock</span>
          <span class="btn-spinner hidden"></span>
        </button>
        <p id="admin-error" class="login-error hidden"></p>
      </form>
    </div>`);
  const input = $("#admin-token");
  if (input) input.focus();
}

// POST /admin/stats — 403/429 carry a .status so the lock screen can react.
// Always a real backend call (like /login), even in ?mock mode.
async function fetchAdminStats(token) {
  const fd = new FormData();
  fd.set("admin_token", token);
  let res;
  try {
    res = await fetch(`${API_BASE}/admin/stats`, { method: "POST", body: fd });
  } catch {
    throw new Error("Can't reach the server. Check your internet and try again.");
  }
  if (res.status === 403 || res.status === 429) {
    const err = new Error(res.status === 403
      ? "Wrong passcode."
      : "Too many attempts — wait a bit and try again.");
    err.status = res.status;
    throw err;
  }
  if (!res.ok) throw new Error(friendlyHttpError(res));
  const data = await res.json();
  if (data.success === false) throw new Error(data.message || "Request failed");
  return data;
}

$("#admin-body").addEventListener("submit", async (e) => {
  if (e.target.id !== "admin-form") return;
  e.preventDefault();
  const input = $("#admin-token");
  const errEl = $("#admin-error");
  const btn = $("#admin-unlock");
  errEl.classList.add("hidden");
  btn.disabled = true;
  btn.querySelector(".btn-label").textContent = "Checking";
  btn.querySelector(".btn-spinner").classList.remove("hidden");
  try {
    const data = await fetchAdminStats(input.value);
    admin.token = input.value;
    admin.data = data;
    renderAdminDash();
  } catch (err) {
    btn.disabled = false;
    btn.querySelector(".btn-label").textContent = "Unlock";
    btn.querySelector(".btn-spinner").classList.add("hidden");
    errEl.textContent = err.message || "Something went wrong.";
    errEl.classList.remove("hidden");
    if (err.status === 403) {
      const panel = $(".admin-panel");
      panel.classList.remove("shake");
      void panel.offsetWidth; // restart the shake animation
      panel.classList.add("shake");
    }
    input.select();
  }
});

$("#admin-body").addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-admin-refresh]");
  if (!btn || !admin.token) return;
  btn.disabled = true;
  try {
    admin.data = await fetchAdminStats(admin.token);
    renderAdminDash();
  } catch (err) {
    if (err.status === 403) {
      admin.token = null;
      admin.data = null;
      renderAdminLock();
    } else {
      toast(err.message || "Could not refresh stats.", "error");
      btn.disabled = false;
    }
  }
});

function renderAdminDash() {
  const d = admin.data || {};
  const t = d.totals || {};
  const cards = [
    { label: "Users", value: t.users, hint: "signed in at least once", icon: "users" },
    { label: "Events · 24h", value: t.events_24h, hint: `${num(t.events)} total events`, icon: "activity" },
    { label: "Logins", value: t.logins, hint: "all time", icon: "log-in" },
    { label: "AI chats", value: t.ai_chats, hint: "all time", icon: "bot" },
  ];
  let html = `<div class="admin-title-row">
      <h2 class="admin-title">admin<span class="pdot">.</span></h2>
      <button type="button" class="btn btn-ghost refresh-btn" data-admin-refresh><i data-lucide="refresh-cw"></i>Refresh</button>
    </div>
    <div class="stats-grid">` + cards.map((c) => `
      <div class="stat-card">
        <div class="stat-icon"><i data-lucide="${c.icon}"></i></div>
        <div class="stat-label">${esc(c.label)}</div>
        <div class="stat-value">${esc(c.value == null ? "—" : c.value)}</div>
        <div class="stat-hint">${esc(c.hint)}</div>
      </div>`).join("") + `</div>`;

  const byType = Object.entries(d.by_type || {}).sort((a, b) => num(b[1]) - num(a[1]));
  const max = Math.max(1, ...byType.map(([, c]) => num(c)));
  html += `<h3 class="section-title">Events by type</h3>`;
  html += byType.length === 0
    ? `<p class="tt-note" style="margin-top:0">No events logged yet.</p>`
    : `<div class="adm-bars">` + byType.map(([k, c]) => `
        <div class="adm-bar-row">
          <span class="adm-bar-key">${esc(k)}</span>
          <div class="adm-bar"><div class="adm-bar-fill" style="width:${Math.min(100, (num(c) / max) * 100).toFixed(1)}%"></div></div>
          <span class="adm-bar-count">${esc(c)}</span>
        </div>`).join("") + `</div>`;

  const users = Array.isArray(d.users) ? d.users : [];
  html += `<h3 class="section-title">Users · ${users.length}</h3>`;
  html += users.length === 0
    ? `<p class="tt-note" style="margin-top:0">No users yet.</p>`
    : `<div class="adm-users">` + users.map((u) => `
        <div class="adm-user">
          <div class="au-top">
            <span class="au-name">${u.name ? `${esc(u.name)} <span class="au-roll">${esc(u.username)}</span>` : esc(u.username)}</span>
            <span class="au-when">${esc(timeAgo(u.last_active))}</span>
          </div>
          <div class="au-stats">
            <span><b>${esc(u.events == null ? 0 : u.events)}</b> events</span>
            <span><b>${esc(u.logins == null ? 0 : u.logins)}</b> logins</span>
            <span><b>${esc(u.ai_chats == null ? 0 : u.ai_chats)}</b> ai chats</span>
          </div>
        </div>`).join("") + `</div>`;

  const recent = (Array.isArray(d.recent) ? d.recent : []).slice(0, 25);
  html += `<h3 class="section-title">Recent events</h3>`;
  html += recent.length === 0
    ? `<p class="tt-note" style="margin-top:0">Nothing logged yet.</p>`
    : `<div class="adm-feed">` + recent.map((r) => `
        <div class="adm-feed-row">
          <span class="af-user">${esc(r.username)}</span>
          <span class="af-event">${esc(r.event)}${r.details ? `<span class="af-details">${esc(formatEventDetails(r.details))}</span>` : ""}</span>
          <span class="af-when">${esc(timeAgo(r.created_at))}</span>
        </div>`).join("") + `</div>`;

  setHTML("#admin-body", html);
}

// Compact one-liner for an event's details JSON, e.g. {"year":"29","sem":"1","ms":842} → "29/1 · 842ms"
function formatEventDetails(raw) {
  try {
    const d = typeof raw === "string" ? JSON.parse(raw) : raw;
    const parts = [];
    if (d.year) parts.push(`${d.year}/${d.sem || "-"}`);
    if (d.rows != null) parts.push(`${d.rows} rows`);
    if (d.days != null) parts.push(`${d.days} days`);
    if (d.model) parts.push(d.model);
    if (d.msg_len) parts.push(`${d.msg_len} chars`);
    if (d.ms != null) parts.push(`${d.ms}ms`);
    return parts.join(" · ");
  } catch { return ""; }
}

// Keep Tab inside the admin overlay while it's open.
$("#admin-overlay").addEventListener("keydown", (e) => {
  if (e.key !== "Tab") return;
  const items = $$("#admin-overlay button, #admin-overlay input");
  if (!items.length) return;
  const first = items[0], last = items[items.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
});

/* ---------- Data loaders ---------- */
function semParams(yearSel, semSel) {
  return {
    academic_year_code: academicYearCode($(yearSel).value),
    semester_id: $(semSel).value,
  };
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

// Core fetchers: deduped while in flight (the dashboard and the individual
// tabs boot together), write through to the SWR cache, and re-render only
// when the fresh payload actually differs (JSON compare).
function fetchTimetableFresh() {
  const key = `${$("#tt-year").value}-${$("#tt-semester").value}`;
  return dedup(`tt:${key}`, async () => {
    const data = await api("/fetch-timetable", { ...semParams("#tt-year", "#tt-semester"), ...cookieOnlyFields() });
    const fresh = data.timetable || {};
    const changed = state.ttKey !== key || JSON.stringify(fresh) !== JSON.stringify(state.timetable);
    state.timetable = fresh;
    state.ttKey = key;
    cacheWrite("timetable", key, fresh);
    stampShow("timetable", Date.now());
    if (changed) { renderTimetable(); renderDashboard(); }
  });
}

function fetchAttendanceFresh() {
  const key = `${$("#att-year").value}-${$("#att-semester").value}`;
  return dedup(`att:${key}`, async () => {
    const data = await api("/fetch-attendance", { ...semParams("#att-year", "#att-semester"), ...cookieOnlyFields() });
    const fresh = data.attendance || [];
    const changed = state.attKey !== key || JSON.stringify(fresh) !== JSON.stringify(state.attendance);
    state.attendance = fresh;
    state.attKey = key;
    cacheWrite("attendance", key, fresh);
    stampShow("attendance", Date.now());
    if (changed) { renderAttendance(); renderDashboard(); }
  });
}

function fetchGradesFresh() {
  return dedup("grades", async () => {
    const data = await api("/fetch-cgpa", { ...cookieOnlyFields() });
    const fresh = data.data || [];
    const changed = JSON.stringify(fresh) !== JSON.stringify(state.grades);
    state.grades = fresh;
    cacheWrite("grades", "", fresh);
    stampShow("grades", Date.now());
    if (changed) renderGrades();
  });
}

function fetchSeatingFresh() {
  return dedup("seating", async () => {
    const data = await api("/fetch-seating-plan", { ...cookieOnlyFields() });
    const fresh = data.seating_plan || [];
    const changed = JSON.stringify(fresh) !== JSON.stringify(state.seating);
    state.seating = fresh;
    cacheWrite("seating", "", fresh);
    stampShow("exams", Date.now());
    if (changed) { renderSeating(); renderDashboard(); } // dashboard shows the exam countdown
  });
}

// Stale-while-revalidate: a cache hit paints instantly (zero spinner), then a
// background fetch revalidates — once per key per session, unless forced.
async function loadTimetable(force) {
  const key = `${$("#tt-year").value}-${$("#tt-semester").value}`;
  if (!force && state.timetable && state.ttKey === key && state.ttValidatedKey === key) { renderTimetable(); return; }
  if (!(state.timetable && state.ttKey === key)) {
    const cached = force ? null : cacheRead("timetable", key);
    if (cached) {
      state.timetable = cached.d;
      state.ttKey = key;
      renderTimetable();
      renderDashboard();
      stampShow("timetable", cached.t);
    } else {
      setHTML("#timetable-content", skelRows(5));
    }
  }
  state.ttValidatedKey = key;
  try {
    await fetchTimetableFresh();
  } catch (err) {
    if (err.message !== "unauthorized" && !(state.timetable && state.ttKey === key)) {
      setHTML("#timetable-content", emptyState("Could not load timetable", err.message, "calendar-days"));
    }
  }
}

async function loadAttendance(force) {
  const key = `${$("#att-year").value}-${$("#att-semester").value}`;
  if (!force && state.attendance && state.attKey === key && state.attValidatedKey === key) { renderAttendance(); return; }
  if (!(state.attendance && state.attKey === key)) {
    const cached = force ? null : cacheRead("attendance", key);
    if (cached) {
      state.attendance = cached.d;
      state.attKey = key;
      renderAttendance();
      renderDashboard();
      stampShow("attendance", cached.t);
    } else {
      setHTML("#attendance-content", skelRows(5));
      setHTML("#attendance-summary", "");
    }
  }
  state.attValidatedKey = key;
  try {
    await fetchAttendanceFresh();
  } catch (err) {
    if (err.message !== "unauthorized" && !(state.attendance && state.attKey === key)) {
      setHTML("#attendance-content", emptyState("Could not load attendance", err.message, "chart-column"));
    }
  }
}

async function loadGrades(force) {
  if (!force && state.grades && state.gradesValidated) { renderGrades(); return; }
  if (!state.grades) {
    const cached = force ? null : cacheRead("grades", "");
    if (cached) {
      state.grades = cached.d;
      renderGrades();
      stampShow("grades", cached.t);
    } else {
      setHTML("#grades-content", skelRows(5));
      setHTML("#grades-summary", "");
    }
  }
  state.gradesValidated = true;
  try {
    await fetchGradesFresh();
  } catch (err) {
    if (err.message !== "unauthorized" && !state.grades) {
      setHTML("#grades-content", emptyState("Could not load grades", err.message, "graduation-cap"));
    }
  }
}

async function loadSeating(force) {
  if (!force && state.seating && state.seatingValidated) { renderSeating(); return; }
  if (!state.seating) {
    const cached = force ? null : cacheRead("seating", "");
    if (cached) {
      state.seating = cached.d;
      renderSeating();
      renderDashboard(); // exam countdown strip picks up the cached seating
      stampShow("exams", cached.t);
    } else {
      setHTML("#exams-content", skelRows(4));
    }
  }
  state.seatingValidated = true;
  try {
    await fetchSeatingFresh();
  } catch (err) {
    if (err.message !== "unauthorized" && !state.seating) {
      setHTML("#exams-content", emptyState("Could not load seating plan", err.message, "armchair"));
    }
  }
}

// Restore the last cached snapshots into state before the first paint, so a
// returning session renders instantly; the loaders revalidate right after.
function hydrateFromCache() {
  const ttKey = `${$("#tt-year").value}-${$("#tt-semester").value}`;
  const attKey = `${$("#att-year").value}-${$("#att-semester").value}`;
  const tt = cacheRead("timetable", ttKey);
  if (tt) { state.timetable = tt.d; state.ttKey = ttKey; stampShow("timetable", tt.t); }
  const att = cacheRead("attendance", attKey);
  if (att) { state.attendance = att.d; state.attKey = attKey; stampShow("attendance", att.t); }
  const gr = cacheRead("grades", "");
  if (gr) { state.grades = gr.d; stampShow("grades", gr.t); }
  const se = cacheRead("seating", "");
  if (se) { state.seating = se.d; stampShow("exams", se.t); }
}

async function loadDashboard() {
  if (state.attendance === null && state.timetable === null) {
    setHTML("#dashboard-content", skelCards(3));
  } else {
    renderDashboard(); // cached/hydrated data — paint before any network
  }
  // Prefetch all three feeds in parallel; the loaders are SWR, so cached data
  // paints instantly and fresh copies re-render only when something changed.
  // Seating rides along so the dashboard can show the next-exam countdown.
  await Promise.allSettled([loadAttendance(), loadTimetable(), loadSeating()]);
  if (state.attendance === null) state.attendance = [];
  if (state.timetable === null) state.timetable = {};
  renderDashboard();
}

/* ---------- Idle prefetch (perceived speed) ---------- */
// Once the dashboard has painted, warm the grades + seating feeds through the
// shared deduped fetchers (write-through to the SWR cache) so those tabs open
// instantly. Runs at most once per session; failures stay silent by design.
let idlePrefetchDone = false;
function scheduleIdlePrefetch() {
  if (idlePrefetchDone) return;
  idlePrefetchDone = true;
  const warm = () => {
    if (!state.creds) return;
    fetchGradesFresh().catch(() => { /* warm-up is best-effort */ });
    fetchSeatingFresh().catch(() => { /* warm-up is best-effort */ });
  };
  if (typeof window.requestIdleCallback === "function") window.requestIdleCallback(warm, { timeout: 2000 });
  else setTimeout(warm, 2000);
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
// time + dim end + slot label on the left, class details on the right. When the
// course is in the catalog the full title leads and the raw code drops into the
// dim mono meta line; unknown codes stay as the title like before.
function classRowHTML(b, isNow) {
  const ci = courseInfo(b.code);
  const meta = [ci ? b.code : "", b.section, b.room ? "Room " + b.room : ""]
    .filter(Boolean).join(" · ");
  return `<div class="class-row${isNow ? " now" : ""}">
    <div class="cr-time">
      <span class="cr-start">${b.start}</span>
      <span class="cr-end">${b.end}</span>
      <span class="cr-slot">${slotLabel(b)}</span>
    </div>
    <div class="cr-info">
      <span class="cr-code">${esc(ci ? ci.title : b.code)}</span>
      <span class="cr-meta cr-mono">${esc(meta)}</span>
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
// for the day / nothing scheduled at all. Title-first like the class rows.
function classHero(blocks) {
  const mins = nowMinutes();
  for (const b of blocks) {
    const s = timeToMin(b.start), e = timeToMin(b.end);
    const ci = courseInfo(b.code);
    const title = ci ? ci.title : b.code;
    const sub = [ci ? b.code : "", b.section, b.room ? "Room " + b.room : "", slotLabel(b)]
      .filter(Boolean).join(" · ");
    if (mins >= s && mins < e) {
      return `<div class="dash-hero now">
        <span class="hero-dot" aria-hidden="true"></span>
        <div class="hero-text">
          <span class="hero-eyebrow">In class now · ends ${b.end}</span>
          <span class="hero-title">${esc(title)}</span>
          <span class="hero-sub">${esc(sub)}</span>
        </div></div>`;
    }
    if (mins < s) {
      return `<div class="dash-hero next">
        <i data-lucide="clock"></i>
        <div class="hero-text">
          <span class="hero-eyebrow">Up next · in ${fmtDuration(s - mins)}</span>
          <span class="hero-title">${esc(title)} <span class="hero-at">${b.start}</span></span>
          <span class="hero-sub">${esc(sub)}</span>
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
    ${examCountdownHTML()}
    ${trackCardHTML()}
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

// "your track." card: dismiss (remembered per prefs signature) and the
// roadmap link, which jumps to the AI tab with a preset prompt.
$("#dashboard-content").addEventListener("click", async (e) => {
  if (e.target.closest("[data-track-dismiss]")) {
    if (state.prefs) {
      try { localStorage.setItem(LS_TRACK_DISMISSED, trackSig(state.prefs)); } catch { /* private mode */ }
    }
    renderDashboard();
    return;
  }
  if (e.target.closest("[data-track-roadmap]")) {
    switchTab("ai");
    if (!state.aiStatus) await loadAi();
    sendAi(roadmapPrompt());
  }
});

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

/* ---------- Timetable: calendar export (.ics) ---------- */
// One VEVENT per merged class block per weekday, repeating weekly for a
// 16-week semester window starting the current week's Monday. Times are
// floating local (no TZ suffix) so calendar apps place them in the device zone.
const ICS_COMP_TYPES = { L: "Lecture", T: "Tutorial", P: "Practical", S: "Skill" };

function p2(n) { return String(n).padStart(2, "0"); }

// RFC5545 text escaping: backslash first, then semicolons, commas, newlines.
function icsEscape(s) {
  return String(s == null ? "" : s)
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

function icsUtcStamp(d) {
  return `${d.getUTCFullYear()}${p2(d.getUTCMonth() + 1)}${p2(d.getUTCDate())}` +
    `T${p2(d.getUTCHours())}${p2(d.getUTCMinutes())}${p2(d.getUTCSeconds())}Z`;
}

// "20260803T092000" from a local Date + "HH:MM".
function icsLocalStamp(d, hhmm) {
  const [h, m] = String(hhmm).split(":").map(Number);
  return `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}T${p2(h)}${p2(m)}00`;
}

// Slot code suffix -> readable component type ("26SC1203-P" -> "Practical").
function compTypeLabel(code) {
  const m = String(code || "").match(/-([A-Za-z])$/);
  return m ? (ICS_COMP_TYPES[m[1].toUpperCase()] || m[1].toUpperCase()) : "";
}

function buildTimetableIcs() {
  if (!state.timetable) return null;
  const mon = new Date();
  mon.setDate(mon.getDate() - ((mon.getDay() + 6) % 7)); // this week's Monday
  const events = [];
  DAY_KEYS.forEach((day, i) => {
    const blocks = blocksForDay(day);
    if (!blocks.length) return;
    const d = new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + i);
    for (const b of blocks) events.push({ d, b });
  });
  if (!events.length) return null;

  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//KL ERP Buddy//Timetable//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
  ];
  const stamp = icsUtcStamp(new Date());
  for (const { d, b } of events) {
    const ci = courseInfo(b.code);
    const summary = ci ? `${ci.title} (${ci.base})` : b.code;
    const desc = [b.section ? "Section " + b.section : "", compTypeLabel(b.code)]
      .filter(Boolean).join(" · ");
    lines.push(
      "BEGIN:VEVENT",
      `UID:${dateISO(d)}-${b.code}-${b.startSlot}@kl-erp-buddy`,
      `DTSTAMP:${stamp}`,
      `DTSTART:${icsLocalStamp(d, b.start)}`,
      `DTEND:${icsLocalStamp(d, b.end)}`,
      "RRULE:FREQ=WEEKLY;COUNT=16",
      `SUMMARY:${icsEscape(summary)}`
    );
    if (b.room) lines.push(`LOCATION:${icsEscape(b.room)}`);
    if (desc) lines.push(`DESCRIPTION:${icsEscape(desc)}`);
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.join("\r\n") + "\r\n";
}

$("#tt-ics-btn").addEventListener("click", () => {
  const ics = buildTimetableIcs();
  if (!ics) { toast("No timetable loaded — nothing to export.", "info"); return; }
  const blob = new Blob([ics], { type: "text/calendar;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "klu-timetable.ics";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  toast("Calendar file downloaded", "success");
});

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
    return `<span class="cmp-hint ok">You can miss <b>${n}</b> more hr${n === 1 ? "" : "s"}</span>`;
  }
  const n = Math.ceil((0.75 * conducted - attended) / 0.25);
  return `<span class="cmp-hint warn">Attend the next <b>${n}</b> hr${n === 1 ? "" : "s"} to reach 75%</span>`;
}

// Group component rows (L/T/P/S) into one object per course with weighted
// totals — shared by the attendance view, the track card and the AI context.
function attendanceGroups() {
  const groups = [];
  const byKey = new Map();
  for (const r of state.attendance || []) {
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
  return groups;
}

// Consecutive classes to attend to reach `target`% from attended/conducted.
// 0 = already there ("safe"), null = nothing conducted yet (chip hidden).
function classesTo(attended, conducted, target) {
  if (conducted <= 0) return null;
  if ((attended / conducted) * 100 >= target) return 0;
  return Math.ceil(((target / 100) * conducted - attended) / (1 - target / 100));
}

// "to 75%: N / safe" quick chips in the course header, from component totals.
function headChipsHTML(g) {
  const t75 = classesTo(g.attended, g.conducted, 75);
  if (t75 == null) return "";
  const t85 = classesTo(g.attended, g.conducted, 85);
  const chip = (target, n) =>
    `<span class="head-chip ${n === 0 ? "ok" : target === 75 ? "warn" : "mid"}">to ${target}%: ${n === 0 ? "safe" : n}</span>`;
  return `<div class="head-chips">${chip(75, t75)}${chip(85, t85)}</div>`;
}

/* --- Bunk simulator: per-row ± steppers, reset whenever the data changes --- */
// Keyed "groupIndex:rowIndex" -> signed n (+n = attend n more, -n = miss n more).
const bunkSims = new Map();
let bunkSig = "";

// Projected percentage after n simulated classes: every simulated class adds a
// conducted hour; attending (n > 0) adds an attended hour on top.
function bunkProjected(row, n) {
  const attended = num(row.attended) + Math.max(0, n);
  const conducted = num(row.conducted) + Math.abs(n);
  return conducted > 0 ? (attended / conducted) * 100 : null;
}

function simOutHTML(p) {
  return p == null ? "" : `projected <b class="sim-pct ${pctClass(p)}">${p.toFixed(1)}%</b>`;
}

// Compact simulator row under a component row. Fixed min-height, so stepping
// never shifts layout; the projection fills in on the first step.
function bunkSimHTML(gi, ri, row) {
  const n = bunkSims.get(`${gi}:${ri}`) || 0;
  const p = n === 0 ? null : bunkProjected(row, n);
  return `<div class="bunk-sim" data-sim-course="${gi}" data-sim-row="${ri}">
    <span class="sim-label">simulate</span>
    <button type="button" class="sim-btn" data-sim="-1" aria-label="Simulate missing one more class"><i data-lucide="minus"></i></button>
    <button type="button" class="sim-btn" data-sim="1" aria-label="Simulate attending one more class"><i data-lucide="plus"></i></button>
    <span class="sim-out" aria-live="polite">${simOutHTML(p)}</span>
  </div>`;
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

  // Fresh data (reload, term switch, revalidate) resets every simulation.
  const sig = JSON.stringify(rows.map((r) => [r.course_code, r.type, r.attended, r.conducted]));
  if (sig !== bunkSig) { bunkSig = sig; bunkSims.clear(); }

  const groups = attendanceGroups();

  const pct = weightedAttendance(rows);
  let attended = 0, conducted = 0;
  for (const r of rows) { attended += num(r.attended); conducted += num(r.conducted); }

  setHTML(sumBox, `
    <div class="sum-banner ${pctClass(pct)}">
      <div class="sum-banner-meta">
        <div class="sum-banner-eyebrow">Overall attendance</div>
        <div class="sum-banner-sub">${attended}/${conducted} hrs · ${groups.length} course${groups.length === 1 ? "" : "s"} · ${rows.length} component${rows.length === 1 ? "" : "s"}</div>
      </div>
      <div class="sum-banner-pct">${pct == null ? "—" : pct.toFixed(1) + "%"}</div>
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
        ${headChipsHTML(g)}
      </div>
      <div class="course-overall">
        <div class="co-left">
          <span class="co-eyebrow">Overall</span>
          <span class="co-sub">Weighted avg · ${esc(letters)} · ${g.rows.length} component${g.rows.length === 1 ? "" : "s"}</span>
        </div>
        <span class="co-pct ${pctClass(g.pct)}">${g.pct == null ? "—" : g.pct.toFixed(1) + "%"}</span>
      </div>
      <div class="cmp-list">` + g.rows.map((r, ri) => {
        const p = num(r.percentage);
        return `<button type="button" class="cmp-row" data-att-course="${gi}" data-att-row="${ri}">
          <span class="cmp-chip">${esc(typeLetter(r.type))}</span>
          <span class="cmp-sec">${esc(r.section || "—")}</span>
          <span class="cmp-nums">
            <span class="cmp-pct ${pctClass(p)}">${p.toFixed(1)}%</span>
            <span class="cmp-frac">${esc(r.attended)}/${esc(r.conducted)} hrs · ${esc(r.absent)} absent</span>
            ${bunkHint(r)}
          </span>
        </button>${bunkSimHTML(gi, ri, r)}`;
      }).join("") + `</div>
    </div>`;
  });
  html += `<p class="grid-hint">Tap any row for the day-by-day register.</p>`;
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
    html += trendSparkline(days);
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

// Cumulative attendance % after each P/A register entry ("-" rows skipped) as
// a compact SVG sparkline with a dashed 75% reference line. Returns "" when
// there aren't at least two points to draw — the modal skips it silently.
function trendSparkline(days) {
  const pts = [];
  let attended = 0, conducted = 0;
  for (const d of days) {
    if (d.status !== "P" && d.status !== "A") continue;
    conducted++;
    if (d.status === "P") attended++;
    pts.push((attended / conducted) * 100);
  }
  if (pts.length < 2) return "";
  const W = 280, H = 56, PAD = 5;
  const lo = Math.max(0, Math.min(...pts, 75) - 3);
  const hi = Math.min(100, Math.max(...pts, 75) + 3);
  const span = hi - lo || 1;
  const x = (i) => PAD + (i / (pts.length - 1)) * (W - 2 * PAD);
  const y = (v) => H - PAD - ((v - lo) / span) * (H - 2 * PAD);
  const line = pts.map((p, i) => `${x(i).toFixed(1)},${y(p).toFixed(1)}`).join(" ");
  const area = `${PAD},${H - PAD} ${line} ${W - PAD},${H - PAD}`;
  const y75 = y(75).toFixed(1);
  const lx = x(pts.length - 1).toFixed(1);
  const ly = y(pts[pts.length - 1]).toFixed(1);
  return `<div class="trend-wrap">
    <svg class="trend-spark" viewBox="0 0 ${W} ${H}" role="img" aria-label="Attendance trend over the semester">
      <polygon class="trend-area" points="${area}"></polygon>
      <line class="trend-ref" x1="${PAD}" y1="${y75}" x2="${W - PAD}" y2="${y75}"></line>
      <polyline class="trend-line" points="${line}"></polyline>
      <circle class="trend-dot" cx="${lx}" cy="${ly}" r="3.2"></circle>
    </svg>
    <div class="trend-cap">trend over the semester · 75% line</div>
  </div>`;
}

// Bunk simulator steppers: update only the projected label in place (no
// re-render, no layout shift). Sims live in bunkSims and reset on data reload.
$("#attendance-content").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-sim]");
  if (!btn) return;
  const wrap = btn.closest("[data-sim-course]");
  const gi = +wrap.dataset.simCourse, ri = +wrap.dataset.simRow;
  const row = (attendanceGroups()[gi] || { rows: [] }).rows[ri];
  if (!row) return;
  const key = `${gi}:${ri}`;
  const n = (bunkSims.get(key) || 0) + (btn.dataset.sim === "1" ? 1 : -1);
  bunkSims.set(key, n);
  const p = n === 0 ? null : bunkProjected(row, n);
  wrap.querySelector(".sim-out").innerHTML = simOutHTML(p);
});

/* ---------- Grades: what-if CGPA calculator ---------- */
// Per-course grade pickers for the current term, combined with the completed
// (already graded) courses into a live projected CGPA. Selections persist per
// account ("kl_erp_whatif_<username>"); recomputing updates only the output
// line in place — never a full tab re-render.
const WHATIF_POINTS = { O: 10, S: 9, A: 8, B: 7, C: 6, D: 5, F: 0 };
const LS_WHATIF = "kl_erp_whatif";

function whatIfHasGrade(g) { return Object.prototype.hasOwnProperty.call(WHATIF_POINTS, g); }

function whatIfKey() {
  const u = state.creds && state.creds.username;
  return u ? `${LS_WHATIF}_${u}` : LS_WHATIF;
}

function whatIfRead() {
  try {
    const d = JSON.parse(localStorage.getItem(whatIfKey()) || "{}");
    return d && typeof d === "object" && !Array.isArray(d) ? d : {};
  } catch { return {}; }
}

// Credits for a course already present in the grades data, else the KL default 4.
function whatIfKnownCredits(code) {
  const hit = (state.grades || []).find((r) => r.course_code === code);
  return hit && num(hit.credits) > 0 ? num(hit.credits) : 4;
}

// Rows for the card: current-term courses from the attendance data when
// available, otherwise the latest academic year's graded rows. [] = hide card.
function whatIfCourses() {
  const groups = attendanceGroups();
  if (groups.length) {
    return groups.map((g) => ({ code: g.code, name: g.name || g.code, credits: whatIfKnownCredits(g.code) }));
  }
  const rows = state.grades || [];
  if (!rows.length) return [];
  const latest = rows.reduce((max, r) => {
    const y = String(r.academic_year || "");
    return y > max ? y : max;
  }, "");
  return rows.filter((r) => String(r.academic_year || "") === latest)
    .map((r) => ({ code: r.course_code, name: r.course_name || r.course_code, credits: whatIfKnownCredits(r.course_code) }));
}

// Projection over completed courses (graded rows outside the what-if set) plus
// every what-if row with a picked grade; unpicked rows count as nothing.
function whatIfProjection() {
  const courses = whatIfCourses();
  if (!courses.length) return null;
  const codes = new Set(courses.map((c) => c.code));
  const saved = whatIfRead();
  let gp = 0, cr = 0, completed = 0;
  for (const r of state.grades || []) {
    if (codes.has(r.course_code)) continue;
    gp += num(r.grade_point) * num(r.credits);
    cr += num(r.credits);
    completed++;
  }
  for (const c of courses) {
    const s = saved[c.code] || {};
    const g = String(s.g || "").toUpperCase();
    if (!whatIfHasGrade(g)) continue;
    const credits = num(s.c) > 0 ? num(s.c) : c.credits;
    gp += WHATIF_POINTS[g] * credits;
    cr += credits;
  }
  return { value: cr > 0 ? gp / cr : null, hasCompleted: completed > 0 };
}

function whatIfPaintOut() {
  const el = document.getElementById("whatif-out");
  if (!el) return;
  const p = whatIfProjection();
  if (!p) return;
  el.innerHTML = `${p.hasCompleted ? "projected cgpa" : "projected first-sem sgpa"}: <b>${p.value == null ? "—" : p.value.toFixed(2)}</b>`;
}

function whatIfCardHTML() {
  const courses = whatIfCourses();
  if (!courses.length) return "";
  const saved = whatIfRead();
  const gradeOpts = (sel) =>
    `<option value=""${sel === "" ? " selected" : ""}>&ndash;</option>` +
    Object.keys(WHATIF_POINTS).map((g) =>
      `<option value="${g}"${sel === g ? " selected" : ""}>${g}</option>`).join("");
  const rowsHtml = courses.map((c) => {
    const s = saved[c.code] || {};
    const credits = num(s.c) > 0 ? num(s.c) : c.credits;
    const g = String(s.g || "").toUpperCase();
    return `<div class="wi-row">
      <div class="wi-course">
        <span class="wi-code">${esc(c.code)}</span>
        <span class="wi-name">${esc(c.name)}</span>
      </div>
      <div class="wi-controls">
        <input type="number" inputmode="decimal" class="wi-credits" data-whatif-credits="${esc(c.code)}" min="0.5" max="30" step="0.5" value="${esc(credits)}" aria-label="Credits for ${esc(c.code)}" />
        <select class="wi-grade" data-whatif-grade="${esc(c.code)}" aria-label="Expected grade for ${esc(c.code)}">${gradeOpts(whatIfHasGrade(g) ? g : "")}</select>
      </div>
    </div>`;
  }).join("");
  return `<div class="card whatif-card" id="whatif-card">
    <span class="wi-eyebrow">calculator</span>
    <h3 class="wi-title">what-if cgpa<span class="pdot">.</span></h3>
    <p class="wi-sub">Pick expected grades for this term's courses — the projection updates live and is saved on this device.</p>
    <div class="wi-rows">${rowsHtml}</div>
    <div class="wi-out" id="whatif-out" aria-live="polite"></div>
  </div>`;
}

// Persist the card's current inputs for this account, then repaint the number.
function whatIfSaveAndPaint() {
  const card = document.getElementById("whatif-card");
  if (!card) return;
  const data = {};
  card.querySelectorAll("[data-whatif-credits]").forEach((el) => {
    (data[el.dataset.whatifCredits] = data[el.dataset.whatifCredits] || {}).c = el.value;
  });
  card.querySelectorAll("[data-whatif-grade]").forEach((el) => {
    (data[el.dataset.whatifGrade] = data[el.dataset.whatifGrade] || {}).g = el.value;
  });
  try { localStorage.setItem(whatIfKey(), JSON.stringify(data)); } catch { /* full — session-only */ }
  whatIfPaintOut();
}

// input covers typing + spinners, change covers selects on older engines.
$("#grades-content").addEventListener("input", (e) => {
  if (e.target.closest("[data-whatif-credits], [data-whatif-grade]")) whatIfSaveAndPaint();
});
$("#grades-content").addEventListener("change", (e) => {
  if (e.target.closest("[data-whatif-credits], [data-whatif-grade]")) whatIfSaveAndPaint();
});

/* ---------- Render: Grades ---------- */
function renderGrades() {
  const rows = state.grades || [];
  const sumBox = $("#grades-summary");
  const box = $("#grades-content");

  if (rows.length === 0) {
    setHTML(sumBox, "");
    // The what-if card can still render here — it sources current-term courses
    // from the attendance data even when no grades are published yet.
    setHTML(box, emptyState("No results yet", "Grades will appear here once published.", "graduation-cap") + whatIfCardHTML());
    whatIfPaintOut();
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
  html += whatIfCardHTML();
  setHTML(box, html);
  whatIfPaintOut();

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
// Tolerant exam-date parsing: ISO (2026-08-14), dd-mm-yyyy / dd/mm/yyyy, or
// anything Date.parse understands ("14 Aug 2026"). Returns a local Date.
function examDateObj(s) {
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
  return d;
}

function examDateParts(s) {
  const d = examDateObj(s);
  if (!d) return null;
  return { day: d.getDate(), mon: d.toLocaleString(undefined, { month: "short" }) };
}

// Nearest upcoming exam from the seating plan (today counts, past days don't).
function nextExam() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  let best = null;
  for (const r of state.seating || []) {
    const raw = examDateObj(r.date);
    if (!raw) continue;
    const d = new Date(raw.getFullYear(), raw.getMonth(), raw.getDate());
    if (d < today) continue;
    if (!best || d < best.d) best = { d, row: r };
  }
  return best;
}

// Slim countdown strip under the dashboard hero — empty string when the
// seating plan has no future exam (the strip simply isn't rendered).
function examCountdownHTML() {
  const nx = nextExam();
  if (!nx) return "";
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = Math.round((nx.d - today) / 86400000);
  const when = days === 0 ? "today" : days === 1 ? "tomorrow" : `in ${days}d`;
  const dp = examDateParts(nx.row.date);
  const detail = [dp ? `${dp.day} ${dp.mon}` : "", nx.row.room_no].filter(Boolean).join(", ");
  return `<div class="exam-strip">
    <i data-lucide="alarm-clock"></i>
    <span class="exam-strip-text">next exam: <b>${esc(nx.row.course_code)}</b> · ${esc(nx.row.exam_type)} · ${esc(when)}${detail ? ` <span class="exam-strip-sub">(${esc(detail)})</span>` : ""}</span>
  </div>`;
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

/* ---------- Plan: study planner + tasks (backend data API) ---------- */
const PRIO_LABELS = ["LOW", "NORM", "HIGH"];

// Free time for a set of merged class blocks: gaps between blocks, plus after
// the last class until 21:00. Slivers under 20 min (short slot breaks) are dropped.
function freeSlotsForBlocks(blocks) {
  const DAY_END = 21 * 60;
  const gaps = [];
  for (let i = 1; i < blocks.length; i++) {
    const prevEnd = timeToMin(blocks[i - 1].end);
    const s = timeToMin(blocks[i].start);
    if (s > prevEnd) gaps.push([prevEnd, s]);
  }
  if (blocks.length) {
    const lastEnd = timeToMin(blocks[blocks.length - 1].end);
    if (lastEnd < DAY_END) gaps.push([lastEnd, DAY_END]);
  }
  return gaps
    .filter(([s, e]) => e - s >= 20)
    .map(([s, e]) => ({ start: minToTime(s), end: minToTime(e), mins: e - s }));
}

function freeSlotsToday() { return freeSlotsForBlocks(todaysBlocks()); }

// Courses for the dropdowns: timetable slot codes (type suffix stripped) plus
// attendance course codes, deduped. Display names come from attendance (ERP)
// when known, otherwise from the courses.json catalog (see courseOptions).
function knownCourses() {
  const map = new Map();
  for (const r of state.attendance || []) {
    if (r.course_code && !map.has(r.course_code)) map.set(r.course_code, r.course_name || "");
  }
  if (state.timetable) {
    for (const d of DAY_KEYS) {
      const day = state.timetable[d];
      if (!day) continue;
      for (const v of Object.values(day)) {
        if (!v || v === "-") continue;
        const code = parseSlot(v).code.replace(/-[A-Za-z]$/, "");
        if (code && !map.has(code)) map.set(code, "");
      }
    }
  }
  return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

function courseOptions({ includeNone = false, includeOther = false } = {}) {
  let html = includeNone ? `<option value="">No course</option>` : "";
  for (const [code, name] of knownCourses()) {
    const ci = courseInfo(code);
    const label = name || (ci ? ci.title : "");
    html += `<option value="${esc(code)}">${esc(code)}${label ? " — " + esc(label) : ""}</option>`;
  }
  if (includeOther) html += `<option value="Other">Other</option>`;
  return html;
}

// Monday..Sunday of the current week as ISO strings (goal progress window).
function weekRangeISO() {
  const now = new Date();
  const mon = new Date(now);
  mon.setDate(now.getDate() - ((now.getDay() + 6) % 7));
  const sun = new Date(mon);
  sun.setDate(mon.getDate() + 6);
  return [dateISO(mon), dateISO(sun)];
}

function blockMins(b) {
  return Math.max(0, timeToMin(hhmm(b.end_time)) - timeToMin(hhmm(b.start_time)));
}

async function loadPlan(force) {
  if (!force && state.planLoaded) { renderPlan(); return; }
  if (!state.planDay) state.planDay = todayISO();
  setHTML("#plan-content", skelRows(5));
  // Free hours + course dropdowns need timetable/attendance — lazy-load them
  // exactly like the dashboard does (shared deduped fetchers, SWR-cached).
  if (!state.timetable) {
    try {
      await fetchTimetableFresh();
    } catch (err) { if (err.message === "unauthorized") return; state.timetable = {}; }
  }
  if (!state.attendance) {
    try {
      await fetchAttendanceFresh();
    } catch (err) { if (err.message === "unauthorized") return; state.attendance = []; }
  }
  try {
    if (MOCK_MODE) {
      const m = mockPlanData();
      state.planTasks = m.tasks; state.planBlocks = m.blocks; state.planGoals = m.goals;
    } else {
      // A session restored from before token auth may still be minting its app
      // token — wait once, then fail like any other unreachable-server case.
      if (!state.appToken) await ensureProfile();
      if (!state.appToken) throw new Error("Can't reach the server. Check your internet and try again.");
      const [t, b, g] = await Promise.all([
        dataApi("tasks"),
        dataApi("study_blocks"),
        dataApi("goals"),
      ]);
      state.planTasks = t.rows || [];
      state.planBlocks = b.rows || [];
      state.planGoals = g.rows || [];
    }
    state.planLoaded = true;
    renderPlan();
  } catch (err) {
    state.planLoaded = false;
    setHTML("#plan-content", retryState("Could not load your planner", err.message, "plan"));
  }
}

// Fields whose typed-but-unsaved values survive a re-render (e.g. toggling a
// task while a new task title is half-typed).
const PLAN_FIELDS = ["task-title", "task-course", "task-due", "block-course", "block-start", "block-end", "block-note", "goal-course", "goal-hours"];

function renderPlan() {
  if (state.activeTab !== "plan" || !state.planLoaded) return;
  const box = $("#plan-content");
  const vals = {};
  for (const id of PLAN_FIELDS) { const el = document.getElementById(id); if (el) vals[id] = el.value; }

  const today = todayISO();
  const ttHasData = !!(state.timetable && DAY_KEYS.some((d) =>
    state.timetable[d] && Object.values(state.timetable[d]).some((v) => v && v !== "-")));

  /* --- free hours today --- */
  let html = `<h3 class="section-title">Free hours today</h3>`;
  if (!ttHasData) {
    html += `<p class="tt-note" style="margin-top:0">Load the timetable to see today's free hours.</p>`;
  } else if (todaysBlocks().length === 0) {
    html += `<div class="free-chips"><span class="free-chip">No classes today — free until 21:00</span></div>`;
  } else {
    const gaps = freeSlotsToday();
    html += gaps.length
      ? `<div class="free-chips">` + gaps.map((g) =>
          `<span class="free-chip">${g.start}–${g.end} · ${fmtDuration(g.mins)}</span>`).join("") + `</div>`
      : `<p class="tt-note" style="margin-top:0">No free gaps between classes today.</p>`;
  }

  /* --- study blocks --- */
  html += `<h3 class="section-title">Study blocks</h3>`;
  html += `<div class="day-pills" role="tablist" aria-label="Plan day">` +
    Array.from({ length: 7 }, (_, i) => {
      const iso = shiftISO(i);
      const d = new Date(); d.setDate(d.getDate() + i);
      const label = i === 0 ? "Today" : `${DAY_KEYS[(d.getDay() + 6) % 7]} ${d.getDate()}`;
      return `<button type="button" role="tab" aria-selected="${iso === state.planDay}"
        class="day-pill${iso === state.planDay ? " active" : ""}" data-plan-day="${iso}">${label}</button>`;
    }).join("") + `</div>`;

  html += `<form id="block-form" class="card plan-form">
    <div class="pf-grid">
      <label class="field pf-span2"><span>Course</span><select id="block-course">${courseOptions({ includeOther: true })}</select></label>
      <label class="field"><span>Start</span><input type="time" id="block-start" required /></label>
      <label class="field"><span>End</span><input type="time" id="block-end" required /></label>
      <label class="field pf-span4"><span>Note (optional)</span><input type="text" id="block-note" maxlength="80" placeholder="e.g. Graph problem set" /></label>
    </div>
    <button type="submit" class="btn btn-primary"><i data-lucide="plus"></i>Add block</button>
  </form>`;

  const dayBlocks = (state.planBlocks || [])
    .filter((b) => b.day === state.planDay)
    .sort((a, b) => hhmm(a.start_time).localeCompare(hhmm(b.start_time)));
  if (dayBlocks.length === 0) {
    html += `<div class="day-empty"><div class="empty-title">no blocks planned.</div>
      <div class="empty-sub">Add a study block for this day above.</div></div>`;
  } else {
    html += `<div class="class-rows">` + dayBlocks.map((b) => {
      const bci = courseInfo(b.course);
      const blockMeta = [bci ? b.course : "", b.note].filter(Boolean).join(" · ");
      return `
      <div class="class-row block-row${b.done ? " done" : ""}">
        <div class="cr-time">
          <span class="cr-start">${esc(hhmm(b.start_time))}</span>
          <span class="cr-end">${esc(hhmm(b.end_time))}</span>
          <span class="cr-slot">${fmtDuration(blockMins(b))}</span>
        </div>
        <div class="cr-info">
          <span class="cr-code">${esc(bci ? bci.title : (b.course || "Other"))}</span>
          ${blockMeta ? `<span class="cr-meta">${esc(blockMeta)}</span>` : ""}
        </div>
        <div class="row-actions">
          <button type="button" class="btn-icon row-toggle" data-block-toggle="${esc(b.id)}" aria-label="Toggle done"><i data-lucide="check"></i></button>
          <button type="button" class="btn-icon" data-block-del="${esc(b.id)}" aria-label="Delete block"><i data-lucide="trash-2"></i></button>
        </div>
      </div>`;
    }).join("") + `</div>`;
  }

  /* --- weekly goals --- */
  const [wkStart, wkEnd] = weekRangeISO();
  const weekBlocks = (state.planBlocks || []).filter((b) => b.day >= wkStart && b.day <= wkEnd);
  html += `<h3 class="section-title">Weekly goals</h3>`;
  html += `<form id="goal-form" class="card plan-form">
    <div class="pf-grid">
      <label class="field pf-span2"><span>Course</span><select id="goal-course">${courseOptions({ includeOther: true })}</select></label>
      <label class="field"><span>Hours / week</span><input type="number" id="goal-hours" min="1" max="40" step="0.5" required placeholder="5" /></label>
    </div>
    <button type="submit" class="btn btn-primary"><i data-lucide="target"></i>Set goal</button>
  </form>`;
  const goals = state.planGoals || [];
  if (goals.length === 0) {
    html += `<div class="day-empty"><div class="empty-title">no goals yet.</div>
      <div class="empty-sub">Set a weekly hours target per course.</div></div>`;
  } else {
    html += `<div class="goal-list">` + goals.map((g) => {
      const doneHrs = weekBlocks
        .filter((b) => (b.course || "Other") === g.course)
        .reduce((s, b) => s + blockMins(b), 0) / 60;
      const pct = num(g.weekly_hours) > 0 ? Math.min(100, (doneHrs / num(g.weekly_hours)) * 100) : 0;
      const gci = courseInfo(g.course);
      return `<div class="card goal-row">
        <div class="goal-top">
          <span class="goal-course">${esc(gci ? gci.title : g.course)}</span>
          <span class="goal-meta">${gci ? esc(g.course) + " · " : ""}${doneHrs.toFixed(1)} / ${esc(g.weekly_hours)} h this week</span>
          <button type="button" class="btn-icon" data-goal-del="${esc(g.course)}" aria-label="Remove goal"><i data-lucide="x"></i></button>
        </div>
        <div class="goal-bar"><div class="goal-fill" style="width:${pct.toFixed(0)}%"></div></div>
      </div>`;
    }).join("") + `</div>`;
  }

  /* --- tasks --- */
  html += `<h3 class="section-title">Tasks</h3>`;
  html += `<form id="task-form" class="card plan-form">
    <div class="pf-grid">
      <label class="field pf-span4"><span>Task</span><input type="text" id="task-title" maxlength="120" required placeholder="e.g. DSA assignment 4" /></label>
      <label class="field pf-span2"><span>Course (optional)</span><select id="task-course">${courseOptions({ includeNone: true })}</select></label>
      <label class="field"><span>Due (optional)</span><input type="date" id="task-due" /></label>
      <div class="field"><span>Priority</span>
        <div class="prio-seg" role="group" aria-label="Priority">
          ${PRIO_LABELS.map((l, i) => `<button type="button" class="prio-btn${i === state.taskPriority ? " active" : ""}" data-prio="${i}">${l}</button>`).join("")}
        </div>
      </div>
    </div>
    <button type="submit" class="btn btn-primary"><i data-lucide="plus"></i>Add task</button>
  </form>`;

  const tasks = state.planTasks || [];
  const groups = [
    { label: "Overdue", cls: "g-overdue", items: [] },
    { label: "Today", cls: "g-today", items: [] },
    { label: "Upcoming", cls: "g-upcoming", items: [] },
    { label: "Done", cls: "g-done", items: [] },
  ];
  for (const t of tasks) {
    if (t.done) groups[3].items.push(t);
    else if (t.due_date && t.due_date < today) groups[0].items.push(t);
    else if (t.due_date === today) groups[1].items.push(t);
    else groups[2].items.push(t);
  }
  const byDue = (a, b) =>
    String(a.due_date || "9999").localeCompare(String(b.due_date || "9999")) || num(b.priority) - num(a.priority);
  groups.forEach((g) => g.items.sort(byDue));

  if (tasks.length === 0) {
    html += `<div class="day-empty"><div class="empty-title">no tasks yet.</div>
      <div class="empty-sub">Add your first to-do above.</div></div>`;
  } else {
    for (const g of groups) {
      if (g.items.length === 0) continue;
      html += `<div class="task-group-label ${g.cls}">${g.label} · ${g.items.length}</div><div class="task-list">`;
      for (const t of g.items) {
        let due = "";
        if (t.due_date) {
          const cls = t.due_date < today ? "late" : t.due_date === today ? "today" : "";
          const d = new Date(t.due_date + "T00:00:00");
          const txt = t.due_date === today ? "today"
            : Number.isNaN(d.getTime()) ? t.due_date
            : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
          due = `<span class="task-due ${cls}">${esc(t.due_date < today ? "due " + txt : txt)}</span>`;
        }
        const prio = Math.min(2, Math.max(0, num(t.priority)));
        const tci = t.course ? courseInfo(t.course) : null;
        html += `<div class="task-row${t.done ? " done" : ""}" data-task-toggle="${esc(t.id)}" role="button" tabindex="0">
          <span class="task-check" aria-hidden="true"></span>
          <div class="task-info">
            <span class="task-title">${esc(t.title)}</span>
            <span class="task-meta">
              ${t.course ? `<span>${esc(t.course)}${tci ? " · " + esc(tci.title) : ""}</span>` : ""}
              ${due}
              <span class="prio-chip p${prio}">${PRIO_LABELS[prio]}</span>
            </span>
          </div>
          <button type="button" class="btn-icon task-del" data-task-del="${esc(t.id)}" aria-label="Delete task"><i data-lucide="x"></i></button>
        </div>`;
      }
      html += `</div>`;
    }
  }

  setHTML(box, html);
  for (const [id, v] of Object.entries(vals)) {
    const el = document.getElementById(id);
    if (el && v) el.value = v;
  }
}

/* --- Plan CRUD (mock mode mutates local state only) --- */
async function planInsert(table, row) {
  if (MOCK_MODE) {
    return { id: "mock-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), ...row };
  }
  const data = await dataApi(table, { method: "POST", body: row });
  return data.row;
}
async function planUpdate(table, id, patch) {
  if (MOCK_MODE) return;
  await dataApi(table, { method: "PATCH", id, body: patch });
}
async function planDelete(table, id) {
  if (MOCK_MODE) return;
  await dataApi(table, { method: "DELETE", id });
}

// Run a mutation, toast on failure, re-render either way.
async function planRun(fn, okMsg) {
  try {
    await fn();
    if (okMsg) toast(okMsg, "success");
  } catch (err) {
    toast(err.message || "That didn't save — try again.", "error");
  }
  renderPlan();
}

$("#plan-content").addEventListener("click", (e) => {
  const dayBtn = e.target.closest("[data-plan-day]");
  if (dayBtn) { state.planDay = dayBtn.dataset.planDay; renderPlan(); return; }

  const prio = e.target.closest("[data-prio]");
  if (prio) {
    state.taskPriority = +prio.dataset.prio;
    prio.closest(".prio-seg").querySelectorAll("[data-prio]").forEach((b) =>
      b.classList.toggle("active", b === prio));
    return;
  }

  const bTgl = e.target.closest("[data-block-toggle]");
  if (bTgl) {
    const b = (state.planBlocks || []).find((x) => String(x.id) === bTgl.dataset.blockToggle);
    if (!b) return;
    planRun(async () => { const done = !b.done; await planUpdate("study_blocks", b.id, { done }); b.done = done; });
    return;
  }
  const bDel = e.target.closest("[data-block-del]");
  if (bDel) {
    const b = (state.planBlocks || []).find((x) => String(x.id) === bDel.dataset.blockDel);
    if (!b) return;
    planRun(async () => {
      await planDelete("study_blocks", b.id);
      state.planBlocks = state.planBlocks.filter((x) => x !== b);
    }, "Block deleted");
    return;
  }

  const tDel = e.target.closest("[data-task-del]");
  if (tDel) {
    const t = (state.planTasks || []).find((x) => String(x.id) === tDel.dataset.taskDel);
    if (!t) return;
    planRun(async () => {
      await planDelete("tasks", t.id);
      state.planTasks = state.planTasks.filter((x) => x !== t);
    }, "Task deleted");
    return;
  }
  const tTgl = e.target.closest("[data-task-toggle]");
  if (tTgl) {
    const t = (state.planTasks || []).find((x) => String(x.id) === tTgl.dataset.taskToggle);
    if (!t) return;
    planRun(async () => { const done = !t.done; await planUpdate("tasks", t.id, { done }); t.done = done; });
    return;
  }

  const gDel = e.target.closest("[data-goal-del]");
  if (gDel) {
    const course = gDel.dataset.goalDel;
    planRun(async () => {
      // Goal rows carry their server id (from GET rows or the POST response);
      // the guard only matters for mock rows, where planDelete no-ops anyway.
      const g = (state.planGoals || []).find((x) => x.course === course);
      if (g && g.id) await planDelete("goals", g.id);
      state.planGoals = state.planGoals.filter((x) => x.course !== course);
    }, "Goal removed");
  }
});

// Task rows are divs with role="button" — make Enter/Space toggle them.
$("#plan-content").addEventListener("keydown", (e) => {
  if ((e.key === "Enter" || e.key === " ") && e.target.matches("[data-task-toggle]")) {
    e.preventDefault();
    e.target.click();
  }
});

$("#plan-content").addEventListener("submit", (e) => {
  e.preventDefault();
  const id = e.target.id;

  if (id === "task-form") {
    const title = $("#task-title").value.trim();
    if (!title) return;
    const task = {
      title,
      course: $("#task-course").value,
      due_date: $("#task-due").value || null,
      priority: state.taskPriority,
      done: false,
    };
    planRun(async () => { state.planTasks.push(await planInsert("tasks", task)); }, "Task added");
  }

  if (id === "block-form") {
    const start = $("#block-start").value;
    const end = $("#block-end").value;
    if (!start || !end) { toast("Pick a start and end time.", "error"); return; }
    if (timeToMin(end) <= timeToMin(start)) { toast("End time must be after start time.", "error"); return; }
    const block = {
      course: $("#block-course").value || "Other",
      day: state.planDay,
      start_time: start,
      end_time: end,
      note: $("#block-note").value.trim(),
      done: false,
    };
    planRun(async () => { state.planBlocks.push(await planInsert("study_blocks", block)); }, "Block added");
  }

  if (id === "goal-form") {
    const course = $("#goal-course").value || "Other";
    const hours = num($("#goal-hours").value);
    if (hours <= 0) { toast("Hours must be more than 0.", "error"); return; }
    planRun(async () => {
      let row = { course, weekly_hours: hours };
      if (!MOCK_MODE) {
        // POST upserts per account+course server-side; the returned row has the id.
        const data = await dataApi("goals", { method: "POST", body: row });
        row = data.row || row;
      }
      const g = state.planGoals.find((x) => x.course === course);
      if (g) Object.assign(g, row); else state.planGoals.push(row);
    }, "Goal saved");
  }
});

/* ---------- AI chat (POST /ai/chat) ---------- */
const AI_QUICK = {
  plan: "Plan my day: using today's free slots between my classes, suggest a concrete study plan with times.",
  attendance: "Fix my attendance: based on my per-course numbers, which upcoming classes can I safely skip and which must I attend to stay at or above 75%?",
  exam: "Exam prep: build a revision plan for my current courses, prioritizing the ones where I'm weakest.",
};

// Roadmap prompt is shared by the quick chip and the dashboard track card.
function roadmapPrompt() {
  const goal = state.prefs && state.prefs.goal ? ` My goal is ${state.prefs.goal}.` : "";
  return `Build my career roadmap: a semester-long plan aligned to my goal and current courses, with monthly milestones and concrete weekly actions.${goal}`;
}

// Tiny safe markdown renderer for AI bubbles. The raw text is escaped FIRST;
// every transform below then operates on entities, so no raw AI HTML can ever
// be injected. Supports: ### h3 / ## h4, **bold**, *italic*, - / • bullets,
// numbered lists, blank-line paragraphs and `code` spans.
function mdToHtml(text) {
  const inline = (s) => s
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*\n]+)\*/g, "<em>$1</em>");
  const blocks = [];
  let list = null;   // {type: "ul"|"ol", items: []}
  let para = [];
  const flushList = () => {
    if (!list) return;
    blocks.push(`<${list.type}>` + list.items.map((it) => `<li>${inline(it)}</li>`).join("") + `</${list.type}>`);
    list = null;
  };
  const flushPara = () => {
    if (!para.length) return;
    blocks.push(`<p>` + para.map(inline).join("<br>") + `</p>`);
    para = [];
  };
  for (const rawLine of esc(text).split("\n")) {
    const t = rawLine.trim();
    if (!t) { flushList(); flushPara(); continue; }
    let m;
    if ((m = t.match(/^#{3,}\s+(.*)/))) { flushList(); flushPara(); blocks.push(`<h3>${inline(m[1])}</h3>`); continue; }
    if ((m = t.match(/^#{1,2}\s+(.*)/))) { flushList(); flushPara(); blocks.push(`<h4>${inline(m[1])}</h4>`); continue; }
    if ((m = t.match(/^(?:-|•)\s+(.*)/))) {
      if (!list || list.type !== "ul") { flushList(); flushPara(); list = { type: "ul", items: [] }; }
      list.items.push(m[1]);
      continue;
    }
    if ((m = t.match(/^\d+[.)]\s+(.*)/))) {
      if (!list || list.type !== "ol") { flushList(); flushPara(); list = { type: "ol", items: [] }; }
      list.items.push(m[1]);
      continue;
    }
    flushList();
    para.push(t);
  }
  flushList(); flushPara();
  return blocks.join("");
}

// Per-account history key: each ERP username gets its own chat log on a
// shared device ("kl_erp_ai_history_<username>"). The bare legacy key is only
// a fallback while no account is known (pre-login).
function aiHistoryKey() {
  const u = state.creds && state.creds.username;
  return u ? `${LS_AI_HISTORY}_${u}` : LS_AI_HISTORY;
}

function loadAiHistory() {
  const key = aiHistoryKey();
  // One-time migration: a pre-per-account global history is adopted by the
  // first account that loads with no history of its own, then the legacy key
  // is deleted so no other account ever inherits it.
  if (key !== LS_AI_HISTORY && localStorage.getItem(key) == null) {
    const legacy = localStorage.getItem(LS_AI_HISTORY);
    if (legacy != null) {
      try { localStorage.setItem(key, legacy); } catch { /* full — keep in memory */ }
      localStorage.removeItem(LS_AI_HISTORY);
    }
  }
  try { state.aiHistory = JSON.parse(localStorage.getItem(key) || "[]"); }
  catch { state.aiHistory = []; }
  if (!Array.isArray(state.aiHistory)) state.aiHistory = [];
}

function pushAi(role, content) {
  state.aiHistory.push({ role, content });
  while (state.aiHistory.length > 20) state.aiHistory.shift();
  try { localStorage.setItem(aiHistoryKey(), JSON.stringify(state.aiHistory)); } catch { /* full — keep in memory */ }
}

async function loadAi(force) {
  if (!force && state.aiStatus) { renderAi(); return; }
  setHTML("#ai-content", `<div class="spinner-center"><div class="spinner"></div></div>`);
  if (MOCK_MODE) { state.aiStatus = "on"; renderAi(); return; }
  try {
    let res;
    try { res = await fetch(`${API_BASE}/ai/status`); }
    catch { throw new Error("Can't reach the server. Check your internet and try again."); }
    if (!res.ok) throw new Error(friendlyHttpError(res));
    const data = await res.json();
    state.aiStatus = data.enabled ? "on" : "off";
  } catch (err) {
    state.aiStatus = null;
    setHTML("#ai-content", retryState("Could not reach AI", err.message, "ai"));
    return;
  }
  renderAi();
}

function aiBubbleHTML(m) {
  const cls = m.role === "user" ? "user" : m.role === "error" ? "err" : "ai";
  // User bubbles stay plain text; assistant bubbles get the markdown treatment.
  const body = m.role === "assistant" ? mdToHtml(m.content) : esc(m.content);
  return `<div class="chat-bubble ${cls}${m.role === "assistant" ? " md" : ""}">${body}</div>`;
}

function renderAi() {
  // The clear-chat button mirrors history emptiness on every render.
  const clearBtn = $("#ai-clear-btn");
  if (clearBtn) clearBtn.disabled = state.aiHistory.length === 0;
  if (state.activeTab !== "ai") return;
  const box = $("#ai-content");
  if (state.aiStatus !== "on") {
    setHTML(box, emptyState("AI isn't configured yet", "Check back soon.", "bot"));
    return;
  }
  const inputEl = document.getElementById("ai-input");
  const inputVal = inputEl ? inputEl.value : "";
  const dis = state.aiSending ? " disabled" : "";

  let html = `<div class="chat-list" id="ai-list">`;
  if (state.aiHistory.length === 0) {
    const goal = state.prefs && state.prefs.onboarded && state.prefs.goal;
    html += `<div class="chat-bubble ai">${goal
      ? esc(`Ready to work toward ${state.prefs.goal}? Ask me anything.`)
      : "Hey! Ask me about your classes, attendance or tasks — or tap a shortcut below."}</div>`;
  }
  html += state.aiHistory.map(aiBubbleHTML).join("");
  if (state.aiSending) {
    html += `<div class="chat-bubble ai thinking" aria-label="Thinking"><span class="tdot"></span><span class="tdot"></span><span class="tdot"></span></div>`;
  }
  html += `</div>
    <div class="chat-quick">
      <button type="button" class="quick-chip" data-ai-quick="plan"${dis}>Plan my day</button>
      <button type="button" class="quick-chip" data-ai-quick="attendance"${dis}>Fix my attendance</button>
      <button type="button" class="quick-chip" data-ai-quick="roadmap"${dis}>Career roadmap</button>
      <button type="button" class="quick-chip" data-ai-quick="exam"${dis}>Exam prep</button>
    </div>
    <form id="ai-form" class="chat-form">
      <input type="text" id="ai-input" maxlength="500" placeholder="Ask about classes, attendance, tasks…" autocomplete="off"${dis} />
      <button type="submit" class="chat-send" aria-label="Send"${dis}><i data-lucide="send-horizontal"></i></button>
    </form>`;
  setHTML(box, html);

  const input = document.getElementById("ai-input");
  if (input && inputVal) input.value = inputVal;
  const list = document.getElementById("ai-list");
  if (list) list.scrollTop = list.scrollHeight;
}

// Compact snapshot of the student's situation, sent with every message.
// Short lines, hard-capped so the payload stays small.
function buildAiContext() {
  const lines = [];
  const p = state.profile || {};
  if (p.name) {
    lines.push(`Profile: ${p.name}${p.roll_no ? " · " + p.roll_no : ""}${p.department ? " · " + deptShort(p.department) : ""}`);
  } else if (state.creds) {
    lines.push(`Profile: ${state.creds.username}`);
  }
  if (state.prefs && state.prefs.goal) {
    lines.push(`Career goal: ${state.prefs.goal}`);
    if (state.prefs.interests) lines.push(`Interests: ${state.prefs.interests}`);
    if (state.prefs.weekly_hours) lines.push(`Weekly study target: ${state.prefs.weekly_hours}h`);
  }
  const blocks = todaysBlocks();
  lines.push(blocks.length
    ? "Today: " + blocks.map((b) => `${courseLabel(b.code)} ${b.start}-${b.end}`).join("; ")
    : "Today: no classes.");
  const free = freeSlotsToday();
  if (free.length) lines.push("Free today: " + free.map((f) => `${f.start}-${f.end}`).join(", "));
  const tmr = blocksForDay(DAY_KEYS[(new Date().getDay() + 7) % 7]);
  lines.push(tmr.length
    ? "Tomorrow: " + tmr.map((b) => `${courseLabel(b.code)} ${b.start}-${b.end}`).join("; ")
    : "Tomorrow: no classes.");
  const groups = attendanceGroups();
  if (groups.length) {
    lines.push("Attendance:");
    for (const g of groups) {
      let bunk = "";
      if (g.conducted > 0 && g.pct != null) {
        bunk = g.pct >= 75
          ? `can miss ${Math.floor(g.attended / 0.75 - g.conducted)}`
          : `need ${Math.ceil((0.75 * g.conducted - g.attended) / 0.25)}`;
      }
      lines.push(`- ${g.name || g.code}: ${g.pct == null ? "—" : Math.round(g.pct) + "%"} (${g.attended}/${g.conducted})${bunk ? ", " + bunk : ""}`);
    }
  }
  const open = (state.planTasks || []).filter((t) => !t.done).slice(0, 5);
  if (open.length) {
    lines.push("Pending tasks:");
    for (const t of open) lines.push(`- ${t.title}${t.due_date ? " (due " + t.due_date + ")" : ""}`);
  }
  const [wkStart, wkEnd] = weekRangeISO();
  const weekMins = (state.planBlocks || [])
    .filter((b) => b.day >= wkStart && b.day <= wkEnd)
    .reduce((s, b) => s + blockMins(b), 0);
  const goalHrs = (state.planGoals || []).reduce((s, g) => s + num(g.weekly_hours), 0);
  if (weekMins > 0 || goalHrs > 0) {
    lines.push(`Study this week: ${(weekMins / 60).toFixed(1)}h planned of ${goalHrs}h goal`);
  }
  let s = lines.join("\n");
  if (s.length > 2800) s = s.slice(0, 2797) + "...";
  return s;
}

// Like api(), but surfaces the backend's detail/message for 429/403/503 so it
// can be shown as an in-chat error bubble.
// Streams token-by-token: calls onDelta(accumulatedText) as chunks arrive and
// resolves to the full reply. Falls back transparently if the server ever
// answers with the old non-streaming JSON shape.
async function aiChat(message, history, context, onDelta) {
  const fd = new FormData();
  if (state.creds) {
    fd.set("username", state.creds.username);
    fd.set("password", state.creds.password);
  }
  for (const [k, v] of Object.entries(cookieOnlyFields())) fd.set(k, v);
  fd.set("message", message);
  fd.set("history", JSON.stringify(history));
  fd.set("context", context);

  let res;
  try {
    res = await fetch(`${API_BASE}/ai/chat`, { method: "POST", body: fd });
  } catch {
    throw new Error("Can't reach the server. Check your internet and try again.");
  }

  if (res.status === 401) {
    clearSession();
    showLogin();
    toast("Session expired. Please sign in again.", "error");
    throw new Error("unauthorized");
  }
  if (!res.ok) {
    let detail = "";
    try { const j = await res.json(); detail = j.detail || j.message || ""; } catch { /* non-JSON error body */ }
    if (res.status === 429) throw new Error(detail || "Rate limited — slow down a bit.");
    if (res.status === 403) throw new Error(detail || "AI access denied.");
    if (res.status === 503) throw new Error(detail || "AI is unavailable right now. Try again later.");
    throw new Error(detail || friendlyHttpError(res));
  }

  const ctype = res.headers.get("content-type") || "";
  if (ctype.includes("application/json")) {
    // Non-streaming fallback path
    const data = await res.json();
    if (data.cookies) saveCookies(data.cookies);
    if (data.success === false) throw new Error(data.message || data.detail || "Request failed");
    const reply = String(data.reply || "").trim() || "(empty reply)";
    if (onDelta) onDelta("t", reply, "");
    return reply;
  }

  // Streaming path: NDJSON lines {"r": reasoning delta} while the model thinks,
  // then {"t": content delta} as it answers. Plain-text = legacy all-content.
  const isNdjson = ctype.includes("ndjson");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "", reply = "", thought = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    if (!isNdjson) {
      reply = buf;
      if (onDelta) onDelta("t", reply, thought);
      continue;
    }
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        if (obj.r) thought += obj.r;
        if (obj.t) reply += obj.t;
      } catch { /* partial line — skip */ }
    }
    if (onDelta) onDelta(reply ? "t" : "r", reply, thought);
  }
  reply += decoder.decode();
  return reply.trim() || "(empty reply)";
}

async function sendAi(text) {
  text = String(text || "").trim();
  if (!text || state.aiSending || state.aiStatus !== "on") return;
  const input = document.getElementById("ai-input");
  if (input) input.value = "";
  state.aiSending = true;
  pushAi("user", text);
  renderAi();

  // Live-streaming bubbles: a dim "thought" bubble shows the model's reasoning
  // as it happens (instant feedback), the answer streams into its own bubble.
  const list = document.getElementById("ai-list");
  let streamEl = null, thoughtEl = null, lastRender = 0;
  const paint = (kind, replyText, thoughtText, force) => {
    const now = Date.now();
    if (!force && now - lastRender < 90) return;   // throttle re-render
    lastRender = now;
    if (!list) return;
    const thinking = list.querySelector(".thinking");
    if (kind === "r" && thoughtText) {
      if (thinking) thinking.remove();
      if (!thoughtEl) {
        thoughtEl = document.createElement("div");
        thoughtEl.className = "chat-bubble thought";
        thoughtEl.title = "tap to expand";
        thoughtEl.addEventListener("click", () => {
          const open = thoughtEl.classList.toggle("open");
          if (open) thoughtEl.textContent = thoughtEl.dataset.full || "";
          else thoughtEl.textContent = thoughtEl.dataset.preview || "";
        });
        list.appendChild(thoughtEl);
      }
      thoughtEl.dataset.full = thoughtText;
      // single-line preview, trimmed at a word boundary so nothing looks cut off
      let tail = thoughtText.slice(-120);
      const sp = tail.indexOf(" ");
      if (thoughtText.length > 120 && sp > 0) tail = tail.slice(sp + 1);
      thoughtEl.dataset.preview = thoughtText.length > 120 ? "… " + tail : tail;
      if (!thoughtEl.classList.contains("open")) thoughtEl.textContent = thoughtEl.dataset.preview;
      thoughtEl.scrollTop = thoughtEl.scrollHeight;
    }
    if (kind === "t" && replyText) {
      if (thinking) thinking.remove();
      if (thoughtEl && !thoughtEl.classList.contains("done")) {
        thoughtEl.classList.add("done");
        thoughtEl.textContent = "done thinking";
        thoughtEl.title = "tap to see the reasoning";
      }
      if (!streamEl) {
        streamEl = document.createElement("div");
        streamEl.className = "chat-bubble ai md streaming";
        list.appendChild(streamEl);
      }
      streamEl.innerHTML = mdToHtml(replyText);
    }
    list.scrollTop = list.scrollHeight;
  };

  try {
    let reply;
    if (MOCK_MODE) {
      let thought = "";
      for (const w of ["Let me", " check", " your", " timetable", " and", " attendance", " data", "…"]) {
        await new Promise((r) => setTimeout(r, 70));
        thought += w;
        paint("r", "", thought, false);
      }
      reply = "";
      for (const ch of MOCK_AI_REPLY.match(/[^ ]+ ?/g) || [MOCK_AI_REPLY]) {
        await new Promise((r) => setTimeout(r, 35));
        reply += ch;
        paint("t", reply, thought, false);
      }
      paint("t", reply, thought, true);
    } else {
      // Prior turns only (the current message goes in "message"), last 10,
      // error bubbles excluded from what the backend sees.
      const prior = state.aiHistory
        .filter((m) => m.role === "user" || m.role === "assistant")
        .slice(0, -1)
        .slice(-10)
        .map((m) => ({ role: m.role, content: m.content }));
      reply = await aiChat(text, prior, buildAiContext(), (kind, r, th) => paint(kind, r, th, false));
      paint("t", reply, "", true);
    }
    pushAi("assistant", reply);
  } catch (err) {
    if (err.message === "unauthorized") { state.aiSending = false; return; }
    pushAi("error", err.message || "Something went wrong.");
  }
  state.aiSending = false;
  renderAi();
}

$("#ai-content").addEventListener("submit", (e) => {
  if (e.target.id !== "ai-form") return;
  e.preventDefault();
  const input = document.getElementById("ai-input");
  sendAi(input ? input.value : "");
});

$("#ai-content").addEventListener("click", (e) => {
  const q = e.target.closest("[data-ai-quick]");
  if (!q) return;
  const key = q.dataset.aiQuick;
  const text = key === "roadmap" ? roadmapPrompt() : AI_QUICK[key];
  if (text) sendAi(text);
});

// Reopen the personalization overlay (prefilled from existing prefs).
$("#personalize-btn").addEventListener("click", openOnboarding);

/* --- Clear chat: wipe this account's history, confirmed via the shared modal --- */
$("#ai-clear-btn").addEventListener("click", () => {
  if (state.aiHistory.length === 0) return; // button is also disabled — double guard
  openModal("clear chat.", `
    <p class="confirm-text">Clear this chat? The saved conversation for this account is wiped from this device — there is no undo.</p>
    <div class="modal-actions">
      <button type="button" class="btn btn-ghost" data-chat-cancel>Cancel</button>
      <button type="button" class="btn btn-primary" data-chat-clear><i data-lucide="trash-2"></i>Clear</button>
    </div>`);
});

// Delegated so it survives the modal body's content swaps (register/scorecard
// modals never carry data-chat-* buttons, so no conflicts).
$("#modal-body").addEventListener("click", (e) => {
  if (e.target.closest("[data-chat-cancel]")) { closeModal(); return; }
  if (!e.target.closest("[data-chat-clear]")) return;
  closeModal();
  state.aiHistory = [];
  try { localStorage.removeItem(aiHistoryKey()); } catch { /* private mode */ }
  renderAi(); // empty history re-renders the greeting bubble
  toast("Chat cleared", "success");
});

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
loadAiHistory();
// App-shell service worker: relative URL keeps the scope correct when the app
// is served from a subpath (e.g. /klu/). Cross-origin API calls and POSTs are
// never intercepted (see sw.js). Best-effort — unsupported contexts just skip.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => { /* offline shell is a bonus */ });
  });
}
// Course titles arrive async — repaint whatever is already on screen once the
// catalog lands so codes swap to full names without a manual refresh.
loadCourses().then(() => {
  if (!state.creds || !state.cookies) return; // still on the login screen
  renderDashboard();
  if (state.timetable) renderTimetable();
  if (state.grades) renderGrades(); // hydrated grades never re-render when the revalidation is unchanged
  if (state.planLoaded) renderPlan();
});
if (state.creds && state.cookies) {
  showApp();
} else {
  showLogin();
}
refreshIcons(); // static placeholders (nav, buttons) on first paint
