"use client";

import { useCallback, useRef, useState } from "react";

// Long-form voice capture for journaling (talk for many minutes).
//
// Two platform limits make a single big upload fail silently for long audio:
//   1. Vercel caps a function request body at ~4.5 MB.
//   2. Functions time out (transcribing minutes of audio in one call is slow).
//
// So we record in rolling SEGMENTS: every ROTATE_MS we finalize the current
// MediaRecorder (a complete, independently-decodable file) and start a fresh
// one on the same mic stream. Each segment is transcribed on its own and the
// texts are stitched back together in order. Low-bitrate opus keeps every
// segment well under the body limit.
const ROTATE_MS = 4 * 60 * 1000; // 4 min per segment
const BITRATE = 32000; // opus ~32 kbps ≈ 0.25 MB/min — plenty for speech

function pickMime(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  const types = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];
  return types.find((t) => MediaRecorder.isTypeSupported(t));
}

export function useVoiceInput(onText: (text: string) => void) {
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const rotateRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Ordered transcript assembly: segments may finish out of order, so buffer by
  // index and emit the longest contiguous prefix as it becomes ready.
  const segCountRef = useRef(0);
  const pendingRef = useRef(0);
  const bufRef = useRef<Record<number, string>>({});
  const nextEmitRef = useRef(0);

  const flush = useCallback(() => {
    const buf = bufRef.current;
    while (buf[nextEmitRef.current] !== undefined) {
      const t = buf[nextEmitRef.current];
      if (t) onText(t);
      delete buf[nextEmitRef.current];
      nextEmitRef.current += 1;
    }
  }, [onText]);

  const transcribeSegment = useCallback(
    async (blob: Blob, idx: number, mime: string) => {
      pendingRef.current += 1;
      setTranscribing(true);
      try {
        const ext = mime.includes("mp4") ? "mp4" : "webm";
        const fd = new FormData();
        fd.append("audio", blob, `segment-${idx}.${ext}`);
        const res = await fetch("/api/transcribe", { method: "POST", body: fd });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(data.error || `Transcription failed (${res.status})`);
        }
        bufRef.current[idx] = (data.text as string) ?? "";
      } catch (e) {
        bufRef.current[idx] = ""; // keep ordering intact even on failure
        setError(e instanceof Error ? e.message : "Transcription failed");
      } finally {
        pendingRef.current -= 1;
        flush();
        setTranscribing(pendingRef.current > 0);
      }
    },
    [flush]
  );

  const startSegment = useCallback(
    (mime: string | undefined) => {
      const stream = streamRef.current;
      if (!stream) return;
      const rec = new MediaRecorder(
        stream,
        mime
          ? { mimeType: mime, audioBitsPerSecond: BITRATE }
          : { audioBitsPerSecond: BITRATE }
      );
      const idx = segCountRef.current;
      segCountRef.current += 1;
      const chunks: Blob[] = [];
      rec.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data);
      };
      rec.onstop = () => {
        const blob = new Blob(chunks, { type: rec.mimeType });
        if (blob.size > 0) transcribeSegment(blob, idx, rec.mimeType);
      };
      recorderRef.current = rec;
      rec.start();
    },
    [transcribeSegment]
  );

  const start = useCallback(async () => {
    if (recording) return;
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mime = pickMime();

      // reset assembly state for a fresh session
      segCountRef.current = 0;
      pendingRef.current = 0;
      bufRef.current = {};
      nextEmitRef.current = 0;

      startSegment(mime);
      rotateRef.current = setInterval(() => {
        const cur = recorderRef.current;
        if (cur && cur.state !== "inactive") cur.stop(); // finalize -> transcribe
        startSegment(mime); // seamless next segment on the same stream
      }, ROTATE_MS);

      setRecording(true);
    } catch {
      setError("Microphone unavailable — check permissions.");
      setRecording(false);
    }
  }, [recording, startSegment]);

  const stop = useCallback(() => {
    if (rotateRef.current) {
      clearInterval(rotateRef.current);
      rotateRef.current = null;
    }
    const cur = recorderRef.current;
    if (cur && cur.state !== "inactive") cur.stop(); // final segment -> transcribe
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setRecording(false);
  }, []);

  const toggle = useCallback(() => {
    if (recording) stop();
    else start();
  }, [recording, start, stop]);

  return { recording, transcribing, error, toggle };
}
