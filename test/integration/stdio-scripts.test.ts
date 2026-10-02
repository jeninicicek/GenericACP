import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const root = fileURLToPath(new URL("../../", import.meta.url));
const tsxCli = fileURLToPath(new URL("../../node_modules/tsx/dist/cli.mjs", import.meta.url));

const scripts = [
  "scripts/test-conformance.ts",
  "scripts/test-edge-cases.ts",
  "scripts/test-session-load.ts",
  "scripts/test-image-content.ts",
  "scripts/test-mcp-bridge.ts",
  "scripts/test-failure.ts",
];

describe("stdio regression scripts", () => {
  beforeAll(() => {
    const built = fileURLToPath(new URL("../../dist/main.js", import.meta.url));
    if (!existsSync(built)) {
      throw new Error("dist/main.js is missing. npm test builds it before Vitest runs.");
    }
    expect(readFileSync(built, "utf8").startsWith("#!/usr/bin/env node\n")).toBe(true);
  });

  for (const script of scripts) {
    it(script, async () => {
      const result = await execFileAsync(process.execPath, [tsxCli, script], {
        cwd: root,
        timeout: 120_000,
      });
      expect(result.stderr ?? "").not.toMatch(/ASSERTION FAILED/);
    }, 120_000);
  }
});
