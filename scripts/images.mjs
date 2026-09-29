// Renders the share images from scripts/og-image.html with a local Chrome:
//   npm run images            (CHROME=/path/to/chrome to override)
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const chrome =
  process.env.CHROME ??
  (process.platform === "darwin"
    ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    : "/usr/bin/google-chrome");
const source = new URL("./og-image.html", import.meta.url).href;
const targets = [
  { path: "../docs/og.png", width: 1200, height: 630 }, // Open Graph / Twitter card
  { path: "../docs/assets/social-preview.png", width: 1280, height: 640 }, // repository social preview
];

const browser = await puppeteer.launch({ executablePath: chrome, headless: true });
try {
  for (const { path, width, height } of targets) {
    const page = await browser.newPage();
    await page.setViewport({ width, height, deviceScaleFactor: 1 });
    await page.goto(source, { waitUntil: "networkidle0" });
    await page.evaluate(() => document.fonts.ready);
    const out = fileURLToPath(new URL(path, import.meta.url));
    await page.screenshot({ path: out });
    console.log(`${out} (${width}×${height})`);
    await page.close();
  }
} finally {
  await browser.close();
}
