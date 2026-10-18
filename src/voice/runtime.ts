import type {
  DeliveryOutcome,
  OutputClaim,
  Unsubscribe,
  VoiceBackend,
  VoiceOutput,
  VoiceSession,
  VoiceSpeech,
  VoiceTransport,
  TranscriptionSession,
  VoicePresentation,
} from "./contracts.js";

const FRAME_BYTES = 800; // At most 100 ms in the carrier's playback buffer.
const ACK_TIMEOUT_MS = 10_000;

type Playback = {
  output: VoiceOutput;
  claim: OutputClaim;
  abort: AbortController;
  isClearing: boolean;
  sentBytes: number;
  acknowledgedBytes: number;
  stopWatch: Unsubscribe;
  expiry?: ReturnType<typeof setTimeout>;
  mark?: { id: string; bytes: number; resolve: (played: boolean) => void };
  lastEvent?: string;
};

/** One live call, with bounded audio and one native delivery at a time. Audio
 * never enters the database. Every synthesized utterance has a native claim. */
export class VoiceCall {
  private transcription?: TranscriptionSession;
  private stopOutputs?: Unsubscribe;
  private playback?: Playback;
  private isClosed = false;
  private deadline?: ReturnType<typeof setTimeout>;
  private work = Promise.resolve();
  private speechWork = Promise.resolve();
  private seen = new Set<string>();
  private desiredOutput: string | null = null;
  private pendingInputs = 0;
  private inputCount = 0;
  private presentation?: VoicePresentation & { settlement: Promise<void> };

  constructor(
    private readonly session: VoiceSession,
    private readonly backend: VoiceBackend,
    private readonly speech: VoiceSpeech,
    private readonly transport: VoiceTransport,
    private readonly report: (error: unknown) => void,
  ) {}

  async start(): Promise<void> {
    if (
      !Number.isSafeInteger(this.session.expiresAt) ||
      this.session.expiresAt <= Date.now()
    )
      throw new Error("Call expired");
    this.deadline = setTimeout(
      () => {
        void this.end("expired").catch(this.report);
      },
      Math.min(this.session.expiresAt - Date.now(), 30 * 60_000),
    );
    this.transcription = await this.speech.transcribe({
      speechStarted: () => {
        this.presentation = undefined;
        void this.interrupt().catch((error) => this.fail(error));
      },
      completed: (id, text) => {
        if (text.trim())
          this.input(() => this.backend.transcript(this.session, id, text));
      },
      failed: (error) => this.fail(error),
    });
    if (this.isClosed) {
      this.transcription.close();
      return;
    }
    this.stopOutputs = this.backend.watchOutput(
      this.session,
      (output) => {
        if (
          output?.source.kind === "proposal" &&
          output.source.agreementId !== this.presentation?.agreementId
        )
          this.presentation = undefined;
        this.desiredOutput = output?.id ?? null;
        if (this.playback && this.playback.output.id !== this.desiredOutput)
          void this.interrupt().catch((error) => this.fail(error));
        if (!output || this.isClosed || this.seen.has(output.id)) return;
        if (this.seen.size >= 128) {
          this.fail(new Error("Voice output limit reached"));
          return;
        }
        this.seen.add(output.id);
        this.speechWork = this.speechWork
          .then(() => this.speak(output))
          .catch((error) => this.fail(error));
      },
      (error) => this.fail(error),
    );
  }

  audio(bytes: Uint8Array): void {
    if (!this.isClosed) this.transcription?.append(bytes);
  }

  digit(eventId: string, digit: string): void {
    // Capture at receipt, before queued mutations change the selection.
    // Waiting for speech would turn a premature key into later consent.
    const presentation = this.presentation;
    this.input(async () => {
      await presentation?.settlement;
      if (this.isClosed) return;
      await this.backend.digit(
        this.session,
        eventId,
        digit,
        presentation && {
          agreementId: presentation.agreementId,
          ticket: presentation.ticket,
        },
      );
    });
  }

  private input(action: () => Promise<void>): void {
    if (this.isClosed) return;
    if (this.pendingInputs >= 64 || this.inputCount >= 512) {
      this.fail(new Error("Call input limit reached"));
      return;
    }
    this.pendingInputs++;
    this.inputCount++;
    this.work = this.work
      .then(async () => {
        try {
          if (!this.isClosed) await action();
        } finally {
          this.pendingInputs--;
        }
      })
      .catch((error) => this.fail(error));
  }

  /** Clear also echoes queued marks. Once clearing starts, no echoed mark
   * counts as successful playback, even if it races the clear command. */
  mark(id: string, eventId: string): void {
    const playback = this.playback;
    if (!playback?.mark || playback.mark.id !== id) return;
    const pending = playback.mark;
    playback.mark = undefined;
    const played = !playback.isClearing && !playback.abort.signal.aborted;
    if (played) playback.acknowledgedBytes += pending.bytes;
    playback.lastEvent = eventId;
    pending.resolve(played);
  }

  async interrupt(): Promise<void> {
    const playback = this.playback;
    if (!playback || playback.isClearing) return;
    playback.isClearing = true;
    playback.abort.abort();
    // Keep the pending mark until the carrier confirms it has drained/cleared.
    // A lost acknowledgement remains unknown and closes the call.
    await this.transport.clear();
  }

