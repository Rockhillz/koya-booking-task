import { MongoServerError, ObjectId } from "mongodb";
import { bookings, slots, type BookingDoc } from "../db.js";
import { badRequest, conflict, notFound } from "../lib/errors.js";
import { toBooking } from "../lib/serialize.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DUPLICATE_KEY = 11000;

export const normalizeEmail = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() !== "" ? v.trim().toLowerCase() : undefined;

function parseBookingInput(body: unknown) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw badRequest("body must be a JSON object");
  const b = body as Record<string, unknown>;

  const slotId = typeof b.slot_id === "string" ? b.slot_id.trim() : "";
  const name = typeof b.name === "string" ? b.name.trim() : "";
  const email = typeof b.email === "string" ? b.email.trim().toLowerCase() : "";

  if (!slotId) throw badRequest("slot_id is required");
  if (!name) throw badRequest("name is required");
  if (!email) throw badRequest("email is required");
  if (!EMAIL_RE.test(email)) throw badRequest("email is invalid");
  return { slotId, name, email };
}

/** Levels 1–3: validate, check the slot, and insert. The unique index decides races. */
export async function createBooking(body: unknown) {
  const { slotId, name, email } = parseBookingInput(body);

  const slot = await slots().findOne({ _id: slotId });
  if (!slot) throw notFound("slot not found");
  if (slot.startAt.getTime() <= Date.now()) throw badRequest("slot has already started");

  const doc: BookingDoc = {
    _id: new ObjectId(),
    slot_id: slotId,
    name,
    email,
    status: "confirmed",
    created_at: new Date(),
  };
  try {
    await bookings().insertOne(doc);
  } catch (err) {
    if (err instanceof MongoServerError && err.code === DUPLICATE_KEY) throw conflict("slot already booked");
    throw err;
  }
  return toBooking(doc);
}

const parseId = (id: string) => (ObjectId.isValid(id) && id.length === 24 ? new ObjectId(id) : undefined);

export async function getBooking(id: string) {
  const _id = parseId(id);
  const doc = _id && (await bookings().findOne({ _id }));
  if (!doc) throw notFound("booking not found");
  return toBooking(doc);
}

/** Level 3: atomically flip confirmed -> cancelled, which also frees the slot in the unique index. */
export async function cancelBooking(id: string) {
  const _id = parseId(id);
  if (!_id) throw notFound("booking not found");
  const updated = await bookings().findOneAndUpdate(
    { _id, status: "confirmed" },
    { $set: { status: "cancelled" } },
    { returnDocument: "after" },
  );
  if (updated) return toBooking(updated);
  const exists = await bookings().findOne({ _id }, { projection: { _id: 1 } });
  if (!exists) throw notFound("booking not found");
  throw conflict("booking already cancelled");
}

// ---- Level 4: cursor pagination ------------------------------------------

interface Cursor {
  t: number; // created_at epoch ms
  id: string; // ObjectId hex (tie-breaker)
}

const encodeCursor = (doc: BookingDoc) =>
  Buffer.from(JSON.stringify({ t: doc.created_at.getTime(), id: doc._id.toHexString() })).toString("base64url");

function decodeCursor(raw: string): Cursor {
  try {
    const c = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Cursor;
    if (typeof c.t === "number" && Number.isFinite(c.t) && typeof c.id === "string" && parseId(c.id)) return c;
  } catch {
    /* fall through */
  }
  throw badRequest("invalid cursor");
}

function parseLimit(raw: unknown): number {
  if (raw === undefined) return 10;
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) throw badRequest("limit must be an integer from 1 to 50");
  const n = Number(raw);
  if (n < 1 || n > 50) throw badRequest("limit must be an integer from 1 to 50");
  return n;
}

export async function listBookings(query: Record<string, unknown>) {
  const email = normalizeEmail(query.email);
  if (!email) throw badRequest("email is required");
  const limit = parseLimit(query.limit);

  const filter: Record<string, unknown> = { email };
  if (query.cursor !== undefined) {
    if (typeof query.cursor !== "string" || query.cursor === "") throw badRequest("invalid cursor");
    const c = decodeCursor(query.cursor);
    const t = new Date(c.t);
    filter.$or = [{ created_at: { $gt: t } }, { created_at: t, _id: { $gt: new ObjectId(c.id) } }];
  }

  // Fetch one extra row to know whether another page exists.
  const docs = await bookings().find(filter).sort({ created_at: 1, _id: 1 }).limit(limit + 1).toArray();
  const page = docs.slice(0, limit);
  const hasMore = docs.length > limit;
  return {
    bookings: page.map(toBooking),
    next_cursor: hasMore ? encodeCursor(page[page.length - 1]) : null,
  };
}
