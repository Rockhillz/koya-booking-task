import { Router, type Request, type Response } from "express";
import { HttpError } from "../lib/errors.js";
import { cancelBooking, createBooking, getBooking, listBookings, normalizeEmail } from "../services/bookings.js";
import { withIdempotency, type HandlerResult } from "../services/idempotency.js";
import { consumeAttempt } from "../services/rateLimit.js";
import { listSlots, resetSlots } from "../services/slots.js";

/**
 * POST /bookings pipeline:
 *   idempotency (replays skip everything below)
 *     -> rate limit per email (counts failed attempts too)
 *       -> validate + book (unique index settles races)
 */
export async function bookSlot(req: Request, res: Response) {
  const result = await withIdempotency(req.get("Idempotency-Key"), req.body, async (): Promise<HandlerResult> => {
    const email = normalizeEmail((req.body as { email?: unknown } | undefined)?.email);
    if (email) {
      const decision = await consumeAttempt(email);
      if (!decision.allowed) {
        return {
          status: 429,
          body: { error: "too many booking attempts for this email, try again later" },
          headers: { "Retry-After": String(decision.retryAfterSeconds) },
        };
      }
    }
    try {
      return { status: 201, body: await createBooking(req.body) };
    } catch (err) {
      // Turn expected 4xx outcomes into results so they can be stored and replayed.
      if (err instanceof HttpError) return { status: err.status, body: { error: err.message } };
      throw err;
    }
  });
  res.status(result.status).set(result.headers ?? {}).json(result.body);
}

export const apiRouter = Router();

apiRouter.post("/reset", async (req, res) => {
  res.json(await resetSlots(req.body));
});

apiRouter.get("/slots", async (req, res) => {
  const provider = typeof req.query.provider === "string" ? req.query.provider : undefined;
  res.json(await listSlots(provider));
});

apiRouter.post("/bookings", bookSlot);

apiRouter.get("/bookings", async (req, res) => {
  res.json(await listBookings(req.query as Record<string, unknown>));
});

apiRouter.get("/bookings/:id", async (req, res) => {
  res.json(await getBooking(req.params.id));
});

apiRouter.delete("/bookings/:id", async (req, res) => {
  res.json(await cancelBooking(req.params.id));
});
