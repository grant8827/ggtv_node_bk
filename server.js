import { createServer } from "node:http";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { startPlayout } from "./playout.js";
import { attachSwitcherOutput } from "./switcherOutput.js";
import { createMediaStore } from "./media.js";

const port = Number(process.env.PORT) || 3001;
const appDir = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR || path.join(appDir, "data");
// The built frontend (frontend/dist) is served from this same origin so the studio session cookie works.
const staticDir = path.resolve(process.env.STATIC_DIR || path.join(appDir, "../frontend/dist"));
const dbFile = path.join(dataDir, "studio.json");
// Uploaded videos. On Railway this is the backend's volume (MEDIA_DIR=/data/media).
const mediaDir = process.env.MEDIA_DIR || path.join(dataDir, "media");
const maxUploadBytes = (Number(process.env.MAX_UPLOAD_GB) || 5) * 1e9;
// With DATABASE_URL set (Railway), studio state lives in Postgres; otherwise in a local JSON file.
const pool = process.env.DATABASE_URL ? new pg.Pool({ connectionString: process.env.DATABASE_URL }) : null;
const rtmpUrl = process.env.RTMP_INGEST_URL || "rtmp://localhost:1935/live";
const hlsBaseUrl = (process.env.HLS_BASE_URL || "http://localhost:8080/live").replace(/\/$/, "");
// Scheduled playlists are pushed to SRS as their own stream; on Railway use SRS's private address.
const playoutRtmpUrl = (process.env.PLAYOUT_RTMP_URL || rtmpUrl).replace(/\/$/, "");
const playoutStream = "playout";
const onRailway = Boolean(process.env.RAILWAY_ENVIRONMENT_NAME);
const secureCookie = process.env.NODE_ENV === "production" || onRailway;

const studioUser = process.env.STUDIO_USERNAME || "admin";
let studioPassword = process.env.STUDIO_PASSWORD;
if (!studioPassword) {
  studioPassword = randomBytes(9).toString("base64url");
  console.warn(`STUDIO_PASSWORD is not set. Temporary studio login for this run: ${studioUser} / ${studioPassword}`);
}

const sessionCookie = "ggtv_session";
const sessionTtlMs = 12 * 60 * 60 * 1000;
const sessions = new Map();
const loginFailures = new Map();
const maxLoginFailures = 5;
const loginLockMs = 15 * 60 * 1000;

// ---------- storage ----------

function defaultDb() {
  return {
    live: {
      isLive: false,
      title: "GGTV Live",
      description: "",
      startedAt: null,
      streamName: "demo",
      streamKey: randomBytes(12).toString("hex"),
      encoderConnected: false,
    },
    schedule: [],
    playlists: [],
    media: [],
  };
}

async function readStored() {
  if (pool) {
    await pool.query(
      "CREATE TABLE IF NOT EXISTS studio_state (id smallint PRIMARY KEY, data jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())",
    );
    const { rows } = await pool.query("SELECT data FROM studio_state WHERE id = 1");
    return rows[0]?.data ?? null;
  }
  try {
    return JSON.parse(await readFile(dbFile, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return null;
  }
}

async function loadDb() {
  const fallback = defaultDb();
  const stored = await readStored();
  if (!stored) return fallback;
  return { ...fallback, ...stored, live: { ...fallback.live, ...stored.live } };
}

async function writeStored() {
  if (pool) {
    await pool.query(
      "INSERT INTO studio_state (id, data) VALUES (1, $1) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()",
      [JSON.stringify(db)],
    );
    return;
  }
  await mkdir(dataDir, { recursive: true });
  const tmp = `${dbFile}.tmp`;
  await writeFile(tmp, JSON.stringify(db, null, 2));
  await rename(tmp, dbFile);
}

const db = await loadDb();
let saving = Promise.resolve();

function saveDb() {
  // Keep the queue alive after a failed write so later saves still run.
  saving = saving.catch(() => undefined).then(writeStored);
  return saving;
}

await saveDb();

// ---------- http helpers ----------

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function sendJson(response, status, body, headers = {}) {
  response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers });
  response.end(JSON.stringify(body));
}

