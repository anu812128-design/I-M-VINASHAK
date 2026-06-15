import express from "express";
import fs from "fs-extra";
import path from "path";
import { fork } from "child_process";
import http from "http";
import https from "https";
import { Server } from "socket.io";

const app = express();
const PORT = process.env.PORT || 5000;
const __dirname = path.resolve();
const USERS_DIR = path.join(__dirname, "users");
if (!fs.existsSync(USERS_DIR)) fs.mkdirSync(USERS_DIR, { recursive: true });

app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "public")));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const procs = {};
const intentionalStops = new Set();
const RESTART_DELAY_MS = Number(process.env.BOT_RESTART_DELAY_MS || 5000);
const SELF_PING_INTERVAL_MS = Number(process.env.SELF_PING_INTERVAL_MS || 4 * 60 * 1000);
const SELF_URL = process.env.SELF_URL || process.env.RENDER_EXTERNAL_URL || process.env.RENDER_EXTERNAL_HOSTNAME;

function normalizeSelfUrl(value) {
  if (!value) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  return raw.startsWith("http://") || raw.startsWith("https://") ? raw : `https://${raw}`;
}

function appendLog(uid, text) {
  try {
    const userDir = path.join(USERS_DIR, String(uid));
    if (!fs.existsSync(userDir)) fs.mkdirSync(userDir, { recursive: true });
    fs.appendFileSync(path.join(userDir, "logs.txt"), `[${new Date().toISOString()}] ${text}\n`);
  } catch (e) { console.error("appendLog failed:", e.message); }
}

