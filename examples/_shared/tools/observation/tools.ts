import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { mkdir, writeFile, readFile, link, rm, lstat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { RegisteredTool } from "@codesoul-co/ditto/worker/interaction";
import type { ExternalResult, JsonObject } from "@codesoul-co/ditto/contracts";
import {
  json,
  object,
  digest,
  stateFor,
  validateDecision,
  type Request,
} from "./domain.ts";
export class ResultTools {
  readonly db: DatabaseSync;
  readonly directory: string;
  readonly request: Request;
  constructor(directory: string, request: Request) {
    this.directory = directory;
    this.request = request;
    this.db = new DatabaseSync(join(directory, "tasks.sqlite"));
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS task(id TEXT PRIMARY KEY,state TEXT,version INTEGER); CREATE TABLE IF NOT EXISTS events(round INTEGER PRIMARY KEY,fingerprint TEXT,decision TEXT,state TEXT)",
    );
    this.db
      .prepare("INSERT OR IGNORE INTO task VALUES(?,'pending',0)")
      .run(request.id);
  }
  async remote(
    path: string,
    signal?: AbortSignal,
  ): Promise<Omit<ExternalResult, "callId" | "source">> {
    const r = this.request;
    signal?.throwIfAborted();
    try {
      const response = await fetch(
        `${r.origin}/${path}?id=${encodeURIComponent(r.orderId)}`,
        {
          method: path === "retry" ? "POST" : "GET",
          redirect: "error",
          headers: { "x-tenant": r.tenant, "idempotency-key": r.id + ":retry" },
          signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(150)])
            : AbortSignal.timeout(150),
        },
      );
      if (!response.ok) {
        await response.body?.cancel();
        const cancelled = response.status === 409;
        return {
          status: cancelled ? "cancelled" : "failed",
          error: {
            code: cancelled ? "REMOTE_CANCELLED" : `HTTP_${response.status}`,
            message: cancelled
              ? "Remote operator cancelled the task"
              : `Remote service returned HTTP ${response.status}`,
            retryable: response.status === 503,
          },
          metadata: { httpStatus: response.status },
        };
      }
      const chunks: Uint8Array[] = [];
      let size = 0;
      if (response.body) {
        const reader = response.body.getReader();
        try {
          for (;;) {
            const part = await reader.read();
            if (part.done) break;
            size += part.value.length;
            if (size > 16384) {
              await reader.cancel();
              throw new Error("Result exceeded limit");
            }
            chunks.push(part.value);
          }
        } finally {
          reader.releaseLock();
        }
      }
      const raw = Buffer.concat(chunks).toString("utf8");
      let structuredContent: unknown;
      if (response.headers.get("content-type")?.includes("application/json")) {
        try {
          structuredContent = JSON.parse(raw);
        } catch {
          /* Retain malformed raw output for interpretation. */
        }
      }
      return {
        status: "success",
        content: raw,
        ...(structuredContent === undefined
          ? {}
          : { structuredContent: json(structuredContent) }),
        references: [{ uri: `${r.origin}/${path}?id=${r.orderId}` }],
        metadata: {
          format: response.headers.get("content-type") ?? "text/plain",
        },
      };
    } catch (error) {
      if (signal?.aborted) throw error;
      if (error instanceof Error && error.name === "TimeoutError")
        return {
          status: "timeout",
          error: {
            code: "REQUEST_TIMEOUT",
            message: "Remote result deadline exceeded; effect is uncertain",
            retryable: false,
          },
        };
      if (error instanceof TypeError && error.message === "fetch failed")
        return {
          status: "unknown",
          error: {
            code: "CONNECTION_LOST",
            message: "Connection ended without a reliable result",
            retryable: false,
          },
        };
      throw error;
    }
  }
  get tools(): RegisteredTool[] {
    return [
      ...["read", "retry", "status"].map<RegisteredTool>((kind) => ({
        name: `result_${kind}`,
        inputSchema: {
          type: "object",
          properties: { round: { type: "integer" } },
          required: ["round"],
          additionalProperties: false,
        },
        effects: kind === "retry" ? ["network", "write"] : ["network", "read"],
        validate: (args) => {
          if (
            Object.keys(args).join() !== "round" ||
            args.round !== (kind === "read" ? 0 : 1)
          )
            throw new Error("Invalid operation round");
        },
        execute: async (_, context) => {
          context.services.sandbox.assert("network", this.request.origin);
          if (kind !== "read") {
            const state = this.db
              .prepare("SELECT state FROM task WHERE id=?")
              .get(this.request.id)!.state;
            if (state !== (kind === "retry" ? "waiting_retry" : "reconciling"))
              throw new Error("Follow-up action is not admitted by task state");
          }
          return this.remote(kind === "read" ? "result" : kind, context.signal);
        },
      })),
      {
        name: "result_commit",
        inputSchema: { type: "object" },
        validate: (args) => {
          if (Object.keys(args).sort().join() !== "decision,result,round")
            throw new Error("Invalid commit fields");
          object(args.result);
          object(args.decision);
        },
        effects: ["write"],
        execute: async (args, context) => {
          context.signal?.throwIfAborted();
          const round = args.round;
          if (round !== 0 && round !== 1)
            throw new Error("Invalid state round");
          const result = object(args.result) as unknown as ExternalResult;
          const decision = validateDecision(
              args.decision,
              result,
              this.request,
              round,
            ),
            fingerprint = digest({ decision, result }),
            state = stateFor(decision.nextAction);
          this.db.exec("BEGIN IMMEDIATE");
          try {
            const prior = this.db
              .prepare("SELECT fingerprint,state FROM events WHERE round=?")
              .get(round);
            if (prior) {
              if (prior.fingerprint !== fingerprint)
                throw new Error("Conflicting state update");
            } else {
              const task = this.db
                .prepare("SELECT state,version FROM task WHERE id=?")
                .get(this.request.id)!;
              if (
                task.version !== round ||
                (round === 0
                  ? task.state !== "pending"
                  : !["waiting_retry", "reconciling"].includes(
                      String(task.state),
                    ))
              )
                throw new Error("Stale task state");
              this.db
                .prepare("INSERT INTO events VALUES(?,?,?,?)")
                .run(round, fingerprint, JSON.stringify(decision), state);
              this.db
                .prepare("UPDATE task SET state=?,version=version+1 WHERE id=?")
                .run(state, this.request.id);
            }
            this.db.exec("COMMIT");
            return {
              status: "success",
              structuredContent: { state, version: round + 1 },
            };
          } catch (error) {
            this.db.exec("ROLLBACK");
            throw error;
          }
        },
      },
      {
        name: "result_publish",
        inputSchema: { type: "object" },
        validate: (args) => {
          if (Object.keys(args).join() !== "report")
            throw new Error("Invalid publication fields");
          object(args.report);
        },
        effects: ["write"],
        execute: async (args, context) => {
          context.signal?.throwIfAborted();
          const report = object(args.report),
            task = this.db
              .prepare("SELECT state,version FROM task WHERE id=?")
              .get(this.request.id)!;
          if (
            report.taskId !== this.request.id ||
            report.state !== task.state ||
            !["completed", "needs_review", "stopped"].includes(
              String(task.state),
            )
          )
            throw new Error("Report does not match terminal task state");
          const folder = join(this.directory, "artifacts");
          await mkdir(folder, { recursive: true });
          const path = join(folder, "result.json"),
            temp = path + "." + randomUUID() + ".tmp",
            content = JSON.stringify(report, null, 2) + "\n";
          try {
            await writeFile(temp, content, { flag: "wx" });
            try {
              await link(temp, path);
            } catch (error) {
              if (
                (error as NodeJS.ErrnoException).code !== "EEXIST" ||
                !(await lstat(path)).isFile() ||
                (await readFile(path, "utf8")) !== content
              )
                throw error;
            }
          } finally {
            await rm(temp, { force: true });
          }
          return {
            status: "success",
            structuredContent: {
              file: "artifacts/result.json",
              state: json(task.state),
            },
          };
        },
      },
    ];
  }
  close() {
    this.db.close();
  }
}
export const toolArgs = (value: unknown) => json(value) as JsonObject;
