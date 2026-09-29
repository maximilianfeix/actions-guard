// Vercel function: GitHub's webhook URL is https://<your-deployment>/api/webhook.
// Plain JavaScript on top of the build (vercel.json runs `npm run build` first).
import { depsFromEnv, fetchHandler, loadEnv } from "../dist/server.js";

let deps;

function handler(request) {
  deps ??= depsFromEnv(loadEnv(process.env));
  return fetchHandler(request, deps);
}

export { handler as GET, handler as POST };
