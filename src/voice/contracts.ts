/** Transport observations carry no identity evidence or business authority. */
export type IncomingCall = Readonly<{
  provider: "twilio";
  accountId: string;
  callId: string;
  from: string;
  to: string;
}>;

export type VoiceSession = Readonly<{
  conversationId: string;
  interactionId: string;
  expiresAt: number;
}>;

export type VoiceOutput = Readonly<{
  id: string;
  source:
    | { kind: "prompt"; name: string }
    | { kind: "agent"; run: string; text?: { step: number; part: number } }
    | { kind: "proposal"; agreementId: string };
}>;

export type DeliveryOutcome =
  | "delivered"
  | "notDelivered"
  | "interrupted"
  | "unknown";
export type OutputClaim = Readonly<{
  ticket: string;
  state: "dispatching" | DeliveryOutcome;
  result: string | null;
  expiresAt: number;
  isInvalidated: boolean;
}>;
export type OutputStatus = Readonly<{
  isCurrent: boolean;
  expiresAt: number;
}>;
export type Unsubscribe = () => void;
/** Full playback observed before an input arrived. Its native settlement
 * must commit before that input can become a proposal response. */
export type VoicePresentation = Readonly<{
  agreementId: string;
  ticket: string;
}>;

/** Application endpoints backed by native interactions, operations and output
 * custody. Implementations authenticate as the channel, never as the model. */
export interface VoiceBackend {
  accept(call: IncomingCall): Promise<VoiceSession & { binding: string }>;
  attach(
    call: IncomingCall,
    streamId: string,
    binding: string,
    connectionId: string,
  ): Promise<VoiceSession>;
  status(accountId: string, callId: string, state: string): Promise<void>;
  transcript(
    session: VoiceSession,
    eventId: string,
    text: string,
  ): Promise<void>;
  digit(
    session: VoiceSession,
    eventId: string,
    digit: string,
    presentation?: VoicePresentation,
  ): Promise<void>;
  watchOutput(
    session: VoiceSession,
    next: (output: VoiceOutput | null) => void,
    error: (error: unknown) => void,
  ): Unsubscribe;
  claim(
    session: VoiceSession,
    output: VoiceOutput,
    processor: string,
  ): Promise<OutputClaim>;
  watchClaim(
    session: VoiceSession,
    output: VoiceOutput,
    ticket: string,
    next: (status: OutputStatus) => void,
    error: (error: unknown) => void,
  ): Unsubscribe;
  settle(
    session: VoiceSession,
    output: VoiceOutput,
    ticket: string,
    outcome: DeliveryOutcome,
    eventId?: string,
  ): Promise<void>;
  ended(session: VoiceSession, reason: string): Promise<void>;
}

/** One authenticated call leg. Audio is raw 8 kHz, mono G.711 mu-law. A
 * playback mark is a transport observation, never participant agreement. */
export interface VoiceTransport {
  audio(bytes: Uint8Array): Promise<void>;
  mark(id: string): Promise<void>;
  clear(): Promise<void>;
  close(): void;
}

export interface TranscriptionSession {
  append(audio: Uint8Array): void;
  close(): void;
}
export interface VoiceSpeech {
  readonly destination: string;
  transcribe(callbacks: {
    speechStarted(): void;
    completed(eventId: string, text: string): void;
    failed(error: unknown): void;
  }): Promise<TranscriptionSession>;
  synthesize(text: string, signal: AbortSignal): AsyncIterable<Uint8Array>;
}
