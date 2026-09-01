import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  execFileSync("node", ["--input-type=module", "--eval", "const module = await import('collab-review-layer/browser'); if (!module.ReviewFrameHost || !module.ReviewShellView) throw new Error('missing browser package export')"], {
    cwd: consumerDirectory,
    stdio: "pipe",
  });
  const installedPackage = JSON.parse(readFileSync(join(consumerDirectory, "node_modules", "collab-review-layer", "package.json"), "utf8"));
  assert.equal(installedPackage.exports["./styles.css"], "./dist/review-shell.css", "missing package stylesheet export");
  assert.match(
    readFileSync(join(consumerDirectory, "node_modules", "collab-review-layer", "dist", "review-shell.css"), "utf8"),
    /\.crl-shell/u,
    "missing scoped review shell stylesheet",
  );
  writeFileSync(join(consumerDirectory, "index.ts"), 'import { ReviewKernel } from "collab-review-layer";\nvoid ReviewKernel;\n');
  writeFileSync(join(consumerDirectory, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      lib: ["ES2022"],
      types: ["node"],
      typeRoots: [join(process.cwd(), "node_modules", "@types")],
      strict: true,
      skipLibCheck: false,
      noEmit: true,
    },
    files: ["index.ts"],
  }));
  execFileSync(process.execPath, [join(process.cwd(), "node_modules", "typescript", "bin", "tsc"), "--project", join(consumerDirectory, "tsconfig.json")], {
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
  "bridge-constraints",
  "browser",
  "browser-bridge",
  "domain",
  "events",
  "export",
  "iframe-host",
  "index",
  "kernel",
  "review-shell-view",
  "shell-state",
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
const expectedPaths = ["LICENSE", "README.md", "package.json", "dist/review-shell.css", ...reviewedOutputs].sort();
assert.deepEqual(paths.sort(), expectedPaths, "packed files must match the reviewed package manifest exactly");

console.log(`verified ${paths.length} package files`);
