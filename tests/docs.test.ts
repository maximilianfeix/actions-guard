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
