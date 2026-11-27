import { spawn } from "node:child_process";

// The channel feed: one stream that always carries what is on air, for cable companies and
// other partners who need a single URL. It relays the live show while the studio is live, the
// server's playlist playout otherwise, and a black slate when nothing is on, so the URL never
// goes dark. Switching sources restarts the relay, which shows as a short (~2-4s) cut.

const checkEveryMs = 2000;
const retryDelayMs = 3000;

function relayArgs(source, destination) {
  return [
    "-hide_banner", "-loglevel", "error", "-nostdin",
    "-rw_timeout", "10000000",
    "-i", source,
    // The studio output and the playout are already H.264/AAC with 2s keyframes.
    "-c", "copy",
    "-f", "flv", destination,
  ];
}

function slateArgs(destination) {
  return [
    "-hide_banner", "-loglevel", "error", "-nostdin",
    "-re", "-f", "lavfi", "-i", "color=c=black:s=1280x720:r=30",
    "-re", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo",
    "-c:v", "libx264", "-preset", "veryfast", "-tune", "stillimage", "-pix_fmt", "yuv420p",
    "-g", "60", "-keyint_min", "60", "-sc_threshold", "0", "-b:v", "300k",
    "-c:a", "aac", "-b:a", "64k",
    "-f", "flv", destination,
  ];
}

// currentSource() returns the RTMP URL to relay, or null for the slate.
export function startChannelOutput({ currentSource, publishUrl, ffmpegPath = "ffmpeg" }) {
  let child = null;
  let running = undefined; // the source the current ffmpeg is relaying (null = slate)
  let retry = null;
  let stopped = false;
  let status = { source: "starting", error: null, since: null };

  function launch(source) {
    clearTimeout(retry);
    running = source;
    const args = source ? relayArgs(source, publishUrl()) : slateArgs(publishUrl());
    const proc = spawn(ffmpegPath, args, { stdio: ["ignore", "ignore", "pipe"] });
    child = proc;
    status = { source: source ? "relay" : "slate", error: null, since: new Date().toISOString() };
    let stderr = "";
    let failure = "";
    proc.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-2000);
    });
    proc.on("error", (error) => {
      failure = error.code === "ENOENT" ? "ffmpeg is not installed on the server" : error.message;
    });
    proc.on("close", (code) => {
      if (child !== proc) return; // replaced on purpose
      child = null;
      running = undefined;
      if (stopped) return;
      // Never log the stream key.
      const message = (failure || stderr.trim().split("\n").pop() || `ffmpeg exited with code ${code}`).replace(/key=[^&\s]+/g, "key=••••");
      status = { ...status, error: message };
      console.error(`Channel feed dropped: ${message}`);
      retry = setTimeout(tick, retryDelayMs);
    });
  }

  function tick() {
    if (stopped) return;
    const wanted = currentSource();
    if (child && wanted === running) return;
    if (child) {
      const old = child;
      child = null;
      old.kill("SIGTERM");
    }
    launch(wanted);
  }

  const timer = setInterval(tick, checkEveryMs);
  tick();

  return {
    refresh: tick,
    status: () => status,
    shutdown() {
      stopped = true;
      clearInterval(timer);
      clearTimeout(retry);
      child?.kill("SIGTERM");
    },
  };
}
