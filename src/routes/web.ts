import { Router } from "express";
import { cancelBooking, getBooking } from "../services/bookings.js";
import { listSlots } from "../services/slots.js";
import { bookSlot } from "./api.js";

/**
 * Same-origin backend for the public booking page.
 *
 * The page never sees the API key: it calls these routes, which run the exact
 * same service code as the keyed API (validation, race protection, idempotency
 * and rate limiting all still apply). Admin operations like /reset are not exposed.
 */
export const webRouter = Router();

webRouter.get("/slots", async (req, res) => {
  const provider = typeof req.query.provider === "string" && req.query.provider ? req.query.provider : undefined;
  res.json(await listSlots(provider));
});
webRouter.post("/bookings", bookSlot);
webRouter.get("/bookings/:id", async (req, res) => {
  res.json(await getBooking(req.params.id));
});
webRouter.delete("/bookings/:id", async (req, res) => {
  res.json(await cancelBooking(req.params.id));
});
webRouter.use((_req, res) => {
  res.status(404).json({ error: "not found" });
});
