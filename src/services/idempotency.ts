import { createHash } from "node:crypto";
import { MongoServerError } from "mongodb";
import { idempotency } from "../db.js";
import { badRequest } from "../lib/errors.js";

export interface HandlerResult {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

const POLL_MS = 50;
const WAIT_MS = 10_000;

/** Stable JSON so {"a":1,"b":2} and {"b":2,"a":1} count as the same body. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.keys(value as object)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

const hashBody = (body: unknown) => createHash("sha256").update(canonical(body)).digest("hex");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Level 4: run `handler` at most once per Idempotency-Key.
 *
 * 1. Claim the key by inserting a "pending" record (the _id is the key, so only
 *    one request can win the claim, even under concurrency).
 * 2. The winner runs the handler and stores the final status + body.
 * 3. Anyone else with the same key either gets 422 (different body) or waits
 *    for the stored response and replays it verbatim.
 *
 * Transient outcomes (429, 5xx, crashes) release the claim so a retry can try again.
 */
export async function withIdempotency(
  key: string | undefined,
  body: unknown,
  handler: () => Promise<HandlerResult>,
): Promise<HandlerResult> {
  if (key === undefined) return handler();
  if (key.trim() === "" || key.length > 255) throw badRequest("Idempotency-Key must be 1-255 characters");

  const bodyHash = hashBody(body);
  const deadline = Date.now() + WAIT_MS;

  while (true) {
    try {
      await idempotency().insertOne({ _id: key, bodyHash, state: "pending", createdAt: new Date() });
      break; // we own the key
    } catch (err) {
      if (!(err instanceof MongoServerError && err.code === 11000)) throw err;
    }

    const existing = await idempotency().findOne({ _id: key });
    if (!existing) continue; // claim was released between our insert and read; try again
    if (existing.bodyHash !== bodyHash) {
      return { status: 422, body: { error: "Idempotency-Key was already used with a different request body" } };
    }
    if (existing.state === "done") {
      return { status: existing.status!, body: existing.response };
    }
    if (Date.now() > deadline) {
      return { status: 409, body: { error: "a request with this Idempotency-Key is still in progress" } };
    }
    await sleep(POLL_MS);
  }

  let result: HandlerResult;
  try {
    result = await handler();
  } catch (err) {
    await idempotency().deleteOne({ _id: key });
    throw err;
  }

  if (result.status === 429 || result.status >= 500) {
    await idempotency().deleteOne({ _id: key });
  } else {
    await idempotency().updateOne(
      { _id: key },
      { $set: { state: "done", status: result.status, response: result.body } },
    );
  }
  return result;
}
