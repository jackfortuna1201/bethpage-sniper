const fetch = (...args) => import("node-fetch").then(({ default: f }) => f(...args));
const twilio = require("twilio");

const CONFIG = {
  TWILIO_ACCOUNT_SID: process.env.TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN:  process.env.TWILIO_AUTH_TOKEN,
  TWILIO_FROM:        process.env.TWILIO_FROM,
  ALERT_TO:           process.env.ALERT_TO,
  TARGET_DATE:   process.env.TARGET_DATE   || "",
  START_TIME:    process.env.START_TIME    || "08:00",
  END_TIME:      process.env.END_TIME      || "13:00",
  PLAYERS:       parseInt(process.env.PLAYERS || "4"),
  COURSES:       process.env.COURSES       || "Black,Red,Blue,Green,Yellow",
  SCAN_INTERVAL: parseInt(process.env.SCAN_INTERVAL || "30"),
};

const COURSE_MAP = {
  Black: "2431", Red: "2432", Blue: "2433", Green: "2434", Yellow: "2435",
};
const FACILITY_ID = "19765";
const alreadyAlerted = new Set();

function timeToMinutes(str = "") {
  const clean = str.length > 5 ? str.substring(11, 16) : str.substring(0, 5);
  const [h, m] = clean.split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
}

function formatTime(raw = "") {
  const clean = raw.length > 5 ? raw.substring(11, 16) : raw.substring(0, 5);
  const [h, m] = clean.split(":").map(Number);
  const ampm = h >= 12 ? "PM" : "AM";
  return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${ampm}`;
}

function getDatesToScan() {
  if (CONFIG.TARGET_DATE) return [CONFIG.TARGET_DATE];
  const dates = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date();
    d.setDate(d.getDate() + i);
    dates.push(d.toISOString().split("T")[0]);
  }
  return dates;
}

async function sendSMS(body) {
  try {
    const client = twilio(CONFIG.TWILIO_ACCOUNT_SID, CONFIG.TWILIO_AUTH_TOKEN);
    await client.messages.create({ body, from: CONFIG.TWILIO_FROM, to: CONFIG.ALERT_TO });
    console.log(`SMS sent: ${body.substring(0, 60)}`);
  } catch (err) {
    console.error("SMS failed:", err.message);
  }
}

async function scanCourse(courseName, courseId, date) {
  const url = `https://foreupsoftware.com/index.php/api/booking/times?time=all&date=${date}&holes=18&players=${CONFIG.PLAYERS}&booking_class=0&schedule_id=${courseId}&schedule_ids[]=${courseId}&specials_only=0&api_key=no_limits&facility_id=${FACILITY_ID}`;
  const res = await fetch(url, { headers: { "Accept": "application/json", "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const times = Array.isArray(data) ? data : (data.teetimes || data.data || []);
  const startMin = timeToMinutes(CONFIG.START_TIME);
  const endMin   = timeToMinutes(CONFIG.END_TIME);
  return times.filter(t => {
    const raw  = t.time || t.teetime || t.start_time || "";
    const mins = timeToMinutes(raw);
    const spots = t.available_spots ?? t.available ?? t.spaces ?? 1;
    return mins >= startMin && mins <= endMin && spots >= CONFIG.PLAYERS;
  });
}

async function runScan() {
  const dates   = getDatesToScan();
  const courses = CONFIG.COURSES.split(",").map(s => s.trim());
  console.log(`[${new Date().toLocaleTimeString()}] Scanning ${courses.length} courses x ${dates.length} dates`);
  for (const date of dates) {
    for (const courseName of courses) {
      const courseId = COURSE_MAP[courseName];
      if (!courseId) continue;
      try {
        const hits = await scanCourse(courseName, courseId, date);
        if (!hits.length) { console.log(`  o ${courseName} ${date}: none`); continue; }
        for (const hit of hits) {
          const raw = hit.time || hit.teetime || hit.start_time || "";
          const key = `${courseId}|${date}|${raw}`;
          if (alreadyAlerted.has(key)) continue;
          alreadyAlerted.add(key);
          const spots = hit.available_spots ?? hit.available ?? hit.spaces ?? "?";
          const msg = `BETHPAGE ${courseName.toUpperCase()} - ${date}\n${formatTime(raw)} | ${spots} spots\nBook: https://foreupsoftware.com/index.php/booking/${FACILITY_ID}/${courseId}#teetimes`;
          console.log(`  FOUND: ${courseName} ${date} ${formatTime(raw)}`);
          await sendSMS(msg);
        }
      } catch (err) {
        console.warn(`  x ${courseName} ${date}: ${err.message}`);
      }
    }
  }
}

async function main() {
  console.log("BETHPAGE SNIPER STARTED");
  console.log(`Courses: ${CONFIG.COURSES} | Window: ${CONFIG.START_TIME}-${CONFIG.END_TIME} | Players: ${CONFIG.PLAYERS}`);
  if (!CONFIG.TWILIO_ACCOUNT_SID || !CONFIG.TWILIO_AUTH_TOKEN || !CONFIG.TWILIO_FROM || !CONFIG.ALERT_TO) {
    console.error("Missing Twilio env vars"); process.exit(1);
  }
  await runScan();
  setInterval(runScan, CONFIG.SCAN_INTERVAL * 1000);
}

main().catch(err => { console.error(err); process.exit(1); });
