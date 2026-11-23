const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const decks = require("./venues");

const PORT = Number(process.env.PORT) || 8000;
const ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const PUBLIC_FILES = new Set(["index.html", "lobby.html", "styles.css", "app.js", "lobby.js", "venues.js"]);
const rooms = new Map();

function createCode() {
  let code;
  do {
    code = Array.from(crypto.randomBytes(8), (byte) => ROOM_CODE_ALPHABET[byte % ROOM_CODE_ALPHABET.length]).join("");
  } while (rooms.has(code));
  return code;
}

function validId(value) {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(value);
}

function cleanName(value) {
  return typeof value === "string" ? value.trim().slice(0, 32) : "";
}

function getMember(room, memberId) {
  return room.members.find((member) => member.id === memberId);
}

function roomSnapshot(room) {
  const availability = Object.values(room.availability);
  const commonAvailability = room.members.length && availability.length === room.members.length
    ? availability.reduce((common, slots) => common.filter((slot) => slots.includes(slot)), [...availability[0]])
    : [];
  return {
    code: room.code,
    createdAt: room.createdAt,
    members: room.members.map(({ id, name, joinedAt }) => ({
      id,
      name,
      joinedAt,
      availability: room.availability[id] || [],
    })),
    votes: room.votes,
    match: room.match,
    ownerId: room.ownerId,
    started: room.started,
    commonAvailability,
  };
}

function sendJson(response, status, value) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(value));
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 16_384) {
        reject(Object.assign(new Error("Request body is too large"), { status: 413 }));
        request.destroy();
      }
    });
    request.on("end", () => {
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(Object.assign(new Error("Request body must be valid JSON"), { status: 400 }));
      }
    });
    request.on("error", reject);
  });
}

function routeApi(request, response, url) {
  const segments = url.pathname.split("/").filter(Boolean);
  if (request.method === "GET" && url.pathname === "/api/venues") {
    sendJson(response, 200, decks);
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/rooms") {
    readJson(request).then((body) => {
      const name = cleanName(body.name);
      if (!name || !validId(body.memberId)) return sendJson(response, 400, { error: "Enter your name to create a room." });
      const code = createCode();
      const room = {
        code,
        createdAt: new Date().toISOString(),
        ownerId: body.memberId,
        started: false,
        members: [{ id: body.memberId, name, joinedAt: new Date().toISOString() }],
        availability: { [body.memberId]: [] },
        votes: {},
        match: null,
      };
      rooms.set(code, room);
      sendJson(response, 201, roomSnapshot(room));
    }).catch((error) => sendJson(response, error.status || 400, { error: error.message }));
    return;
  }
  if (segments[0] !== "api" || segments[1] !== "rooms" || !segments[2]) {
    sendJson(response, 404, { error: "Not found." });
    return;
  }

  const code = segments[2].toUpperCase();
  const room = rooms.get(code);
  if (!room) {
    sendJson(response, 404, { error: "That room code was not found. Check it and try again." });
    return;
  }
  const action = segments[3];

  if (request.method === "GET" && !action) {
    sendJson(response, 200, roomSnapshot(room));
    return;
  }
  if (request.method === "POST" && action === "join") {
    readJson(request).then((body) => {
      const name = cleanName(body.name);
      if (!name || !validId(body.memberId)) return sendJson(response, 400, { error: "Enter your name to join the room." });
      const existing = getMember(room, body.memberId);
      if (existing) {
        existing.name = name;
        sendJson(response, 200, roomSnapshot(room));
        return;
      }
      if (room.started) return sendJson(response, 409, { error: "This group has already started, so new members can't join." });
      if (room.members.length >= 20) return sendJson(response, 409, { error: "This room is full (20 people maximum)." });
      room.members.push({ id: body.memberId, name, joinedAt: new Date().toISOString() });
      room.availability[body.memberId] = [];
      sendJson(response, 200, roomSnapshot(room));
    }).catch((error) => sendJson(response, error.status || 400, { error: error.message }));
    return;
  }
  if (request.method === "POST" && action === "start") {
    readJson(request).then((body) => {
      if (body.memberId !== room.ownerId) return sendJson(response, 403, { error: "Only the group creator can start the app." });
      if (room.members.length < 2) return sendJson(response, 409, { error: "Wait for at least one friend to join before starting." });
      room.started = true;
      sendJson(response, 200, roomSnapshot(room));
    }).catch((error) => sendJson(response, error.status || 400, { error: error.message }));
    return;
  }
  if (request.method === "POST" && action === "availability") {
    readJson(request).then((body) => {
      if (!getMember(room, body.memberId)) return sendJson(response, 403, { error: "Join this room before updating availability." });
      if (!room.started) return sendJson(response, 409, { error: "The group creator hasn't started the app yet." });
      if (!Array.isArray(body.slots) || body.slots.length > 21 ||
          body.slots.some((slot) => typeof slot !== "string" || !/^\d{4}-\d{2}-\d{2}:(morning|afternoon|evening)$/.test(slot))) {
        return sendJson(response, 400, { error: "Select valid availability slots from the weekly schedule." });
      }
      room.availability[body.memberId] = [...new Set(body.slots)];
      sendJson(response, 200, roomSnapshot(room));
    }).catch((error) => sendJson(response, error.status || 400, { error: error.message }));
    return;
  }
  if (request.method === "POST" && action === "vote") {
    readJson(request).then((body) => {
      if (!getMember(room, body.memberId)) return sendJson(response, 403, { error: "Join this room before voting." });
      if (!room.started) return sendJson(response, 409, { error: "The group creator hasn't started the app yet." });
      if (!Object.hasOwn(decks, body.category) || typeof body.optionId !== "string" ||
          !decks[body.category].some((option) => option.id === body.optionId) || typeof body.liked !== "boolean") {
        return sendJson(response, 400, { error: "That vote is not valid." });
      }
      if (room.match) return sendJson(response, 409, { error: "Your group has already found a match." });
      room.votes[body.category] ||= {};
      room.votes[body.category][body.optionId] ||= {};
      room.votes[body.category][body.optionId][body.memberId] = body.liked;
      const optionVotes = room.votes[body.category][body.optionId];
      if (body.liked && room.members.every((member) => optionVotes[member.id] === true)) {
        room.match = { category: body.category, optionId: body.optionId, decidedAt: new Date().toISOString() };
      }
      sendJson(response, 200, roomSnapshot(room));
    }).catch((error) => sendJson(response, error.status || 400, { error: error.message }));
    return;
  }
  sendJson(response, 404, { error: "Not found." });
}

function createServer() {
  return http.createServer((request, response) => {
    const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
    if (url.pathname.startsWith("/api/")) {
      routeApi(request, response, url);
      return;
    }

    let requested;
    try {
      requested = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
    } catch {
      response.writeHead(404);
      response.end("Not found");
      return;
    }
    if (!PUBLIC_FILES.has(requested)) {
      response.writeHead(404);
      response.end("Not found");
      return;
    }
    const filePath = path.join(__dirname, requested);
    fs.readFile(filePath, (error, contents) => {
      if (error) {
        response.writeHead(500);
        response.end("Unable to read application file.");
        return;
      }
      const types = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8" };
      response.writeHead(200, { "content-type": types[path.extname(filePath)], "cache-control": "no-cache" });
      response.end(contents);
    });
  });
}

if (require.main === module) {
  createServer().listen(PORT, "0.0.0.0", () => console.log(`Gather listening on http://localhost:${PORT}`));
}

module.exports = { createServer };
