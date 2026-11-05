/** OpenAPI 3 description of the API, served as Swagger UI at /docs and raw JSON at /openapi.json. */

const err = (description: string, example: string) => ({
  description,
  content: { "application/json": { schema: { $ref: "#/components/schemas/Error" }, example: { error: example } } },
});

const bookingResponse = (description: string, status = "confirmed") => ({
  description,
  content: {
    "application/json": {
      schema: { $ref: "#/components/schemas/Booking" },
      example: {
        id: "672a1f0c9b1e8a3d4c5b6a71",
        slot_id: "s1",
        name: "Ada Obi",
        email: "ada@example.com",
        status,
        created_at: "2026-11-05T11:39:54.516Z",
      },
    },
  },
});

const unauthorized = err("Missing or wrong X-API-Key (level 2)", "invalid API key");

const bookingIdParam = {
  name: "id",
  in: "path",
  required: true,
  schema: { type: "string" },
  description: "Booking id returned by POST /bookings",
};

export const openapiSpec = {
  openapi: "3.0.3",
  info: {
    title: "Koya Clinic Booking API",
    version: "1.0.0",
    description:
      "Booking API for the Koya Cohort 4 assessment (Task 1).\n\n" +
      "Everything is JSON. Every error looks like `{\"error\": \"<message>\"}`.\n\n" +
      "**Click Authorize and enter your API key** — every endpoint requires the `X-API-Key` header.",
  },
  servers: [{ url: "/", description: "This server" }],
  security: [{ ApiKey: [] }],
  tags: [
    { name: "Slots", description: "Appointment slots" },
    { name: "Bookings", description: "Booking, lookup, cancellation and history" },
  ],
  paths: {
    "/reset": {
      post: {
        tags: ["Slots"],
        summary: "Replace all slots (level 1)",
        description:
          "Deletes every booking and replaces all slots with the ones you send, including slots in the past. " +
          "Also clears stored idempotency keys and rate-limit counters.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["slots"],
                properties: { slots: { type: "array", items: { $ref: "#/components/schemas/SlotInput" } } },
              },
              example: {
                slots: [
                  { id: "s1", provider: "Dr Ade", start: "2026-12-10T09:00:00Z", end: "2026-12-10T09:30:00Z" },
                  { id: "s2", provider: "Dr Ade", start: "2026-12-10T09:30:00Z", end: "2026-12-10T10:00:00Z" },
                  { id: "s3", provider: "Dr Bola", start: "2026-12-11T14:00:00Z", end: "2026-12-11T14:30:00Z" },
                ],
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Done",
            content: { "application/json": { example: { ok: true, slots: 3 } } },
          },
          "400": err("Malformed slots payload", "slots[0].start is not a valid date"),
          "401": unauthorized,
        },
      },
    },
    "/slots": {
      get: {
        tags: ["Slots"],
        summary: "List slots (level 1)",
        description: "Every slot, earliest start first.",
        parameters: [
          {
            name: "provider",
            in: "query",
            required: false,
            schema: { type: "string" },
            description: "Only this provider's slots (exact match)",
          },
        ],
        responses: {
          "200": {
            description: "The slots",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { slots: { type: "array", items: { $ref: "#/components/schemas/Slot" } } },
                },
              },
            },
          },
          "401": unauthorized,
        },
      },
    },
    "/bookings": {
      post: {
        tags: ["Bookings"],
        summary: "Book a slot (levels 1–5)",
        description: [
          "- **Level 1:** returns 201 with the booking, status `confirmed`.",
          "- **Level 2:** 400 if `slot_id`, `name` or `email` is missing/empty or the email is invalid; 404 if the slot doesn't exist; 400 if the slot has already started. Name and email are trimmed; email is stored lower-case.",
          "- **Level 3:** 409 if the slot already has a confirmed booking — holds under concurrent requests.",
          "- **Level 4:** optional `Idempotency-Key`. Same key + same body replays the same response (status and booking id). Same key + different body returns 422.",
          "- **Level 5:** at most 5 attempts per email per minute (failed attempts included). The 6th returns 429 with `Retry-After` in whole seconds.",
        ].join("\n"),
        parameters: [
          {
            name: "Idempotency-Key",
            in: "header",
            required: false,
            schema: { type: "string", maxLength: 255 },
            description: "Level 4 — reuse the same value when retrying the same request",
          },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/BookingInput" },
              example: { slot_id: "s1", name: "Ada Obi", email: "ada@example.com" },
            },
          },
        },
        responses: {
          "201": bookingResponse("Booked"),
          "400": err("Missing or invalid field, or the slot has already started (level 2)", "email is invalid"),
          "401": unauthorized,
          "404": err("The slot doesn't exist (level 2)", "slot not found"),
          "409": err("Slot already booked (level 3)", "slot already booked"),
          "422": err(
            "Idempotency-Key reused with a different body (level 4)",
            "Idempotency-Key was already used with a different request body",
          ),
          "429": {
            ...err("Too many attempts for this email (level 5)", "too many booking attempts for this email, try again later"),
            headers: {
              "Retry-After": { description: "Seconds to wait", schema: { type: "integer", example: 42 } },
            },
          },
        },
      },
      get: {
        tags: ["Bookings"],
        summary: "List a person's bookings (level 4)",
        description:
          "That person's bookings, oldest first. The email match ignores case. " +
          "Cursor pagination: pass `next_cursor` back as `cursor` to get the next page. The last page has `next_cursor: null`.",
        parameters: [
          { name: "email", in: "query", required: true, schema: { type: "string" }, example: "ada@example.com" },
          {
            name: "limit",
            in: "query",
            required: false,
            schema: { type: "integer", minimum: 1, maximum: 50, default: 10 },
            description: "1 to 50. Anything else returns 400.",
          },
          { name: "cursor", in: "query", required: false, schema: { type: "string" } },
        ],
        responses: {
          "200": {
            description: "A page of bookings",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    bookings: { type: "array", items: { $ref: "#/components/schemas/Booking" } },
                    next_cursor: { type: "string", nullable: true },
                  },
                },
              },
            },
          },
          "400": err("Invalid limit, cursor, or missing email", "limit must be an integer from 1 to 50"),
          "401": unauthorized,
        },
      },
    },
    "/bookings/{id}": {
      get: {
        tags: ["Bookings"],
        summary: "Get a booking (level 1)",
        parameters: [bookingIdParam],
        responses: {
          "200": bookingResponse("The booking"),
          "401": unauthorized,
          "404": err("No booking with that id", "booking not found"),
        },
      },
      delete: {
        tags: ["Bookings"],
        summary: "Cancel a booking (level 3)",
        description: "Sets status to `cancelled` and frees the slot.",
        parameters: [bookingIdParam],
        responses: {
          "200": bookingResponse("The cancelled booking", "cancelled"),
          "401": unauthorized,
          "404": err("No booking with that id", "booking not found"),
          "409": err("Already cancelled", "booking already cancelled"),
        },
      },
    },
  },
  components: {
    securitySchemes: {
      ApiKey: { type: "apiKey", in: "header", name: "X-API-Key" },
    },
    schemas: {
      Error: {
        type: "object",
        required: ["error"],
        properties: { error: { type: "string" } },
      },
      SlotInput: {
        type: "object",
        required: ["id", "provider", "start", "end"],
        properties: {
          id: { type: "string", example: "s1" },
          provider: { type: "string", example: "Dr Ade" },
          start: { type: "string", format: "date-time", example: "2026-12-10T09:00:00Z" },
          end: { type: "string", format: "date-time", example: "2026-12-10T09:30:00Z" },
        },
      },
      Slot: {
        allOf: [
          { $ref: "#/components/schemas/SlotInput" },
          {
            type: "object",
            required: ["available"],
            properties: { available: { type: "boolean", description: "false if the slot has a confirmed booking" } },
          },
        ],
      },
      BookingInput: {
        type: "object",
        required: ["slot_id", "name", "email"],
        properties: {
          slot_id: { type: "string", example: "s1" },
          name: { type: "string", example: "Ada Obi" },
          email: { type: "string", format: "email", example: "ada@example.com" },
        },
      },
      Booking: {
        type: "object",
        required: ["id", "slot_id", "name", "email", "status", "created_at"],
        properties: {
          id: { type: "string" },
          slot_id: { type: "string" },
          name: { type: "string" },
          email: { type: "string" },
          status: { type: "string", enum: ["confirmed", "cancelled"] },
          created_at: { type: "string", format: "date-time" },
        },
      },
    },
  },
} as const;
