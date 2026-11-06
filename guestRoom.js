import { randomUUID } from "node:crypto";
import { WebSocketServer } from "ws";

const maxGuests = 8;
const maxMessageBytes = 64 * 1024;

function send(ws, message) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
}

function parse(data, isBinary) {
  if (isBinary) return null;
  try {
    const message = JSON.parse(String(data));
    return message && typeof message === "object" && typeof message.type === "string" ? message : null;
  } catch {
    return null;
  }
}

// Connects invited guests' browsers with the studio switcher's browser. The video itself goes
// directly between the browsers over WebRTC; this only passes the setup messages between them.
//   studio socket: one at a time (a newer studio tab takes over)
//   guest socket:  one per invite link at a time (rejoining replaces the old connection)
export function attachGuestRoom(server, { studioPath, guestPath, authorizeStudio, findInvite, iceServers }) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: maxMessageBytes });
  let studio = null;
  const guests = new Map(); // connection id -> { id, inviteId, name, ws, joinedAt }

  const guestView = (guest) => ({ guestId: guest.id, inviteId: guest.inviteId, name: guest.name, joinedAt: guest.joinedAt });

  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url, "http://localhost");
    if (url.pathname === studioPath) {
      const denied = authorizeStudio(request);
      if (denied) {
        socket.end(`HTTP/1.1 ${denied}\r\nConnection: close\r\n\r\n`);
        return;
      }
      wss.handleUpgrade(request, socket, head, onStudio);
    } else if (url.pathname === guestPath) {
      const invite = findInvite(url.searchParams.get("token") || "");
      if (!invite) {
        socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
        return;
      }
      const replacing = [...guests.values()].some((guest) => guest.inviteId === invite.id);
      if (!replacing && guests.size >= maxGuests) {
        socket.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
        return;
      }
      wss.handleUpgrade(request, socket, head, (ws) => onGuest(ws, invite));
    }
  });

  function onStudio(ws) {
    if (studio) studio.close(4000, "The studio was opened in another tab");
    studio = ws;
    send(ws, { type: "welcome", iceServers: iceServers(), guests: [...guests.values()].map(guestView) });
    for (const guest of guests.values()) send(guest.ws, { type: "studio-ready" });

    ws.on("message", (data, isBinary) => {
      const message = parse(data, isBinary);
      if (!message || studio !== ws) return;
      const guest = guests.get(message.guestId);
      if (!guest) return;
      if (message.type === "signal" && message.data && typeof message.data === "object") {
        send(guest.ws, { type: "signal", data: message.data });
      } else if (message.type === "remove") {
        guest.ws.close(4001, "The studio ended your connection");
      }
    });
    ws.on("close", () => {
      if (studio !== ws) return;
      studio = null;
      for (const guest of guests.values()) send(guest.ws, { type: "studio-away" });
    });
  }

  function onGuest(ws, invite) {
    for (const guest of guests.values()) {
      if (guest.inviteId === invite.id) guest.ws.close(4002, "This invite link was opened somewhere else");
    }
    const guest = { id: randomUUID(), inviteId: invite.id, name: invite.name, ws, joinedAt: new Date().toISOString() };
    guests.set(guest.id, guest);
    send(ws, { type: "welcome", name: invite.name, iceServers: iceServers(), studioReady: Boolean(studio) });
    send(studio, { type: "guest-joined", ...guestView(guest) });

    ws.on("message", (data, isBinary) => {
      const message = parse(data, isBinary);
      if (message?.type === "signal" && message.data && typeof message.data === "object") {
        send(studio, { type: "signal", guestId: guest.id, data: message.data });
      }
    });
    ws.on("close", () => {
      if (guests.get(guest.id) !== guest) return;
      guests.delete(guest.id);
      send(studio, { type: "guest-left", guestId: guest.id });
    });
  }

  return {
    // Disconnects anyone using an invite that has just been deleted.
    revoke(inviteId) {
      for (const guest of guests.values()) {
        if (guest.inviteId === inviteId) guest.ws.close(4003, "This invite link was cancelled");
      }
    },
    connectedInvites: () => new Set([...guests.values()].map((guest) => guest.inviteId)),
    shutdown() {
      studio?.close(1001, "Server restarting");
      for (const guest of guests.values()) guest.ws.close(1001, "Server restarting");
    },
  };
}
