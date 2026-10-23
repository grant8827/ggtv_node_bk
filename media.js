import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, stat, statfs, unlink } from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { randomUUID } from "node:crypto";

// Leave some room on the volume for temporary files and anything else stored there.
const reserveBytes = 512 * 1024 * 1024;

// Video files uploaded from the studio, stored on disk (the Railway volume in production).
export function createMediaStore({ dir, maxUploadBytes, HttpError }) {
  async function usage() {
    await mkdir(dir, { recursive: true });
    const fs = await statfs(dir);
    return { free: Math.max(0, fs.bavail * fs.bsize - reserveBytes), total: fs.blocks * fs.bsize };
  }

  // Streams the request body to disk. The browser sends the raw file with its name in X-File-Name.
  async function upload(request) {
    const type = String(request.headers["content-type"] || "").split(";")[0].trim();
    if (!type.startsWith("video/")) throw new HttpError(415, "Only video files can be uploaded");
    const length = Number(request.headers["content-length"]);
    if (!Number.isFinite(length) || length <= 0) throw new HttpError(411, "The upload is missing its file size");
    if (length > maxUploadBytes) throw new HttpError(413, `Files can be up to ${Math.floor(maxUploadBytes / 1e9)} GB`);
    if (length > (await usage()).free) throw new HttpError(507, "Not enough space left on the server for this file");

    let name = "video";
    try {
      name = decodeURIComponent(String(request.headers["x-file-name"] || "")).trim().slice(0, 200) || name;
    } catch {
      // keep the default name
    }
    const id = randomUUID();
    const ext = (path.extname(name).toLowerCase().match(/^\.[a-z0-9]{1,8}$/) ?? [".mp4"])[0];
    const file = `${id}${ext}`;
    const partial = path.join(dir, `${id}.part`);

    let received = 0;
    const counter = new Transform({
      transform(chunk, _encoding, callback) {
        received += chunk.length;
        callback(received > length ? new HttpError(400, "The upload was larger than announced") : null, chunk);
      },
    });
    try {
      await pipeline(request, counter, createWriteStream(partial));
      if (received !== length) throw new HttpError(400, "The upload was interrupted. Try again.");
      await rename(partial, path.join(dir, file));
    } catch (error) {
      await unlink(partial).catch(() => undefined);
      if (error instanceof HttpError) throw error;
      throw new HttpError(400, "The upload was interrupted. Try again.");
    }
    return { id, name, type, size: received, file, uploadedAt: new Date().toISOString() };
  }

  // Sends a stored file, honouring Range requests so browsers can seek and read MP4 indexes.
  async function serve(request, response, media) {
    const file = path.join(dir, media.file);
    const info = await stat(file).catch(() => null);
    if (!info) throw new HttpError(404, "The video file is missing on the server");
    const headers = { "Content-Type": media.type, "Accept-Ranges": "bytes", "Cache-Control": "private, max-age=3600" };

    const range = /^bytes=(\d*)-(\d*)$/.exec(String(request.headers.range || ""));
    if (!range) {
      response.writeHead(200, { ...headers, "Content-Length": info.size });
      createReadStream(file).pipe(response);
      return;
    }
    let start = range[1] === "" ? info.size - Number(range[2]) : Number(range[1]);
    let end = range[1] !== "" && range[2] !== "" ? Number(range[2]) : info.size - 1;
    start = Math.max(0, start);
    end = Math.min(end, info.size - 1);
    if (start > end) {
      response.writeHead(416, { "Content-Range": `bytes */${info.size}` });
      response.end();
      return;
    }
    response.writeHead(206, { ...headers, "Content-Length": end - start + 1, "Content-Range": `bytes ${start}-${end}/${info.size}` });
    createReadStream(file, { start, end }).pipe(response);
  }

  return {
    usage,
    upload,
    serve,
    pathOf: (media) => path.join(dir, media.file),
    remove: (media) => unlink(path.join(dir, media.file)).catch(() => undefined),
  };
}