  async end(reason = "disconnected"): Promise<void> {
    if (this.isClosed) return;
    this.isClosed = true;
    this.presentation = undefined;
    clearTimeout(this.deadline);
    this.stopOutputs?.();
    this.transcription?.close();
    const playback = this.playback;
    if (playback) {
      playback.isClearing = true;
      playback.abort.abort();
      playback.mark?.resolve(false);
      playback.mark = undefined;
    }
    // A lost native acknowledgement must not keep the physical call open.
    // Closure fences native sessions when recorded; settlement stays legal.
    this.transport.close();
    try {
      await this.bounded(this.backend.ended(this.session, reason));
    } finally {
      await this.bounded(this.speechWork);
    }
  }

  private fail(error: unknown): void {
    this.report(error);
    void this.end("failed").catch(this.report);
  }

  private async speak(output: VoiceOutput): Promise<void> {
    if (this.isClosed || output.id !== this.desiredOutput) return;
    let claim: OutputClaim;
    try {
      claim = await this.backend.claim(
        this.session,
        output,
        this.speech.destination,
      );
    } catch (error) {
      if (this.isClosed || output.id !== this.desiredOutput) return;
      throw error;
    }
    if (claim.result === null) {
      // A replay never resends a first-claim payload. The host must reconcile
      // its old transport, rather than guess whether the caller heard it.
      if (claim.state === "dispatching" || claim.state === "unknown")
        throw new Error("Previous voice dispatch requires reconciliation");
      return;
    }
    const playback: Playback = {
      output,
      claim,
      abort: new AbortController(),
      isClearing: false,
      sentBytes: 0,
      acknowledgedBytes: 0,
      stopWatch: () => {},
    };
    this.playback = playback;
    let outcome: DeliveryOutcome = "notDelivered";
    let streamCompleted = false;
    try {
      if (
        this.isClosed ||
        output.id !== this.desiredOutput ||
        claim.isInvalidated ||
        claim.expiresAt <= Date.now()
      )
        return;
      const authorization = new Promise<void>((resolve, reject) => {
        playback.stopWatch = this.backend.watchClaim(
          this.session,
          output,
          claim.ticket,
          (status) => {
            clearTimeout(playback.expiry);
            if (!status.isCurrent || status.expiresAt <= Date.now()) {
              reject(new Error("Voice output authorization ended"));
              void this.interrupt().catch((error) => this.fail(error));
              return;
            }
            playback.expiry = setTimeout(
              () => {
                void this.interrupt().catch((error) => this.fail(error));
              },
              Math.min(status.expiresAt - Date.now(), 86_400_000),
            );
            resolve();
          },
          (error) => {
            reject(error);
            void this.interrupt().catch((failure) => this.fail(failure));
          },
        );
      });
      await this.bounded(authorization);
      let pending = new Uint8Array(0);
      for await (const chunk of this.speech.synthesize(
        claim.result,
        playback.abort.signal,
      )) {
        if (playback.abort.signal.aborted || this.isClosed) break;
        if (chunk.length > 256 * 1024)
          throw new Error("Speech chunk exceeds bounds");
        const joined = new Uint8Array(pending.length + chunk.length);
        joined.set(pending);
        joined.set(chunk, pending.length);
        let offset = 0;
        while (joined.length - offset >= FRAME_BYTES) {
          if (
            !(await this.send(
              playback,
              joined.subarray(offset, offset + FRAME_BYTES),
            ))
          )
            break;
          offset += FRAME_BYTES;
        }
        pending = joined.slice(offset);
        if (playback.abort.signal.aborted || this.isClosed) break;
      }
      if (!playback.abort.signal.aborted && !this.isClosed && pending.length)
        await this.send(playback, pending);
      streamCompleted = !playback.abort.signal.aborted && !this.isClosed;
    } catch (error) {
      if (!playback.abort.signal.aborted) this.report(error);
      await this.interrupt();
    } finally {
      playback.stopWatch();
      clearTimeout(playback.expiry);
      if (playback.mark) {
        try {
          await this.waitMark(playback);
        } catch {
          /* retained as unknown below */
        }
      }
      if (playback.sentBytes === 0) outcome = "notDelivered";
      else if (this.isClosed || playback.mark) outcome = "unknown";
      else if (
        streamCompleted &&
        playback.acknowledgedBytes === playback.sentBytes
      )
        outcome = "delivered";
      else outcome = "interrupted";
      this.playback = undefined;
      const settlement = Promise.resolve().then(() =>
        this.backend.settle(
          this.session,
          output,
          claim.ticket,
          outcome,
          playback.lastEvent,
        ),
      );
      if (outcome === "delivered" && output.source.kind === "proposal")
        this.presentation = {
          agreementId: output.source.agreementId,
          ticket: claim.ticket,
          settlement,
        };
      await settlement;
      if (outcome === "unknown")
        throw new Error("Voice playback requires reconciliation");
    }
  }

  private async send(playback: Playback, bytes: Uint8Array): Promise<boolean> {
    if (playback.abort.signal.aborted || this.isClosed) return false;
    const id = `${playback.claim.ticket}:${playback.sentBytes}`;
    const acknowledged = new Promise<boolean>((resolve) => {
      playback.mark = { id, bytes: bytes.length, resolve };
    });
    // Count before transport: a failed send can be ambiguous.
    playback.sentBytes += bytes.length;
    await this.transport.audio(bytes);
    await this.transport.mark(id);
    return this.bounded(acknowledged);
  }

  private waitMark(playback: Playback): Promise<boolean> {
    return this.bounded(
      new Promise<boolean>((resolve) => {
        const pending = playback.mark;
        if (!pending) {
          resolve(false);
          return;
        }
        const prior = pending.resolve;
        pending.resolve = (played) => {
          prior(played);
          resolve(played);
        };
      }),
    );
  }

  private async bounded<T>(work: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Voice acknowledgement timed out")),
            ACK_TIMEOUT_MS,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}
