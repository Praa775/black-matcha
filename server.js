require("dotenv").config();
const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();
app.use(express.json({ limit: "100kb" }));
app.use(express.static(path.join(__dirname, "public")));

const PORT = Number(process.env.PORT || 3000);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const SESSION_SECRET = process.env.SESSION_SECRET || "";
const CHECK_MS = Math.max(15, Number(process.env.CHECK_INTERVAL_SECONDS || 60)) * 1000;
const BACKUP_MS = Math.max(1, Number(process.env.BACKUP_INTERVAL_HOURS || 6)) * 60 * 60 * 1000;
const CONFIG_FILE = path.join(__dirname, "config.json");
const USERS_FILE = path.join(__dirname, "users.json");
const BACKUP_DIR = path.join(__dirname, "backups");
const startedAt = Date.now();
let health = [];
let lastBackup = null;
let lastError = null;
const sessions = new Map();

if (!ADMIN_PASSWORD || !SESSION_SECRET) {
  console.warn("WARNING: Set ADMIN_PASSWORD and SESSION_SECRET in .env before exposing this server.");
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return fallback; }
}
function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
}
function safeUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === "https:" ? u.toString() : null;
  } catch { return null; }
}
function currentConfig() {
  return readJson(CONFIG_FILE, {
    app_name: "BLACK MATCHA V3", maintenance: false,
    primary_url: "", fallback_url: ""
  });
}
function sign(value) {
  return crypto.createHmac("sha256", SESSION_SECRET).update(value).digest("hex");
}
function auth(req, res, next) {
  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const item = sessions.get(token);
  if (!item || item.expires < Date.now() || item.signature !== sign(token)) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}
async function probe(url) {
  const checkedAt = new Date().toISOString();
  if (!url) return { url: "", status: "not-configured", latency_ms: null, checked_at: checkedAt };
  const safe = safeUrl(url);
  if (!safe) return { url, status: "invalid-url", latency_ms: null, checked_at: checkedAt };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  const start = Date.now();
  try {
    // HEAD may be rejected by some hosts; this is a basic reachability check,
    // not a guarantee that the whole application is healthy.
    const response = await fetch(safe, { method: "HEAD", signal: controller.signal, redirect: "follow" });
    return {
      url: safe, status: response.status < 500 ? "online" : "degraded",
      http_status: response.status, latency_ms: Date.now() - start, checked_at: checkedAt
    };
  } catch (e) {
    return { url: safe, status: "offline", latency_ms: Date.now() - start, checked_at: checkedAt };
  } finally { clearTimeout(timer); }
}
async function runHealthCheck() {
  const c = currentConfig();
  health = await Promise.all([
    probe(c.primary_url).then(x => ({ name: "primary", ...x })),
    probe(c.fallback_url).then(x => ({ name: "fallback", ...x }))
  ]);
}
function selectedPanel() {
  const c = currentConfig();
  const primary = health.find(x => x.name === "primary");
  const fallback = health.find(x => x.name === "fallback");
  if (primary && primary.status === "online") return { url: primary.url, selected: "primary" };
  if (fallback && fallback.status === "online") return { url: fallback.url, selected: "fallback" };
  return { url: "", selected: "none" };
}
function doBackup() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const payload = {
    created_at: new Date().toISOString(),
    config: readJson(CONFIG_FILE, {}),
    users: readJson(USERS_FILE, []),
    health,
    note: "Backup lokal. Pastikan direktori backups ikut dicadangkan ke storage terpisah."
  };
  const destination = path.join(BACKUP_DIR, `backup-${stamp}.json`);
  fs.writeFileSync(destination, JSON.stringify(payload, null, 2), { mode: 0o600 });
  lastBackup = { created_at: payload.created_at, file: path.basename(destination) };
  lastError = null;
  // Keep at most 30 local backup snapshots.
  const names = fs.readdirSync(BACKUP_DIR).filter(n => n.endsWith(".json")).sort();
  while (names.length > 30) {
    const old = names.shift();
    try { fs.unlinkSync(path.join(BACKUP_DIR, old)); } catch {}
  }
  return lastBackup;
}

