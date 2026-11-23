const params = new URLSearchParams(location.search);
let code = (params.get("room") || "").toUpperCase();
const createNewRoom = params.get("new") === "1";
const memberId = localStorage.getItem("gather-member-id") || createMemberId();
const $ = (selector) => document.querySelector(selector);
let room;
let pollTimer;
let polling = false;

localStorage.setItem("gather-member-id", memberId);
$("#join-name").value = localStorage.getItem("gather-name") || "";

function createMemberId() {
  return globalThis.crypto?.randomUUID?.() || `member-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]);
}

function colorFor(id) {
  const colors = ["#f4e3bd", "#e8d2dc", "#d0e1d7", "#d5d9ee", "#f0d7c4", "#d4e4e9"];
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return colors[hash % colors.length];
}

async function request(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { "content-type": "application/json", ...options.headers },
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `Request failed (${response.status}).`);
  return result;
}

function setError(message = "") {
  $("#lobby-error").textContent = message;
}

function inviteUrl() {
  return `${location.origin}${location.pathname}?room=${code}`;
}

async function copyValue(value, label) {
  try {
    await navigator.clipboard.writeText(value);
    setError(`${label} copied. Send it to your friends.`);
  } catch {
    window.prompt(`Copy ${label.toLowerCase()}:`, value);
  }
}

function enterApp() {
  location.replace(`/index.html?room=${code}`);
}

function render() {
  if (!room) return;
  const isMember = room.members.some((member) => member.id === memberId);
  const isOwner = room.ownerId === memberId;

  if (room.started) {
    if (isMember) enterApp();
    else setError("This group has already started, so new members can't join.");
    return;
  }

  $("#lobby-title").textContent = isOwner ? "Waiting for your crew" : isMember ? "You're in the group" : "Join your friends";
  $("#lobby-description").textContent = isOwner
    ? "Share the link and start once your friends have arrived."
    : isMember ? "You're in. The group creator will start the app when everyone is ready." : "Enter your name, join the room, and wait for the group to start.";

  $("#join-form").hidden = isMember;
  $("#lobby-invite").hidden = !isOwner;
  $("#lobby-members").hidden = !isMember;
  $("#lobby-waiting").hidden = !isMember || isOwner;
  $("#start-button").hidden = !isOwner;
  $("#lobby-footnote").hidden = !isOwner;

  if (isOwner) {
    $("#lobby-code").textContent = room.code;
    $("#start-button").disabled = room.members.length < 2;
    $("#start-button").innerHTML = room.members.length < 2
      ? "Waiting for a friend to join…"
      : `Start choosing places with ${room.members.length} people <span>→</span>`;
  } else if (isMember) {
    $("#waiting-message").textContent = "Waiting for the group creator to start…";
  }

  $("#member-count").textContent = `${room.members.length} ${room.members.length === 1 ? "person" : "people"}`;
  $("#member-list").innerHTML = room.members.map((member) => `
    <div class="lobby-member">
      <span class="member-avatar" style="background:${colorFor(member.id)}">${escapeHtml(member.name[0].toUpperCase())}</span>
      <span class="lobby-member-name">${escapeHtml(member.name)}${member.id === room.ownerId ? " · host" : ""}</span>
      <span class="lobby-member-state">${member.id === memberId ? "You" : "Joined"}</span>
    </div>`).join("");
}

async function refreshRoom() {
  if (polling || !code) return;
  polling = true;
  try {
    room = await request(`/api/rooms/${code}`);
    setError();
    render();
  } catch (error) {
    setError(error.message);
  } finally {
    polling = false;
  }
}

async function joinGroup() {
  const name = $("#join-name").value.trim() || "Guest";
  $("#join-name").value = name;
  $("#join-button").disabled = true;
  $("#join-button").textContent = "Joining…";
  setError();
  try {
    localStorage.setItem("gather-name", name);
    room = await request(`/api/rooms/${code}/join`, {
      method: "POST",
      body: JSON.stringify({ memberId, name }),
    });
    render();
  } catch (error) {
    setError(error.message);
  } finally {
    $("#join-button").disabled = false;
    $("#join-button").innerHTML = "Join this group <span>→</span>";
  }
}

async function startApp() {
  $("#start-button").disabled = true;
  $("#start-button").textContent = "Starting…";
  setError();
  try {
    room = await request(`/api/rooms/${code}/start`, {
      method: "POST",
      body: JSON.stringify({ memberId }),
    });
    render();
  } catch (error) {
    setError(error.message);
  }
}

async function createGroup() {
  const name = localStorage.getItem("gather-name") || "Guest";
  try {
    room = await request("/api/rooms", {
      method: "POST",
      body: JSON.stringify({ memberId, name }),
    });
    code = room.code;
    history.replaceState(null, "", `/lobby.html?room=${code}`);
    render();
    pollTimer = setInterval(refreshRoom, 2000);
  } catch (error) {
    setError(error.message);
  }
}

$("#join-button").addEventListener("click", joinGroup);
$("#join-name").addEventListener("keydown", (event) => {
  if (event.key === "Enter") joinGroup();
});
$("#copy-code").addEventListener("click", () => copyValue(code, "Room code"));
$("#copy-link").addEventListener("click", () => copyValue(inviteUrl(), "Invite link"));
$("#start-button").addEventListener("click", startApp);

if (createNewRoom) {
  createGroup();
} else if (!/^[A-HJ-NP-Z2-9]{8}$/.test(code)) {
  setError("That invite link doesn't contain a valid group code.");
} else {
  refreshRoom();
  pollTimer = setInterval(refreshRoom, 2000);
}
