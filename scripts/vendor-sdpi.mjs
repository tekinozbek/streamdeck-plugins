// Restores the vendored sdpi-components.js in both plugins, so the settings pages work offline and run no remote code.
// Usage: node scripts/vendor-sdpi.mjs   (or `npm run vendor:sdpi` in a plugin folder)
//
// The release URL floats with every v4 update, so the download is only accepted if it is byte for byte the version
// named in THIRD-PARTY-NOTICES.md. To upgrade: review the new file, then update VERSION, SHA256 and the notices.
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";

const VERSION = "4.0.1";
const SHA256 = "f6c0dfd2ed68e18084b9952842b86e3850cf837d674704700c2a0718e0a24f6b";
const REMOTE = "https://sdpi-components.dev/releases/v4/sdpi-components.js";

const res = await fetch(REMOTE);
if (!res.ok) throw new Error(`Download failed: ${res.status}`);
const body = Buffer.from(await res.arrayBuffer());
const got = createHash("sha256").update(body).digest("hex");
if (got !== SHA256) throw new Error(`The download is not sdpi-components ${VERSION} (sha256 ${got}); nothing written`);

for (const name of ["api-tools", "utilities"]) {
  const target = new URL(`../${name}/io.github.tekinozbek.${name}.sdPlugin/ui/sdpi-components.js`, import.meta.url);
  await writeFile(target, body);
  console.log(`Wrote sdpi-components ${VERSION} to ${name}`);
}
