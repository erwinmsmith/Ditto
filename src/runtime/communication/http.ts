import { createHash, timingSafeEqual } from "node:crypto";
import type { RequestListener } from "node:http";
import type { DittoRuntime } from "../runtime.js";
import type { InvocationEnvelope, InvocationResult, InvokeTransport } from "./transport.js";

export interface HttpTransportOptions {
  readonly id: string;
  /** Full endpoint, e.g. https://worker.internal/ditto/invoke. */
  readonly url: string;
  readonly token: string;
  readonly timeoutMs?: number;
  readonly maxBodyBytes?: number;
}
const limit = 1024 * 1024;
function checkOptions(token: string, bytes: number): void {
  if (!token.trim()) throw new Error("A Worker transport token is required");
  if (!Number.isSafeInteger(bytes) || bytes < 1) throw new Error("maxBodyBytes must be a positive integer");
}
export function createHttpTransport(options: HttpTransportOptions): InvokeTransport {
  const maxBodyBytes = options.maxBodyBytes ?? limit;
  checkOptions(options.token, maxBodyBytes);
  const url = new URL(options.url);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Invalid Worker URL");
  return {
    id: options.id,
    async invoke(envelope, invocationOptions): Promise<InvocationResult> {
      const body = JSON.stringify(envelope);
      if (Buffer.byteLength(body) > maxBodyBytes) throw new Error("Worker request is too large");
      const response = await fetch(url, {
        method: "POST", redirect: "error", signal: AbortSignal.any([AbortSignal.timeout(options.timeoutMs ?? 30_000),
          ...(invocationOptions?.signal ? [invocationOptions.signal] : [])]),
        headers: { authorization: `Bearer ${options.token}`, "content-type": "application/json", "x-ditto-protocol": "1" }, body,
      });
      if (!response.ok) { await response.body?.cancel(); throw new Error(`Worker request failed (HTTP ${response.status})`); }
      if (response.headers.get("x-ditto-protocol") !== "1" || !response.body) {
        await response.body?.cancel(); throw new Error("Invalid Worker protocol response");
      }
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      for await (const chunk of response.body) {
        bytes += chunk.byteLength;
        if (bytes > maxBodyBytes) throw new Error("Worker response is too large");
        chunks.push(chunk);
      }
      const result: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!record(result) || result.invocationId !== envelope.id || !payload(result.payload)) throw new Error("Invalid Worker result");
      return result as unknown as InvocationResult;
    },
  };
}

/** Mount on a Node HTTP(S) server. Token authorizes all locally registered capabilities. */
export function createWorkerHttpHandler(runtime: DittoRuntime, options: { token: string; maxBodyBytes?: number }): RequestListener {
  const maxBodyBytes = options.maxBodyBytes ?? limit;
  checkOptions(options.token, maxBodyBytes);
  const expected = createHash("sha256").update(`Bearer ${options.token}`).digest();
  return (request, response) => {
    const send = (status: number, value: unknown): void => {
      if (response.destroyed) return;
      response.writeHead(status, { "content-type": "application/json", "x-ditto-protocol": "1" });
      response.end(JSON.stringify(value));
    };
    void (async () => {
      if (request.url !== "/ditto/invoke" || request.method !== "POST") { send(404, { error: "Not found" }); return; }
      const actual = createHash("sha256").update(request.headers.authorization ?? "").digest();
      if (!timingSafeEqual(actual, expected)) { send(401, { error: "Unauthorized" }); return; }
      if (request.headers["x-ditto-protocol"] !== "1") { send(400, { error: "Unsupported protocol" }); return; }
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of request) {
        const buffer = Buffer.from(chunk as Uint8Array);
        bytes += buffer.length;
        if (bytes > maxBodyBytes) { send(413, { error: "Request too large" }); return; }
        chunks.push(buffer);
      }
      let value: unknown;
      try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
      catch { send(400, { error: "Invalid JSON" }); return; }
      if (!envelope(value)) { send(400, { error: "Invalid invocation" }); return; }
      try {
        const result = await runtime.receive(value);
        if (Buffer.byteLength(JSON.stringify(result)) > maxBodyBytes) { send(413, { error: "Response too large" }); return; }
        send(200, result);
      } catch { send(500, { error: "Worker invocation failed" }); }
    })().catch(() => send(400, { error: "Invalid request" }));
  };
}
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function address(value: unknown): boolean {
  return record(value) && ["workerId", "workerType", "hostId", "processId"].every((key) => typeof value[key] === "string" && value[key] !== "");
}
function payload(value: unknown): boolean {
  return record(value) && (value.kind === "inline" && Object.hasOwn(value, "value")
    || value.kind === "reference" && record(value.reference) && typeof value.reference.uri === "string");
}
function envelope(value: unknown): value is InvocationEnvelope {
  return record(value) && typeof value.id === "string" && value.id !== "" && typeof value.node === "string"
    && /^[^.]+\..+$/.test(value.node) && address(value.target) && payload(value.payload)
    && (value.source === undefined || address(value.source))
    && (value.execution === undefined || record(value.execution)
      && ["graphId", "runId", "nodeId"].every((key) => typeof (value.execution as Record<string, unknown>)[key] === "string"));
}
