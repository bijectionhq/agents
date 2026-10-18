// @vitest-environment node
import { expect, test } from "vitest";
import { VoiceCall } from "./runtime.js";
import {
  decodeMuLaw,
  encodeMuLaw,
  MuLawFromPcm24,
  pcm24FromMuLaw,
  VoiceActivity,
} from "./audio.js";
import type {
  DeliveryOutcome,
  OutputStatus,
  VoiceBackend,
  VoiceOutput,
  VoiceSpeech,
  VoiceTransport,
  VoicePresentation,
} from "./contracts.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function line(
  options: {
    isCurrent?: boolean;
    isReplay?: boolean;
    claimGate?: Promise<void>;
    inputGate?: Promise<void>;
    settlementGate?: Promise<void>;
    closeGate?: Promise<void>;
  } = {},
) {
  const session = {
    conversationId: "call",
    interactionId: "interaction",
    expiresAt: Date.now() + 60_000,
  };
  const output: VoiceOutput = {
    id: "proposal",
    source: { kind: "proposal", agreementId: "proposal" },
  };
  const settled = deferred<DeliveryOutcome>();
  const frames = [deferred<string>(), deferred<string>()];
  const marks: string[] = [];
  const observations: string[] = [];
  const errors: unknown[] = [];
  const digits: { digit: string; presentation?: VoicePresentation }[] = [];
  let authorization!: (status: OutputStatus) => void;
  let outputReady!: (output: VoiceOutput | null) => void;
  let call!: VoiceCall;
  let frame = 0;
  let syntheses = 0;
  const backend: VoiceBackend = {
    accept: async () => ({ ...session, binding: "b".repeat(32) }),
    attach: async () => session,
    status: async () => {},
    transcript: async () => {},
    digit: async (_session, _event, digit, presentation) => {
      if (digit === "9") await options.inputGate;
      digits.push({ digit, presentation });
    },
    watchOutput: (_session, callback) => {
      outputReady = callback;
      return () => {};
    },
    claim: async () => {
      observations.push("claimed");
      await options.claimGate;
      return {
        ticket: "ticket",
        state: "dispatching",
        result: options.isReplay ? null : "Exact proposal",
        expiresAt: Date.now() + 60_000,
        isInvalidated: false,
      };
    },
    watchClaim: (_session, _output, _ticket, callback) => {
      authorization = callback;
      callback({
        isCurrent: options.isCurrent !== false,
        expiresAt: Date.now() + 60_000,
      });
      return () => {};
    },
    settle: async (_session, _output, _ticket, outcome) => {
      observations.push(outcome);
      settled.resolve(outcome);
      await options.settlementGate;
    },
    ended: async () => {
      observations.push("closed");
      await options.closeGate;
    },
  };
  const speech: VoiceSpeech = {
    destination: "https://speech.example/synthesize",
    transcribe: async () => ({ append: () => {}, close: () => {} }),
    async *synthesize() {
      syntheses++;
      yield new Uint8Array(1600);
    },
  };
  const transport: VoiceTransport = {
    audio: async () => {
      observations.push("audio");
    },
    mark: async (id) => {
      marks.push(id);
      frames[frame++]!.resolve(id);
    },
    clear: async () => {
      observations.push("clear");
      for (const id of marks.splice(0)) call.mark(id, "cleared");
    },
    close: () => {
      observations.push("socket_closed");
    },
  };
  call = new VoiceCall(session, backend, speech, transport, (error) => {
    errors.push(error);
  });
  return {
    call,
    output,
    settled,
    frames,
    observations,
    errors,
    digits,
    ready: () => outputReady(output),
    withdraw: () => outputReady(null),
    synthesisCount: () => syntheses,
    ack: (id: string) => {
      marks.splice(marks.indexOf(id), 1);
      call.mark(id, `played-${id}`);
    },
    revoke: () => authorization({ isCurrent: false, expiresAt: Date.now() }),
  };
}

test("voice waits for native admission and each playback acknowledgement", async () => {
  const lineState = line();
  await lineState.call.start();
  lineState.ready();
  const first = await lineState.frames[0]!.promise;
  expect(lineState.observations).toEqual(["claimed", "audio"]);
  lineState.ack(first);
  const second = await lineState.frames[1]!.promise;
  expect(
    lineState.observations.filter((event) => event === "audio"),
  ).toHaveLength(2);
  lineState.ack(second);
  expect(await lineState.settled.promise).toBe("delivered");
  await lineState.call.end();
  expect(lineState.errors).toEqual([]);
});

test("voice clear echoes cannot establish proposal presentation", async () => {
  const lineState = line();
  await lineState.call.start();
  lineState.ready();
  lineState.ack(await lineState.frames[0]!.promise);
  await lineState.frames[1]!.promise;
  await lineState.call.interrupt();
  expect(await lineState.settled.promise).toBe("interrupted");
  expect(lineState.observations).not.toContain("delivered");
  await lineState.call.end();
});

test("voice withdraws an obsolete output even when its native claim is in flight", async () => {
  const gate = deferred<void>();
  const lineState = line({ claimGate: gate.promise });
  await lineState.call.start();
  lineState.ready();
  await new Promise<void>((resolve) => setImmediate(resolve));
  lineState.withdraw();
  gate.resolve();
  expect(await lineState.settled.promise).toBe("notDelivered");
  expect(lineState.synthesisCount()).toBe(0);
  await lineState.call.end();
});

