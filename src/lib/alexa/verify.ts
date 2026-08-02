// Best-effort verification of Alexa's request signature.
//
// When a custom skill endpoint is HTTPS with a CA-signed certificate ("Trusted"
// cert mode, e.g. Vercel's Let's Encrypt), Amazon does NOT require signature
// verification — the TLS connection is the security boundary, and Amazon may
// omit the Signature headers entirely. That's why this is OFF by default.
//
// Set ALEXA_VERIFY_REQUESTS=1 to turn it on. In that mode requests MUST carry a
// valid SignatureCertChainUrl + Signature (Amazon's "SelfSigned" cert mode), and
// this verifies them the way ask-sdk's standard builder does:
//   1. cert URL must be Amazon's echo-api cert on s3.amazonaws.com
//   2. fetch the PEM chain (cached 12h)
//   3. RSA-verify the Base64 signature over the raw request body
// (accepts SHA-256 or SHA-1, since Amazon has used both over the years)
import crypto from "node:crypto";
import https from "node:https";

const ALLOWED_CERT_HOST = "s3.amazonaws.com";
const ALLOWED_CERT_PATHS = ["/echo.api/echo-api-cert.pem"];
const CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

let certCache: { pem: string; at: number } | null = null;

function fetchCertPem(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`cert fetch failed: HTTP ${res.statusCode}`));
        return;
      }
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      res.on("error", reject);
    });
    req.on("error", reject);
  });
}

export async function verifyAlexaRequest(
  headers: Headers,
  rawBody: string
): Promise<boolean> {
  const certUrl = headers.get("SignatureCertChainUrl");
  const signature = headers.get("Signature");
  if (!certUrl || !signature) return false;

  // 1. Only accept Amazon's official echo-api certificate location.
  let url: URL;
  try {
    url = new URL(certUrl);
  } catch {
    return false;
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== ALLOWED_CERT_HOST ||
    !ALLOWED_CERT_PATHS.includes(url.pathname)
  ) {
    return false;
  }

  // 2. Fetch (and cache) the certificate chain.
  let pem = certCache?.pem;
  if (!pem || Date.now() - (certCache?.at ?? 0) > CACHE_TTL_MS) {
    pem = await fetchCertPem(certUrl);
    certCache = { pem, at: Date.now() };
  }

  // 3. RSA-verify the signature over the raw request body.
  try {
    const publicKey = crypto.createPublicKey(pem);
    const body = Buffer.from(rawBody, "utf8");
    const sig = Buffer.from(signature, "base64");
    if (crypto.verify("sha256", body, publicKey, sig)) return true;
    if (crypto.verify("sha1", body, publicKey, sig)) return true;
  } catch {
    return false;
  }
  return false;
}
