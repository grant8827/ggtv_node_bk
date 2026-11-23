import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const tickMs = 1000;
const retryDelayMs = 10_000;
const quickFailSeconds = 5;
// A quick failure is retried this many times before moving on: SRS can briefly refuse a new
// publisher while the previous one is still disconnecting.
const quickRetries = 3;
const quickRetryDelayMs = 2000;
// Pause after the previous ffmpeg has exited, so SRS has released the stream.
const handoverDelayMs = 1000;

// The "BK:10" … "BK:01" countdown shown before a break: one image per second, played as a
// 1 fps image sequence over the top-right of the picture. The last image is repeated because the
// final frame of a sequence gets no screen time.
const countdownSeconds = 10;
const countdownImages = join(dirname(fileURLToPath(import.meta.url)), "countdown", "bk-%02d.png");

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

// `breakInSec`: seconds from now until a break starts, if one is coming. When the countdown falls
// within this item, it is drawn into the picture so every viewer sees it in step with the video.
function ffmpegArgs(item, offsetSec, output, breakInSec = null) {
  const limit = item.durationMinutes > 0 ? Math.max(1, item.durationMinutes * 60 - offsetSec) : null;
  const countdownAt = breakInSec === null ? null : breakInSec - countdownSeconds;
  const countdown = countdownAt !== null && countdownAt > -countdownSeconds && (limit === null || countdownAt < limit);
  // Scale every item to one format so the outgoing stream stays consistent between items.
  const video = countdown
    ? ["-filter_complex", "[0:v]scale=-2:720,fps=30[base];[base][1:v]overlay=x=W-w-32:y=32:eof_action=pass:format=auto[v]", "-map", "[v]", "-map", "0:a?"]
    : ["-vf", "scale=-2:720,fps=30"];
  return [
    "-hide_banner", "-loglevel", "error", "-nostdin",
    "-re",
    // Uploaded videos are local files; links may only use network protocols.
    "-protocol_whitelist", item.isLocal ? "file" : "http,https,tcp,tls,crypto",
    ...(offsetSec > 0 ? ["-ss", String(offsetSec)] : []),
    "-i", item.input ?? item.url,
    // The countdown starts `countdownAt` seconds in, or part-way through if the break is closer.
    ...(countdown
      ? [...(countdownAt >= 0 ? ["-itsoffset", countdownAt.toFixed(2)] : ["-ss", (-countdownAt).toFixed(2)]), "-framerate", "1", "-i", countdownImages]
      : []),
    ...(limit ? ["-t", String(limit)] : []),
    ...video,
    "-c:v", "libx264", "-preset", "veryfast", "-tune", "zerolatency", "-pix_fmt", "yuv420p",
    "-b:v", "2500k", "-maxrate", "2500k", "-bufsize", "5000k",
    "-g", "60", "-keyint_min", "60", "-sc_threshold", "0",
    "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "2",
    "-f", "flv", output,
  ];
}

// The videos after the one at `index` (wrapping round when the plan loops), up to `count`, each
// with when it should start. A start is only known while every video before it has a set length;
// after one that plays to its end, it is null.
const upcomingCount = 6;
function upcomingItems(plan, index, itemStartedMs, count = upcomingCount) {
  const { items, loop } = plan;
  const list = [];
  let startMs = items[index].durationMinutes > 0 ? itemStartedMs + items[index].durationMinutes * 60000 : null;
  for (let step = 1; list.length < Math.min(count, loop ? items.length - 1 : items.length); step += 1) {
    const at = index + step;
    if (!loop && at >= items.length) break;
    const item = items[at % items.length];
    list.push({ title: item.title, start: startMs === null ? null : new Date(startMs).toISOString() });
    startMs = startMs !== null && item.durationMinutes > 0 ? startMs + item.durationMinutes * 60000 : null;
  }
  return list;
}

