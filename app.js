const decks = window.GATHER_DECKS;
const periods = [
  { id: "morning", label: "Morning", icon: "☀" },
  { id: "afternoon", label: "Afternoon", icon: "◷" },
  { id: "evening", label: "Evening", icon: "☾" },
];
const state = {
  category: "restaurants",
  index: 0,
  animating: false,
  room: null,
  memberId: localStorage.getItem("gather-member-id") || createMemberId(),
  seenMatch: null,
};
const $ = (selector) => document.querySelector(selector);
const placeCard = $("#place-card");
let toastTimer;
let pollTimer;
let pollInFlight = false;
let refreshErrorAt = 0;
let availabilitySave = Promise.resolve();
let availabilityPending = 0;
let availabilitySlots = new Set();
let scheduleDays = [];

localStorage.setItem("gather-member-id", state.memberId);
const savedName = localStorage.getItem("gather-name") || "";
$("#member-name").value = savedName;
$("#profile-avatar").textContent = savedName ? savedName[0].toUpperCase() : "?";

function createMemberId() {
  return globalThis.crypto?.randomUUID?.() || `member-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function athensToday() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Athens",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function getScheduleDays() {
  const [year, month, day] = athensToday().split("-").map(Number);
  return Array.from({ length: 7 }, (_, offset) => {
    const date = new Date(Date.UTC(year, month - 1, day + offset, 12));
    const key = date.toISOString().slice(0, 10);
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/Athens",
      weekday: "short",
      day: "numeric",
      month: "short",
    }).formatToParts(date);
    const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
    return { key, weekday: values.weekday, label: `${values.day} ${values.month}` };
  });
}

function mapsUrl(place) {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${place.name}, ${place.address}, Greece`)}`;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { "content-type": "application/json", ...options.headers },
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `Request failed (${response.status}).`);
  return result;
}

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("visible"), 3000);
}

function gateError(message = "") {
  $("#gate-error").textContent = message;
}

function setGateBusy(busy, joining = false) {
  $("#create-room").disabled = busy;
  $("#join-room").disabled = busy;
  $("#create-room").innerHTML = busy && !joining ? "Creating your group…" : "Create a group <span>→</span>";
  $("#join-room").textContent = busy && joining ? "Joining…" : "Join";
}

function currentPlaceVotes(place) {
  return state.room?.votes?.[state.category]?.[place.id] || {};
}

function renderMembers(place = decks[state.category][state.index]) {
  if (!state.room) return;
  const votes = place ? currentPlaceVotes(place) : {};
  const members = state.room.members;
  $("#group-name").textContent = `Your group · ${members.length}`;
  $("#member-list").innerHTML = members.map((member) => {
    const vote = votes[member.id];
    const availabilityCount = member.availability.length;
    const status = typeof vote === "boolean"
      ? vote ? "Liked this place" : "Passed on this place"
      : availabilityCount ? `${availabilityCount} free time${availabilityCount === 1 ? "" : "s"}`
        : "Choosing availability";
    const statusClass = typeof vote === "boolean" || availabilityCount ? " is-active" : "";
    const check = typeof vote === "boolean";
    return `<div class="member">
      <span class="member-avatar" style="background:${avatarColor(member.id)}">${escapeHtml(member.name[0].toUpperCase())}</span>
      <div class="member-copy"><div class="member-name">${escapeHtml(member.name)}${member.id === state.memberId ? " (you)" : ""}</div><div class="member-status${statusClass}">${status}</div></div>
      <span class="member-check${check ? member.id === state.memberId ? " you" : " done" : ""}">${check ? "✓" : ""}</span>
    </div>`;
  }).join("");

  const voted = Object.keys(votes).length;
  $("#progress-count").textContent = `${voted} of ${members.length}`;
  $("#progress-fill").style.width = `${members.length ? (voted / members.length) * 100 : 0}%`;
  $("#progress-caption").textContent = voted === members.length
    ? "Everyone has voted on this place."
    : `${members.length - voted} ${members.length - voted === 1 ? "person" : "people"} still deciding on this place.`;
}

function avatarColor(id) {
  const colors = ["#f4e3bd", "#e8d2dc", "#d0e1d7", "#d5d9ee", "#f0d7c4", "#d4e4e9"];
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return colors[hash % colors.length];
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]);
}

function renderCard() {
  if (!state.room) return;
  const deck = decks[state.category];
  if (state.room.match) {
    placeCard.hidden = true;
    $(".stack-card").hidden = true;
    $("#empty-state").hidden = false;
    $("#empty-state h2").textContent = "Your group found a match!";
    $("#empty-state p").textContent = "The winning Athens venue is ready. Check the schedule to find a time.";
    $("#restart-button").textContent = "See your match";
    $("#swipe-controls").hidden = true;
    $(".keyboard-hint").hidden = true;
    renderMembers(null);
    return;
  }
  $("#empty-state h2").textContent = "All caught up!";
  $("#empty-state p").textContent = "You've seen every option in this category. Try another category or start over.";
  $("#restart-button").textContent = "Shuffle again";
  if (state.index >= deck.length) {
    placeCard.hidden = true;
    $(".stack-card").hidden = true;
    $("#empty-state").hidden = false;
    $("#swipe-controls").hidden = true;
    $(".keyboard-hint").hidden = true;
    renderMembers(null);
    return;
  }
  placeCard.hidden = false;
  $(".stack-card").hidden = false;
  $("#empty-state").hidden = true;
  $("#swipe-controls").hidden = false;
  $(".keyboard-hint").hidden = false;
  placeCard.classList.remove("swipe-like", "swipe-pass");
  const place = deck[state.index];
  $("#place-image").src = place.image;
  $("#place-image").alt = "";
  $("#place-name").textContent = place.name;
  $("#place-meta").textContent = `${place.area} · ${place.address}`;
  $("#card-badge").textContent = place.badge;
  $("#place-category").textContent = place.type;
  $("#map-link").href = mapsUrl(place);
  $("#place-description").textContent = place.description;

  const votes = currentPlaceVotes(place);
  $("#vote-row").innerHTML = state.room.members.map((member) => {
    const vote = votes[member.id];
    const status = typeof vote === "boolean" ? vote ? "yes" : "no" : "waiting";
    return `<span class="vote-avatar ${status}" style="background:${avatarColor(member.id)}" title="${escapeHtml(member.name)}">${escapeHtml(member.name[0].toUpperCase())}</span>`;
  }).join("") + `<span class="vote-caption">${Object.keys(votes).length} of ${state.room.members.length} voted</span>`;
  renderMembers(place);
}

function renderSchedule() {
  if (!state.room) return;
  const mine = state.room.members.find((member) => member.id === state.memberId);
  if (!availabilityPending) availabilitySlots = new Set(mine?.availability || []);
  const headers = scheduleDays.map((day) => `
    <div class="schedule-day"><span>${day.weekday}</span><strong>${day.label}</strong></div>`).join("");
  const rows = periods.map((period) => `
    <div class="period-label">${period.icon} ${period.label}</div>
    ${scheduleDays.map((day) => {
      const slot = `${day.key}:${period.id}`;
      const selected = availabilitySlots.has(slot);
      return `<button class="availability-cell${selected ? " selected" : ""}" type="button" data-slot="${slot}" aria-label="${day.weekday} ${day.label}, ${period.label}" aria-pressed="${selected}">${selected ? "✓" : ""}</button>`;
    }).join("")}`).join("");
  $("#availability-table").innerHTML = `<div class="schedule-grid"><div class="schedule-corner"></div>${headers}${rows}</div>`;
  $("#availability-table").querySelectorAll(".availability-cell").forEach((button) => {
    button.addEventListener("click", () => toggleAvailability(button.dataset.slot));
  });

  const common = state.room.commonAvailability;
  const allSlots = scheduleDays.flatMap((day) => periods.map((period) => ({
    key: `${day.key}:${period.id}`,
    day,
    period,
  })));
  if (common.length) {
    const labels = common.map((key) => {
      const slot = allSlots.find((item) => item.key === key);
      return slot ? `${slot.day.weekday} ${slot.day.label} · ${slot.period.label}` : null;
    }).filter(Boolean);
    $("#schedule-results").innerHTML = `<strong>Everyone is free</strong><p>${labels.map(escapeHtml).join("<br>")}</p>`;
  } else {
    const overlaps = allSlots.map((slot) => ({
      ...slot,
      count: state.room.members.filter((member) => member.availability.includes(slot.key)).length,
    })).filter((slot) => slot.count > 0).sort((a, b) => b.count - a.count).slice(0, 3);
    const suggestions = overlaps.length
      ? `<p>Closest overlaps: ${overlaps.map((slot) => `${slot.day.weekday} ${slot.day.label} ${slot.period.label} (${slot.count}/${state.room.members.length})`).join(" · ")}</p>`
      : "<p>Choose the times you're free; shared options will show up here.</p>";
    $("#schedule-results").innerHTML = `<strong>No time works for everyone yet</strong>${suggestions}`;
  }
}

async function toggleAvailability(slot) {
  const next = new Set(availabilitySlots);
  if (next.has(slot)) next.delete(slot);
  else next.add(slot);
  availabilitySlots = next;
  availabilityPending++;
  renderSchedule();
  availabilitySave = availabilitySave.catch(() => {}).then(async () => {
    try {
      const updated = await api(`/api/rooms/${state.room.code}/availability`, {
        method: "POST",
        body: JSON.stringify({ memberId: state.memberId, slots: [...next] }),
      });
      state.room = updated;
    } catch (error) {
      showToast(`Availability wasn't saved: ${error.message}`);
      await refreshRoom();
    } finally {
      availabilityPending--;
      if (!availabilityPending && state.room) syncRoom(state.room);
      else renderSchedule();
    }
  });
  await availabilitySave;
}

