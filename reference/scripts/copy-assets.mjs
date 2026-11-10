// The built CLI reads the schemas and conformance vectors at run time, by paths relative to its own
// files (`../../schema/...` from dist/src). From the source tree those paths reach the repository
// root; from dist they reach this package, so the build copies both trees in, and a packed tarball
// carries them. LICENSE and NOTICE live at the repository root too; Apache-2.0 asks that a
// redistributed copy carries both, so the build copies them in as well.
import { cpSync, rmSync } from "node:fs";

const assets = [
  ["../schema", "schema"],
  ["../conformance/vectors", "conformance/vectors"],
  ["../LICENSE", "LICENSE"],
  ["../NOTICE", "NOTICE"],
];

for (const [from, to] of assets) {
  const source = new URL(`../${from}`, import.meta.url);
  const target = new URL(`../${to}`, import.meta.url);
  rmSync(target, { recursive: true, force: true });
  cpSync(source, target, { recursive: true });
}
