import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, parseConfig } from "../src/config.js";

describe("parseConfig", () => {
  it("uses the defaults without a file", () => {
    expect(parseConfig(null)).toEqual({ config: DEFAULT_CONFIG, warnings: [] });
    expect(parseConfig("  \n")).toEqual({ config: DEFAULT_CONFIG, warnings: [] });
  });

  it("reads every setting", () => {
    const { config, warnings } = parseConfig(
      "fail_on: medium\nignore: [curl-pipe-shell]\nallow_unpinned:\n  - my-org/*\n",
    );
    expect(config).toEqual({ failOn: "medium", ignore: ["curl-pipe-shell"], allowUnpinned: ["my-org/*"] });
    expect(warnings).toEqual([]);
  });

  it("accepts never and a single string for lists", () => {
    const { config } = parseConfig("fail_on: never\nignore: missing-permissions\n");
    expect(config.failOn).toBe("never");
    expect(config.ignore).toEqual(["missing-permissions"]);
  });

  it("keeps the default for a bad fail_on and says so", () => {
    const { config, warnings } = parseConfig("fail_on: sometimes\n");
    expect(config.failOn).toBe("high");
    expect(warnings).toEqual([expect.stringContaining("fail_on must be one of")]);
  });

  it("drops unknown rules and settings with a warning", () => {
    const { config, warnings } = parseConfig("ignore: [curl-pipe-shell, made-up]\ncolour: red\n");
    expect(config.ignore).toEqual(["curl-pipe-shell"]);
    expect(warnings).toEqual(["Unknown rules in ignore: made-up.", 'Unknown setting "colour".']);
  });

  it("ignores non-string list entries", () => {
    expect(parseConfig("allow_unpinned: [1, true, org/*]\n").config.allowUnpinned).toEqual(["org/*"]);
    expect(parseConfig("allow_unpinned: 5\n").config.allowUnpinned).toEqual([]);
  });

  it("falls back to the defaults for broken files", () => {
    expect(parseConfig("fail_on: [high\n").warnings).toEqual([expect.stringContaining("not valid YAML")]);
    expect(parseConfig("- a list\n").warnings).toEqual([expect.stringContaining("should be a mapping")]);
    expect(parseConfig("- a list\n").config).toEqual(DEFAULT_CONFIG);
  });
});
