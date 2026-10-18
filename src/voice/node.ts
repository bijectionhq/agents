import { createServer, type IncomingMessage } from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { VoiceCall } from "./runtime.js";
import {
  carrierEvent,
  incomingCall,
  isTwilioRequest,
  streamResponse,
} from "./twilio.js";
import type { VoiceBackend, VoiceSpeech, VoiceTransport } from "./contracts.js";

export type VoiceServerOptions = {
  publicOrigin: string;
  accountId: string;
  authToken: string;
  numbers: readonly string[];
  backend: VoiceBackend;
  speech: VoiceSpeech;
  maxCalls?: number;
  /** Redact at the application boundary; raw provider messages are never logged. */
  report(error: unknown): void;
};

/** The server owns its listeners, sockets and timers. The operator supplies
 * TLS and explicitly configures these webhook URLs on the carrier number. */
export function createVoiceServer(options: VoiceServerOptions) {
  const origin = new URL(options.publicOrigin);
  if (
    origin.protocol !== "https:" ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash ||
    origin.username ||
    origin.password ||
    !/^AC[0-9a-fA-F]{32}$/.test(options.accountId) ||
    !options.authToken ||
    !options.numbers.length ||
    options.numbers.some((number) => !/^\+[1-9][0-9]{5,14}$/.test(number))
  )
    throw new Error(
      "Configure the public HTTPS origin and carrier account and numbers",
    );
  const maxCalls = options.maxCalls ?? 32;
  if (!Number.isSafeInteger(maxCalls) || maxCalls < 1 || maxCalls > 1000)
    throw new Error("Invalid voice capacity");
  const numbers = new Set(options.numbers);
  const mediaUrl = new URL("/voice/media/", origin);
  mediaUrl.protocol = "wss:";
  const sockets = new WebSocketServer({
    noServer: true,
    maxPayload: 16 * 1024,
    perMessageDeflate: false,
  });
  const calls = new Map<string, { call: VoiceCall; socket: WebSocket }>();

  const server = createServer(async (request, response) => {
    try {
      if (
        request.method !== "POST" ||
        !["/voice/incoming", "/voice/status"].includes(request.url ?? "")
      ) {
        response.writeHead(404).end();
        return;
      }
      if (
        !request.headers["content-type"]?.startsWith(
          "application/x-www-form-urlencoded",
        )
      ) {
        response.writeHead(415).end();
        return;
      }
      const parameters = await formBody(request);
      const url = new URL(request.url!, origin).href;
      const signature = request.headers["x-twilio-signature"];
      if (
        typeof signature !== "string" ||
        !isTwilioRequest(options.authToken, url, parameters, signature)
      ) {
        response.writeHead(403).end();
        return;
      }
      const call = incomingCall(parameters, options.accountId, numbers);
      if (request.url === "/voice/status") {
        const state = parameters.get("CallStatus") ?? "";
        if (
          ![
            "queued",
            "initiated",
            "ringing",
            "in-progress",
            "completed",
            "busy",
            "failed",
            "no-answer",
            "canceled",
          ].includes(state)
        )
          throw new Error("Unknown call status");
        await options.backend.status(call.accountId, call.callId, state);
        if (
          ["completed", "busy", "failed", "no-answer", "canceled"].includes(
            state,
          )
        )
          await calls.get(call.callId)?.call.end(state);
        response.writeHead(204).end();
        return;
      }
      if (calls.size >= maxCalls) {
        response.writeHead(503).end();
        return;
      }
      const admitted = await options.backend.accept(call);
      response
        .writeHead(200, {
          "Content-Type": "text/xml; charset=utf-8",
          "Cache-Control": "no-store",
        })
        .end(streamResponse(mediaUrl.href, call, admitted.binding));
    } catch (error) {
      options.report(error);
      if (!response.headersSent) response.writeHead(400);
      response.end();
    }
  });

  server.on("upgrade", (request, socket, head) => {
    const signature = request.headers["x-twilio-signature"];
    if (
      request.url !== "/voice/media/" ||
      calls.size >= maxCalls ||
      sockets.clients.size >= maxCalls ||
      typeof signature !== "string" ||
      !isTwilioRequest(
        options.authToken,
        mediaUrl.href,
        new URLSearchParams(),
        signature,
      )
    ) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    sockets.handleUpgrade(request, socket, head, (client) =>
      sockets.emit("connection", client),
    );
  });

  sockets.on("connection", (socket) => {
    const connectionId = randomUUID();
    let call: VoiceCall | undefined;
    let callId: string | undefined;
    let streamId: string | undefined;
    let sequence = 0n;
    let isConnected = false;
    let queuedBytes = 0;
    let work = Promise.resolve();
    let isAlive = true;
    const timeout = setTimeout(() => socket.terminate(), 15_000);
    const heartbeat = setInterval(() => {
      if (!isAlive) socket.terminate();
      else {
        isAlive = false;
        socket.ping();
      }
    }, 30_000);
    heartbeat.unref();
    socket.on("pong", () => {
      isAlive = true;
    });
    const send = async (value: unknown) => {
      if (
        socket.readyState !== WebSocket.OPEN ||
        socket.bufferedAmount > 64 * 1024
      )
        throw new Error("Carrier socket is unavailable");
      await new Promise<void>((resolve, reject) =>
        socket.send(JSON.stringify(value), (error) =>
          error ? reject(error) : resolve(),
        ),
      );
    };
    const transport: VoiceTransport = {
      audio: (bytes) =>
        send({
          event: "media",
          streamSid: streamId,
          media: { payload: Buffer.from(bytes).toString("base64") },
        }),
      mark: (id) =>
        send({ event: "mark", streamSid: streamId, mark: { name: id } }),
      clear: () => send({ event: "clear", streamSid: streamId }),
      close: () => socket.close(),
    };
    socket.on("message", (bytes, isBinary) => {
      const message = Buffer.isBuffer(bytes)
        ? bytes
        : Array.isArray(bytes)
          ? Buffer.concat(bytes)
          : Buffer.from(bytes);
      queuedBytes += message.length;
      if (isBinary || queuedBytes > 64 * 1024) {
        socket.terminate();
        return;
      }
      work = work
        .then(async () => {
          queuedBytes -= message.length;
          const event = carrierEvent(
            message.toString(),
            options.accountId,
            numbers,
          );
          if (event.event === "connected") {
            if (isConnected) throw new Error("Carrier connection replayed");
            isConnected = true;
            return;
          }
          if (!isConnected || event.sequence <= sequence)
            throw new Error("Carrier sequence replayed");
          sequence = event.sequence;
          if (event.event === "start") {
            if (call || calls.has(event.call.callId) || calls.size >= maxCalls)
              throw new Error("Call stream already attached");
            const session = await options.backend.attach(
              event.call,
              event.streamId,
              event.binding,
              connectionId,
            );
            if (socket.readyState !== WebSocket.OPEN) {
              await options.backend.ended(session, "setup_disconnected");
              return;
            }
            streamId = event.streamId;
            callId = event.call.callId;
            call = new VoiceCall(
              session,
              options.backend,
              options.speech,
              transport,
              options.report,
            );
            calls.set(callId, { call, socket });
            await call.start();
            clearTimeout(timeout);
            return;
          }
          if (!call || event.streamId !== streamId)
            throw new Error("Carrier event belongs to another stream");
          const eventId = `${callId}:${streamId}:${event.sequence}`;
          switch (event.event) {
            case "media":
              call.audio(event.audio);
              break;
            case "mark":
              call.mark(event.name, eventId);
              break;
            case "dtmf":
              call.digit(eventId, event.digit);
              break;
            case "stop":
              await call.end("carrier_stopped");
              break;
          }
        })
        .catch((error) => {
          options.report(error);
          socket.terminate();
        });
    });
    socket.on("error", (error) => {
      options.report(error);
      socket.terminate();
    });
    socket.on("close", () => {
      clearTimeout(timeout);
      clearInterval(heartbeat);
      if (callId) calls.delete(callId);
      void call?.end("socket_closed").catch(options.report);
    });
  });

  return {
    server,
    urls: {
      incoming: new URL("/voice/incoming", origin).href,
      status: new URL("/voice/status", origin).href,
      media: mediaUrl.href,
    },
    async close(): Promise<void> {
      await Promise.allSettled(
        [...calls.values()].map(({ call }) => call.end("shutdown")),
      );
      for (const socket of sockets.clients) socket.terminate();
      await new Promise<void>((resolve) => sockets.close(() => resolve()));
      if (server.listening)
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
    },
  };
}

async function formBody(request: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > 16 * 1024) throw new Error("Carrier webhook exceeds bounds");
    chunks.push(bytes);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}
