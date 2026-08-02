// Injects your real deployment URL into skill-package/skill.json before
// `ask deploy`, so you never edit the endpoint by hand in the Alexa console.
//
// Resolution order:
//   1. ALEXA_ENDPOINT (set it in .env.local) e.g. https://my-app.vercel.app/api/alexa
//   2. VERCEL_PROJECT_PRODUCTION_URL (available during Vercel builds)
//   3. VERCEL_URL
// If none resolve, the placeholder is left in place and a warning is printed.
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const skillPath = join(root, "skill-package", "skill.json");

const endpoint =
  process.env.ALEXA_ENDPOINT ||
  (process.env.VERCEL_PROJECT_PRODUCTION_URL
    ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}/api/alexa`
    : process.env.VERCEL_URL
      ? `https://${process.env.VERCEL_URL}/api/alexa`
      : null);

const skill = JSON.parse(readFileSync(skillPath, "utf8"));
const api = skill.manifest.apis.custom;
const before = api.endpoint.uri;

if (endpoint) {
  api.endpoint.uri = endpoint;
  // Vercel serves *.vercel.app with a wildcard cert, so the skill must use
  // sslCertificateType "Wildcard" (not "Trusted") or Amazon rejects the endpoint.
  api.endpoint.sslCertificateType = "Wildcard";
} else {
  console.warn(
    "WARNING: ALEXA_ENDPOINT not set — keeping the placeholder.\n" +
      "Set ALEXA_ENDPOINT=https://<your-app>.vercel.app/api/alexa in .env.local\n" +
      "(or .env.production for CI) and re-run."
  );
}

writeFileSync(skillPath, JSON.stringify(skill, null, 2) + "\n");
console.log(`skill.json endpoint: ${before} -> ${api.endpoint.uri}`);
