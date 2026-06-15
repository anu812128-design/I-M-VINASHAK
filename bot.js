import { createRequire } from "module";
import fs from "fs";
import path from "path";
import http from "http";
import https from "https";

const require = createRequire(import.meta.url);
const { login } = require("anuragxarohi");

const ADMIN_ARG = process.argv[2];
if (!ADMIN_ARG) {
  console.error("❌ Missing admin UID arg. Usage: node bot.js <adminUID>");
  process.exit(1);
}

const ROOT = process.cwd();
const USER_DIR = path.join(ROOT, "users", String(ADMIN_ARG));
const APPSTATE_PATH = path.join(USER_DIR, "appstate.json");
const ADMIN_PATH = path.join(USER_DIR, "admin.txt");
const LOCKS_PATH = path.join(USER_DIR, "locks.json");
const PHOTOS_DIR = path.join(USER_DIR, "photos");
const TELEGRAM_PATH = path.join(USER_DIR, "telegram.json");
const GROUPS_PATH = path.join(USER_DIR, "groups.json");
const APPSTATE_BACKUP_PATH = path.join(USER_DIR, "appstate.backup.json");
const LOCK_RECHECK_INTERVAL_MS = Number(process.env.LOCK_RECHECK_INTERVAL_MS || 2 * 60 * 1000);
const APPSTATE_SAVE_INTERVAL_MS = Number(process.env.APPSTATE_SAVE_INTERVAL_MS || 5 * 60 * 1000);

const BOT_NICKNAME = "😍 फातिमा की गुलाबी बुर 😘";

if (!fs.existsSync(USER_DIR)) {
  console.error("❌ User folder not found:", USER_DIR);
  process.exit(1);
}
if (!fs.existsSync(PHOTOS_DIR)) {
  try { fs.mkdirSync(PHOTOS_DIR, { recursive: true }); } catch (e) {}
}

let appState;
try {
  appState = JSON.parse(fs.readFileSync(APPSTATE_PATH, "utf8"));
} catch (e) {
  console.error("❌ Failed reading appstate.json:", e.message);
  process.exit(1);
}

let BOSS_UID = ADMIN_ARG;
try {
  if (fs.existsSync(ADMIN_PATH)) {
    const t = fs.readFileSync(ADMIN_PATH, "utf8").trim();
    if (t) BOSS_UID = t;
  }
} catch {}

let locks = { groupNames: {}, nicknames: {}, emojis: {}, antiOut: {}, groupPics: {} };
try {
  if (fs.existsSync(LOCKS_PATH)) locks = JSON.parse(fs.readFileSync(LOCKS_PATH, "utf8"));
} catch {}

let tgConfig = { token: null, chatId: null };
try {
  if (fs.existsSync(TELEGRAM_PATH)) {
    const t = JSON.parse(fs.readFileSync(TELEGRAM_PATH, "utf8"));
    if (t.token && t.chatId) tgConfig = t;
  }
} catch {}

function saveLocks() {
  try { fs.writeFileSync(LOCKS_PATH, JSON.stringify(locks, null, 2)); } catch (e) { log("❌ Failed saving locks: " + e.message); }
}

function saveAppState(api) {
  try {
    if (!api || typeof api.getAppState !== "function") return false;
    const latest = api.getAppState();
    if (!latest) return false;
    try {
      if (fs.existsSync(APPSTATE_PATH)) fs.copyFileSync(APPSTATE_PATH, APPSTATE_BACKUP_PATH);
    } catch {}
    fs.writeFileSync(APPSTATE_PATH, JSON.stringify(latest, null, 2));
    appState = latest;
    return true;
  } catch (e) {
    log("⚠️ Failed saving fresh appstate: " + e.message);
    return false;
  }
}

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function downloadToFile(url, dest) {
  return new Promise((resolve, reject) => {
    try {
      const lib = url.startsWith("https") ? https : http;
      const req = lib.get(url, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location)
          return downloadToFile(res.headers.location, dest).then(resolve).catch(reject);
        if (res.statusCode !== 200) return reject(new Error("Download failed: " + res.statusCode));
        const f = fs.createWriteStream(dest);
        res.pipe(f);
        f.on("finish", () => f.close(() => resolve(dest)));
        f.on("error", reject);
      });
      req.on("error", reject);
    } catch (e) { reject(e); }
  });
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---- Queues ----
const nickQueue = [];
let nickProcessing = false;
const nameQueue = [];
let nameProcessing = false;

