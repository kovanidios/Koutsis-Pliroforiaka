const { after, before, test } = require("node:test");
const assert = require("node:assert/strict");
const { createServer } = require("../server");

let server;
let baseUrl;

before(async () => {
  server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

async function post(path, value) {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(value),
  });
}

test("room codes join members and reconcile shared weekly availability", async () => {
  const created = await post("/api/rooms", { memberId: "member_one", name: "Alex" });
  assert.equal(created.status, 201);
  const room = await created.json();
  assert.match(room.code, /^[A-HJ-NP-Z2-9]{8}$/);

  const joined = await post(`/api/rooms/${room.code}/join`, { memberId: "member_two", name: "Sam" });
  assert.equal(joined.status, 200);
  const start = await post(`/api/rooms/${room.code}/start`, { memberId: "member_one" });
  assert.equal((await start.json()).started, true);
  const slot = "2026-11-25:evening";
  await post(`/api/rooms/${room.code}/availability`, { memberId: "member_one", slots: [slot, "2026-11-26:morning"] });
  const reconciled = await post(`/api/rooms/${room.code}/availability`, { memberId: "member_two", slots: [slot] });
  const updated = await reconciled.json();
  assert.deepEqual(updated.commonAvailability, [slot]);
});

test("only unanimous likes create a shared venue match", async () => {
  const created = await post("/api/rooms", { memberId: "voter_one", name: "Alex" });
  const room = await created.json();
  await post(`/api/rooms/${room.code}/join`, { memberId: "voter_two", name: "Sam" });
  await post(`/api/rooms/${room.code}/start`, { memberId: "voter_one" });

  const firstVote = await post(`/api/rooms/${room.code}/vote`, {
    memberId: "voter_one", category: "restaurants", optionId: "nolan", liked: true,
  });
  assert.equal((await firstVote.json()).match, null);

  const secondVote = await post(`/api/rooms/${room.code}/vote`, {
    memberId: "voter_two", category: "restaurants", optionId: "nolan", liked: true,
  });
  const matchedRoom = await secondVote.json();
  assert.equal(matchedRoom.match.category, "restaurants");
  assert.equal(matchedRoom.match.optionId, "nolan");
  assert.ok(Number.isFinite(Date.parse(matchedRoom.match.decidedAt)));
});

test("only the creator can start after another person has joined", async () => {
  const created = await post("/api/rooms", { memberId: "host", name: "Alex" });
  const room = await created.json();
  const tooEarly = await post(`/api/rooms/${room.code}/start`, { memberId: "host" });
  assert.equal(tooEarly.status, 409);

  await post(`/api/rooms/${room.code}/join`, { memberId: "guest", name: "Sam" });
  const notHost = await post(`/api/rooms/${room.code}/start`, { memberId: "guest" });
  assert.equal(notHost.status, 403);
  const started = await post(`/api/rooms/${room.code}/start`, { memberId: "host" });
  assert.equal((await started.json()).started, true);
});
