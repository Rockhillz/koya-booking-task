import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MongoMemoryServer } from "mongodb-memory-server";
import request from "supertest";
import { createApp } from "../src/app.js";
import { connect, disconnect, rateLimits } from "../src/db.js";

const KEY = "test-key";
const app = createApp({ apiKey: KEY });
let mongo: MongoMemoryServer;

const future = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();
const SLOTS = [
  { id: "s2", provider: "Dr Bola", start: future(120), end: future(150) },
  { id: "s1", provider: "Dr Ade", start: future(60), end: future(90) },
  { id: "past", provider: "Dr Ade", start: future(-60), end: future(-30) },
];

const api = {
  get: (p: string) => request(app).get(p).set("X-API-Key", KEY),
  post: (p: string) => request(app).post(p).set("X-API-Key", KEY),
  del: (p: string) => request(app).delete(p).set("X-API-Key", KEY),
};
const book = (body: object, idemKey?: string) => {
  const r = api.post("/bookings");
  if (idemKey) r.set("Idempotency-Key", idemKey);
  return r.send(body);
};

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await connect(mongo.getUri(), "test");
});
afterAll(async () => {
  await disconnect();
  await mongo.stop();
});
beforeEach(async () => {
  await api.post("/reset").send({ slots: SLOTS }).expect(200);
});

describe("level 1", () => {
  it("lists slots earliest first, with availability, and filters by provider", async () => {
    const res = await api.get("/slots").expect(200);
    expect(res.body.slots.map((s: { id: string }) => s.id)).toEqual(["past", "s1", "s2"]);
    expect(res.body.slots[1]).toEqual({ ...SLOTS[1], available: true });

    const ade = await api.get("/slots?provider=Dr%20Ade").expect(200);
    expect(ade.body.slots.map((s: { id: string }) => s.id)).toEqual(["past", "s1"]);
  });

  it("books a slot and looks it up", async () => {
    const res = await book({ slot_id: "s1", name: "Ada Obi", email: "ada@example.com" }).expect(201);
    expect(res.body).toMatchObject({ slot_id: "s1", name: "Ada Obi", email: "ada@example.com", status: "confirmed" });
    expect(typeof res.body.id).toBe("string");
    expect(new Date(res.body.created_at).toISOString()).toBe(res.body.created_at);

    const got = await api.get(`/bookings/${res.body.id}`).expect(200);
    expect(got.body).toEqual(res.body);

    const slots = await api.get("/slots").expect(200);
    expect(slots.body.slots.find((s: { id: string }) => s.id === "s1").available).toBe(false);
  });

  it("returns 404 for unknown booking ids", async () => {
    await api.get("/bookings/nope").expect(404);
    const res = await api.get("/bookings/0123456789abcdef01234567").expect(404);
    expect(res.body).toHaveProperty("error");
  });

  it("reset wipes bookings", async () => {
    const b = await book({ slot_id: "s1", name: "A", email: "a@x.io" }).expect(201);
    await api.post("/reset").send({ slots: SLOTS }).expect(200);
    await api.get(`/bookings/${b.body.id}`).expect(404);
  });
});

describe("level 2", () => {
  it("requires the API key", async () => {
    expect((await request(app).get("/slots")).status).toBe(401);
    const res = await request(app).get("/slots").set("X-API-Key", "wrong");
    expect(res.status).toBe(401);
    expect(res.body).toHaveProperty("error");
    expect((await request(app).post("/reset").send({ slots: [] })).status).toBe(401);
  });

  it.each([
    [{ name: "A", email: "a@x.io" }],
    [{ slot_id: "s1", email: "a@x.io" }],
    [{ slot_id: "s1", name: "A" }],
    [{ slot_id: "", name: "A", email: "a@x.io" }],
    [{ slot_id: "s1", name: "   ", email: "a@x.io" }],
    [{ slot_id: "s1", name: "A", email: "not-an-email" }],
    [{ slot_id: "s1", name: "A", email: 42 }],
  ])("rejects invalid body %j with 400", async (body) => {
    const res = await book(body).expect(400);
    expect(res.body).toHaveProperty("error");
  });

  it("404s an unknown slot and 400s a slot that already started", async () => {
    await book({ slot_id: "ghost", name: "A", email: "a@x.io" }).expect(404);
    await book({ slot_id: "past", name: "A", email: "a@x.io" }).expect(400);
  });

  it("trims name and email and lower-cases email", async () => {
    const res = await book({ slot_id: "s1", name: "  Ada Obi  ", email: "  ADA@Example.COM " }).expect(201);
    expect(res.body.name).toBe("Ada Obi");
    expect(res.body.email).toBe("ada@example.com");
  });
});