function renderMatch(match, show = false) {
  const place = decks[match.category]?.find((option) => option.id === match.optionId);
  if (!place) return;
  const matchKey = `${match.category}:${match.optionId}`;
  $("#match-image").src = place.image;
  $("#match-image").alt = "";
  $("#match-name").textContent = place.name;
  $("#match-subtitle").textContent = `${place.type} · ${place.address}`;
  $("#match-map-link").href = mapsUrl(place);
  $("#match-avatars").innerHTML = state.room.members.map((member) =>
    `<span class="member-avatar" style="background:${avatarColor(member.id)}" title="${escapeHtml(member.name)}">${escapeHtml(member.name[0].toUpperCase())}</span>`
  ).join("");
  if (show && state.seenMatch !== matchKey) {
    state.seenMatch = matchKey;
    $("#match-overlay").classList.add("open");
    $("#match-overlay").setAttribute("aria-hidden", "false");
    $("#done-button").focus();
  }
}

function closeMatch() {
  $("#match-overlay").classList.remove("open");
  $("#match-overlay").setAttribute("aria-hidden", "true");
}

function skipResolvedCards() {
  const deck = decks[state.category];
  while (state.index < deck.length) {
    const votes = currentPlaceVotes(deck[state.index]);
    const rejected = Object.values(votes).some((liked) => liked === false);
    const alreadyVoted = Object.hasOwn(votes, state.memberId);
    if (!rejected && !alreadyVoted) break;
    state.index++;
  }
}

