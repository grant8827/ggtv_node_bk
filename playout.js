import { spawn } from "node:child_process";

const tickMs = 1000;
const retryDelayMs = 10_000;
const quickFailSeconds = 5;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Where in the playlist we should be `elapsedSec` into the slot. Needs every item's duration;
// otherwise playback simply starts from the first item.
function startPosition(items, elapsedSec) {
  if (!items.every((item) => item.durationMinutes > 0)) return { index: 0, offsetSec: 0 };
  const total = items.reduce((sum, item) => sum + item.durationMinutes * 60, 0);
  let remaining = elapsedSec % total;
  for (let index = 0; index < items.length; index += 1) {
    const length = items[index].durationMinutes * 60;
    if (remaining < length) return { index, offsetSec: Math.floor(remaining) };
    remaining -= length;
  }
  return { index: 0, offsetSec: 0 };
}

function ffmpegArgs(item, offsetSec, output) {
  const limit = item.durationMinutes > 0 ? Math.max(1, item.durationMinutes * 60 - offsetSec) : null;
  return [
    "-hide_banner", "-loglevel", "error", "-nostdin",
    "-re",
    // Uploaded videos are local files; links may only use network protocols.
    "-protocol_whitelist", item.isLocal ? "file" : "http,https,tcp,tls,crypto",
    ...(offsetSec > 0 ? ["-ss", String(offsetSec)] : []),
    "-i", item.input ?? item.url,
    ...(limit ? ["-t", String(limit)] : []),
    // Re-encode every item to one format so the outgoing stream stays consistent between items.
    "-vf", "scale=-2:720,fps=30",
    "-c:v", "libx264", "-preset", "veryfast", "-tune", "zerolatency", "-pix_fmt", "yuv420p",
    "-b:v", "2500k", "-maxrate", "2500k", "-bufsize", "5000k",
    "-g", "60", "-keyint_min", "60", "-sc_threshold", "0",
    "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "2",
    "-f", "flv", output,
  ];
}

const IDLE = { state: "idle", kind: null, slotId: null, slotTitle: null, playlistName: null, itemTitle: null, error: null };

// Streams what the channel should show into SRS, one ffmpeg process per item.
// `getPlan` returns null, or a plan:
//   { key, kind, id, title, playlistName, items, loop,
//     alignTo?: ISO time  – start where the schedule says we should be by now (scheduled slots)
//     resumeKey?: string  – carry on from where this was last stopped (the fill playlist)
//     onFinished?: fn     – called when a non-looping plan (a break) has played every item }
// A new key replaces whatever is playing.
export function startPlayout({ getPlan, publishUrl, ffmpegPath = "ffmpeg" }) {
  let job = null;
  let status = IDLE;
  const positions = new Map();

  function playItem(current, item, offsetSec) {
    return new Promise((resolve) => {
      const child = spawn(ffmpegPath, ffmpegArgs(item, offsetSec, publishUrl()), { stdio: ["ignore", "ignore", "pipe"] });
      current.child = child;
      let stderr = "";
      child.stderr.on("data", (chunk) => {
        stderr = (stderr + chunk).slice(-2000);
      });
      child.on("error", (error) => {
        current.child = null;
        resolve({ ok: false, message: error.code === "ENOENT" ? "ffmpeg is not installed on the server" : error.message });
      });
      child.on("close", (code) => {
        current.child = null;
        const message = stderr.trim().split("\n").pop() || `ffmpeg exited with code ${code}`;
        resolve({ ok: code === 0, message });
      });
    });
  }

  function startOf(plan) {
    if (plan.resumeKey && positions.has(plan.resumeKey)) return positions.get(plan.resumeKey);
    if (plan.alignTo) return startPosition(plan.items, (Date.now() - Date.parse(plan.alignTo)) / 1000);
    return { index: 0, offsetSec: 0 };
  }

  async function run(current, plan) {
    const items = plan.items;
    let { index, offsetSec } = startOf(plan);
    if (index >= items.length) index = 0;
    let failuresInRow = 0;

    while (!current.stopped) {
      const item = items[index];
      status = { ...status, state: "playing", itemTitle: item.title };
      const started = Date.now();
      current.position = { index, offsetSec, started };
      const result = await playItem(current, item, offsetSec);
      if (current.stopped) break;

      const ranSeconds = (Date.now() - started) / 1000;
      if (!result.ok && ranSeconds < quickFailSeconds) {
        failuresInRow += 1;
        console.error(`Playout: "${item.title}" failed: ${result.message}`);
        status = { ...status, error: `"${item.title}": ${result.message}` };
      } else {
        failuresInRow = 0;
        status = { ...status, error: null };
      }

      if (failuresInRow >= items.length) {
        status = { ...status, state: "error", itemTitle: null };
        await sleep(retryDelayMs);
        failuresInRow = 0;
      }
      offsetSec = 0;
      if (!plan.loop && index === items.length - 1) {
        // A break has played everything once: hand back to whatever comes next.
        current.finished = true;
        status = IDLE;
        plan.onFinished?.();
        tick();
        return;
      }
      index = (index + 1) % items.length;
    }
  }

  // Remembers where a resumable plan (the fill playlist) was, so it carries on from there.
  function rememberPosition(current) {
    const { plan, position } = current;
    if (!plan.resumeKey || !position) return;
    const item = plan.items[position.index];
    let offsetSec = Math.floor(position.offsetSec + (Date.now() - position.started) / 1000);
    let index = position.index;
    if (item && item.durationMinutes > 0 && offsetSec >= item.durationMinutes * 60) {
      index = (index + 1) % plan.items.length;
      offsetSec = 0;
    }
    positions.set(plan.resumeKey, { index, offsetSec });
  }

  function stop() {
    if (!job) return;
    job.stopped = true;
    if (!job.finished) rememberPosition(job);
    job.child?.kill("SIGTERM");
    job = null;
    status = IDLE;
  }

  function tick() {
    const plan = getPlan();
    const key = plan?.key ?? null;
    if (job?.key === key && !job.finished) return;
    stop();
    if (!plan) return;

    job = { key, plan, child: null, stopped: false, finished: false, position: null };
    status = { ...IDLE, state: "starting", kind: plan.kind, slotId: plan.id, slotTitle: plan.title, playlistName: plan.playlistName };
    void run(job, plan);
  }

  tick();
  const timer = setInterval(tick, tickMs);

  return {
    status: () => status,
    refresh: tick,
    shutdown() {
      clearInterval(timer);
      stop();
    },
  };
}