io.on("connection", (socket) => {
  socket.on("join", (uid) => socket.join(String(uid)));
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ---- Bot spawn helper ----
function startBot(admin) {
  admin = String(admin);
  intentionalStops.delete(admin);

  if (procs[admin]) {
    try { procs[admin].kill(); } catch {}
    delete procs[admin];
  }

  const child = fork(path.join(__dirname, "bot.js"), [String(admin)], { silent: true });

  child.stdout.on("data", (d) => {
    const text = d.toString().trim();
    if (text) { appendLog(admin, text); io.to(String(admin)).emit("botlog", text); }
  });
  child.stderr.on("data", (d) => {
    const text = d.toString().trim();
    if (text) { appendLog(admin, "[ERR] " + text); io.to(String(admin)).emit("botlog", "[ERR] " + text); }
  });
  child.on("exit", (code, sig) => {
    delete procs[admin];
    if (intentionalStops.has(admin)) {
      intentionalStops.delete(admin);
      const msg = `🔴 Bot stopped (code=${code}, sig=${sig})`;
      appendLog(admin, msg);
      io.to(String(admin)).emit("botlog", msg);
      return;
    }

    const delay = code === 42 ? 2000 : RESTART_DELAY_MS;
    const msg = code === 42
      ? `🔄 Bot restart ho raha hai...`
      : `⚠️ Bot exited (code=${code}, sig=${sig}) — auto restart ${Math.round(delay / 1000)}s mein`;
    appendLog(admin, msg);
    io.to(String(admin)).emit("botlog", msg);
    setTimeout(() => startBot(admin), delay);
  });

  procs[admin] = child;
  appendLog(admin, `✅ Bot started for admin ${admin}`);
  io.to(String(admin)).emit("botlog", `✅ Bot started for ${admin}`);
}

// ---- Start Bot ----
app.post("/start-bot", (req, res) => {
  const { appstate, admin } = req.body;
  if (!appstate || !admin) return res.status(400).send("❌ appstate or admin missing");

  const userDir = path.join(USERS_DIR, String(admin));
  fs.ensureDirSync(userDir);

  try {
    const appObj = typeof appstate === "string" ? JSON.parse(appstate) : appstate;
    fs.writeJsonSync(path.join(userDir, "appstate.json"), appObj, { spaces: 2 });
    fs.writeFileSync(path.join(userDir, "admin.txt"), String(admin));
  } catch (e) {
    return res.status(400).send("❌ Invalid appstate JSON");
  }

  startBot(admin);
  res.send(`✅ started ${admin}`);
});

// ---- Stop Bot ----
app.get("/stop-bot", (req, res) => {
  const uid = req.query.uid;
  if (!uid) return res.status(400).send("❌ uid missing");
  if (!procs[uid]) return res.send("⚠️ Bot not running");
  try {
    intentionalStops.add(String(uid));
    procs[uid].kill();
    delete procs[uid];
    appendLog(uid, "🔴 Bot stopped by panel");
    io.to(String(uid)).emit("botlog", "🔴 Bot stopped by panel");
    res.send("🔴 stopped");
  } catch (e) { res.status(500).send("❌ Failed: " + e.message); }
});

app.get(["/health", "/ping"], (req, res) => {
  res.json({ ok: true, uptime: process.uptime(), bots: Object.keys(procs).length });
});

// ---- Logs ----
app.get("/logs", (req, res) => {
  const uid = req.query.uid;
  if (!uid) return res.status(400).send("❌ uid missing");
  const lf = path.join(USERS_DIR, String(uid), "logs.txt");
  if (!fs.existsSync(lf)) return res.send("(No logs yet)");
  res.send(fs.readFileSync(lf, "utf8"));
});

// ---- Save Telegram Config ----
app.post("/save-telegram", (req, res) => {
  const { admin, token, chatId } = req.body;
  if (!admin || !token || !chatId) return res.status(400).send("❌ admin, token, chatId required");
  const userDir = path.join(USERS_DIR, String(admin));
  fs.ensureDirSync(userDir);
  try {
    fs.writeJsonSync(path.join(userDir, "telegram.json"), { token: String(token).trim(), chatId: String(chatId).trim() }, { spaces: 2 });
    res.send("✅ Telegram config saved! Restart bot to apply.");
  } catch (e) { res.status(500).send("❌ Failed: " + e.message); }
});

// ---- Groups List ----
app.get("/groups-list", (req, res) => {
  const uid = req.query.uid;
  if (!uid) return res.status(400).send("❌ uid missing");
  const gf = path.join(USERS_DIR, String(uid), "groups.json");
  if (!fs.existsSync(gf)) return res.json([]);
  try { res.json(JSON.parse(fs.readFileSync(gf, "utf8"))); } catch { res.json([]); }
});

// ---- Telegram Config (GET for panel to pre-fill) ----
app.get("/get-telegram", (req, res) => {
  const uid = req.query.uid;
  if (!uid) return res.json({});
  const tf = path.join(USERS_DIR, String(uid), "telegram.json");
  if (!fs.existsSync(tf)) return res.json({});
  try { res.json(JSON.parse(fs.readFileSync(tf, "utf8"))); } catch { res.json({}); }
});

function autoStartSavedBots() {
  try {
    for (const uid of fs.readdirSync(USERS_DIR)) {
      const appstatePath = path.join(USERS_DIR, uid, "appstate.json");
      if (fs.existsSync(appstatePath)) {
        appendLog(uid, "🚀 Server boot auto-start using saved appstate");
        startBot(uid);
      }
    }
  } catch (e) {
    console.error("autoStartSavedBots failed:", e.message);
  }
}

function startSelfPing() {
  const url = normalizeSelfUrl(SELF_URL);
  if (!url) return console.log("ℹ️ SELF_URL/RENDER_EXTERNAL_URL not set; self-ping disabled");
  const pingUrl = `${url.replace(/\/$/, "")}/ping`;
  setInterval(() => {
    const client = pingUrl.startsWith("https://") ? https : http;
    client.get(pingUrl, res => res.resume()).on("error", e => console.log("⚠️ self-ping failed:", e.message));
  }, SELF_PING_INTERVAL_MS).unref();
  console.log(`💓 Self-ping enabled: ${pingUrl}`);
}

app.use((req, res) => {
  if (req.accepts("html")) return res.sendFile(path.join(__dirname, "public", "index.html"));
  res.status(404).json({ ok: false, error: "Not found" });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 ANURAG PANEL running on http://0.0.0.0:${PORT}`);
  autoStartSavedBots();
  startSelfPing();
});
