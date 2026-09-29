// Vercel function: GitHub's webhook URL is https://<your-deployment>/api/webhook.
// Plain JavaScript on top of the build (vercel.json runs `npm run build` first).
import { envHandler } from "../dist/server.js";

const handler = envHandler(process.env);

export { handler as GET, handler as POST };
