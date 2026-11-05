import { MongoServerError } from "mongodb";
import { rateLimits } from "../db.js";

export const RATE_LIMIT = 5;
export const WINDOW_MS = 60_000;

export interface RateDecision {
  allowed: boolean;
  retryAfterSeconds: number;
}

/**
 * Level 5: sliding-window limiter, one document per email.
 *
 * The whole decision (drop expired hits, check the count, record this hit)
 * happens in a single pipeline update, so concurrent requests for the same
 * email are serialized by MongoDB and can never sneak past the limit.
 * Rejected attempts are not recorded, so a blocked client isn't locked out
 * for longer than the window.
 */
export async function consumeAttempt(email: string, now = Date.now()): Promise<RateDecision> {
  const cutoff = now - WINDOW_MS;
  const update = [
    {
      $set: {
        hits: { $filter: { input: { $ifNull: ["$hits", []] }, cond: { $gt: ["$$this", cutoff] } } },
      },
    },
    { $set: { _allowed: { $lt: [{ $size: "$hits" }, RATE_LIMIT] } } },
    {
      $set: {
        hits: { $cond: ["$_allowed", { $concatArrays: ["$hits", [now]] }, "$hits"] },
        expireAt: new Date(now + WINDOW_MS),
      },
    },
  ];

  for (let attempt = 0; ; attempt++) {
    try {
      const doc = await rateLimits().findOneAndUpdate({ _id: email }, update, {
        upsert: true,
        returnDocument: "after",
      });
      const d = doc as unknown as { hits: number[]; _allowed: boolean };
      if (d._allowed) return { allowed: true, retryAfterSeconds: 0 };
      const oldest = Math.min(...d.hits);
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((oldest + WINDOW_MS - now) / 1000)) };
    } catch (err) {
      // Two first-ever requests for an email can both try to upsert; one loses
      // with a duplicate key. Retrying finds the now-existing document.
      if (err instanceof MongoServerError && err.code === 11000 && attempt < 3) continue;
      throw err;
    }
  }
}
