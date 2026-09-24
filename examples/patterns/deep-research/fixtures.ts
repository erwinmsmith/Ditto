import { randomUUID } from "node:crypto";
import type { Request } from "../../_shared/tools/research/domain.ts";
/** Public-web demo request; callers provide authenticated tenant/principal in their application. */
export function defaultRequest(change: Partial<Request> = {}): Request {
  return {
    id: randomUUID(),
    tenant: "demo",
    principal: "reader",
    question:
      "Research SQLite deployment architecture and its write-concurrency limitations. Explain the implications for a small application team.",
    allowedOrigins: [
      "https://en.wikipedia.org",
      "https://www.sqlite.org",
      "https://sqlite.org",
    ],
    referenceUrls: [
      "https://www.sqlite.org/serverless.html",
      "https://www.sqlite.org/whentouse.html",
    ],
    maxQueries: 2,
    maxPages: 4,
    researchType: "industry",
    audience: "Application architects",
    scope:
      "Documented SQLite behavior; no performance benchmarks or vendor recommendations.",
    maxRounds: 3,
    maxSearches: 6,
    maxReadPages: 10,
    maxModelCalls: 12,
    researchSeconds: 600,
    crossCheck: false,
    allowPartial: false,
    ...change,
  };
}