app.post("/api/login", (req, res) => {
  if (!ADMIN_PASSWORD || !SESSION_SECRET) return res.status(503).json({ error: "Admin credentials are not configured in .env" });
  const password = String(req.body?.password || "");
  const a = Buffer.from(password);
  const b = Buffer.from(ADMIN_PASSWORD);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: "Password salah" });
  }
  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(token, { expires: Date.now() + 8 * 60 * 60 * 1000, signature: sign(token) });
  res.json({ token, expires_in: 28800 });
});
app.post("/api/logout", auth, (req, res) => {
  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  sessions.delete(token);
  res.json({ ok: true });
});
app.get("/api/overview", auth, (req, res) => {
  const c = currentConfig();
  const users = readJson(USERS_FILE, []);
  res.json({
    app_name: c.app_name || "BLACK MATCHA V3",
    maintenance: !!c.maintenance,
    uptime_seconds: Math.floor((Date.now() - startedAt) / 1000),
    health, selected_panel: selectedPanel(),
    user_count: Array.isArray(users) ? users.length : 0,
    last_backup: lastBackup, last_error: lastError
  });
});
app.get("/api/config", auth, (req, res) => res.json(currentConfig()));
app.put("/api/config", auth, (req, res) => {
  const old = currentConfig();
  const body = req.body || {};
  const primary = safeUrl(String(body.primary_url || ""));
  const fallback = body.fallback_url ? safeUrl(String(body.fallback_url)) : "";
  if (!primary) return res.status(400).json({ error: "primary_url harus URL HTTPS yang valid" });
  if (body.fallback_url && !fallback) return res.status(400).json({ error: "fallback_url harus URL HTTPS yang valid" });
  const next = {
    app_name: String(body.app_name || old.app_name || "BLACK MATCHA V3").slice(0, 80),
    maintenance: Boolean(body.maintenance),
    primary_url: primary,
    fallback_url: fallback || "",
    updated_at: new Date().toISOString()
  };
  writeJson(CONFIG_FILE, next);
  runHealthCheck().catch(e => { lastError = String(e.message || e); });
  res.json({ ok: true, config: next });
});
app.get("/api/users", auth, (req, res) => {
  const users = readJson(USERS_FILE, []);
  res.json(Array.isArray(users) ? users : []);
});
app.post("/api/users", auth, (req, res) => {
  const body = req.body || {};
  const username = String(body.username || "").trim().slice(0, 80);
  if (!username) return res.status(400).json({ error: "username wajib diisi" });
  const users = readJson(USERS_FILE, []);
  if (!Array.isArray(users)) return res.status(500).json({ error: "users.json tidak valid" });
  const id = crypto.randomUUID();
  users.push({ id, username, status: body.status === "disabled" ? "disabled" : "active", last_seen: null, created_at: new Date().toISOString() });
  writeJson(USERS_FILE, users);
  res.status(201).json({ ok: true, user: users[users.length - 1] });
});
app.post("/api/health-check", auth, async (req, res) => {
  await runHealthCheck();
  res.json({ health, selected_panel: selectedPanel() });
});
app.post("/api/backup", auth, (req, res) => {
  try { res.json({ ok: true, backup: doBackup() }); }
  catch (e) { lastError = String(e.message || e); res.status(500).json({ error: "Backup gagal" }); }
});
app.get("/api/public-config", (req, res) => {
  const c = currentConfig();
  const panel = selectedPanel();
  res.set("Cache-Control", "no-store");
  res.json({
    app_name: c.app_name || "BLACK MATCHA V3",
    maintenance: !!c.maintenance,
    panel_url: panel.url || c.primary_url || "",
    updated_at: c.updated_at || null
  });
});
app.get("/api/health", (req, res) => res.json({ ok: true }));

app.listen(PORT, async () => {
  console.log(`BLACK MATCHA Remote Control listening on port ${PORT}`);
  await runHealthCheck().catch(e => { lastError = String(e.message || e); });
  setInterval(() => runHealthCheck().catch(e => { lastError = String(e.message || e); }), CHECK_MS);
  setInterval(() => { try { doBackup(); } catch (e) { lastError = String(e.message || e); } }, BACKUP_MS);
});
