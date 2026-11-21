// Fails when a package in a lockfile has a license that is not known to be AGPL-3.0 compatible. Run: npm run licenses
import { readFileSync } from "node:fs";

const ALLOWED = new Set([
  "MIT", "ISC", "BSD-2-Clause", "BSD-3-Clause", "Apache-2.0", "0BSD", "BlueOak-1.0.0", "CC0-1.0", "Unlicense", "MPL-2.0",
  "LGPL-3.0-only", "LGPL-3.0-or-later", "GPL-3.0-only", "GPL-3.0-or-later", "AGPL-3.0-only", "AGPL-3.0-or-later",
]);
const ok = (expr) => {
  const e = expr.replace(/[()]/g, "").trim();
  if (e.includes(" OR ")) return e.split(" OR ").some(ok);
  if (e.includes(" AND ")) return e.split(" AND ").every(ok);
  return ALLOWED.has(e);
};

const files = process.argv.length > 2 ? process.argv.slice(2) : ["package-lock.json", "meet/package-lock.json"];
let bad = 0;
for (const file of files) {
  const { packages } = JSON.parse(readFileSync(file, "utf8"));
  for (const [path, p] of Object.entries(packages)) {
    if (path === "") continue; // the project itself
    if (p.license && ok(String(p.license))) continue;
    console.log(`${file}: ${path.replace(/^.*node_modules\//, "")}@${p.version}: ${p.license ?? "no license field"}`);
    bad++;
  }
}
console.log(bad ? `${bad} packages need a license review` : "all dependency licenses are AGPL-3.0 compatible");
process.exit(bad ? 1 : 0);
