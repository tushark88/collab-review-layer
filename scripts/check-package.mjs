import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cacheDirectory = mkdtempSync(join(tmpdir(), "collab-review-layer-npm-"));
let raw;
try {
  raw = execFileSync("npm", ["pack", "--dry-run", "--json"], {
    encoding: "utf8",
    env: { ...process.env, npm_config_cache: cacheDirectory },
  });
} finally {
  rmSync(cacheDirectory, { recursive: true, force: true });
}
const [{ files = [] } = {}] = JSON.parse(raw);
const paths = files.map((entry) => entry.path);

assert.ok(paths.includes("package.json"), "package.json must be published");
assert.ok(paths.includes("README.md"), "README.md must be published");
assert.ok(paths.includes("LICENSE"), "LICENSE must be published");
assert.ok(paths.some((path) => path.startsWith("src/")), "source entrypoints must be published");

const unexpected = paths.filter(
  (path) => path !== "package.json" && path !== "README.md" && path !== "LICENSE" && !path.startsWith("src/"),
);
assert.deepEqual(unexpected, [], `unexpected package files: ${unexpected.join(", ")}`);

console.log(`verified ${paths.length} package files`);
