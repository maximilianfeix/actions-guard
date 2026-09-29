// Self-hosting: `node dist/main.js` with APP_ID, PRIVATE_KEY(_PATH), WEBHOOK_SECRET and PORT set (see .env.example)
import { start } from "./server.js";

start(process.env);
