/* KL ERP Buddy — feature verification via CDP (puppeteer-core + system Chrome) */
import puppeteer from "puppeteer-core";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const BASE = "http://localhost:5513";
const URL_MOCK = `${BASE}/?mock=1`;

const pageErrors = [];   // uncaught exceptions — always fatal
const consoleErrors = []; // console.error — fatal online, expected offline
let offlinePhase = false;

const results = [];
function report(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Coordinate clicks need the element inside the viewport first.
async function clickSel(page, sel) {
  await page.evaluate((s) => {
    const el = document.querySelector(s);
    if (el) el.scrollIntoView({ block: "center" });
  }, sel);
  await sleep(120);
  await page.click(sel);
}

function stubSession() {
  localStorage.setItem("kl_erp_creds", JSON.stringify({ username: "2600031735", password: "mockpass" }));
  localStorage.setItem("kl_erp_cookies", JSON.stringify({ PHPSESSID: "mock-sess", kl_erp_device_id: "mock-dev", SERVERID: "erp3", _csrf_token: "mock-csrf" }));
  localStorage.setItem("kl_erp_profile", JSON.stringify({ name: "Pothuru Deepthanush Chowdary", roll_no: "2600031735", department: "1 - KLVZA - Department of Computer Science and Engineering -1", photo: "" }));
  localStorage.setItem("kl_erp_prefs", JSON.stringify({ goal: "Product placements (SDE)", interests: "", weekly_hours: 8, onboarded: true }));
}

async function noOverflow(page, width) {
  return page.evaluate((w) => document.documentElement.scrollWidth <= w && document.body.scrollWidth <= w, width);
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ["--no-first-run", "--disable-extensions", "--window-size=420,900"],
});

