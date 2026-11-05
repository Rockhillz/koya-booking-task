import { bookings, idempotency, rateLimits, slots, type SlotDoc } from "../db.js";
import { badRequest } from "../lib/errors.js";
import { toSlot } from "../lib/serialize.js";

const nonEmptyString = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";

function parseSlots(body: unknown): SlotDoc[] {
  const list = (body as { slots?: unknown } | null)?.slots;
  if (!Array.isArray(list)) throw badRequest("slots must be an array");

  const seen = new Set<string>();
  return list.map((raw, i) => {
    const s = raw as Record<string, unknown>;
    if (!s || typeof s !== "object") throw badRequest(`slots[${i}] must be an object`);
    for (const field of ["id", "provider", "start", "end"]) {
      if (!nonEmptyString(s[field])) throw badRequest(`slots[${i}].${field} is required`);
    }
    const id = s.id as string;
    const startAt = new Date(s.start as string);
    const endAt = new Date(s.end as string);
    if (Number.isNaN(startAt.getTime())) throw badRequest(`slots[${i}].start is not a valid date`);
    if (Number.isNaN(endAt.getTime())) throw badRequest(`slots[${i}].end is not a valid date`);
    if (endAt <= startAt) throw badRequest(`slots[${i}].end must be after start`);
    if (seen.has(id)) throw badRequest(`duplicate slot id: ${id}`);
    seen.add(id);
    return { _id: id, provider: s.provider as string, start: s.start as string, end: s.end as string, startAt };
  });
}

/** Level 1: wipe every booking and replace all slots. */
export async function resetSlots(body: unknown) {
  const docs = parseSlots(body); // validate fully before touching any data
  await Promise.all([
    bookings().deleteMany({}),
    slots().deleteMany({}),
    // A reset starts a clean world, so stale idempotency keys and rate-limit
    // counters from the previous run shouldn't leak into it.
    idempotency().deleteMany({}),
    rateLimits().deleteMany({}),
  ]);
  if (docs.length) await slots().insertMany(docs);
  return { ok: true, slots: docs.length };
}

/** Level 1: every slot (optionally one provider's), earliest start first. */
export async function listSlots(provider?: string) {
  const filter = provider !== undefined ? { provider } : {};
  const [slotDocs, bookedIds] = await Promise.all([
    slots().find(filter).sort({ startAt: 1, _id: 1 }).toArray(),
    bookings().distinct("slot_id", { status: "confirmed" }),
  ]);
  const booked = new Set(bookedIds);
  return { slots: slotDocs.map((s) => toSlot(s, !booked.has(s._id))) };
}
