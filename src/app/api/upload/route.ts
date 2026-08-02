import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60; // pdf/docx parsing can be slow on big files

const MAX_BYTES = 8 * 1024 * 1024; // 8 MB
const MAX_CHARS = 50000; // keep the prompt sane for huge files

// Extract readable text from an uploaded file so it can be fed to the assistant.
// Supports PDF (pdf-parse), DOCX (mammoth), and any plain-text file (txt, md,
// csv, json, code…). Returns { name, text }.
export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "No file" }, { status: 400 });
    }
    if (file.size > MAX_BYTES) {
      return NextResponse.json({ error: "File too large (max 8 MB)" }, { status: 413 });
    }

    const name = file.name.toLowerCase();
    let text: string;

    if (name.endsWith(".pdf")) {
      const pdfParse = (await import("pdf-parse/lib/pdf-parse.js")).default;
      const buf = Buffer.from(await file.arrayBuffer());
      const data = await pdfParse(buf);
      text = data.text ?? "";
    } else if (name.endsWith(".docx")) {
      const mammoth = await import("mammoth");
      const buf = Buffer.from(await file.arrayBuffer());
      const result = await mammoth.extractRawText({ buffer: buf });
      text = result.value ?? "";
    } else {
      text = await file.text();
    }

    // Strip null bytes (pdf-parse sometimes emits them) and normalize.
    text = text.replace(/\u0000/g, "").replace(/\r\n/g, "\n").trim();
    if (text.length > MAX_CHARS) {
      text = `${text.slice(0, MAX_CHARS)}\n\n…[file truncated]`;
    }

    return NextResponse.json({ name: file.name, text });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Upload failed";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