function enqueueNickTask(fn) {
  return new Promise(resolve => {
    nickQueue.push({ fn, resolve });
    if (!nickProcessing) processNickQueue();
  });
}
function enqueueNameTask(fn) {
  return new Promise(resolve => {
    nameQueue.push({ fn, resolve });
    if (!nameProcessing) processNameQueue();
  });
}
async function processNickQueue() {
  nickProcessing = true;
  while (nickQueue.length) {
    const item = nickQueue.shift();
    try { await item.fn(); } catch (e) { log("❌ nick queue: " + e.message); }
    try { item.resolve(); } catch {}
    await sleep(500);
  }
  nickProcessing = false;
}
async function processNameQueue() {
  nameProcessing = true;
  while (nameQueue.length) {
    const item = nameQueue.shift();
    try { await item.fn(); } catch (e) { log("❌ name queue: " + e.message); }
    try { item.resolve(); } catch {}
    await sleep(600);
  }
  nameProcessing = false;
}

// ---- API wrappers: setNickname (anuragxarohi), gcname ----
async function retryChangeNick(api, threadID, uid, nick, retries = 5) {
  const nickFn = api.setNickname || api.changeNickname;
  if (typeof nickFn !== "function") { log("❌ Nickname fn (setNickname) not found"); return false; }
  let lastErr = null;
  await enqueueNickTask(async () => {
    for (let i = 0; i < retries; i++) {
      try {
        lastErr = null;
        await new Promise(res => nickFn.call(api, nick, threadID, uid, err => { lastErr = err; res(); }));
        if (!lastErr) return;
      } catch (e) { lastErr = e; }
      if (i < retries - 1) await sleep(300 + i * 250);
    }
  });
  if (lastErr) { log(`❌ changeNick failed for ${uid}`); return false; }
  return true;
}

async function retrySetTitle(api, threadID, name, retries = 6) {
  const titleFn = api.gcname || api.setTitle || api.setTitleDelta || api.threadTitle;
  if (typeof titleFn !== "function") { log("❌ Group name fn (gcname/setTitle) not found"); return false; }
  let lastErr = null;
  for (let i = 0; i < retries; i++) {
    try {
      lastErr = null;
      await new Promise(res => titleFn.call(api, name, threadID, err => { lastErr = err; res(); }));
      if (!lastErr) return true;
    } catch (e) { lastErr = e; }
    if (i < retries - 1) await sleep(400 + i * 300);
  }
  if (lastErr) log(`❌ setTitle failed for ${threadID}: ${lastErr.message || lastErr}`);
  return false;
}

async function revertSingleNick(api, threadID, uid) {
  const locked = locks.nicknames?.[threadID]?.[uid];
  if (!locked) return;
  await retryChangeNick(api, threadID, uid, locked, 5);
  log(`🔁 Reverted nick for ${uid} in ${threadID}`);
}

async function enforceNickLockForThread(api, threadID, nick) {
  const info = await api.getThreadInfo(threadID);
  const members = info?.participantIDs || [];
  log(`🔐 Enforcing nicklock for ${members.length} members in ${threadID}...`);
  for (const uid of members) {
    await retryChangeNick(api, threadID, uid, nick, 5);
    await sleep(600);
  }
  locks.nicknames[threadID] = {};
  members.forEach(uid => { locks.nicknames[threadID][uid] = nick; });
  saveLocks();
  log(`✅ Nicklock enforced for ${threadID}`);
  return true;
}

