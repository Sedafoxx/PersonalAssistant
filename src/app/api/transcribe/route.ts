import OpenAI from "openai";
import { NextRequest, NextResponse } from "next/server";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const file = form.get("audio");

    if (!(file instanceof File)) {
      return NextResponse.json({ error: "No audio file" }, { status: 400 });
    }

    const transcription = await client.audio.transcriptions.create({
      file,
      model: "gpt-4o-transcribe",
    });

    return NextResponse.json({ text: transcription.text });
  } catch (err) {
    console.error("transcribe error", err);
    return NextResponse.json({ error: "Transcription failed" }, { status: 500 });
  }
}
