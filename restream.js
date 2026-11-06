import { spawn } from "node:child_process";

// Where the studio's program output can be sent on to, besides the GGTV channel itself.
export const PLATFORMS = {
  youtube: { name: "YouTube", defaultServerUrl: "rtmp://a.rtmp.youtube.com/live2" },
  facebook: { name: "Facebook", defaultServerUrl: "rtmps://live-api-s.facebook.com:443/rtmp/" },
};

const retryDelayMs = 5000;
// ffmpeg prints nothing while it is happily copying, so a process that has stayed up this long counts as live.
const liveAfterMs = 5000;

function ffmpegArgs(source, destination) {
  return [
    "-hide_banner", "-loglevel", "error", "-nostdin",
    // Give up on a stalled input or output after 10s instead of hanging; the loop below retries.
    "-rw_timeout", "10000000",
    "-i", source,
    // The studio output is already H.264/AAC with 2s keyframes, which both platforms accept.
    "-c", "copy",
    "-f", "flv", destination,
  ];
}

const OFF = { state: "off", error: null, startedAt: null };

// Copies the studio's program stream from SRS to YouTube / Facebook, one ffmpeg process per platform.
// While a platform is on, a dropped connection (or no studio output yet) is retried until it is turned off.
export function startRestreams({ sourceUrl, ffmpegPath = "ffmpeg" }) {
  const jobs = new Map();

  function run(platform, job) {
    if (job.stopped) return;
    const destination = `${job.serverUrl.replace(/\/+$/, "")}/${job.streamKey}`;
    const child = spawn(ffmpegPath, ffmpegArgs(sourceUrl(), destination), { stdio: ["ignore", "ignore", "pipe"] });
    job.child = child;
    let stderr = "";
    let failure = "";
    const liveTimer = setTimeout(() => {
      job.status = { state: "live", error: null, startedAt: job.status.startedAt ?? new Date().toISOString() };
    }, liveAfterMs);

    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-2000);
    });
    child.on("error", (error) => {
      failure = error.code === "ENOENT" ? "ffmpeg is not installed on the server" : error.message;
    });
    child.on("close", (code) => {
      clearTimeout(liveTimer);
      job.child = null;
      if (job.stopped) return;
      // Never show or log the stream key.
      const message = (failure || stderr.trim().split("\n").pop() || `ffmpeg exited with code ${code}`)
        .split(job.streamKey).join("••••");
      console.error(`${PLATFORMS[platform].name} restream dropped: ${message}`);
      job.status = { state: "connecting", error: message, startedAt: null };
      job.retry = setTimeout(() => run(platform, job), retryDelayMs);
    });
  }

  function stop(platform) {
    const job = jobs.get(platform);
    if (!job) return;
    job.stopped = true;
    clearTimeout(job.retry);
    job.child?.kill("SIGTERM");
    jobs.delete(platform);
  }

  return {
    start(platform, { serverUrl, streamKey }) {
      stop(platform);
      const job = { serverUrl, streamKey, child: null, retry: null, stopped: false, status: { state: "connecting", error: null, startedAt: null } };
      jobs.set(platform, job);
      run(platform, job);
    },
    stop,
    status: (platform) => jobs.get(platform)?.status ?? OFF,
    shutdown() {
      for (const platform of [...jobs.keys()]) stop(platform);
    },
  };
}