const IDLE = { state: "idle", kind: null, slotId: null, slotTitle: null, playlistName: null, itemTitle: null, nextItemTitle: null, upcoming: [], error: null };

// Streams what the channel should show into SRS, one ffmpeg process per item.
// `getPlan` returns null, or a plan:
//   { key, kind, id, title, playlistName, items, loop,
//     alignTo?: ISO time  – start where the schedule says we should be by now (scheduled slots)
//     resumeKey?: string  – carry on from where this was last stopped (the fill playlist)
//     onFinished?: fn     – called when a non-looping plan (a break) has played every item }
// A new key replaces whatever is playing. `nextBreakAt` returns when the next break starts (ms), or
// null, so a countdown can be shown before it.
export function startPlayout({ getPlan, publishUrl, nextBreakAt = () => null, ffmpegPath = "ffmpeg" }) {
  let job = null;
  let status = IDLE;
  const positions = new Map();
  // Resolves once the last stopped ffmpeg has exited; the next plan waits for it.
  let previousExit = Promise.resolve();

  function playItem(current, item, offsetSec) {
    return new Promise((resolve) => {
      // Breaks themselves don't count down to the next break.
      const breakAt = current.plan.kind === "break" ? null : nextBreakAt();
      const breakInSec = breakAt === null ? null : (breakAt - Date.now()) / 1000;
      current.countdownFor = breakAt;
      const child = spawn(ffmpegPath, ffmpegArgs(item, offsetSec, publishUrl(), breakInSec), { stdio: ["ignore", "ignore", "pipe"] });
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
    let retries = 0;

    await previousExit;
    await sleep(handoverDelayMs);

    while (!current.stopped) {
      const item = items[index];
      const upcoming = upcomingItems(plan, index, Date.now() - offsetSec * 1000);
      status = { ...status, state: "playing", itemTitle: item.title, nextItemTitle: upcoming[0]?.title ?? null, upcoming };
      const started = Date.now();
      current.position = { index, offsetSec, started };
      const result = await playItem(current, item, offsetSec);
      if (current.stopped) break;

      const ranSeconds = (Date.now() - started) / 1000;
      // Restarted part-way through to add the countdown for a break: carry on from the same spot.
      if (current.restart) {
        current.restart = false;
        offsetSec += Math.floor(ranSeconds);
        await sleep(handoverDelayMs);
        continue;
      }
      if (!result.ok && ranSeconds < quickFailSeconds && retries < quickRetries) {
        retries += 1;
        console.error(`Playout: "${item.title}" failed, retrying: ${result.message}`);
        await sleep(quickRetryDelayMs);
        continue;
      }
      retries = 0;
      if (!result.ok && ranSeconds < quickFailSeconds) {
        failuresInRow += 1;
        console.error(`Playout: "${item.title}" failed: ${result.message}`);
        status = { ...status, error: `"${item.title}": ${result.message}` };
      } else {
        failuresInRow = 0;
        status = { ...status, error: null };
      }

      if (failuresInRow >= items.length) {
        status = { ...status, state: "error", itemTitle: null, nextItemTitle: null, upcoming: [] };
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
    const child = job.child;
    if (child) {
      previousExit = new Promise((resolve) => child.once("close", resolve));
      child.kill("SIGTERM");
    }
    job = null;
    status = IDLE;
  }

  // A break added (or moved) while an item was already playing: restart the item where it is, with
  // the countdown, just as the countdown should appear.
  function ensureCountdown(current) {
    if (current.plan.kind === "break" || !current.child || current.restart) return;
    const breakAt = nextBreakAt();
    if (breakAt === null || breakAt === current.countdownFor) return;
    if (breakAt - Date.now() > (countdownSeconds + 1) * 1000) return;
    current.restart = true;
    current.child.kill("SIGTERM");
  }

  function tick() {
    const plan = getPlan();
    const key = plan?.key ?? null;
    if (job?.key === key && !job.finished) {
      ensureCountdown(job);
      return;
    }
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
