// @vitest-environment node
import { createHmac } from "node:crypto";
import { once } from "node:events";
import WebSocket from "ws";
import { expect, test } from "vitest";
import { createVoiceServer } from "./node.js";
import { carrierEvent, isTwilioRequest, streamResponse } from "./twilio.js";
import type {
  DeliveryOutcome,
  VoiceBackend,
  VoiceOutput,
  VoiceSpeech,
} from "./contracts.js";

const account = `AC${"a".repeat(32)}`;
const callId = `CA${"b".repeat(32)}`;
const streamId = `MZ${"c".repeat(32)}`;
const origin = "https://voice.example";
const secret = "test-only-carrier-secret";
const number = "+33123456789";
const binding = "binding".repeat(8);
const sign = (url: string, parameters = new URLSearchParams()) =>
  createHmac("sha1", secret)
    .update(
      url +
        [...parameters.keys()]
          .sort()
          .map((key) => key + parameters.get(key))
          .join(""),
    )
    .digest("base64");

test("voice carrier signatures bind exact public URLs and every POST parameter", () => {
  const parameters = new URLSearchParams({
    AccountSid: account,
    CallSid: callId,
  });
  const signature = sign(`${origin}/voice/incoming`, parameters);
  expect(
    isTwilioRequest(secret, `${origin}/voice/incoming`, parameters, signature),
  ).toBe(true);
  expect(
    isTwilioRequest(secret, `${origin}/voice/status`, parameters, signature),
  ).toBe(false);
  parameters.set("CallSid", `CA${"d".repeat(32)}`);
  expect(
    isTwilioRequest(secret, `${origin}/voice/incoming`, parameters, signature),
  ).toBe(false);
  parameters.append("AccountSid", account);
  expect(
    isTwilioRequest(
      secret,
      `${origin}/voice/incoming`,
      parameters,
      sign(`${origin}/voice/incoming`, parameters),
    ),
  ).toBe(false);
});

test("voice carrier parsing errors omit the caller payload", () => {
  expect(() =>
    carrierEvent(
      '{"private":"customer-private-marker"',
      account,
      new Set([number]),
    ),
  ).toThrow(/^Invalid carrier JSON$/);
});

test("voice carrier start binds the account, call leg, media format and opaque token", () => {
  const start = {
    event: "start",
    sequenceNumber: "1",
    streamSid: streamId,
    start: {
      streamSid: streamId,
      accountSid: account,
      callSid: callId,
      tracks: ["inbound"],
      mediaFormat: { encoding: "audio/x-mulaw", sampleRate: 8000, channels: 1 },
      customParameters: { binding, from: "+33111111111", to: number },
    },
  };
  expect(
    carrierEvent(JSON.stringify(start), account, new Set([number])).event,
  ).toBe("start");
  start.start.accountSid = `AC${"d".repeat(32)}`;
  expect(() =>
    carrierEvent(JSON.stringify(start), account, new Set([number])),
  ).toThrow();
  const xml = streamResponse(
    "wss://voice.example/voice/media/",
    {
      provider: "twilio",
      accountId: account,
      callId,
      from: '<untrusted "caller">',
      to: number,
    },
    binding,
  );
  expect(xml).toContain("&lt;untrusted &quot;caller&quot;&gt;");
});

test("voice signed webhook and media socket deliver only native-claimed audio", async () => {
  let delivered!: (outcome: DeliveryOutcome) => void;
  const delivery = new Promise<DeliveryOutcome>((resolve) => {
    delivered = resolve;
  });
  const session = {
    conversationId: "call",
    interactionId: "interaction",
    expiresAt: Date.now() + 60_000,
  };
  const output: VoiceOutput = {
    id: "greeting",
    source: { kind: "prompt", name: "greeting" },
  };
  const observed: string[] = [];
  const backend: VoiceBackend = {
    accept: async () => ({ ...session, binding }),
    attach: async (call, stream, token) => {
      expect([call.accountId, call.callId, stream, token]).toEqual([
        account,
        callId,
        streamId,
        binding,
      ]);
      observed.push("attached");
      return session;
    },
    status: async () => {},
    transcript: async () => {},
    digit: async () => {},
    watchOutput: (_session, callback) => {
      callback(output);
      return () => {};
    },
    claim: async () => {
      observed.push("claimed");
      return {
        ticket: "native-ticket",
        state: "dispatching",
        result: "Welcome",
        expiresAt: Date.now() + 60_000,
        isInvalidated: false,
      };
    },
    watchClaim: (_session, _output, _ticket, callback) => {
      callback({ isCurrent: true, expiresAt: Date.now() + 60_000 });
      return () => {};
    },
    settle: async (_session, _output, _ticket, outcome) => {
      delivered(outcome);
    },
    ended: async () => {},
  };
  const speech: VoiceSpeech = {
    destination: "https://speech.example",
    transcribe: async () => ({ append: () => {}, close: () => {} }),
    async *synthesize() {
      observed.push("synthesized");
      yield new Uint8Array(800).fill(255);
    },
  };
  const errors: unknown[] = [];
  const gateway = createVoiceServer({
    publicOrigin: origin,
    accountId: account,
    authToken: secret,
    numbers: [number],
    backend,
    speech,
    report: (error) => {
      errors.push(error);
    },
  });
  gateway.server.listen(0, "127.0.0.1");
  await once(gateway.server, "listening");
  const address = gateway.server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing gateway listener");
  const local = `http://127.0.0.1:${address.port}`;
  let socket: WebSocket | undefined;
  try {
    const parameters = new URLSearchParams({
      AccountSid: account,
      CallSid: callId,
      From: "+33111111111",
      To: number,
    });
    const refused = await fetch(`${local}/voice/incoming`, {
      method: "POST",
      body: parameters,
    });
    expect(refused.status).toBe(403);
    const response = await fetch(`${local}/voice/incoming`, {
      method: "POST",
      body: parameters,
      headers: {
        "X-Twilio-Signature": sign(gateway.urls.incoming, parameters),
      },
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain(binding);
    socket = new WebSocket(`${local.replace("http:", "ws:")}/voice/media/`, {
      headers: { "X-Twilio-Signature": sign(gateway.urls.media) },
    });
    let sequence = 1;
    socket.on("message", (raw) => {
      const event = JSON.parse(raw.toString());
      if (event.event === "media") {
        expect(observed).toEqual(["attached", "claimed", "synthesized"]);
        expect(Buffer.from(event.media.payload, "base64")).toHaveLength(800);
      } else if (event.event === "mark") {
        socket!.send(
          JSON.stringify({
            event: "mark",
            streamSid: streamId,
            sequenceNumber: String(++sequence),
            mark: event.mark,
          }),
        );
      }
    });
    await once(socket, "open");
    socket.send(
      JSON.stringify({
        event: "connected",
        protocol: "Call",
        version: "1.0.0",
      }),
    );
    socket.send(
      JSON.stringify({
        event: "start",
        sequenceNumber: "1",
        streamSid: streamId,
        start: {
          streamSid: streamId,
          accountSid: account,
          callSid: callId,
          tracks: ["inbound"],
          mediaFormat: {
            encoding: "audio/x-mulaw",
            sampleRate: 8000,
            channels: 1,
          },
          customParameters: { binding, from: "+33111111111", to: number },
        },
      }),
    );
    expect(await delivery).toBe("delivered");
    expect(errors).toEqual([]);
  } finally {
    socket?.terminate();
    await gateway.close();
  }
});