function syncRoom(updated) {
  state.room = updated;
  $("#room-code").textContent = updated.code;
  renderSchedule();
  if (updated.match) {
    renderCard();
    renderMatch(updated.match, true);
    return;
  }
  if (state.animating) return;
  skipResolvedCards();
  renderCard();
}

async function refreshRoom() {
  if (!state.room || pollInFlight) return;
  pollInFlight = true;
  try {
    const updated = await api(`/api/rooms/${state.room.code}`);
    refreshErrorAt = 0;
    syncRoom(updated);
  } catch (error) {
    if (Date.now() - refreshErrorAt > 10_000) {
      showToast(`Couldn't refresh the room: ${error.message}`);
      refreshErrorAt = Date.now();
    }
  } finally {
    pollInFlight = false;
  }
}

async function enterRoom(endpoint, payload, openApp = false) {
  const name = $("#member-name").value.trim() || "Guest";
  $("#member-name").value = name;
  gateError();
  setGateBusy(true, endpoint !== "/api/rooms");
  try {
    localStorage.setItem("gather-name", name);
    const updated = await api(endpoint, {
      method: "POST",
      body: JSON.stringify({ ...payload, memberId: state.memberId, name }),
    });
    if (!openApp) {
      location.assign(`/lobby.html?room=${updated.code}`);
      return;
    }
    if (!updated.started) {
      location.replace(`/lobby.html?room=${updated.code}`);
      return;
    }
    state.room = updated;
    state.index = 0;
    $("#profile-avatar").textContent = name[0].toUpperCase();
    $("#room-gate").hidden = true;
    history.replaceState(null, "", `/index.html?room=${updated.code}`);
    scheduleDays = getScheduleDays();
    syncRoom(updated);
    clearInterval(pollTimer);
    pollTimer = setInterval(refreshRoom, 2000);
  } catch (error) {
    gateError(error.message);
  } finally {
    setGateBusy(false, endpoint !== "/api/rooms");
  }
}