async function revertGroupNameLocked(api, threadID) {
  const lockedName = locks.groupNames?.[threadID];
  if (!lockedName) return;
  await enqueueNameTask(async () => {
    const ok = await retrySetTitle(api, threadID, lockedName, 6);
    log(ok ? `🔒 Name reverted in ${threadID}: ${lockedName}` : `⚠️ Failed to revert name in ${threadID}`);
  });
}

async function recheckAllLocks(api, botUID) {
  try {
    const groupNameLocks = Object.entries(locks.groupNames || {});
    for (const [threadID, lockedName] of groupNameLocks) {
      try {
        const info = await api.getThreadInfo(threadID);
        const current = info?.threadName || info?.name || "";
        if (lockedName && current && current !== lockedName) {
          log(`🛡️ Periodic name check: ${threadID} is "${current}"; reverting to "${lockedName}"`);
          await revertGroupNameLocked(api, threadID);
        }
        await sleep(800);
      } catch (e) { log(`⚠️ Name recheck failed for ${threadID}: ${e.message}`); }
    }

    for (const [threadID, memberLocks] of Object.entries(locks.nicknames || {})) {
      try {
        const info = await api.getThreadInfo(threadID);
        const currentNicknames = info?.nicknames || info?.nickNames || {};
        for (const [uid, lockedNick] of Object.entries(memberLocks || {})) {
          if (!lockedNick) continue;
          const currentNick = currentNicknames?.[uid] || "";
          if (currentNick === lockedNick) continue;
          try {
            await retryChangeNick(api, threadID, uid, lockedNick, 3);
            await sleep(500);
          } catch (e) { log(`⚠️ Nick recheck failed for ${uid} in ${threadID}: ${e.message}`); }
        }
      } catch (e) { log(`⚠️ Nick recheck thread info failed for ${threadID}: ${e.message}`); }
    }

    saveLocks();
  } catch (e) {
    log("⚠️ Lock recheck error: " + e.message);
  }
}

// ---- Telegram via raw HTTPS (no npm package needed) ----
function tgPost(token, method, body = {}) {
  return new Promise((resolve) => {
    const data = JSON.stringify(body);
    const options = {
      hostname: "api.telegram.org",
      path: `/bot${token}/${method}`,
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) }
    };
    const req = https.request(options, (res) => {
      let raw = "";
      res.on("data", c => raw += c);
      res.on("end", () => { try { resolve(JSON.parse(raw)); } catch { resolve({}); } });
    });
    req.on("error", () => resolve({}));
    req.write(data);
    req.end();
  });
}

function tgSend(token, chatId, text) {
  return tgPost(token, "sendMessage", { chat_id: chatId, text, parse_mode: "HTML" });
}

// ---- Load and cache groups ----
// anuragxarohi's getThreadList is async (returns Promise directly, no callback)
async function loadAndSaveGroups(api) {
  try {
    const list = await api.getThreadList(100, null, ["INBOX"]);
    if (!list || !list.length) return [];
    const groups = list.filter(t => t.isGroup).map(g => ({
      threadID: String(g.threadID),
      name: g.name || "Unknown Group"
    }));
    try { fs.writeFileSync(GROUPS_PATH, JSON.stringify(groups, null, 2)); } catch {}
    return groups;
  } catch (e) {
    log("❌ getThreadList error: " + e.message);
    return [];
  }
}

