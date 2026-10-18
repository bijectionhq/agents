import WebSocket from "ws";
import { MuLawFromPcm24, pcm24FromMuLaw, VoiceActivity } from "./audio.js";
import type { VoiceSpeech, TranscriptionSession } from "./contracts.js";

export type OpenAiSpeechOptions = {
  apiKey: string;
  transcriptionModel: string;
  speechModel: string;
  voice: string;
  /** Explicit deployment/data-residency endpoints, fixed by the operator. */
  transcriptionUrl?: string;
  speechUrl?: string;
  vadThreshold?: number;
};

/** Transcription produces untrusted caller input. Synthesis receives only
 * claimed text from VoiceCall; this provider never chooses an operation. */
export function openAiSpeech(options: OpenAiSpeechOptions): VoiceSpeech {
  if (
    !options.apiKey ||
    !options.transcriptionModel ||
    !options.speechModel ||
    !options.voice
  )
    throw new Error("Configure speech credentials, exact models and voice");
  const transcriptionUrl =
    options.transcriptionUrl ??
    "wss://api.openai.com/v1/realtime?intent=transcription";
  const speechUrl =
    options.speechUrl ?? "https://api.openai.com/v1/audio/speech";
  for (const [value, protocol] of [
    [transcriptionUrl, "wss:"],
    [speechUrl, "https:"],
  ] as const) {
    const url = new URL(value);
    if (url.protocol !== protocol || url.username || url.password || url.hash)
      throw new Error(
        "Speech endpoints require authenticated encrypted transport",
      );
  }
  return {
    destination: speechUrl,
    async transcribe(callbacks): Promise<TranscriptionSession> {
      const socket = new WebSocket(transcriptionUrl, {
        headers: { Authorization: `Bearer ${options.apiKey}` },
        maxPayload: 256 * 1024,
      });
      const vad = new VoiceActivity(options.vadThreshold);
      let pending = new Uint8Array(0);
      let isClosed = false;
      let commitsPending = 0;
      const ordered: { id: string; text?: string }[] = [];
      const seen = new Set<string>();
      const fail = (error: unknown) => {
        if (isClosed) return;
        isClosed = true;
        socket.close();
        callbacks.failed(
          error instanceof Error ? error : new Error("Transcription failed"),
        );
      };
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          socket.terminate();
          reject(new Error("Transcription setup timed out"));
        }, 10_000);
        socket.once("open", () => {
          socket.send(
            JSON.stringify({
              type: "session.update",
              session: {
                type: "transcription",
                audio: {
                  input: {
                    format: { type: "audio/pcm", rate: 24_000 },
                    transcription: { model: options.transcriptionModel },
                    turn_detection: null,
                  },
                },
              },
            }),
          );
        });
        socket.on("message", (bytes) => {
          try {
            const event = JSON.parse(bytes.toString());
            if (
              event.type === "session.updated" ||
              event.type === "transcription_session.updated"
            ) {
              clearTimeout(timer);
              resolve();
            } else if (event.type === "input_audio_buffer.committed") {
              if (
                !commitsPending ||
                typeof event.item_id !== "string" ||
                seen.has(event.item_id)
              )
                throw new Error("Unexpected transcription commit");
              commitsPending--;
              ordered.push({ id: event.item_id });
              seen.add(event.item_id);
              if (seen.size > 256)
                throw new Error("Transcription turn limit reached");
            } else if (
              event.type ===
              "conversation.item.input_audio_transcription.completed"
            ) {
              const turn = ordered.find((turn) => turn.id === event.item_id);
              if (
                !turn ||
                typeof event.transcript !== "string" ||
                event.transcript.length > 8192
              )
                throw new Error("Unexpected transcription result");
              if (turn.text !== undefined)
                throw new Error("Duplicate transcription result");
              turn.text = event.transcript;
              while (ordered[0]?.text !== undefined) {
                const ready = ordered.shift()!;
                callbacks.completed(ready.id, ready.text!);
              }
            } else if (
              event.type === "error" ||
              event.type ===
                "conversation.item.input_audio_transcription.failed"
            ) {
              throw new Error("Speech provider refused transcription");
            }
          } catch (error) {
            if (error instanceof SyntaxError)
              error = new Error("Invalid transcription JSON");
            clearTimeout(timer);
            reject(error);
            fail(error);
          }
        });
        socket.on("error", (error) => {
          clearTimeout(timer);
          reject(error);
          fail(error);
        });
        socket.on("close", () => {
          clearTimeout(timer);
          reject(new Error("Transcription disconnected"));
          fail(new Error("Transcription disconnected"));
        });
      });
      return {
        append(bytes) {
          if (isClosed) return;
          if (bytes.length > 8000 || socket.bufferedAmount > 256 * 1024) {
            fail(new Error("Transcription backpressure exceeded"));
            return;
          }
          const joined = new Uint8Array(pending.length + bytes.length);
          joined.set(pending);
          joined.set(bytes, pending.length);
          let offset = 0;
          while (joined.length - offset >= 160) {
            const activity = vad.append(joined.subarray(offset, offset + 160));
            offset += 160;
            if (activity.isStarted) callbacks.speechStarted();
            for (const audio of activity.audio)
              socket.send(
                JSON.stringify({
                  type: "input_audio_buffer.append",
                  audio: Buffer.from(pcm24FromMuLaw(audio)).toString("base64"),
                }),
              );
            if (activity.isEnded) {
              if (commitsPending + ordered.length >= 4) {
                fail(new Error("Transcription completion backlog exceeded"));
                return;
              }
              commitsPending++;
              socket.send(
                JSON.stringify({ type: "input_audio_buffer.commit" }),
              );
            }
          }
          pending = joined.slice(offset);
        },
        close() {
          isClosed = true;
          socket.close();
        },
      };
    },
    async *synthesize(text, signal) {
      const response = await fetch(speechUrl, {
        method: "POST",
        redirect: "error",
        signal,
        headers: {
          Authorization: `Bearer ${options.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: options.speechModel,
          voice: options.voice,
          input: text,
          response_format: "pcm",
        }),
      });
      if (!response.ok || !response.body)
        throw new Error(`Speech synthesis failed (${response.status})`);
      const converter = new MuLawFromPcm24();
      const reader = response.body.getReader();
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          const audio = converter.append(chunk.value);
          if (audio.length) yield audio;
        }
        const tail = converter.finish();
        if (tail.length) yield tail;
      } finally {
        await reader.cancel();
        reader.releaseLock();
      }
    },
  };
}
