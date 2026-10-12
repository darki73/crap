import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Offline validation of inline relative links in CRAP's README and user guides.
// External URLs are intentionally not fetched (some refer to private services).
const root = fileURLToPath(new URL("../", import.meta.url));
const { publicDocuments: guides } = JSON.parse(
  await readFile(new URL('../deploy/privacy-policy.json', import.meta.url), 'utf8'),
);
const errors = [];
let checked = 0;
async function exactFile(target) {
  const relative = path.relative(root, target);
  if (relative.startsWith("..") || path.isAbsolute(relative))
    throw new Error("outside repository");
  let current = root;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    if (!(await readdir(current)).includes(part))
      throw new Error("missing file or incorrect case");
    current = path.join(current, part);
  }
}
for (const file of guides) {
  const source = await readFile(path.join(root, file), "utf8");
  const body = source.replace(/^```[^\n]*\r?\n[\s\S]*?^```\s*$/gm, "");
  for (const match of body.matchAll(/\[[^\]\n]+\]\(([^)\s]+)\)/g)) {
    const href = match[1];
    if (/^[a-z][a-z0-9+.-]*:/i.test(href)) continue;
    const [filename, anchor] = href.split("#");
    const target = filename
      ? path.resolve(root, path.dirname(file), decodeURIComponent(filename))
      : path.join(root, file);
    try {
      await exactFile(target);
      if (anchor) {
        const content = await readFile(target, "utf8");
        const slugs = [...content.matchAll(/^#{1,6}\s+(.+)$/gm)].map((m) =>
          m[1]
            .toLowerCase()
            .replace(/[^\p{L}\p{N}\s_-]/gu, "")
            .trim()
            .replace(/\s/g, "-"),
        );
        if (!slugs.includes(decodeURIComponent(anchor)))
          throw new Error("missing heading anchor");
      }
      checked++;
    } catch (error) {
      errors.push(`${file}: ${href}: ${error.message}`);
    }
  }
}
if (errors.length) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else
  console.log(
    `PASS: ${checked} relative documentation links in ${guides.length} files (case-sensitive, offline).`,
  );
