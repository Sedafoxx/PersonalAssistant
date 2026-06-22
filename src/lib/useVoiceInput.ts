"use client";

import { useRef, useState } from "react";

// Record mic audio → POST to /api/transcribe (Whisper) → return text.
// onText is called with the transcript when recording stops and transcribes.
export function useVoiceInput(onText: (text: string) => void) {
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  async function start() {
    if (recording || transcribing) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      chunksRef.current = [];

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType });
        if (blob.size === 0) return;
        setTranscribing(true);
        try {
          const ext = recorder.mimeType.includes("mp4") ? "mp4" : "webm";
          const fd = new FormData();
          fd.append("audio", blob, `recording.${ext}`);
          const res = await fetch("/api/transcribe", { method: "POST", body: fd });
          const data = await res.json();
          if (data.text) onText(data.text as string);
        } catch {
          // user can retry
        } finally {
          setTranscribing(false);
        }
      };

      recorderRef.current = recorder;
      recorder.start();
      setRecording(true);
    } catch {
      setRecording(false);
    }
  }

  function stop() {
    recorderRef.current?.stop();
    setRecording(false);
  }

  function toggle() {
    if (recording) stop();
    else start();
  }

  return { recording, transcribing, toggle };
}