describe("level 3", () => {
  it("rejects a second booking for the same slot", async () => {
    await book({ slot_id: "s1", name: "A", email: "a@x.io" }).expect(201);
    await book({ slot_id: "s1", name: "B", email: "b@x.io" }).expect(409);
  });

  it("allows exactly one booking when 30 requests race for one slot", async () => {
    const results = await Promise.all(
      Array.from({ length: 30 }, (_, i) => book({ slot_id: "s1", name: `P${i}`, email: `p${i}@x.io` })),
    );
    const codes = results.map((r) => r.status);
    expect(codes.filter((c) => c === 201)).toHaveLength(1);
    expect(codes.filter((c) => c === 409)).toHaveLength(29);
  });

  it("cancels a booking, frees the slot, and 409s a second cancel", async () => {
    const b = await book({ slot_id: "s1", name: "A", email: "a@x.io" }).expect(201);
    const c = await api.del(`/bookings/${b.body.id}`).expect(200);
    expect(c.body).toMatchObject({ id: b.body.id, status: "cancelled" });
    await api.del(`/bookings/${b.body.id}`).expect(409);
    await api.del("/bookings/0123456789abcdef01234567").expect(404);

    const slots = await api.get("/slots");
    expect(slots.body.slots.find((s: { id: string }) => s.id === "s1").available).toBe(true);
    await book({ slot_id: "s1", name: "B", email: "b@x.io" }).expect(201);
  });
});