// ---- Send group list to Telegram ----
async function sendGroupListToTg(api, token, chatId) {
  try {
    const groups = await loadAndSaveGroups(api);
    if (!groups.length) {
      return tgSend(token, chatId, "⚠️ No groups found. Make sure the bot is in some groups.");
    }
    let msg = `👥 <b>FACEBOOK GROUPS</b> (${groups.length})\n\n`;
    groups.forEach((g, i) => {
      msg += `${i + 1}. <b>${g.name}</b>\n   🔑 Code: <code>/@${g.threadID}</code>\n\n`;
    });
    msg += `💡 <b>Command format:</b>\n<code>/@CODE /command</code>\n\n<b>Example:</b>\n<code>/@${groups[0].threadID} /groupname on Test</code>`;
    return tgSend(token, chatId, msg);
  } catch (e) {
    log("❌ sendGroupListToTg: " + e.message);
    return tgSend(token, chatId, "❌ Error loading groups: " + e.message);
  }
}

// ---- Shared command processor (used by both FB and Telegram) ----
async function processCmd(api, threadID, cmd, args, botUID, replyFn) {
  if (cmd === "anurag") {
    return replyFn(
      `👑 ANURAG BOT COMMANDS\n\n` +
      `/groupname on <name> → Lock group name\n` +
      `/groupname off → Unlock group name\n\n` +
      `/nicknames on <nick> → Lock all nicknames\n` +
      `/nicknames off → Unlock nicknames\n\n` +
      `/photolock on → Lock group photo\n` +
      `/photolock off → Unlock group photo\n` +
      `/photolock reset → Restore locked photo\n\n` +
      `🧠 Admin: ${BOSS_UID}\n` +
      `🔰 Powered by Anurag Mishra`
    );
  }

  if (cmd === "groupname") {
    const sub = (args[0] || "").toLowerCase();
    if (sub === "on") {
      const name = args.slice(1).join(" ");
      if (!name) return replyFn("⚠️ Usage: /groupname on <Name>");
      locks.groupNames[threadID] = name;
      saveLocks();
      await enqueueNameTask(async () => {
        const ok = await retrySetTitle(api, threadID, name, 6);
        if (ok) {
          await replyFn(`✅ Group name LOCKED: ${name}\n🔒 Protection activated`);
          log(`✅ Group name locked: ${name} in ${threadID}`);
        } else {
          await replyFn(`❌ Failed to lock name: ${name}`);
        }
      });
      return;
    }
    if (sub === "off") {
      delete locks.groupNames[threadID];
      saveLocks();
      return replyFn("🔓 Group name unlocked");
    }
    return replyFn("⚠️ Usage: /groupname on <Name> | /groupname off");
  }

  if (cmd === "nicknames") {
    const sub = (args[0] || "").toLowerCase();
    if (sub === "on") {
      const nick = args.slice(1).join(" ");
      if (!nick) return replyFn("⚠️ Usage: /nicknames on <Nick>");
      await replyFn(`🔐 Locking nicknames as "${nick}"... Please wait...`);
      await enforceNickLockForThread(api, threadID, nick);
      return replyFn(`✅ NICKNAMES LOCKED: "${nick}"\n🔒 All members protected!`);
    }
    if (sub === "off") {
      const existed = locks.nicknames[threadID];
      if (existed) {
        delete locks.nicknames[threadID];
        saveLocks();
        return replyFn("🔓 Nickname lock hataya — kisi ka nickname change nahi kiya");
      }
      return replyFn("⚠️ No nicknames locked in this group");
    }
    return replyFn("⚠️ Usage: /nicknames on <Nick> | /nicknames off");
  }

  if (cmd === "photolock") {
    const sub = (args[0] || "").toLowerCase();
    const fetchImg = async () => {
      try {
        const info = await api.getThreadInfo(threadID);
        return info?.imageSrc || info?.threadImage || info?.image || "";
      } catch { return ""; }
    };
    if (sub === "on") {
      const url = await fetchImg();
      if (!url) return replyFn("⚠️ No group photo found.");
      const ext = (url.match(/\.(jpg|jpeg|png|webp)$/i) || ["", "jpg"])[1];
      const filename = path.join(PHOTOS_DIR, `${threadID}.${ext}`);
      try {
        await downloadToFile(url, filename);
        locks.groupPics[threadID] = { file: filename, url };
        saveLocks();
        return replyFn("📸 Group photo locked!");
      } catch (e) {
        log("❌ download error: " + e.message);
        return replyFn("❌ Failed to save group photo.");
      }
    }
    if (sub === "off") {
      delete locks.groupPics[threadID];
      saveLocks();
      return replyFn("🔓 Group photo unlocked.");
    }
    if (sub === "reset") {
      const locked = locks.groupPics?.[threadID];
      if (locked?.file && fs.existsSync(locked.file)) {
        const fn = api.changeGroupImage || api.setGroupImage;
        if (typeof fn === "function") {
          await fn.call(api, fs.createReadStream(locked.file), threadID);
          return replyFn("🔁 Group photo reset to locked image.");
        }
        return replyFn("⚠️ changeGroupImage not available.");
      }
      return replyFn("⚠️ No saved photo found.");
    }
    const has = locks.groupPics?.[threadID] ? "ON" : "OFF";
    return replyFn(`📸 Photo lock: ${has}`);
  }
}

