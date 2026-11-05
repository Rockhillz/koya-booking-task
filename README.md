# Koya Clinic Booking API

A booking API for a clinic, plus a simple web page that uses it. Patients can see available slots, book one,
see the confirmation, look up a booking and cancel it.

Built for Task 1 of the Koya Cohort 4 assessment and follows the
[technical spec](https://koyaacademy.com/assessment-api). All five levels are implemented.

**Stack:** Node.js · Express 5 · TypeScript · MongoDB (Atlas) · hosted on Render

---

## What's in the box

One Render service serves all of these:

| URL | What it is | Needs API key? |
| --- | --- | --- |
| `/` | The booking web page | No |
| `/docs` | Swagger UI: interactive docs for every endpoint | No (but requests sent from it do) |
| `/openapi.json` | Raw OpenAPI 3 spec | No |
| `/slots`, `/bookings`, `/reset`, … | The API from the spec | **Yes**, `X-API-Key` header |
| `/web/*` | Small backend used only by the web page | No |
| `/health` | Health check for Render | No |

After deploying, with `https://koya-booking-api.onrender.com` as an example:

- **API base URL:** `https://koya-booking-api.onrender.com`
- **Web page URL:** `https://koya-booking-api.onrender.com/`
- **API docs:** `https://koya-booking-api.onrender.com/docs`

---

## API endpoints

Everything is JSON. Every error response is `{"error": "<message>"}`. Every request needs `X-API-Key`; a missing or wrong key returns `401`.

| Method | Path | Level | What it does |
| --- | --- | --- | --- |
| POST | `/reset` | 1 | Deletes all bookings and replaces all slots |
| GET | `/slots?provider=` | 1 | Lists slots, earliest first, each with `available` |
| POST | `/bookings` | 1–5 | Books a slot |
| GET | `/bookings/:id` | 1 | Gets one booking |
| DELETE | `/bookings/:id` | 3 | Cancels a booking and frees the slot |
| GET | `/bookings?email=&limit=&cursor=` | 4 | A person's bookings, oldest first, paginated |

### Quick try with curl

```bash
BASE=https://koya-booking-api.onrender.com
KEY=your-api-key

# Load slots
curl -X POST $BASE/reset -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
  -d '{"slots":[{"id":"s1","provider":"Dr Ade","start":"2026-12-10T09:00:00Z","end":"2026-12-10T09:30:00Z"}]}'

# List slots
curl $BASE/slots -H "X-API-Key: $KEY"

# Book (with an idempotency key, so retrying is safe)
curl -X POST $BASE/bookings -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
  -H "Idempotency-Key: abc-123" \
  -d '{"slot_id":"s1","name":"Ada Obi","email":"ada@example.com"}'
```

Or open `/docs`, click **Authorize**, paste the key, and use **Try it out**.

---

## How each level is handled

### Level 1: list, book, look up
Slots are stored with the exact `start`/`end` strings sent to `/reset`, and returned unchanged. `available` is `false` when the slot has a confirmed booking.

### Level 2: API key and validation
- The API key is compared in constant time (`src/middleware/auth.ts`).
- `name` and `email` are trimmed, and `email` is lower-cased before it's validated and stored.
- Checks run in this order: missing or invalid field → **400**; unknown slot → **404**; slot already started → **400**.

### Level 3: no double booking, even at the same moment
- The database enforces this, not the app. A **unique partial index** on `bookings.slot_id` covers only bookings with `status: "confirmed"`.
- When many requests arrive at once, MongoDB lets exactly one insert succeed. The rest fail with a duplicate-key error, which becomes **409**.
- The app never checks "is it free?" and then writes, so there's no window for a race.
- Cancelling is one atomic `confirmed → cancelled` update. That takes the booking out of the index and frees the slot. Cancelling twice returns **409**.

### Level 4: idempotent retries and pagination
- **Idempotency.** The `Idempotency-Key` header value is used as the `_id` of a record in `idempotency_keys`, so only one request can claim a key.
  - The winner runs the booking and saves the final status and body.
  - A retry with the same key and same body gets that saved response back: same status, same booking id.
  - Concurrent duplicates wait for the winner's result.
  - The same key with a different body returns **422**.
  - Temporary failures (429, 5xx) aren't saved, so a later retry gets a real attempt.
- **Pagination.** Results are sorted by `(created_at, _id)`. `next_cursor` is an opaque token for the last row's position, and the last page returns `next_cursor: null`. A `limit` outside 1–50 returns **400**.

### Level 5: rate limiting
- At most 5 attempts per email per minute, failed attempts included, using a sliding 60-second window.
- Each email has one document. Dropping old hits, checking the count and recording the new hit happen in **one atomic update**, so a burst of simultaneous requests can't get past the limit.
- The 6th attempt gets **429** with `Retry-After` in whole seconds. Other emails aren't affected.
- Counters live in MongoDB, so they survive restarts.

### The web page
`public/index.html` calls `/web/*` routes, which run the **same service code** as the API: validation, double-booking protection, idempotency and rate limiting all apply. The API key stays on the server and never reaches the browser, and admin routes like `/reset` aren't exposed to the page.

---

## Project structure

```
src/
  index.ts              Starts the server (reads env vars, connects to Mongo)
  app.ts                Express app: routes, auth, docs, error handling
  db.ts                 Mongo connection, collection types, indexes
  openapi.ts            Swagger / OpenAPI spec
  middleware/auth.ts    X-API-Key check
  routes/api.ts         The spec's endpoints + POST /bookings pipeline
  routes/web.ts         Keyless routes for the web page
  services/slots.ts     Reset + list slots
  services/bookings.ts  Create, get, cancel, list (pagination)
  services/idempotency.ts
  services/rateLimit.ts
public/index.html       The web page
test/api.test.ts        Tests covering every level, incl. concurrency
render.yaml             Render deployment config
```

---

## Run locally

Requirements: Node 20+ and a MongoDB connection string (Atlas free tier works).

```bash
cp .env.example .env     # fill in MONGODB_URI and API_KEY
npm install
npm run dev              # http://localhost:3000  (docs at /docs)
npm test                 # runs against an in-memory MongoDB, no setup needed
```

Environment variables:

| Name | Required | Description |
| --- | --- | --- |
| `MONGODB_URI` | Yes | MongoDB connection string, including the database name, e.g. `.../koya` |
| `API_KEY` | Yes | The key clients must send in `X-API-Key` |
| `PORT` | No | Defaults to 3000 (Render sets this for you) |

---

## Deploying (MongoDB Atlas + Render)

### 1. MongoDB Atlas (the database)
1. Create a free account at [mongodb.com/atlas](https://www.mongodb.com/atlas) and create a free **M0** cluster.
2. **Database Access:** add a database user with a password.
3. **Network Access:** add `0.0.0.0/0`. Render's IP addresses change, so the database has to accept connections from anywhere. The username and password still protect it.
4. Click **Connect → Drivers** and copy the connection string. Add a database name before the `?`:
   ```
   mongodb+srv://USER:PASSWORD@cluster0.xxxxx.mongodb.net/koya?retryWrites=true&w=majority
   ```
   If the password contains special characters such as `@`, `:` or `/`, URL-encode them.

Indexes are created automatically when the app starts.

### 2. Render (the server)
1. Push this repo to GitHub.
2. On [render.com](https://render.com), choose **New → Blueprint** and pick the repo. Render reads `render.yaml`.
   Alternatively, choose **New → Web Service** and use:
   - Build command: `npm ci --include=dev && npm run build`
   - Start command: `npm start`
   - Health check path: `/health`
3. Under **Environment**, set:
   - `MONGODB_URI`: the Atlas string from step 1
   - `API_KEY`: a long random value, e.g. from `openssl rand -hex 24`
4. Deploy. Check `https://<your-app>.onrender.com/health`, which should return `{"ok":true}`.

### Free-tier notes
- **Sleeping:** a free Render service sleeps after about 15 minutes with no traffic. The first request after that takes 30–60 seconds while it starts up. No data is lost, because everything is in MongoDB. Before graders test it, open the URL to wake it up, or point a free uptime monitor (e.g. UptimeRobot) at `/health` every 10 minutes.
- **Persistence:** Render's disk is wiped on every restart and deploy, which is why nothing is stored in memory or on disk. Slots, bookings, idempotency keys and rate-limit counters all live in MongoDB, so bookings are still there on the next request, after restarts, and across deploys.

---

## Security notes
- Secrets (`MONGODB_URI`, `API_KEY`) are read from environment variables only. `.env` is git-ignored, and secrets are never committed.
- The MongoDB connection string is never shared with API clients. They only need the base URL and the API key.
