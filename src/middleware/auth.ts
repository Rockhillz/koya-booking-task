import { createHash, timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";

const digest = (s: string) => createHash("sha256").update(s).digest();

/** Level 2: every API request needs the X-API-Key header. Constant-time comparison. */
export function requireApiKey(apiKey: string): RequestHandler {
  const expected = digest(apiKey);
  return (req, res, next) => {
    const provided = req.get("X-API-Key");
    if (provided && timingSafeEqual(digest(provided), expected)) return next();
    res.status(401).json({ error: provided ? "invalid API key" : "missing API key" });
  };
}
