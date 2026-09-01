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
const reviewedModules = [
  "adapters/github",
  "adapters/http",
  "adapters/linear",
  "auth",
  "bridge",
  "browser-bridge",
  "domain",
  "events",
  "export",
  "index",
  "kernel",
  "tracker-orchestrator",
  "tracker",
  "webhook",
];
const reviewedOutputs = reviewedModules.flatMap((module) => [
  `dist/${module}.d.ts`,
  `dist/${module}.d.ts.map`,
  `dist/${module}.js`,
  `dist/${module}.js.map`,
]);
const expectedPaths = ["LICENSE", "README.md", "package.json", ...reviewedOutputs].sort();
assert.deepEqual(paths.sort(), expectedPaths, "packed files must match the reviewed package manifest exactly");

console.log(`verified ${paths.length} package files`);