// ---- Telegram command handler (/@GCODE /command) ----
async function handleTgCommand(api, threadID, commandText, token, chatId, botUID) {
  const parts = commandText.trim().split(/\s+/);
  const cmd = parts[0].replace(/^\//, "").toLowerCase();
  const args = parts.slice(1);

  const replyFn = async (msg) => {
    await tgSend(token, chatId, `📨 <b>Group ${threadID}:</b>\n${msg}`);
    log(`📱 Telegram command /${cmd} on ${threadID}`);
  };

  await processCmd(api, threadID, cmd, args, botUID, replyFn);
}

function runTelegramTask(label, task) {
  setImmediate(async () => {
    try {
      await task();
    } catch (e) {
      log(`⚠️ Telegram task failed (${label}): ${e.message}`);
    }
  });
}

// ---- Start Telegram polling ----
async function startTelegram(token, chatId, api, botUID) {
  log("📱 Starting Telegram bot polling...");
  try {
    await tgSend(token, chatId,
      `🤖 <b>ANURAG BOT IS ONLINE!</b>\n\n` +
      `📋 Commands:\n` +
      `/groups - List all Facebook groups\n` +
      `/help - Show command help\n` +
      `<code>/@CODE /command</code> - Send to group`
    );
    runTelegramTask("startup groups", () => sendGroupListToTg(api, token, chatId));
  } catch (e) { log("⚠️ Telegram startup msg failed: " + e.message); }

  let offset = 0;
  const poll = async () => {
    try {
      const res = await tgPost(token, "getUpdates", { offset, timeout: 25, allowed_updates: ["message"] });
      if (res.ok && res.result?.length) {
        for (const upd of res.result) {
          offset = upd.update_id + 1;
          const msg = upd.message;
          if (!msg?.text) continue;
          if (String(msg.chat.id) !== String(chatId)) continue;

          // Strip bot username only from /command@BotName → /command
          // Do NOT touch /@GCODE format (e.g. /@1178211057845842 /groupname on Test)
          const txt = msg.text.trim().replace(/^(\/[a-zA-Z_]+)@\S+/, "$1");
          log(`📱 Telegram msg: ${txt}`);

          if (txt === "/groups" || txt === "/list") {
            await tgSend(token, chatId, "⏳ Groups load ho rahe hain... response yahin aayega.");
            runTelegramTask("groups", () => sendGroupListToTg(api, token, chatId));
          } else if (txt === "/help") {
            await tgSend(token, chatId,
              `📋 <b>ANURAG BOT COMMANDS</b>\n\n` +
              `<b>Telegram:</b>\n` +
              `/groups - List Facebook groups\n` +
              `<code>/@CODE /command</code> - Send to group\n\n` +
              `<b>Facebook commands:</b>\n` +
              `/groupname on &lt;name&gt;\n` +
              `/groupname off\n` +
              `/nicknames on &lt;nick&gt;\n` +
              `/nicknames off\n` +
              `/photolock on/off/reset\n` +
              `/anurag - Full help\n\n` +
              `<b>Example:</b>\n` +
              `<code>/@100123456 /groupname on My Group</code>`
            );
          } else if (txt === "/stop") {
            await tgSend(token, chatId, "🔴 Bot band ho raha hai...");
            log("🔴 Bot stopped via Telegram /stop command");
            setTimeout(() => process.exit(0), 1000);
          } else if (txt === "/restart") {
            await tgSend(token, chatId, "🔄 Bot restart ho raha hai... thodi der mein wapas aayega!");
            log("🔄 Bot restarting via Telegram /restart command");
            setTimeout(() => process.exit(42), 1000);
          } else if (txt.startsWith("/@")) {
            const spaceIdx = txt.indexOf(" ");
            if (spaceIdx !== -1) {
              const gcCode = txt.slice(2, spaceIdx).trim();
              const cmd = txt.slice(spaceIdx + 1).trim();
              if (gcCode && cmd) {
                await tgSend(token, chatId, `⚡ Command received for <code>${gcCode}</code>. Execute ho raha hai, final response yahin aayega.`);
                runTelegramTask(`/${gcCode}`, () => handleTgCommand(api, gcCode, cmd, token, chatId, botUID));
              } else {
                await tgSend(token, chatId, "⚠️ Format: /@CODE /command\nExample: /@100123 /groupname on Test");
              }
            }
          }
        }
      }
    } catch (e) {
      log("⚠️ Telegram poll error: " + e.message);
    }
    setTimeout(poll, 500);
  };
  poll();
}

// ---- Error handlers ----
process.on("uncaughtException", e => { log("⛔ uncaughtException: " + e.message); log("⛔ Stack: " + e.stack); });
process.on("unhandledRejection", e => { log("⛔ unhandledRejection: " + (e?.message || e)); });

let botHealthy = false;
let lastEventTime = Date.now();

setInterval(() => {
  if (botHealthy) log(`💓 Heartbeat - Last event ${Math.floor((Date.now() - lastEventTime) / 1000)}s ago`);
}, 30 * 1000);

// ---- Login ----
if (typeof login !== "function") {
  console.error("❌ login is not a function. Check anuragxarohi package export.");
  process.exit(1);
}

login({ appState }, async (err, api) => {
  if (err) {
    console.error("❌ Login failed:", err?.message || err);
    log("❌ CRITICAL: Login failed - " + (err?.message || JSON.stringify(err)));
    process.exitCode = 2;
    setTimeout(() => process.exit(2), 1000);
    return;
  }

  api.setOptions({ listenEvents: true, selfListen: false });
  log("🤖 Bot logged in! Listening...");
  botHealthy = true;

  const botUID = String(api.getCurrentUserID ? api.getCurrentUserID() : ADMIN_ARG);
  log(`🆔 Bot UID: ${botUID} | BOT_NICKNAME: ${BOT_NICKNAME}`);

  saveAppState(api);
  setInterval(saveLocks, 60 * 1000);
  setInterval(() => saveAppState(api), APPSTATE_SAVE_INTERVAL_MS);
  setInterval(() => recheckAllLocks(api, botUID), LOCK_RECHECK_INTERVAL_MS);

  // Set bot's own nickname to ERIIC in all groups on startup
  setTimeout(async () => {
    try {
      const groups = await loadAndSaveGroups(api);
      log(`📋 Loaded ${groups.length} groups`);
      for (const g of groups) {
        try {
          await retryChangeNick(api, g.threadID, botUID, BOT_NICKNAME, 3);
          log(`✅ Set nickname ERIIC in group: ${g.name}`);
          await sleep(800);
        } catch (e) { log(`⚠️ Could not set nick in ${g.name}: ${e.message}`); }
      }
    } catch (e) { log("⚠️ Startup nick set error: " + e.message); }
  }, 5000);

  // Start Telegram if configured
  if (tgConfig.token && tgConfig.chatId) {
    startTelegram(tgConfig.token, tgConfig.chatId, api, botUID);
  } else {
    log("📱 Telegram not configured (set Token + Chat ID in panel)");
  }

  // ---- MQTT Event listener ----
  api.listenMqtt(async (err, event) => {
    try {
      if (err) {
        const msg = err?.message || String(err);
        log("❌ MQTT Error: " + msg);
        if (/Not logged in|login|appstate|cookie|ECONNRESET|closed|disconnect/i.test(msg)) {
          saveAppState(api);
          log("🔄 MQTT disconnected/error — supervisor ko restart signal bhej rahe hain");
          setTimeout(() => process.exit(42), 1000);
        }
        return;
      }
      if (!event) return;

      lastEventTime = Date.now();
      if (Math.random() < 0.03) saveAppState(api);
      const threadID = String(event.threadID || "");
      const senderID = String(event.senderID || "");
      const body = (event.body || "").toString();
      const logType = event.logMessageType || "";

      // ---- Event handlers ----
      if (event.type === "event") {

        // Group name change
        if (logType === "log:thread-name") {
          const newName = event.logMessageData?.name || "";
          const lockedName = locks.groupNames?.[threadID];
          if (lockedName && newName !== lockedName) {
            log(`⚠️ Name change in ${threadID}: "${newName}" → reverting`);
            await sleep(800);
            await revertGroupNameLocked(api, threadID);
          }
          return;
        }

        // Group photo change
        if (["log:thread-image", "log:thread-photo", "log:thread-image-update"].includes(logType)) {
          const locked = locks.groupPics?.[threadID];
          if (locked?.file && fs.existsSync(locked.file)) {
            try {
              const fn = api.changeGroupImage || api.setGroupImage;
              if (typeof fn === "function") {
                await fn.call(api, fs.createReadStream(locked.file), threadID);
                await api.sendMessage("📸 Group picture reverted (lock active).", threadID);
                log(`🔒 Reverted photo in ${threadID}`);
              }
            } catch (e) { log("❌ revert photo: " + e.message); }
          }
          return;
        }

        // Nickname change
        if (logType === "log:user-nickname") {
          const uid = String(event.logMessageData?.participant_id || "");
          const newNick = event.logMessageData?.nickname || "";

          // Bot's own nickname — always revert to ERIIC
          if (uid === botUID && newNick !== BOT_NICKNAME) {
            log(`🔒 Bot nickname changed to "${newNick}" → reverting to "${BOT_NICKNAME}"`);
            await retryChangeNick(api, threadID, botUID, BOT_NICKNAME, 5);
            return;
          }

          // Locked nickname for other users
          if (locks.nicknames?.[threadID]?.[uid] && locks.nicknames[threadID][uid] !== newNick) {
            await revertSingleNick(api, threadID, uid);
          }
          return;
        }
      }

      // ---- Command handler (Facebook messages) ----
      if (senderID !== BOSS_UID) return;
      if (!body) return;

      const parts = body.trim().split(/\s+/);
      const cmd = parts[0].replace(/^\//, "").toLowerCase();
      const args = parts.slice(1);

      const replyFn = (msg) => api.sendMessage(msg, threadID);

      await processCmd(api, threadID, cmd, args, botUID, replyFn);

    } catch (e) {
      log("❌ Handler error: " + e.message);
      log("❌ Stack: " + e.stack);
    }
  });
});

process.on("SIGINT", () => { log("🔴 Bot stopped (SIGINT)"); process.exit(0); });
process.on("SIGTERM", () => { log("🔴 Bot stopped (SIGTERM)"); process.exit(0); });
setInterval(() => {}, 60000);