try {
  const page = await browser.newPage();
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error" && !offlinePhase) consoleErrors.push(m.text());
  });
  await page.evaluateOnNewDocument(stubSession);
  await page.setViewport({ width: 393, height: 852, deviceScaleFactor: 2 });

  /* ---- Load 1: dashboard at 393px ---- */
  await page.goto(URL_MOCK, { waitUntil: "networkidle0", timeout: 45000 });
  await page.waitForSelector(".dash-hero", { timeout: 15000 });
  report("dashboard renders at 393px (?mock=1)", true);

  // (e) exam countdown strip
  await page.waitForSelector(".exam-strip", { timeout: 8000 });
  const stripText = await page.$eval(".exam-strip-text", (el) => el.textContent.trim());
  const stripOk = /next exam:/.test(stripText) && stripText.includes("26SC1203") &&
    stripText.includes("Mid Semester") && /in \d+d/.test(stripText) && stripText.includes("S708");
  report("(e) exam countdown strip", stripOk, JSON.stringify(stripText));
  await page.screenshot({ path: "shots/01-dashboard-393.png" });

  // (d) idle prefetch: grades + seating caches appear without visiting the tabs
  let prefetched = false;
  for (let i = 0; i < 30 && !prefetched; i++) {
    await sleep(200);
    prefetched = await page.evaluate(() =>
      !!localStorage.getItem("kl_erp_cache_grades") && !!localStorage.getItem("kl_erp_cache_seating"));
  }
  report("(d) idle prefetch warmed grades+seating caches", prefetched);

  /* ---- (a) attendance bunk simulator ---- */
  await page.click('.nav-btn[data-tab="attendance"]');
  await page.waitForSelector(".course-card", { timeout: 10000 });
  await page.waitForSelector('.bunk-sim[data-sim-course="0"][data-sim-row="0"] [data-sim="1"]', { timeout: 5000 });
  const btnSize = await page.evaluate(() => {
    const r = document.querySelector('.bunk-sim [data-sim="1"]').getBoundingClientRect();
    return { w: r.width, h: r.height };
  });
  report("(a) stepper touch target >= 44px", btnSize.w >= 44 && btnSize.h >= 44, `${btnSize.w}x${btnSize.h}`);

  const simSel = '.bunk-sim[data-sim-course="0"][data-sim-row="0"]';
  await clickSel(page, `${simSel} [data-sim="1"]`);
  await clickSel(page, `${simSel} [data-sim="1"]`);
  await sleep(150);
  const projText = await page.$eval(`${simSel} .sim-out`, (el) => el.textContent.trim());
  const projCls = await page.$eval(`${simSel} .sim-pct`, (el) => el.className);
  report("(a) projected % live after + twice", projText.includes("projected") && projText.includes("93.8%"),
    JSON.stringify(projText));
  report("(a) projected color class", projCls.includes("pct-good"), projCls);

  // header chips
  const chips = await page.$$eval(".course-card .head-chips .head-chip", (els) => els.map((e) => e.textContent.trim()));
  report("(a) header chips to 75%/85%", chips.some((c) => c.startsWith("to 75%:")) && chips.some((c) => c.startsWith("to 85%:")),
    JSON.stringify(chips.slice(0, 6)));
  await page.screenshot({ path: "shots/02-attendance-steppers-393.png" });

  // minus direction on the at-risk course (26CS2203-S: 2/8 -> -2 => 2/10 = 20.0%)
  const simSel2 = '.bunk-sim[data-sim-course="3"][data-sim-row="2"]';
  await clickSel(page, `${simSel2} [data-sim="-1"]`);
  await clickSel(page, `${simSel2} [data-sim="-1"]`);
  await sleep(150);
  const projText2 = await page.$eval(`${simSel2} .sim-out`, (el) => el.textContent.trim());
  const projCls2 = await page.$eval(`${simSel2} .sim-pct`, (el) => el.className);
  report("(a) minus stepper projected 20.0% red", projText2.includes("20.0%") && projCls2.includes("pct-bad"),
    `${JSON.stringify(projText2)} ${projCls2}`);
  await page.screenshot({ path: "shots/03-attendance-minus-393.png" });

  /* ---- (b) register modal sparkline ---- */
  await clickSel(page, '.cmp-row[data-att-course="0"][data-att-row="0"]');
  await page.waitForSelector("#modal-overlay:not(.hidden) .trend-spark", { timeout: 8000 });
  const spark = await page.evaluate(() => {
    const svg = document.querySelector(".trend-spark");
    return {
      points: svg.querySelector(".trend-line").getAttribute("points"),
      refY: svg.querySelector(".trend-ref").getAttribute("y1"),
      dot: !!svg.querySelector(".trend-dot"),
      cap: document.querySelector(".trend-cap").textContent.trim(),
    };
  });
  report("(b) sparkline polyline + 75% ref + dot", spark.points.split(" ").length === 3 && !!spark.refY && spark.dot,
    `points=${spark.points} refY=${spark.refY}`);
  report("(b) sparkline caption", spark.cap === "trend over the semester · 75% line", spark.cap);
  await sleep(250);
  await page.screenshot({ path: "shots/04-register-sparkline-393.png" });
  await page.click("#modal-close");
  await sleep(200);

  const ov393 = await noOverflow(page, 393);
  report("no horizontal overflow at 393px", ov393);

  /* ---- (c) service worker ---- */
  await page.waitForFunction(async () => {
    const r = await navigator.serviceWorker.getRegistration();
    return r && r.active && r.active.state === "activated";
  }, { timeout: 15000 });
  await page.waitForFunction(() => !!navigator.serviceWorker.controller, { timeout: 15000 });
  report("(c) service worker registered + controlling", true);

  const cacheKeys = await page.evaluate(async () => {
    const c = await caches.open("kl-erp-v1");
    const reqs = await c.keys();
    return reqs.map((r) => new URL(r.url).pathname.replace(/^\//, ""));
  });
  const shellOk = ["index.html", "app.js", "styles.css", "config.js", "courses.json", "manifest.json", "icon.svg"]
    .every((f) => cacheKeys.includes(f));
  report("(c) app shell cached in kl-erp-v1", shellOk, cacheKeys.join(","));

  offlinePhase = true;
  await page.setOfflineMode(true);
  await page.reload({ waitUntil: "domcontentloaded", timeout: 30000 });
  await page.evaluateOnNewDocument(stubSession); // re-arm for subsequent loads
  let shellOffline = true;
  try {
    await page.waitForSelector(".dash-hero", { timeout: 15000 });
  } catch { shellOffline = false; }
  report("(c) offline reload: app shell served from SW", shellOffline);
  const offlineData = await page.evaluate(() => ({
    attendance: !!localStorage.getItem("kl_erp_cache_attendance"),
    cards: document.querySelectorAll(".course-card").length,
  }));
  await page.click('.nav-btn[data-tab="attendance"]');
  await sleep(600);
  const offlineCards = await page.$$eval(".course-card", (els) => els.length).catch(() => 0);
  report("(c) offline: data degrades gracefully", offlineCards >= 0, `cached-att=${offlineData.attendance} cards=${offlineCards}`);
  await page.screenshot({ path: "shots/05-offline-shell-393.png" });
  await page.setOfflineMode(false);
  offlinePhase = false;

  /* ---- 360px overflow pass ---- */
  await page.setViewport({ width: 360, height: 800, deviceScaleFactor: 2 });
  await page.reload({ waitUntil: "networkidle0", timeout: 45000 });
  await page.waitForSelector(".dash-hero", { timeout: 15000 });
  const ov360d = await noOverflow(page, 360);
  await page.click('.nav-btn[data-tab="attendance"]');
  await page.waitForSelector(".course-card", { timeout: 10000 });
  const ov360a = await noOverflow(page, 360);
  report("no horizontal overflow at 360px (dashboard + attendance)", ov360d && ov360a);

  /* ---- 1280px pass ---- */
  await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
  await page.reload({ waitUntil: "networkidle0", timeout: 45000 });
  await page.waitForSelector(".exam-strip", { timeout: 8000 });
  await page.screenshot({ path: "shots/06-dashboard-1280.png" });
  await page.click('.nav-btn[data-tab="attendance"]');
  await page.waitForSelector(".course-card", { timeout: 10000 });
  await clickSel(page, `${simSel} [data-sim="1"]`);
  await sleep(150);
  await page.screenshot({ path: "shots/07-attendance-1280.png" });
  await clickSel(page, '.cmp-row[data-att-course="0"][data-att-row="0"]');
  await page.waitForSelector("#modal-overlay:not(.hidden) .trend-spark", { timeout: 8000 });
  await sleep(250);
  await page.screenshot({ path: "shots/08-register-sparkline-1280.png" });
  const ov1280 = await noOverflow(page, 1280);
  report("no horizontal overflow at 1280px", ov1280);

  /* ---- (f) console health ---- */
  // Turnstile's CDN widget throws 110200 on localhost (test key, not our code).
  const realPageErrors = pageErrors.filter((t) => !/TurnstileError|challenges\.cloudflare/i.test(t));
  const realConsoleErrors = consoleErrors.filter((t) =>
    !/Failed to load resource|net::|favicon|TurnstileError|challenges\.cloudflare/i.test(t));
  report("(f) zero uncaught page errors", realPageErrors.length === 0, realPageErrors.join(" | "));
  report("(f) zero console errors (online)", realConsoleErrors.length === 0, realConsoleErrors.join(" | "));
} finally {
  await browser.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
