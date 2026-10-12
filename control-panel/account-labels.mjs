import { createHmac } from "node:crypto";

const maskEmails = (value) =>
  value.replace(/[^\s<>/@]+@[^\s<>/@]+/g, (email) => {
    const [local, domain] = email.split("@");
    return `${local[0]}•••@${domain[0]}•••`;
  });

export function accountDisplayLabel(file) {
  const label = typeof file.label === "string" ? file.label.trim() : "";
  const email = typeof file.email === "string" ? file.email.trim() : "";
  // Never fall back to filenames or IDs, which can contain credentials.
  return label || email.includes("@")
    ? maskEmails(label || email)
        .replace(/[\r\n\t]+/g, " ")
        .slice(0, 120)
    : "";
}

// Match identity.Reference in the control service, including Go's JSON escaping.
// Raw account identities and the HMAC secret never leave this bridge.
export function accountLabels(files, hexKey) {
  if (!/^(?:[a-f0-9]{2}){32,}$/i.test(hexKey || "")) return {};
  const labels = {};
  for (const file of files || []) {
    const raw = file.id || file.name;
    if (typeof raw !== "string" || !raw) continue;
    const encoded = JSON.stringify(["v1", "local", "account", raw]).replace(
      /[<>&\u2028\u2029]/g,
      (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
    );
    const id = `v1:${createHmac("sha256", Buffer.from(hexKey, "hex")).update(encoded).digest("hex")}`;
    const label = accountDisplayLabel(file);
    if (label) labels[id] = label;
  }
  return labels;
}
