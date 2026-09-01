import { copyFileSync } from "node:fs";

copyFileSync(
  new URL("../src/review-shell.css", import.meta.url),
  new URL("../dist/review-shell.css", import.meta.url),
);
