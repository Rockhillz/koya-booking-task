import type { BookingDoc, SlotDoc } from "../db.js";

export function toBooking(doc: BookingDoc) {
  return {
    id: doc._id.toHexString(),
    slot_id: doc.slot_id,
    name: doc.name,
    email: doc.email,
    status: doc.status,
    created_at: doc.created_at.toISOString(),
  };
}

export function toSlot(doc: SlotDoc, available: boolean) {
  return { id: doc._id, provider: doc.provider, start: doc.start, end: doc.end, available };
}
