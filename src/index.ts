import "dotenv/config";
import { createApp } from "./app.js";
import { connect, disconnect } from "./db.js";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required env var ${name}`);
    process.exit(1);
  }
  return value;
}

const MONGODB_URI = required("MONGODB_URI");
const API_KEY = required("API_KEY");
const PORT = Number(process.env.PORT ?? 3000);

await connect(MONGODB_URI, process.env.MONGODB_DB || undefined);
const server = createApp({ apiKey: API_KEY }).listen(PORT, () => {
  console.log(`Booking API listening on :${PORT}`);
});

const shutdown = () => {
  server.close(() => void disconnect().then(() => process.exit(0)));
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
