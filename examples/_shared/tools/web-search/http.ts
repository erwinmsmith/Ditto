/** Application transport: pinned public DNS, explicit origins, bounded bodies and retries. */
import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import { BlockList, isIP } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { canonical } from "./domain.ts";
export class SourceError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = "SourceError";
    this.code = code;
  }
}
const blocked = new BlockList();
for (const [network, bits] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 3],
] as const)
  blocked.addSubnet(network, bits, "ipv4");
for (const [network, bits] of [
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
] as const)
  blocked.addSubnet(network, bits, "ipv6");
export function publicAddress(address: string): boolean {
  if (isIP(address) === 4) return !blocked.check(address, "ipv4");
  return (
    isIP(address) === 6 &&
    /^[23]/i.test(address) &&
    !blocked.check(address, "ipv6")
  );
}
export interface TransportOptions {
  allowLoopbackTest?: boolean;
  trustBenchmarkProxy?: boolean;
  onRequest?: (url: string, status: number) => void;
}
export function permitted(
  value: string,
  origins: readonly string[],
  allowLoopbackTest = false,
): URL {
  const u = new URL(canonical(value));
  const localTest =
    allowLoopbackTest &&
    u.protocol === "http:" &&
    ["127.0.0.1", "localhost"].includes(u.hostname);
  if (
    !origins.includes(u.origin) ||
    (!localTest && u.protocol !== "https:") ||
    (!localTest && isIP(u.hostname.replace(/^\[|\]$/g, "")))
  )
    throw new SourceError("URL_POLICY_DENIED");
  return u;
}
export function retryDelay(
  value: string | undefined,
  now = Date.now(),
): number {
  if (!value) return 1000;
  const milliseconds = /^\d+$/.test(value)
    ? Number(value) * 1000
    : Date.parse(value) - now;
  if (!Number.isFinite(milliseconds) || milliseconds > 60000)
    throw new SourceError("RETRY_AFTER_EXCEEDS_BUDGET");
  return Math.max(0, milliseconds);
}
async function once(url: URL, options: TransportOptions, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const deadline = AbortSignal.timeout(20000),
    combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const localTest =
    options.allowLoopbackTest &&
    url.protocol === "http:" &&
    ["127.0.0.1", "localhost"].includes(url.hostname);
  let stopLookup!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    stopLookup = () => reject(combined.reason);
    combined.addEventListener("abort", stopLookup, { once: true });
  });
  const addresses = await Promise.race([
    lookup(url.hostname, { all: true }),
    aborted,
  ]).finally(() => combined.removeEventListener("abort", stopLookup));
  combined.throwIfAborted();
  if (
    !addresses.length ||
    (!localTest &&
      addresses.some(
        (a) =>
          !publicAddress(a.address) &&
          !(options.trustBenchmarkProxy && /^198\.(18|19)\./.test(a.address)),
      ))
  )
    throw new SourceError("PRIVATE_ADDRESS_DENIED");
  const address = addresses[0]!;
  return new Promise<{
    status: number;
    headers: import("node:http").IncomingHttpHeaders;
    body: string;
  }>((resolve, reject) => {
    const req = (localTest ? httpRequest : httpsRequest)(
      url,
      {
        agent: false,
        signal: combined,
        family: address.family,
        lookup: (_hostname, _options, callback) =>
          callback(null, address.address, address.family),
        headers: {
          "user-agent": "DittoWebQA/1.0 (bounded research example)",
          accept: "text/html,application/json",
          "accept-encoding": "identity",
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 1024 * 1024)
            response.destroy(new SourceError("BODY_LIMIT"));
          else chunks.push(chunk);
        });
        response.once("error", reject);
        response.once("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.once("error", reject);
    req.end();
  });
}
export async function download(
  value: string,
  origins: readonly string[],
  kind: "html" | "json",
  options: TransportOptions = {},
  signal?: AbortSignal,
) {
  let url = permitted(value, origins, options.allowLoopbackTest),
    redirects = 0,
    attempts = 0;
  for (;;) {
    signal?.throwIfAborted();
    const response = await once(url, options, signal);
    options.onRequest?.(url.href, response.status);
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (++redirects > 3 || !response.headers.location)
        throw new SourceError("REDIRECT_LIMIT");
      url = permitted(
        new URL(response.headers.location, url).href,
        origins,
        options.allowLoopbackTest,
      );
      continue;
    }
    if ([429, 502, 503, 504].includes(response.status) && attempts++ < 2) {
      await delay(
        retryDelay(response.headers["retry-after"]),
        undefined,
        signal ? { signal } : {},
      );
      continue;
    }
    if (response.status < 200 || response.status >= 300)
      throw new SourceError(`HTTP_${response.status}`);
    if (
      !response.headers["content-type"]?.includes(
        kind === "html" ? "text/html" : "application/json",
      )
    )
      throw new SourceError("CONTENT_TYPE_DENIED");
    signal?.throwIfAborted();
    return { url: url.href, body: response.body };
  }
}

export function transportConfig(): TransportOptions {
  return process.env.DITTO_EXAMPLE_WEB_TRUST_BENCHMARK_PROXY === "1"
    ? { trustBenchmarkProxy: true }
    : {};
}
