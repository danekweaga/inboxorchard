import { existsSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";

// Cloudflare's Vite preview output can copy local development variables next to
// the Worker bundle. They are not static assets, but removing the file makes the
// production artifact safe to archive or hand to another person.
const workerOutput = resolve("dist", "chatmany");
const devVars = resolve(workerOutput, ".dev.vars");
if (dirname(devVars) !== workerOutput) throw new Error("Refusing to sanitize an unexpected build path");
if (existsSync(devVars)) {
  rmSync(devVars, { force: true });
  console.log("Removed local .dev.vars from the production artifact.");
}
