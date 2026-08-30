import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const temporaryDirectory = mkdtempSync(join(tmpdir(), "collab-review-layer-package-"));
const cacheDirectory = join(temporaryDirectory, "npm-cache");
const packDirectory = join(temporaryDirectory, "pack");
const consumerDirectory = join(temporaryDirectory, "consumer");
mkdirSync(packDirectory, { recursive: true });
mkdirSync(consumerDirectory, { recursive: true });

let packed;
try {
  const raw = execFileSync("npm", ["pack", "--json", "--pack-destination", packDirectory], {
    encoding: "utf8",
    env: { ...process.env, npm_config_cache: cacheDirectory },
  });
  [packed] = JSON.parse(raw);

  writeFileSync(join(consumerDirectory, "package.json"), JSON.stringify({ private: true, type: "module" }));
  execFileSync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", join(packDirectory, packed.filename)], {
    cwd: consumerDirectory,
    env: { ...process.env, npm_config_cache: cacheDirectory },
    stdio: "pipe",
  });
  execFileSync("node", ["--input-type=module", "--eval", "const module = await import('collab-review-layer'); if (!module.ReviewKernel) throw new Error('missing package export')"], {
    cwd: consumerDirectory,
    stdio: "pipe",
  });
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
const { files = [] } = packed ?? {};
const paths = files.map((entry) => entry.path);

assert.ok(paths.includes("package.json"), "package.json must be published");
assert.ok(paths.includes("README.md"), "README.md must be published");
assert.ok(paths.includes("LICENSE"), "LICENSE must be published");
assert.ok(paths.some((path) => path.startsWith("dist/") && path.endsWith(".js")), "compiled entrypoints must be published");
assert.ok(paths.some((path) => path.startsWith("dist/") && path.endsWith(".d.ts")), "type declarations must be published");

const unexpected = paths.filter(
  (path) => path !== "package.json" && path !== "README.md" && path !== "LICENSE" && !path.startsWith("dist/"),
);
assert.deepEqual(unexpected, [], `unexpected package files: ${unexpected.join(", ")}`);

console.log(`verified ${paths.length} package files`);
