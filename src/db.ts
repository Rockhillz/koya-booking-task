import { MongoClient, type Db, type Collection, type ObjectId } from "mongodb";

export interface SlotDoc {
  _id: string; // slot id supplied by the client, e.g. "s1"
  provider: string;
  start: string; // original string, echoed back verbatim
  end: string;
  startAt: Date; // parsed, used for sorting and "already started" checks
}

export type BookingStatus = "confirmed" | "cancelled";

export interface BookingDoc {
  _id: ObjectId;
  slot_id: string;
  name: string;
  email: string; // trimmed + lower-cased
  status: BookingStatus;
  created_at: Date;
}

export interface IdempotencyDoc {
  _id: string; // the Idempotency-Key header value
  bodyHash: string;
  state: "pending" | "done";
  status?: number;
  response?: unknown;
  createdAt: Date; // TTL
}

export interface RateLimitDoc {
  _id: string; // normalized email
  hits: number[]; // epoch ms of attempts inside the current window
  expireAt: Date; // TTL
}

let client: MongoClient | undefined;
let db: Db | undefined;

export async function connect(uri: string, dbName?: string): Promise<Db> {
  client = new MongoClient(uri);
  await client.connect();
  db = client.db(dbName);
  await ensureIndexes();
  return db;
}

export async function disconnect(): Promise<void> {
  await client?.close();
  client = undefined;
  db = undefined;
}

function getDb(): Db {
  if (!db) throw new Error("Database not connected");
  return db;
}

export const slots = (): Collection<SlotDoc> => getDb().collection<SlotDoc>("slots");
export const bookings = (): Collection<BookingDoc> => getDb().collection<BookingDoc>("bookings");
export const idempotency = (): Collection<IdempotencyDoc> =>
  getDb().collection<IdempotencyDoc>("idempotency_keys");
export const rateLimits = (): Collection<RateLimitDoc> =>
  getDb().collection<RateLimitDoc>("rate_limits");

async function ensureIndexes(): Promise<void> {
  await Promise.all([
    slots().createIndex({ startAt: 1 }),
    slots().createIndex({ provider: 1, startAt: 1 }),
    // Level 3: the database itself guarantees at most one *confirmed* booking per slot.
    // Concurrent inserts for the same slot race on this index; exactly one wins.
    bookings().createIndex(
      { slot_id: 1 },
      { unique: true, partialFilterExpression: { status: "confirmed" }, name: "one_confirmed_per_slot" },
    ),
    // Level 4: cursor pagination by email, oldest first.
    bookings().createIndex({ email: 1, created_at: 1, _id: 1 }),
    idempotency().createIndex({ createdAt: 1 }, { expireAfterSeconds: 24 * 60 * 60 }),
    rateLimits().createIndex({ expireAt: 1 }, { expireAfterSeconds: 0 }),
  ]);
}