function showPlaceInfo() {
  const place = decks[state.category][state.index];
  if (!place) return;
  $("#info-title").textContent = place.name;
  $("#info-copy").textContent = `${place.detail} Address: ${place.address}, Athens, Greece.`;
  $("#info-map").href = mapsUrl(place);
  $("#info-overlay").classList.add("open");
  $("#info-overlay").setAttribute("aria-hidden", "false");
  $("#info-close").focus();
}

function closeInfo() {
  $("#info-overlay").classList.remove("open");
  $("#info-overlay").setAttribute("aria-hidden", "true");
  $("#info-button").focus();
}

async function vote(liked) {
  if (!state.room || state.animating || state.index >= decks[state.category].length ||
      $("#match-overlay").classList.contains("open")) return;
  if (state.room.match) {
    showToast("Your group has already found its place.");
    return;
  }
  const place = decks[state.category][state.index];
  const category = state.category;
  state.animating = true;
  $("#like-stamp").classList.toggle("visible", liked);
  $("#pass-stamp").classList.toggle("visible", !liked);
  placeCard.classList.add(liked ? "swipe-like" : "swipe-pass");
  setTimeout(async () => {
    $("#like-stamp").classList.remove("visible");
    $("#pass-stamp").classList.remove("visible");
    state.index++;
    renderCard();
    try {
      const updated = await api(`/api/rooms/${state.room.code}/vote`, {
        method: "POST",
        body: JSON.stringify({ memberId: state.memberId, category, optionId: place.id, liked }),
      });
      state.animating = false;
      syncRoom(updated);
    } catch (error) {
      state.animating = false;
      showToast(`Your vote wasn't saved: ${error.message}`);
      if (!state.room.match) state.index = Math.max(0, state.index - 1);
      renderCard();
      await refreshRoom();
    }
  }, 300);
}

function setCategory(category) {
  if (state.animating || !decks[category] || category === state.category) return;
  state.category = category;
  state.index = 0;
  document.querySelectorAll(".category-tab").forEach((tab) => {
    const active = tab.dataset.category === category;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", String(active));
  });
  skipResolvedCards();
  renderCard();
}

