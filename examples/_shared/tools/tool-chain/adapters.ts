import { mkdir, readFile, lstat } from "node:fs/promises";
import { join } from "node:path";
import type {
  RegisteredTool,
  ToolExecutionOutcome,
} from "@codesoul-co/ditto/worker/interaction";
import { immutable } from "../execution/files.ts";
import { digest, json, object } from "../evidence.ts";
import {
  request,
  decision,
  snapshot,
  payload,
  type Request,
  type Decision,
  type Receipt,
  type Report,
} from "./domain.ts";
async function regular(path: string) {
  const s = await lstat(path);
  if (!s.isFile() || s.isSymbolicLink() || s.size > 500000)
    throw new Error("Invalid task file");
  return readFile(path, "utf8");
}
export async function createTask(directory: string, input: Request) {
  const r = request(input);
  await mkdir(directory, { recursive: true });
  await immutable(join(directory, "request.json"), JSON.stringify(r, null, 2));
  await immutable(
    join(directory, "policy.json"),
    JSON.stringify({
      fingerprint: digest(JSON.stringify(r)),
      enabled: true,
      principals: [r.principal],
    }),
  );
  return r;
}
class ServiceError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}
export class ChainAdapters {
  readonly directory: string;
  readonly request: Request;
  constructor(directory: string, r: Request) {
    this.directory = directory;
    this.request = request(r);
  }
  async authorize() {
    const r = request(
        JSON.parse(await regular(join(this.directory, "request.json"))),
      ),
      p = object(
        JSON.parse(await regular(join(this.directory, "policy.json"))),
      );
    if (
      JSON.stringify(r) !== JSON.stringify(this.request) ||
      p.fingerprint !== digest(JSON.stringify(r))
    )
      throw new Error("Task request changed");
    if (
      p.enabled !== true ||
      !Array.isArray(p.principals) ||
      !p.principals.includes(r.principal)
    )
      throw new Error("Task permission revoked");
  }
  async http(
    path: string,
    signal?: AbortSignal,
    body?: unknown,
    optional = false,
  ): Promise<Record<string, unknown> | undefined> {
    const r = this.request,
      u = new URL(path, r.origin);
    u.searchParams.set("customerId", r.customerId);
    u.searchParams.set("orderId", r.orderId);
    const response = await fetch(u, {
      method: body === undefined ? "GET" : "POST",
      redirect: "error",
      headers: {
        "content-type": "application/json",
        "x-task-id": r.id,
        "idempotency-key": `${r.id}:${u.pathname.slice(1)}`,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(2000)])
        : AbortSignal.timeout(2000),
    });
    if (optional && response.status === 404) {
      await response.body?.cancel();
      return;
    }
    const reader = response.body?.getReader(),
      chunks: Uint8Array[] = [];
    let size = 0;
    if (reader)
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.length;
          if (size > 50000) {
            await reader.cancel();
            throw new Error("Response too large");
          }
          chunks.push(part.value);
        }
      } finally {
        reader.releaseLock();
      }
    const value = object(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    if (!response.ok)
      throw new ServiceError(String(value.code ?? `HTTP_${response.status}`));
    return value;
  }
  async record(kind: string, data: unknown) {
    const raw = JSON.stringify({
        fingerprint: digest(JSON.stringify(this.request)),
        kind,
        data,
      }),
      id = digest(raw);
    await mkdir(join(this.directory, "evidence"), { recursive: true });
    await immutable(join(this.directory, "evidence", id + ".json"), raw);
    return id;
  }
  async evidence(id: string) {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("Invalid evidence ID");
    const raw = await regular(join(this.directory, "evidence", id + ".json")),
      e = object(JSON.parse(raw));
    if (
      digest(raw) !== id ||
      e.fingerprint !== digest(JSON.stringify(this.request))
    )
      throw new Error("Evidence checksum mismatch");
    return e;
  }
  async validateReads(input: unknown) {
    for (const [name, value] of Object.entries(object(input))) {
      const result = object(value);
      if (result.status !== "success") continue;
      const content = object(result.structuredContent),
        e = await this.evidence(String(content.evidenceId));
      if (
        e.kind !== (name === "order" ? "orders" : name) ||
        JSON.stringify(e.data) !== JSON.stringify(content.data)
      )
        throw new Error("Read evidence changed");
    }
  }
  async verify(out: Report, signal?: AbortSignal) {
    const round = out.rounds.at(-1);
    if (!round?.decision) throw new Error("No verified decision");
    const d = round.decision,
      reads = object(round.reads),
      s = snapshot(
        Object.fromEntries(
          ["customer", "order", "payment", "shipment"].map((k) => [
            k,
            object(object(reads[k]).structuredContent).data,
          ]),
        ),
        this.request,
      );
    decision(d, s, this.request);
    const live = await this.http("/verify", signal);
    const current = snapshot(live!.snapshot, this.request);
    if (JSON.stringify(current) !== JSON.stringify(s))
      throw new Error("Business state changed after analysis");
    const expected = payload(d, this.request);
    for (const kind of ["crm", "notify"] as const) {
      const receipt = kind === "crm" ? out.crm : out.notification,
        required = kind === "crm" ? d.updateCrm : d.notify;
      if (!required) {
        if (receipt) throw new Error("Unexpected effect");
        continue;
      }
      if (
        !receipt ||
        receipt.key !== `${this.request.id}:${kind}` ||
        receipt.kind !== kind ||
        JSON.stringify(receipt.payload) !== JSON.stringify(expected)
      )
        throw new Error("Receipt mismatch");
      const stored = await this.http(
        `/operation?key=${encodeURIComponent(receipt.key)}`,
        signal,
      );
      if (JSON.stringify(stored) !== JSON.stringify(receipt))
        throw new Error("Missing committed receipt");
    }
    if (d.updateCrm) {
      const crm = object(live!.crm);
      if (
        crm.status !== d.status ||
        crm.revision !== d.revision ||
        crm.message !== expected.message
      )
        throw new Error("CRM state mismatch");
    } else if (live!.crm !== null) throw new Error("Unexpected CRM write");
    const notifications = live!.notifications as Record<string, unknown>[];
    if (
      notifications.length !== (d.notify ? 1 : 0) ||
      notifications.some(
        (n) =>
          n.recipient !== this.request.recipient ||
          n.message !== expected.message,
      )
    )
      throw new Error("Notification inbox mismatch");
    return this.record("verification", {
      decision: d,
      crm: out.crm,
      notification: out.notification,
      snapshot: s,
    });
  }
  get tools(): RegisteredTool[] {
    const tool = (
      name: string,
      effects: RegisteredTool["effects"],
      run: RegisteredTool["execute"],
    ): RegisteredTool => ({
      name,
      effects: effects ?? [],
      inputSchema: { type: "object" },
      validate: object,
      execute: async (a, c) => {
        await this.authorize();
        c.signal?.throwIfAborted();
        if (effects?.includes("network"))
          c.services.sandbox.assert("network", this.request.origin);
        return run(a, c);
      },
    });
    const failure = (e: unknown, write = false): ToolExecutionOutcome => ({
      status: write && !(e instanceof ServiceError) ? "unknown" : "failed",
      error: {
        code:
          e instanceof ServiceError
            ? e.code
            : write
              ? "OUTCOME_UNKNOWN"
              : "READ_FAILED",
        message:
          e instanceof ServiceError
            ? e.code
            : "Operation did not return a verified response",
        retryable:
          e instanceof ServiceError &&
          ["NOTIFICATION_UNAVAILABLE", "PAYMENT_UNAVAILABLE"].includes(e.code),
      },
    });
    return [
      tool("chain_validate_reads", ["read"], async (a) => {
        await this.validateReads(a.reads);
        return { status: "success", structuredContent: { verified: true } };
      }),
      tool("chain_authorize", ["read"], async () => ({
        status: "success",
        structuredContent: { authorized: true },
      })),
      ...(["customer", "orders", "payment", "shipment"] as const).map((path) =>
        tool(`chain_${path}`, ["read", "write", "network"], async (a, c) => {
          if (
            a.customerId !== this.request.customerId ||
            a.orderId !== this.request.orderId ||
            Object.keys(a).length !== 2
          )
            throw new Error("Read scope changed");
          let data: Record<string, unknown>;
          try {
            data = (await this.http(`/${path}`, c.signal))!;
          } catch (e) {
            if (c.signal?.aborted) throw e;
            return failure(e);
          }
          const evidenceId = await this.record(path, data);
          return {
            status: "success",
            structuredContent: json({ data, evidenceId }),
          };
        }),
      ),
      ...(["crm", "notify"] as const).map((kind) =>
        tool(`chain_${kind}`, ["read", "write", "network"], async (a, c) => {
          const p = payload(a.decision as unknown as Decision, this.request),
            key = `${this.request.id}:${kind}`;
          if (
            !this.request.allowCrmWrite ||
            (kind === "notify" && !this.request.allowNotify)
          )
            throw new Error("Effect not authorized");
          let receipt: Receipt;
          let reconciled = false;
          try {
            const old = await this.http(
              `/operation?key=${encodeURIComponent(key)}`,
              c.signal,
              undefined,
              true,
            );
            reconciled = !!old;
            receipt = (old ??
              (await this.http(`/${kind}`, c.signal, p))) as unknown as Receipt;
          } catch (e) {
            if (c.signal?.aborted) throw e;
            return failure(e, true);
          }
          if (
            receipt.key !== key ||
            receipt.kind !== kind ||
            JSON.stringify(receipt.payload) !== JSON.stringify(p)
          )
            throw new Error("Committed effect payload changed");
          const evidenceId = await this.record(kind, receipt);
          return {
            status: "success",
            structuredContent: json({ receipt, evidenceId, reconciled }),
          };
        }),
      ),
      tool("chain_verify", ["read", "write", "network"], async (a, c) => ({
        status: "success",
        structuredContent: {
          verificationId: await this.verify(
            a.report as unknown as Report,
            c.signal,
          ),
        },
      })),
      tool("chain_publish", ["read", "write"], async (a) => {
        const out = a.report as unknown as Report;
        if (
          out.requestId !== this.request.id ||
          !["completed", "partial", "needs-human"].includes(out.status)
        )
          throw new Error("Invalid report");
        for (const round of out.rounds) {
          for (const [name, result] of Object.entries(object(round.reads))) {
            const rr = object(result);
            if (rr.status !== "success") continue;
            const content = object(rr.structuredContent),
              e = await this.evidence(String(content.evidenceId));
            if (
              e.kind !== (name === "order" ? "orders" : name) ||
              JSON.stringify(e.data) !== JSON.stringify(content.data)
            )
              throw new Error("Read evidence changed");
          }
        }
        if (out.status === "completed") {
          if (!out.verificationId) throw new Error("Missing verification");
          const e = await this.evidence(out.verificationId),
            p = object(e.data);
          if (
            e.kind !== "verification" ||
            JSON.stringify(p.decision) !==
              JSON.stringify(out.rounds.at(-1)?.decision) ||
            JSON.stringify(p.crm) !== JSON.stringify(out.crm) ||
            JSON.stringify(p.notification) !== JSON.stringify(out.notification)
          )
            throw new Error("Verified report changed");
        } else if (out.verificationId !== null)
          throw new Error("Unverified completion");
        for (const receipt of [out.crm, out.notification])
          if (receipt)
            await this.evidence(
              digest(
                JSON.stringify({
                  fingerprint: digest(JSON.stringify(this.request)),
                  kind: receipt.kind,
                  data: receipt,
                }),
              ),
            );
        const dir = join(this.directory, "output");
        await mkdir(dir, { recursive: true });
        await immutable(
          join(dir, "report.json"),
          JSON.stringify(out, null, 2) + "\n",
        );
        if (out.notification)
          await immutable(
            join(dir, "notification.json"),
            JSON.stringify(out.notification, null, 2) + "\n",
          );
        await immutable(
          join(dir, "report.md"),
          `# Tool-chain task\n\nStatus: ${out.status}\nStop: ${out.stopReason}\nMode: ${this.request.mode}\n\nCRM receipt: ${out.crm?.key ?? "none"}\nNotification receipt: ${out.notification?.key ?? "none"}\n\n` +
            out.rounds
              .map(
                (x) =>
                  `- Round ${x.round}: ${x.problem ?? x.decision?.reasonCode ?? "not analyzed"}`,
              )
              .join("\n") +
            "\n",
        );
        return { status: "success", structuredContent: { published: true } };
      }),
    ];
  }
}
