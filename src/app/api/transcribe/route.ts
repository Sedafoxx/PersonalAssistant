import OpenAI from "openai";
import { NextRequest, NextResponse } from "next/server";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export const dynamic = "force-dynamic";
export const maxDuration = 60; // transcription of a multi-minute segment is slow

// Vercel caps a function request body at ~4.5 MB; reject early with a clear
// message rather than letting the platform return an opaque 413. The client
// records in low-bitrate segments to stay well under this.
const MAX_BYTES = 4 * 1024 * 1024;

export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const file = form.get("audio");

    if (!(file instanceof File)) {
      return NextResponse.json({ error: "No audio file" }, { status: 400 });
    }
    if (file.size > MAX_BYTES) {
      return NextResponse.json(
        { error: "Audio segment too large — please try again." },
        { status: 413 }
      );
    }

    const transcription = await client.audio.transcriptions.create({
      file,
      model: "gpt-4o-transcribe",
    });

    return NextResponse.json({ text: transcription.text });
  } catch (err) {
    console.error("transcribe error", err);
    const msg = err instanceof Error ? err.message : "Transcription failed";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
