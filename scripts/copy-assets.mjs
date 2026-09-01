import { copyFileSync } from "node:fs";

copyFileSync(
  new URL("../src/review-shell.css", import.meta.url),
  new URL("../dist/review-shell.css", import.meta.url),
);

copyFileSync(
  new URL("../src/review-overlay.css", import.meta.url),
  new URL("../dist/review-overlay.css", import.meta.url),
);
