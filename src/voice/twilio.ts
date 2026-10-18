import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingCall } from "./contracts.js";

/** Validate against the configured public URL, never forwarded Host headers.
 * Twilio's signed POST encoding has one value per parameter here. */
export function isTwilioRequest(
  authToken: string,
  url: string,
  parameters: URLSearchParams,
  signature: string | undefined,
): boolean {
  if (!signature || !/^[A-Za-z0-9+/]{27}=$/.test(signature)) return false;
  const keys = [...parameters.keys()];
  if (keys.length !== new Set(keys).size) return false;
  let signed = url;
  for (const key of keys.sort()) signed += key + parameters.get(key)!;
  const expected = createHmac("sha1", authToken).update(signed).digest();
  const received = Buffer.from(signature, "base64");
  return (
    received.length === expected.length && timingSafeEqual(received, expected)
  );
}

export function incomingCall(
  parameters: URLSearchParams,
  accountId: string,
  numbers: ReadonlySet<string>,
): IncomingCall {
  const callId = parameters.get("CallSid") ?? "";
  const from = parameters.get("From") ?? "";
  const to = parameters.get("To") ?? "";
  if (
    parameters.get("AccountSid") !== accountId ||
    !/^CA[0-9a-fA-F]{32}$/.test(callId) ||
    from.length > 128 ||
    !from ||
    !numbers.has(to)
  )
    throw new Error("Call admission refused");
  return { provider: "twilio", accountId, callId, from, to };
}

const xml = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (value) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&apos;",
      })[value]!,
  );

export function streamResponse(
  streamUrl: string,
  call: IncomingCall,
  binding: string,
): string {
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(binding))
    throw new Error("Call binding is invalid");
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Connect><Stream url="${xml(streamUrl)}"><Parameter name="binding" value="${xml(binding)}"/><Parameter name="from" value="${xml(call.from)}"/><Parameter name="to" value="${xml(call.to)}"/></Stream></Connect></Response>`;
}

export type CarrierEvent =
  | { event: "connected" }
  | {
      event: "start";
      sequence: bigint;
      streamId: string;
      call: IncomingCall;
      binding: string;
    }
  | { event: "media"; sequence: bigint; streamId: string; audio: Uint8Array }
  | { event: "mark"; sequence: bigint; streamId: string; name: string }
  | { event: "dtmf"; sequence: bigint; streamId: string; digit: string }
  | { event: "stop"; sequence: bigint; streamId: string };

/** Decode only the bidirectional carrier protocol, with bounded frames. */
export function carrierEvent(
  raw: string,
  accountId: string,
  numbers: ReadonlySet<string>,
): CarrierEvent {
  if (raw.length > 16 * 1024) throw new Error("Carrier message exceeds bounds");
  let value: any;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("Invalid carrier JSON");
  }
  if (value.event === "connected") {
    if (value.protocol !== "Call" || value.version !== "1.0.0")
      throw new Error("Unsupported carrier protocol");
    return { event: "connected" };
  }
  if (
    typeof value.sequenceNumber !== "string" ||
    !/^[1-9][0-9]{0,19}$/.test(value.sequenceNumber) ||
    typeof value.streamSid !== "string" ||
    !/^MZ[0-9a-fA-F]{32}$/.test(value.streamSid)
  )
    throw new Error("Invalid carrier sequence");
  const sequence = BigInt(value.sequenceNumber);
  const streamId = value.streamSid as string;
  switch (value.event) {
    case "start": {
      const start = value.start;
      if (
        !start ||
        start.streamSid !== streamId ||
        start.mediaFormat?.encoding !== "audio/x-mulaw" ||
        start.mediaFormat?.sampleRate !== 8000 ||
        start.mediaFormat?.channels !== 1 ||
        !Array.isArray(start.tracks) ||
        !start.tracks.includes("inbound")
      )
        throw new Error("Unsupported carrier audio");
      const params = new URLSearchParams({
        AccountSid: start.accountSid,
        CallSid: start.callSid,
        From: start.customParameters?.from ?? "",
        To: start.customParameters?.to ?? "",
      });
      const call = incomingCall(params, accountId, numbers);
      const binding = start.customParameters?.binding;
      if (
        typeof binding !== "string" ||
        !/^[A-Za-z0-9_-]{32,128}$/.test(binding)
      )
        throw new Error("Missing call binding");
      return { event: "start", sequence, streamId, call, binding };
    }
    case "media": {
      const payload = value.media?.payload;
      if (
        value.media?.track !== "inbound" ||
        typeof payload !== "string" ||
        !payload.length ||
        payload.length > 10_668 ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
          payload,
        )
      )
        throw new Error("Invalid carrier audio");
      return {
        event: "media",
        sequence,
        streamId,
        audio: Buffer.from(payload, "base64"),
      };
    }
    case "mark":
      if (typeof value.mark?.name !== "string" || value.mark.name.length > 128)
        throw new Error("Invalid playback mark");
      return { event: "mark", sequence, streamId, name: value.mark.name };
    case "dtmf":
      if (
        value.dtmf?.track !== "inbound_track" ||
        !/^[0-9*#]$/.test(value.dtmf?.digit ?? "")
      )
        throw new Error("Invalid keypad event");
      return { event: "dtmf", sequence, streamId, digit: value.dtmf.digit };
    case "stop":
      return { event: "stop", sequence, streamId };
    default:
      throw new Error("Unsupported carrier event");
  }
}
