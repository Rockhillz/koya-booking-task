import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type ErrorRequestHandler } from "express";
import swaggerUi from "swagger-ui-express";
import { openapiSpec } from "./openapi.js";
import { HttpError } from "./lib/errors.js";
import { requireApiKey } from "./middleware/auth.js";
import { apiRouter } from "./routes/api.js";
import { webRouter } from "./routes/web.js";

const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public");

export function createApp({ apiKey }: { apiKey: string }) {
  const app = express();
  app.set("trust proxy", 1); // behind Render's proxy
  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));

  // Public: health check, the booking page, and its keyless backend.
  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });
  app.get("/openapi.json", (_req, res) => {
    res.json(openapiSpec);
  });
  app.use(
    "/docs",
    swaggerUi.serve,
    swaggerUi.setup(openapiSpec, {
      customSiteTitle: "Koya Booking API Docs",
      swaggerOptions: { persistAuthorization: true, displayRequestDuration: true },
    }),
  );
  app.use(express.static(publicDir));
  app.use("/web", webRouter);

  // Everything else is the keyed API from the spec.
  app.use(requireApiKey(apiKey));
  app.use(apiRouter);

  app.use((_req, res) => {
    res.status(404).json({ error: "not found" });
  });

  const onError: ErrorRequestHandler = (err, _req, res, _next) => {
    if (err instanceof HttpError) {
      res.status(err.status).set(err.headers).json({ error: err.message });
      return;
    }
    // body-parser errors (malformed JSON, payload too large) carry a 4xx status.
    const status = typeof err?.status === "number" ? err.status : 500;
    if (status >= 400 && status < 500) {
      const message = err.type === "entity.parse.failed" ? "invalid JSON body" : String(err.message);
      res.status(status).json({ error: message });
      return;
    }
    console.error(err);
    res.status(500).json({ error: "internal server error" });
  };
  app.use(onError);

  return app;
}
