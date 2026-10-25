import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export default function globalSetup() {
  const dir = join(process.cwd(), "e2e", ".samples");
  mkdirSync(dir, { recursive: true });
  const out = execFileSync("python3", ["tests/samples.py", dir], { cwd: join(process.cwd(), "..", "backend"), encoding: "utf8" });
  writeFileSync(join(dir, "samples.json"), out);
}
