import { NextRequest, NextResponse } from "next/server";
import { alexaSkill } from "@/lib/alexa/skill";
import { verifyAlexaRequest } from "@/lib/alexa/verify";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Health check — open https://<your-app>/api/alexa in a browser to confirm the
// route is deployed before enabling the skill.
export async function GET() {
  return NextResponse.json({ status: "ok", service: "alexa-skill" });
}

export async function POST(req: NextRequest) {
  const rawBody = await req.text();

  // Optional signature verification (see verify.ts). Off by default because the
  // Vercel deployment uses a CA-signed cert ("Trusted" mode) which doesn't send
  // Signature headers. Set ALEXA_VERIFY_REQUESTS=1 to require them.
  if (process.env.ALEXA_VERIFY_REQUESTS === "1") {
    const ok = await verifyAlexaRequest(req.headers, rawBody);
    if (!ok) {
      return NextResponse.json({ error: "invalid signature" }, { status: 401 });
    }
  }

  let envelope: unknown;
  try {
    envelope = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }

  try {
    const response = await alexaSkill.invoke(
      envelope as Parameters<typeof alexaSkill.invoke>[0],
      {} as Parameters<typeof alexaSkill.invoke>[1]
    );
    return NextResponse.json(response);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "skill error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
