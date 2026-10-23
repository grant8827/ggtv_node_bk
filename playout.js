import { spawn } from "node:child_process";

const tickMs = 5000;
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
    "-protocol_whitelist", "http,https,tcp,tls,crypto",
    ...(offsetSec > 0 ? ["-ss", String(offsetSec)] : []),
    "-i", item.url,
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

// Streams the playlist scheduled for the current slot into SRS, one ffmpeg process per item.
// `getPlan` returns { slot, playlist } when something should play, or null.
export function startPlayout({ getPlan, publishUrl, ffmpegPath = "ffmpeg" }) {
  let job = null;
  let status = { state: "idle", slotId: null, slotTitle: null, playlistName: null, itemTitle: null, error: null };

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

  async function run(current, { slot, playlist }) {
    const items = playlist.items;
    let { index, offsetSec } = startPosition(items, (Date.now() - Date.parse(slot.start)) / 1000);
    let failuresInRow = 0;

    while (!current.stopped) {
      const item = items[index];
      status = { ...status, state: "playing", itemTitle: item.title };
      const started = Date.now();
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
      index = (index + 1) % items.length;
    }
  }

  function stop() {
    if (!job) return;
    job.stopped = true;
    job.child?.kill("SIGTERM");
    job = null;
    status = { state: "idle", slotId: null, slotTitle: null, playlistName: null, itemTitle: null, error: null };
  }

  function tick() {
    const plan = getPlan();
    // Restart when the slot changes or the playlist is edited mid-slot.
    const key = plan ? `${plan.slot.id}:${plan.playlist.id}:${plan.playlist.updatedAt}` : null;
    if (job?.key === key) return;
    stop();
    if (!plan) return;

    job = { key, child: null, stopped: false };
    status = { state: "starting", slotId: plan.slot.id, slotTitle: plan.slot.title, playlistName: plan.playlist.name, itemTitle: null, error: null };
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
