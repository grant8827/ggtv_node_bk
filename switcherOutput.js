import { spawn } from "node:child_process";
import { WebSocketServer } from "ws";

const maxBufferedBytes = 16 * 1024 * 1024;

function ffmpegArgs(output) {
  return [
    "-hide_banner", "-loglevel", "error", "-nostdin",
    // MediaRecorder output (WebM or fragmented MP4) arrives on stdin as it is recorded.
    "-fflags", "+genpts", "-i", "pipe:0",
    "-vf", "scale=-2:720,fps=30",
    "-c:v", "libx264", "-preset", "veryfast", "-tune", "zerolatency", "-pix_fmt", "yuv420p",
    "-b:v", "3000k", "-maxrate", "3000k", "-bufsize", "6000k",
    "-g", "60", "-keyint_min", "60", "-sc_threshold", "0",
    "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "2",
    "-f", "flv", output,
  ];
}

// Accepts the studio switcher's program output over a WebSocket and relays it to SRS through ffmpeg.
// Only one switcher can be on the output at a time.
export function attachSwitcherOutput(server, { path, authorize, publishUrl, ffmpegPath = "ffmpeg" }) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });
  let active = null;

  server.on("upgrade", (request, socket, head) => {
    const { pathname } = new URL(request.url, "http://localhost");
    if (pathname !== path) {
      socket.destroy();
      return;
    }
    const denied = authorize(request);
    if (denied) {
      socket.end(`HTTP/1.1 ${denied}\r\nConnection: close\r\n\r\n`);
      return;
    }
    if (active) {
      socket.end("HTTP/1.1 409 Conflict\r\nConnection: close\r\n\r\n");
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => relay(ws, request));
  });

  function relay(ws, request) {
    const child = spawn(ffmpegPath, ffmpegArgs(publishUrl()), { stdio: ["pipe", "ignore", "pipe"] });
    const session = { ws, child, user: request.studioUser, startedAt: new Date().toISOString(), bytes: 0 };
    active = session;
    let stderr = "";
    let closedReason = "";

    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-2000);
    });
    child.stdin.on("error", () => undefined);
    child.on("error", (error) => {
      closedReason = error.code === "ENOENT" ? "ffmpeg is not installed on the server" : error.message;
    });
    child.on("close", (code) => {
      if (active === session) active = null;
      const reason = closedReason || stderr.trim().split("\n").pop() || `ffmpeg exited with code ${code}`;
      if (ws.readyState === ws.OPEN) ws.close(code === 0 ? 1000 : 1011, reason.slice(0, 120));
      if (code !== 0) console.error(`Switcher output stopped: ${reason}`);
    });

    ws.on("message", (data, isBinary) => {
      if (!isBinary) return;
      session.bytes += data.length;
      if (child.stdin.writableLength > maxBufferedBytes) {
        closedReason = "The server could not keep up with the incoming video";
        child.kill("SIGTERM");
        return;
      }
      child.stdin.write(data);
    });
    ws.on("close", () => {
      child.stdin.end();
      // Give ffmpeg a moment to flush, then make sure it is gone.
      setTimeout(() => child.kill("SIGTERM"), 3000).unref();
    });

    ws.send(JSON.stringify({ type: "ready" }));
  }

  return {
    status: () => (active ? { active: true, user: active.user, startedAt: active.startedAt } : { active: false }),
    shutdown() {
      active?.ws.close(1001, "Server restarting");
      active?.child.kill("SIGTERM");
    },
  };
}