async function readJson(request) {
  if (!String(request.headers["content-type"] || "").startsWith("application/json")) {
    throw new HttpError(415, "Expected a JSON body");
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 256 * 1024) throw new HttpError(413, "Request body is too large");
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
    return body;
  } catch {
    throw new HttpError(400, "Malformed JSON body");
  }
}

function parseCookies(header = "") {
  return Object.fromEntries(
    header.split(";").map((part) => part.trim().split("=")).filter(([key, value]) => key && value).map(([key, value]) => [key, decodeURIComponent(value)]),
  );
}

function cookieHeader(value, maxAgeSeconds) {
  return [
    `${sessionCookie}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${maxAgeSeconds}`,
    secureCookie ? "Secure" : "",
  ].filter(Boolean).join("; ");
}

function clientIp(request) {
  // Behind Railway's edge proxy the socket address is the proxy, so use the client IP it forwards.
  if (onRailway && request.headers["x-real-ip"]) return String(request.headers["x-real-ip"]);
  return request.socket.remoteAddress || "unknown";
}

// ---------- validation ----------

function text(value, field, { min = 0, max }) {
  const result = typeof value === "string" ? value.trim() : "";
  if (result.length < min) throw new HttpError(400, `${field} is required`);
  if (result.length > max) throw new HttpError(400, `${field} must be ${max} characters or fewer`);
  return result;
}

function isoDate(value, field) {
  const date = new Date(typeof value === "string" ? value : "");
  if (Number.isNaN(date.getTime())) throw new HttpError(400, `${field} must be a valid date`);
  return date.toISOString();
}

