import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { RULE_IDS } from "../src/rules.js";

const page = readFileSync(new URL("../docs/index.html", import.meta.url), "utf8");

it.each(RULE_IDS)("documents %s under the anchor the comments link to", (rule) => {
  expect(page).toContain(`id="${rule}"`);
});

it("has the privacy and support sections the app listing points to", () => {
  expect(page).toContain('id="privacy"');
  expect(page).toContain('id="support"');
});

it("has a favicon and a share image that exist", () => {
  expect(page).toContain('rel="icon" href="favicon.svg"');
  expect(page).toContain(
    'property="og:image" content="https://maximilianfeix.github.io/actions-guard/og.png"',
  );
  expect(page).toContain('name="twitter:card" content="summary_large_image"');
  for (const file of ["../docs/favicon.svg", "../docs/og.png"]) {
    expect(readFileSync(new URL(file, import.meta.url)).length).toBeGreaterThan(200);
  }
});
