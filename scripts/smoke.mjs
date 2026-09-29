// After `npm run build`: the Vercel function answers a signed ping, and rejects an unsigned one.
import { createHmac, generateKeyPairSync } from "node:crypto";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
Object.assign(process.env, {
  APP_ID: "1",
  PRIVATE_KEY: privateKey.replace(/\n/g, "\\n"),
  WEBHOOK_SECRET: "smoke",
});
const { POST, GET } = await import("../api/webhook.js");

const body = "{}";
const signature = "sha256=" + createHmac("sha256", "smoke").update(body).digest("hex");
const ping = await POST(
  new Request("https://example.com/api/webhook", {
    method: "POST",
    headers: { "x-github-event": "ping", "x-hub-signature-256": signature },
    body,
  }),
);
const unsigned = await POST(
  new Request("https://example.com/api/webhook", {
    method: "POST",
    headers: { "x-github-event": "ping" },
    body,
  }),
);
const status = await GET(new Request("https://example.com/api/webhook"));
const results = [
  ping.status === 200 && (await ping.text()) === "pong",
  unsigned.status === 401,
  status.status === 200,
];
console.log(`signed ping: ${results[0]}, unsigned rejected: ${results[1]}, GET: ${results[2]}`);
process.exit(results.every(Boolean) ? 0 : 1);