describe("level 4", () => {
  it("replays the same response for a retried request", async () => {
    const body = { slot_id: "s1", name: "A", email: "a@x.io" };
    const first = await book(body, "k1").expect(201);
    const second = await book(body, "k1").expect(201);
    expect(second.body).toEqual(first.body);
    const list = await api.get("/bookings?email=a@x.io");
    expect(list.body.bookings).toHaveLength(1);
  });

  it("returns 422 when a key is reused with a different body", async () => {
    await book({ slot_id: "s1", name: "A", email: "a@x.io" }, "k2").expect(201);
    await book({ slot_id: "s2", name: "A", email: "a@x.io" }, "k2").expect(422);
  });

  it("replays error responses too", async () => {
    await book({ slot_id: "s1", name: "A", email: "a@x.io" }).expect(201);
    await book({ slot_id: "s1", name: "B", email: "b@x.io" }, "k3").expect(409);
    await book({ slot_id: "s1", name: "B", email: "b@x.io" }, "k3").expect(409);
  });

  it("creates only one booking when the same key arrives concurrently", async () => {
    const body = { slot_id: "s2", name: "A", email: "a@x.io" };
    const results = await Promise.all(Array.from({ length: 10 }, () => book(body, "k4")));
    expect(results.map((r) => r.status)).toEqual(Array(10).fill(201));
    expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
  });

  it("pages through a person's bookings oldest first, matching email case-insensitively", async () => {
    const many = Array.from({ length: 5 }, (_, i) => ({
      id: `m${i}`, provider: "Dr Ade", start: future(200 + i * 30), end: future(230 + i * 30),
    }));
    await api.post("/reset").send({ slots: many }).expect(200);
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await book({ slot_id: `m${i}`, name: "Ada", email: i % 2 ? "ADA@x.io" : "ada@x.io" }).expect(201);
      ids.push(r.body.id);
    }
    await book({ slot_id: "m0", name: "Other", email: "other@x.io" }).expect(409); // someone else's attempt

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const q = `/bookings?email=Ada@X.io&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const res = await api.get(q).expect(200);
      seen.push(...res.body.bookings.map((b: { id: string }) => b.id));
      cursor = res.body.next_cursor;
      pages++;
    } while (cursor);
    expect(seen).toEqual(ids);
    expect(pages).toBe(3);

    const all = await api.get("/bookings?email=ada@x.io").expect(200);
    expect(all.body.bookings).toHaveLength(5);
    expect(all.body.next_cursor).toBeNull();
  });

  it.each(["0", "51", "abc", "1.5", "-1"])("rejects limit=%s with 400", async (limit) => {
    await api.get(`/bookings?email=a@x.io&limit=${limit}`).expect(400);
  });

  it("requires email and a valid cursor", async () => {
    await api.get("/bookings").expect(400);
    await api.get("/bookings?email=a@x.io&cursor=garbage").expect(400);
  });
});

describe("level 5", () => {
  it("allows 5 attempts per email per minute, failures included, then 429s with Retry-After", async () => {
    const email = "spam@x.io";
    await book({ slot_id: "s1", name: "A", email }).expect(201);
    for (let i = 0; i < 4; i++) await book({ slot_id: "ghost", name: "A", email }).expect(404);

    const blocked = await book({ slot_id: "s2", name: "A", email: " SPAM@x.io " }).expect(429);
    expect(blocked.body).toHaveProperty("error");
    const retry = Number(blocked.headers["retry-after"]);
    expect(Number.isInteger(retry)).toBe(true);
    expect(retry).toBeGreaterThan(0);
    expect(retry).toBeLessThanOrEqual(60);

    // other emails are unaffected
    await book({ slot_id: "s2", name: "B", email: "other@x.io" }).expect(201);
  });

  it("holds the limit under concurrency", async () => {
    const results = await Promise.all(
      Array.from({ length: 12 }, () => book({ slot_id: "ghost", name: "A", email: "burst@x.io" })),
    );
    const codes = results.map((r) => r.status);
    expect(codes.filter((c) => c === 404)).toHaveLength(5);
    expect(codes.filter((c) => c === 429)).toHaveLength(7);
  });

  it("lets the email in again once the window passes", async () => {
    for (let i = 0; i < 5; i++) await book({ slot_id: "ghost", name: "A", email: "w@x.io" }).expect(404);
    await book({ slot_id: "ghost", name: "A", email: "w@x.io" }).expect(429);
    // Age every recorded hit past the 60s window.
    await rateLimits().updateOne({ _id: "w@x.io" }, [
      { $set: { hits: { $map: { input: "$hits", in: { $subtract: ["$$this", 61_000] } } } } },
    ]);
    await book({ slot_id: "ghost", name: "A", email: "w@x.io" }).expect(404);
  });
});

describe("docs", () => {
  it("serves Swagger UI and the OpenAPI spec without a key", async () => {
    const spec = await request(app).get("/openapi.json").expect(200);
    expect(Object.keys(spec.body.paths)).toEqual(["/reset", "/slots", "/bookings", "/bookings/{id}"]);
    const ui = await request(app).get("/docs/").expect(200);
    expect(ui.text).toContain("swagger-ui");
  });
});

describe("web page", () => {
  it("serves the page and keyless /web routes without exposing /reset", async () => {
    const page = await request(app).get("/").expect(200);
    expect(page.text).toContain("Book an appointment");
    expect(page.text).not.toContain(KEY);
    await request(app).get("/web/slots").expect(200);
    await request(app).post("/web/reset").send({ slots: [] }).expect(404);
  });
});