test("voice cannot turn a keypad event queued before full playback into consent", async () => {
  const gate = deferred<void>();
  const lineState = line({ inputGate: gate.promise });
  await lineState.call.start();
  lineState.call.digit("holding-input", "9");
  lineState.ready();
  const first = await lineState.frames[0]!.promise;
  lineState.call.digit("premature-accept", "1");
  lineState.ack(first);
  lineState.ack(await lineState.frames[1]!.promise);
  await lineState.settled.promise;
  gate.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(
    lineState.digits.find((event) => event.digit === "1")?.presentation,
  ).toBeUndefined();
  expect(lineState.digits).toHaveLength(2);
  await lineState.call.end();
});

test("voice keys after full playback wait for the native receipt and retain the exact proposal", async () => {
  const gate = deferred<void>();
  const lineState = line({ settlementGate: gate.promise });
  await lineState.call.start();
  lineState.ready();
  lineState.ack(await lineState.frames[0]!.promise);
  lineState.ack(await lineState.frames[1]!.promise);
  await lineState.settled.promise;
  lineState.call.digit("after-playback", "1");
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(lineState.digits).toEqual([]);
  gate.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(lineState.digits).toEqual([
    {
      digit: "1",
      presentation: { agreementId: "proposal", ticket: "ticket" },
    },
  ]);
  await lineState.call.end();
});

test("voice authorization revocation clears already queued audio", async () => {
  const lineState = line();
  await lineState.call.start();
  lineState.ready();
  await lineState.frames[0]!.promise;
  lineState.revoke();
  expect(await lineState.settled.promise).toBe("interrupted");
  expect(lineState.observations).toContain("clear");
  await lineState.call.end();
});

test("voice refuses synthesis after admission expires or is revoked", async () => {
  const lineState = line({ isCurrent: false });
  await lineState.call.start();
  lineState.ready();
  expect(await lineState.settled.promise).toBe("notDelivered");
  expect(lineState.synthesisCount()).toBe(0);
  await lineState.call.end();
});

test("voice disconnect preserves uncertain playback instead of retrying", async () => {
  const lineState = line();
  await lineState.call.start();
  lineState.ready();
  await lineState.frames[0]!.promise;
  await lineState.call.end("socket_lost");
  expect(await lineState.settled.promise).toBe("unknown");
  expect(lineState.observations.indexOf("closed")).toBeLessThan(
    lineState.observations.indexOf("unknown"),
  );
});

test("voice never resends an unresolved first-claim payload", async () => {
  const lineState = line({ isReplay: true });
  await lineState.call.start();
  lineState.ready();
  // Flush the finite promise chain, without advancing transport timeouts.
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(lineState.synthesisCount()).toBe(0);
  expect(lineState.observations).toContain("closed");
  await lineState.call.end();
});

test("voice closes the physical call before waiting for the native closure acknowledgement", async () => {
  const gate = deferred<void>();
  const lineState = line({ closeGate: gate.promise });
  await lineState.call.start();
  const ending = lineState.call.end();
  expect(lineState.observations).toContain("socket_closed");
  gate.resolve();
  await ending;
});

test("voice PCM conversion preserves carrier vectors across chunk boundaries", () => {
  expect([
    decodeMuLaw(255),
    decodeMuLaw(127),
    decodeMuLaw(0),
    decodeMuLaw(128),
  ]).toEqual([0, 0, -32124, 32124]);
  expect([encodeMuLaw(0), encodeMuLaw(-32124), encodeMuLaw(32124)]).toEqual([
    255, 0, 128,
  ]);
  const audio = new Uint8Array([0, 128, 255, 42, 160]);
  const pcm = pcm24FromMuLaw(audio);
  const converter = new MuLawFromPcm24();
  const result = [
    converter.append(pcm.slice(0, 5)),
    converter.append(pcm.slice(5, 17)),
    converter.append(pcm.slice(17)),
    converter.finish(),
  ];
  expect(new Uint8Array(result.flatMap((chunk) => [...chunk]))).toEqual(audio);
  const partial = new MuLawFromPcm24();
  partial.append(new Uint8Array([1]));
  expect(() => partial.finish()).toThrow("between samples");
});

test("voice endpoint detection bounds silence and preserves the start of speech", () => {
  const vad = new VoiceActivity();
  for (let i = 0; i < 100; i++)
    expect(vad.append(new Uint8Array(160).fill(255)).audio).toEqual([]);
  const voiced = new Uint8Array(160).fill(128);
  expect(vad.append(voiced).isStarted).toBe(false);
  expect(vad.append(voiced).isStarted).toBe(false);
  const start = vad.append(voiced);
  expect(start.isStarted).toBe(true);
  expect(start.audio).toHaveLength(10);
  for (let i = 0; i < 29; i++)
    expect(vad.append(new Uint8Array(160).fill(255)).isEnded).toBe(false);
  expect(vad.append(new Uint8Array(160).fill(255)).isEnded).toBe(true);
});