function mediaUrl(value, field) {
  const result = text(value, field, { min: 1, max: 2048 });
  let url;
  try {
    url = new URL(result);
  } catch {
    throw new HttpError(400, `${field} must be a valid URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new HttpError(400, `${field} must use http or https`);
  return url.toString();
}

function minutes(value, field) {
  const result = Number(value ?? 0);
  if (!Number.isFinite(result) || result < 0 || result > 1440) throw new HttpError(400, `${field} must be between 0 and 1440 minutes`);
  return Math.round(result * 100) / 100;
}

// ---------- auth ----------

function digest(value) {
  return createHash("sha256").update(String(value)).digest();
}

function credentialsMatch(username, password) {
  const userOk = timingSafeEqual(digest(username), digest(studioUser));
  const passwordOk = timingSafeEqual(digest(password), digest(studioPassword));
  return userOk && passwordOk;
}

function currentSession(request) {
  const token = parseCookies(request.headers.cookie)[sessionCookie];
  if (!token) return null;
  const session = sessions.get(token);
  if (!session) return null;
  if (session.expiresAt < Date.now()) {
    sessions.delete(token);
    return null;
  }
  return { token, ...session };
}

async function login(request, response) {
  const ip = clientIp(request);
  const failures = loginFailures.get(ip);
  if (failures && failures.count >= maxLoginFailures && failures.until > Date.now()) {
    throw new HttpError(429, "Too many failed attempts. Try again in a few minutes.");
  }

  const body = await readJson(request);
  if (!credentialsMatch(body.username ?? "", body.password ?? "")) {
    const next = failures && failures.until > Date.now() ? failures.count + 1 : 1;
    loginFailures.set(ip, { count: next, until: Date.now() + loginLockMs });
    throw new HttpError(401, "Incorrect username or password");
  }

  loginFailures.delete(ip);
  const token = randomBytes(32).toString("base64url");
  sessions.set(token, { user: studioUser, expiresAt: Date.now() + sessionTtlMs });
  sendJson(response, 200, { user: studioUser }, { "Set-Cookie": cookieHeader(token, sessionTtlMs / 1000) });
}

// ---------- views ----------

const mediaStore = createMediaStore({ dir: mediaDir, maxUploadBytes, HttpError });

function playoutPlan() {
  if (db.live.isLive) return null;
  const now = new Date().toISOString();
  const slot = db.schedule.find((entry) => entry.kind === "playlist" && entry.start <= now && entry.end > now);
  const playlist = slot && db.playlists.find((item) => item.id === slot.playlistId);
  // Links and uploaded videos can play from here; files kept in a studio browser can't.
  const items = (playlist?.items ?? []).flatMap((item) => {
    if (item.url) return [{ ...item, input: item.url }];
    const media = item.mediaId && db.media.find((entry) => entry.id === item.mediaId);
    return media ? [{ ...item, input: mediaStore.pathOf(media), isLocal: true }] : [];
  });
  return items.length ? { slot, playlist: { ...playlist, items } } : null;
}

const playout = startPlayout({
  getPlan: playoutPlan,
  publishUrl: () => `${playoutRtmpUrl}/${playoutStream}?key=${db.live.streamKey}`,
  ffmpegPath: process.env.FFMPEG_PATH || "ffmpeg",
});

function publicLive() {
  const { isLive, title, description, startedAt, streamName, encoderConnected } = db.live;
  const run = playout.status();
  const source = isLive ? "live" : run.state === "playing" ? "playlist" : "off";
  return {
    isLive,
    source,
    title,
    description,
    startedAt,
    encoderConnected,
    nowPlaying: source === "playlist" ? { slotTitle: run.slotTitle, itemTitle: run.itemTitle } : null,
    hlsUrl: `${hlsBaseUrl}/${source === "playlist" ? playoutStream : streamName}.m3u8`,
  };
}

function studioLive() {
  return {
    ...publicLive(),
    streamName: db.live.streamName,
    streamKey: db.live.streamKey,
    rtmpUrl,
    playout: playout.status(),
    switcherOutput: switcherOutput.status(),
  };
}

function scheduleView(entries) {
  return [...entries]
    .sort((a, b) => a.start.localeCompare(b.start))
    .map((entry) => ({ ...entry, playlistName: db.playlists.find((playlist) => playlist.id === entry.playlistId)?.name ?? null }));
}

// ---------- schedule & playlists ----------

// Video items shared by playlists and scheduled breaks: a link, an uploaded video, or a file
// kept in a studio browser.
function itemsInput(rawItems, max) {
  if (!Array.isArray(rawItems)) throw new HttpError(400, "Items must be a list");
  if (rawItems.length > max) throw new HttpError(400, `Up to ${max} videos are allowed`);
  return rawItems.map((item, index) => {
    const label = `Item ${index + 1}`;
    const base = {
      id: typeof item?.id === "string" && item.id ? item.id : randomUUID(),
      title: text(item?.title, `${label} title`, { min: 1, max: 120 }),
      durationMinutes: minutes(item?.durationMinutes, `${label} duration`),
    };
    // A video uploaded to the server's media storage.
    if (item?.mediaId) {
      const media = db.media.find((entry) => entry.id === item.mediaId);
      if (!media) throw new HttpError(400, `${label}: the uploaded video no longer exists`);
      return { ...base, url: null, mediaId: media.id, fileName: media.name };
    }
    // A video file kept in the studio browser's IndexedDB: only that browser's switcher can play it.
    if (item?.fileId) {
      return {
        ...base,
        url: null,
        fileId: text(item.fileId, `${label} file`, { min: 1, max: 64 }),
        fileName: text(item.fileName, `${label} file name`, { max: 200 }),
      };
    }
    return { ...base, url: mediaUrl(item?.url, `${label} URL`) };
  });
}

function scheduleInput(body, ignoreId) {
  const title = text(body.title, "Title", { min: 1, max: 120 });
  const description = text(body.description, "Description", { max: 500 });
  const start = isoDate(body.start, "Start time");
  const kind = ["playlist", "break"].includes(body.kind) ? body.kind : "live";

  let end;
  let playlistId = null;
  let items;
  if (kind === "break") {
    // A break plays its videos once; its end is when they're expected to finish.
    items = itemsInput(body.items, 50);
    if (!items.length) throw new HttpError(400, "Add at least one video to the break");
    // Unknown lengths (0) still reserve a minute so the break has a window to start in.
    const totalMinutes = items.reduce((sum, item) => sum + item.durationMinutes, 0) || 1;
    end = new Date(Date.parse(start) + totalMinutes * 60000).toISOString();
  } else {
    end = isoDate(body.end, "End time");
    if (end <= start) throw new HttpError(400, "End time must be after the start time");
    if (kind === "playlist") {
      playlistId = typeof body.playlistId === "string" ? body.playlistId : "";
      if (!db.playlists.some((playlist) => playlist.id === playlistId)) throw new HttpError(400, "Choose a playlist for this slot");
    }
  }

  // Breaks interrupt shows, so they may sit inside a show; they just can't overlap each other.
  const isBreak = (entry) => entry.kind === "break";
  const clash = db.schedule.find((entry) => entry.id !== ignoreId && isBreak(entry) === (kind === "break") && entry.start < end && start < entry.end);
  if (clash) throw new HttpError(409, `Overlaps with "${clash.title}"`);

  return { title, description, start, end, kind, playlistId, ...(items ? { items } : {}) };
}

function playlistInput(body) {
  const name = text(body.name, "Playlist name", { min: 1, max: 80 });
  return { name, items: itemsInput(body.items, 500) };
}

// Names of the playlists and breaks that use an uploaded video.
function mediaUsers(mediaId) {
  const uses = (items) => (items ?? []).some((item) => item.mediaId === mediaId);
  return [
    ...db.playlists.filter((playlist) => uses(playlist.items)).map((playlist) => playlist.name),
    ...db.schedule.filter((entry) => uses(entry.items)).map((entry) => `break "${entry.title}"`),
  ];
}

function findIndex(list, id, label) {
  const index = list.findIndex((item) => item.id === id);
  if (index === -1) throw new HttpError(404, `${label} not found`);
  return index;
}

async function mediaList() {
  const used = db.media.reduce((sum, media) => sum + media.size, 0);
  const { free } = await mediaStore.usage();
  return { items: db.media.map((media) => ({ ...media, usedBy: mediaUsers(media.id) })), used, free };
}

// ---------- SRS hooks ----------

// Configure SRS http_hooks on_publish / on_unpublish to point here (see infra/srs/srs.conf).
// SRS treats an HTTP 200 with code 0 as "allow"; anything else rejects the publisher.
async function srsHook(request, response, action) {
  const body = await readJson(request);
  // SRS sends the publisher's query string as `param` on both publish and unpublish.
  const key = new URLSearchParams(String(body.param || "").replace(/^\?/, "")).get("key") || "";
  const isEncoder = body.stream === db.live.streamName;
  if ((!isEncoder && body.stream !== playoutStream) || !timingSafeEqual(digest(key), digest(db.live.streamKey))) {
    sendJson(response, 403, { code: 1 });
    return;
  }
  if (isEncoder) {
    db.live.encoderConnected = action === "publish";
    await saveDb();
  }
  sendJson(response, 200, { code: 0 });
}

// ---------- frontend ----------

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
  ".woff2": "font/woff2",
};

async function staticFile(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const file = path.resolve(staticDir, `.${decoded}`);
  if (!file.startsWith(staticDir + path.sep)) return null;
  const info = await stat(file).catch(() => null);
  return info?.isFile() ? file : null;
}

// Serves files from the frontend build, falling back to index.html so client-side routes like /studio load.
async function serveFrontend(request, response, pathname) {
  const isAsset = pathname.startsWith("/assets/");
  const file = (await staticFile(pathname)) ?? (isAsset ? null : await staticFile("/index.html"));
  if (!file) return false;
  response.writeHead(200, {
    "Content-Type": contentTypes[path.extname(file)] ?? "application/octet-stream",
    "Cache-Control": isAsset ? "public, max-age=31536000, immutable" : "no-cache",
    "X-Content-Type-Options": "nosniff",
  });
  if (request.method === "HEAD") response.end();
  else createReadStream(file).pipe(response);
  return true;
}

// ---------- routes ----------

const routes = [
  ["GET", "/health", false, (request, response) => sendJson(response, 200, { status: "ok" })],

  ["POST", "/api/auth/login", false, login],
  ["POST", "/api/auth/logout", false, (request, response) => {
    const session = currentSession(request);
    if (session) sessions.delete(session.token);
    sendJson(response, 200, { ok: true }, { "Set-Cookie": cookieHeader("", 0) });
  }],
  ["GET", "/api/auth/session", true, (request, response, { session }) => sendJson(response, 200, { user: session.user })],

  ["GET", "/api/live", false, (request, response) => sendJson(response, 200, publicLive())],
  ["GET", "/api/schedule", false, (request, response) => {
    const now = new Date().toISOString();
    // Breaks are for the studio's automation, not the public programme guide.
    const listings = db.schedule.filter((entry) => entry.end > now && entry.kind !== "break").map(({ items, ...entry }) => entry);
    sendJson(response, 200, scheduleView(listings).slice(0, 50));
  }],

  ["POST", "/api/hooks/srs/on_publish", false, (request, response) => srsHook(request, response, "publish")],
  ["POST", "/api/hooks/srs/on_unpublish", false, (request, response) => srsHook(request, response, "unpublish")],

  ["GET", "/api/studio/live", true, (request, response) => sendJson(response, 200, studioLive())],
  ["POST", "/api/studio/live/start", true, async (request, response) => {
    const body = await readJson(request);
    db.live.title = text(body.title, "Broadcast title", { min: 1, max: 120 });
    db.live.description = text(body.description, "Description", { max: 500 });
    if (!db.live.isLive) db.live.startedAt = new Date().toISOString();
    db.live.isLive = true;
    await saveDb();
    playout.refresh();
    sendJson(response, 200, studioLive());
  }],
  ["POST", "/api/studio/live/stop", true, async (request, response) => {
    db.live.isLive = false;
    db.live.startedAt = null;
    await saveDb();
    playout.refresh();
    sendJson(response, 200, studioLive());
  }],
  ["POST", "/api/studio/live/key", true, async (request, response) => {
    db.live.streamKey = randomBytes(12).toString("hex");
    await saveDb();
    sendJson(response, 200, studioLive());
  }],

  ["GET", "/api/studio/schedule", true, (request, response) => sendJson(response, 200, scheduleView(db.schedule))],
  ["POST", "/api/studio/schedule", true, async (request, response) => {
    const entry = { id: randomUUID(), ...scheduleInput(await readJson(request)) };
    db.schedule.push(entry);
    await saveDb();
    sendJson(response, 201, entry);
  }],
  ["PUT", /^\/api\/studio\/schedule\/([\w-]+)$/, true, async (request, response, { params }) => {
    const index = findIndex(db.schedule, params[0], "Schedule entry");
    db.schedule[index] = { id: params[0], ...scheduleInput(await readJson(request), params[0]) };
    await saveDb();
    sendJson(response, 200, db.schedule[index]);
  }],
  ["DELETE", /^\/api\/studio\/schedule\/([\w-]+)$/, true, async (request, response, { params }) => {
    db.schedule.splice(findIndex(db.schedule, params[0], "Schedule entry"), 1);
    await saveDb();
    sendJson(response, 200, { ok: true });
  }],

  ["GET", "/api/studio/media", true, async (request, response) => sendJson(response, 200, await mediaList())],
  ["POST", "/api/studio/media", true, async (request, response) => {
    const media = await mediaStore.upload(request);
    db.media.push(media);
    await saveDb();
    sendJson(response, 201, media);
  }],
  ["GET", /^\/api\/studio\/media\/([\w-]+)\/file$/, true, async (request, response, { params }) => {
    await mediaStore.serve(request, response, db.media[findIndex(db.media, params[0], "Video")]);
  }],
  ["DELETE", /^\/api\/studio\/media\/([\w-]+)$/, true, async (request, response, { params }) => {
    const index = findIndex(db.media, params[0], "Video");
    const users = mediaUsers(params[0]);
    if (users.length) throw new HttpError(409, `This video is used in: ${users.join(", ")}`);
    const [media] = db.media.splice(index, 1);
    await saveDb();
    await mediaStore.remove(media);
    sendJson(response, 200, { ok: true });
  }],

  ["GET", "/api/studio/playlists", true, (request, response) => sendJson(response, 200, db.playlists)],
  ["POST", "/api/studio/playlists", true, async (request, response) => {
    const playlist = { id: randomUUID(), ...playlistInput(await readJson(request)), updatedAt: new Date().toISOString() };
    db.playlists.push(playlist);
    await saveDb();
    sendJson(response, 201, playlist);
  }],
  ["PUT", /^\/api\/studio\/playlists\/([\w-]+)$/, true, async (request, response, { params }) => {
    const index = findIndex(db.playlists, params[0], "Playlist");
    db.playlists[index] = { id: params[0], ...playlistInput(await readJson(request)), updatedAt: new Date().toISOString() };
    await saveDb();
    sendJson(response, 200, db.playlists[index]);
  }],
  ["DELETE", /^\/api\/studio\/playlists\/([\w-]+)$/, true, async (request, response, { params }) => {
    const index = findIndex(db.playlists, params[0], "Playlist");
    if (db.schedule.some((entry) => entry.playlistId === params[0])) {
      throw new HttpError(409, "This playlist is used in the schedule. Remove those slots first.");
    }
    db.playlists.splice(index, 1);
    await saveDb();
    sendJson(response, 200, { ok: true });
  }],
];

function matchRoute(method, pathname) {
  let pathExists = false;
  for (const [routeMethod, pattern, requiresAuth, handler] of routes) {
    const match = typeof pattern === "string" ? (pattern === pathname ? [] : null) : pathname.match(pattern)?.slice(1);
    if (!match) continue;
    pathExists = true;
    if (routeMethod === method) return { requiresAuth, handler, params: match };
  }
  return pathExists ? "method" : null;
}

const server = createServer(async (request, response) => {
  try {
    const { pathname } = new URL(request.url, "http://localhost");
    const route = matchRoute(request.method, pathname);
    if (route === "method") throw new HttpError(405, "Method not allowed");
    if (!route) {
      const canServePage = (request.method === "GET" || request.method === "HEAD") && !pathname.startsWith("/api/");
      if (canServePage && (await serveFrontend(request, response, pathname))) return;
      throw new HttpError(404, "Not found");
    }

    // Browsers can't send custom headers cross-site without a CORS preflight, which this server never grants.
    if (request.method !== "GET" && !pathname.startsWith("/api/hooks/") && request.headers["x-ggtv-studio"] !== "1") {
      throw new HttpError(403, "Missing studio request header");
    }

    const session = currentSession(request);
    if (route.requiresAuth && !session) throw new HttpError(401, "Sign in to the studio to continue");
    await route.handler(request, response, { params: route.params, session });
  } catch (error) {
    if (error instanceof HttpError) {
      sendJson(response, error.status, { error: error.message });
      return;
    }
    console.error(error);
    sendJson(response, 500, { error: "Internal server error" });
  }
});

// The browser switcher streams its program output here; it publishes as the live encoder.
const switcherOutput = attachSwitcherOutput(server, {
  path: "/api/studio/switcher/output",
  authorize(request) {
    const session = currentSession(request);
    if (!session) return "401 Unauthorized";
    // Cookies ride along on cross-site WebSocket handshakes, so require our own origin.
    let originHost = null;
    try {
      originHost = new URL(request.headers.origin).host;
    } catch {
      return "403 Forbidden";
    }
    if (originHost !== request.headers.host) return "403 Forbidden";
    request.studioUser = session.user;
    return null;
  },
  publishUrl: () => `${playoutRtmpUrl}/${db.live.streamName}?key=${db.live.streamKey}`,
  ffmpegPath: process.env.FFMPEG_PATH || "ffmpeg",
});

server.listen(port, () => {
  console.log(`Node backend listening on http://localhost:${port} (storage: ${pool ? "postgres" : dbFile})`);
});

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    playout.shutdown();
    switcherOutput.shutdown();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