$("#join-room").addEventListener("click", () => {
  const code = $("#room-code-input").value.trim().toUpperCase();
  if (!/^[A-HJ-NP-Z2-9]{8}$/.test(code)) {
    gateError("Enter the 8-character room code from your invite.");
    $("#room-code-input").focus();
    return;
  }
  enterRoom(`/api/rooms/${code}/join`, {});
});
$("#room-code-input").addEventListener("input", (event) => {
  event.target.value = event.target.value.toUpperCase().replace(/[^A-HJ-NP-Z2-9]/g, "").slice(0, 8);
});
$("#invite-button").addEventListener("click", async () => {
  if (!state.room) return;
  const url = `${location.origin}/lobby.html?room=${state.room.code}`;
  try {
    if (navigator.share) await navigator.share({ title: "Join our Gather group", url });
    else {
      await navigator.clipboard.writeText(url);
      showToast("Invite link copied. Send it to your friends!");
    }
  } catch (error) {
    if (error.name === "AbortError") return;
    window.prompt("Copy this invite link for your friends:", url);
  }
});
$("#pass-button").addEventListener("click", () => vote(false));
$("#like-button").addEventListener("click", () => vote(true));
document.querySelectorAll(".category-tab").forEach((tab) => tab.addEventListener("click", () => setCategory(tab.dataset.category)));
$("#restart-button").addEventListener("click", () => {
  if (state.room?.match) {
    state.seenMatch = null;
    renderMatch(state.room.match, true);
    return;
  }
  state.index = 0;
  skipResolvedCards();
  renderCard();
});
$("#match-close").addEventListener("click", closeMatch);
$("#done-button").addEventListener("click", () => {
  closeMatch();
  showToast("It's a plan. Check the schedule to find your shared time.");
});
$("#keep-going-button").addEventListener("click", () => {
  closeMatch();
  $("#schedule-panel").scrollIntoView({ behavior: "smooth", block: "center" });
});
$("#match-overlay").addEventListener("click", (event) => { if (event.target === $("#match-overlay")) closeMatch(); });
$("#info-button").addEventListener("click", showPlaceInfo);
$("#info-close").addEventListener("click", closeInfo);
$("#info-done").addEventListener("click", closeInfo);
$("#info-overlay").addEventListener("click", (event) => { if (event.target === $("#info-overlay")) closeInfo(); });
$("#member-name").addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    if ($("#room-code-input").value.trim()) $("#join-room").click();
    else $("#create-room").click();
  }
});
$("#member-name").addEventListener("input", (event) => {
  localStorage.setItem("gather-name", event.target.value);
});

let pointerStart = null;
placeCard.addEventListener("pointerdown", (event) => {
  if (state.animating || event.target.closest("button")) return;
  pointerStart = { x: event.clientX };
  placeCard.setPointerCapture(event.pointerId);
  placeCard.style.transition = "none";
});
placeCard.addEventListener("pointermove", (event) => {
  if (!pointerStart || state.animating) return;
  const deltaX = event.clientX - pointerStart.x;
  if (Math.abs(deltaX) < 4) return;
  placeCard.style.transform = `translate(${deltaX}px, ${Math.max(-8, Math.abs(deltaX) * .04)}px) rotate(${deltaX * .035}deg)`;
  $("#like-stamp").classList.toggle("visible", deltaX > 45);
  $("#pass-stamp").classList.toggle("visible", deltaX < -45);
});
placeCard.addEventListener("pointerup", (event) => {
  if (!pointerStart) return;
  const deltaX = event.clientX - pointerStart.x;
  pointerStart = null;
  placeCard.style.transition = "";
  placeCard.style.transform = "";
  $("#like-stamp").classList.remove("visible");
  $("#pass-stamp").classList.remove("visible");
  if (deltaX > 90) vote(true);
  else if (deltaX < -90) vote(false);
});
placeCard.addEventListener("pointercancel", () => {
  pointerStart = null;
  placeCard.style.transition = "";
  placeCard.style.transform = "";
  $("#like-stamp").classList.remove("visible");
  $("#pass-stamp").classList.remove("visible");
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    if ($("#info-overlay").classList.contains("open")) closeInfo();
    if ($("#match-overlay").classList.contains("open")) closeMatch();
  }
  if (event.key === "ArrowLeft") vote(false);
  if (event.key === "ArrowRight") vote(true);
});

scheduleDays = getScheduleDays();
const invitedCode = new URLSearchParams(location.search).get("room");
if (invitedCode) {
  $("#room-code-input").value = invitedCode.toUpperCase();
  enterRoom(`/api/rooms/${invitedCode.toUpperCase()}/join`, {}, true);
}
