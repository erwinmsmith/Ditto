import { randomUUID } from "node:crypto";
import type { Request } from "../../_shared/tools/web-search/domain.ts";
/** Public-web demo request; callers provide authenticated tenant/principal in their application. */
export function defaultRequest(change: Partial<Request> = {}): Request {
  return {
    id: randomUUID(),
    tenant: "demo",
    principal: "reader",
    question: "What is SQLite, and does it require a separate server process?",
    allowedOrigins: [
      "https://en.wikipedia.org",
      "https://www.sqlite.org",
      "https://sqlite.org",
    ],
    referenceUrls: ["https://www.sqlite.org/serverless.html"],
    maxQueries: 1,
    maxPages: 3,
    crossCheck: false,
    allowPartial: false,
    ...change,
  };
}
