import { mkdir, readFile, lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import type {
  RegisteredTool,
  ToolExecutionOutcome,
} from "@codesoul-co/ditto/worker/interaction";
import { immutable } from "../execution/files.ts";
import { browserSdk } from "../operations/sdk.ts";
import { object, digest, json } from "../evidence.ts";
import {
  request,
  catalog,
  action,
  evidence,
  csv,
  final,
  report as validateReport,
  type Request,
  type Evidence,
  type Final,
} from "./domain.ts";
async function regular(path: string) {
  const s = await lstat(path);
  if (!s.isFile() || s.isSymbolicLink() || s.size > 100000)
    throw new Error("Invalid application file");
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
export class ReactAdapters {
  readonly directory: string;
  readonly request: Request;
  constructor(directory: string, input: Request) {
    this.directory = directory;
    this.request = request(input);
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
    post = false,
    optional = false,
  ): Promise<Record<string, unknown> | undefined> {
    const response = await fetch(
      `${this.request.origin}/${path}?jobId=${encodeURIComponent(this.request.jobId)}`,
      {
        method: post ? "POST" : "GET",
        redirect: "error",
        headers: { "idempotency-key": this.request.id },
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(400)])
          : AbortSignal.timeout(400),
      },
    );
    if (!response.ok) {
      await response.body?.cancel();
      if (optional && response.status === 404) return;
      throw new Error(`HTTP_${response.status}`);
    }
    let size = 0;
    const chunks: Uint8Array[] = [];
    if (response.body) {
      const reader = response.body.getReader();
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.length;
          if (size > 20000) {
            await reader.cancel();
            throw new Error("RESULT_TOO_LARGE");
          }
          chunks.push(part.value);
        }
      } finally {
        reader.releaseLock();
      }
    }
    return object(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  }
  async loadEvidence(id: string): Promise<Evidence> {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("Invalid evidence ID");
    const e = JSON.parse(
      await regular(join(this.directory, "evidence", id + ".json")),
    ) as Evidence;
    if (e.id !== id || evidence(e.tool, e.arguments, e.data).id !== id)
      throw new Error("Evidence checksum mismatch");
    action({ id: "check", name: e.tool, arguments: e.arguments }, this.request);
    return e;
  }
  async record(
    name: string,
    args: Record<string, unknown>,
    data: Record<string, unknown>,
  ) {
    const e = evidence(name, args, data);
    await mkdir(join(this.directory, "evidence"), { recursive: true });
    try {
      return await this.loadEvidence(e.id);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await immutable(
      join(this.directory, "evidence", e.id + ".json"),
      JSON.stringify(e),
    );
    return e;
  }
  async evidenceList() {
    try {
      return await Promise.all(
        (await readdir(join(this.directory, "evidence")))
          .filter((p) => p.endsWith(".json"))
          .map((p) => this.loadEvidence(p.slice(0, -5))),
      );
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw e;
    }
  }
  async verify(input: Final, signal?: AbortSignal) {
    const f = final(input),
      r = this.request;
    if (!f.evidenceIds.length)
      return { valid: false, reason: "Cite actual tool evidence IDs." };
    const evidence = await Promise.all(
        f.evidenceIds.map((id) => this.loadEvidence(id)),
      ),
      state = await this.http("status", signal);
    if (f.status === "completed") {
      const result = evidence.find(
        (e) =>
          e.tool ===
          (r.delivery === "browser" ? "job_result_browser" : "job_result"),
      );
      if (state?.state !== "completed" || !result)
        return {
          valid: false,
          reason: "Read the completed job CSV before declaring completion.",
        };
      const values = csv(result.data.csv, r),
        fresh = await this.http("result", signal);
      if (f.totalCents !== values.totalCents || fresh?.csv !== result.data.csv)
        return {
          valid: false,
          reason:
            "Final total must match the actual CSV, including quantities and integer cents.",
        };
      if (
        r.delivery === "browser" &&
        (await regular(join(this.directory, "download.csv"))) !==
          result.data.csv
      )
        throw new Error("Browser download changed");
      return {
        valid: true,
        summary: /\p{Script=Han}/u.test(r.goal)
          ? `任务 ${r.jobId} 已完成；CSV 核对总额为 ${values.totalCents} 分。`
          : `Job ${r.jobId} completed; verified CSV total: ${values.totalCents} cents.`,
      };
    }
    if (
      state?.state === "completed" ||
      f.totalCents !== null ||
      !evidence.some((e) => e.tool === "job_logs" || e.tool === "job_status")
    )
      return {
        valid: false,
        reason:
          "Human handoff requires evidence of an unresolved job, with no invented result amount.",
      };
    return {
      valid: true,
      summary: /\p{Script=Han}/u.test(r.goal)
        ? `任务 ${r.jobId} 尚未完成，需要人工处理。`
        : `Job ${r.jobId} remains unresolved and requires human intervention.`,
    };
  }
  get tools(): RegisteredTool[] {
    const r = this.request;
    const modelTools: RegisteredTool[] = catalog(r).map((d) => ({
      name: d.name,
      description: d.description!,
      inputSchema: json(d.inputSchema),
      effects:
        d.name === "runbook_search"
          ? ["read"]
          : d.name === "job_retry"
            ? ["network", "write"]
            : ["network", "read"],
      validate: (args) => {
        action({ id: "validate", name: d.name, arguments: args }, r);
      },
      execute: async (args, context): Promise<ToolExecutionOutcome> => {
        await this.authorize();
        context.signal?.throwIfAborted();
        if (d.name !== "runbook_search")
          context.services.sandbox.assert("network", r.origin);
        let data: Record<string, unknown>;
        try {
          if (d.name === "runbook_search") {
            const content = await regular(join(this.directory, "runbook.txt"));
            data = {
              code: args.code,
              matches: content
                .split("\n")
                .filter((line) => line.startsWith(String(args.code) + ":")),
              sha256: digest(content),
            };
          } else if (d.name === "job_retry") {
            const committed = await this.http(
              "operation",
              context.signal,
              false,
              true,
            );
            const current =
              committed ?? (await this.http("status", context.signal));
            if (current?.state === "completed")
              data = { ...current, recoverySkipped: !committed };
            else {
              const prior = await this.evidenceList();
              if (
                !prior.some(
                  (e) =>
                    e.tool === "job_logs" && e.data.errorCode === "E_TRANSIENT",
                ) ||
                !prior.some(
                  (e) =>
                    e.tool === "runbook_search" &&
                    e.data.code === "E_TRANSIENT" &&
                    Array.isArray(e.data.matches) &&
                    e.data.matches.length,
                )
              )
                return {
                  status: "failed",
                  error: {
                    code: "PRECONDITION",
                    message:
                      "Read job logs and search the matching runbook before retrying.",
                    retryable: false,
                  },
                };
              data = (await this.http("retry", context.signal, true))!;
            }
          } else if (d.name === "job_result_browser") {
            const browser = await browserSdk().chromium.launch({
              headless: true,
            });
            const abort = () => {
              void browser.close().catch(() => {});
            };
            context.signal?.addEventListener("abort", abort, { once: true });
            try {
              const page = await browser.newPage({
                acceptDownloads: true,
                serviceWorkers: "block",
              });
              await page.route("**/*", (route) =>
                new URL(route.request().url()).origin === r.origin
                  ? route.continue()
                  : route.abort(),
              );
              page.setDefaultTimeout(10000);
              await page.goto(`${r.origin}/portal?jobId=${r.jobId}`);
              await page.getByLabel("Job ID").fill(r.jobId);
              await page.getByRole("button", { name: "Find" }).click();
              await page.getByRole("link", { name: "Download CSV" }).waitFor();
              const pending = page.waitForEvent("download");
              await page.getByRole("link", { name: "Download CSV" }).click();
              const download = await pending;
              await download.saveAs(join(this.directory, "download.csv"));
              await page.screenshot({
                path: join(this.directory, "browser.png"),
              });
              const raw = await regular(join(this.directory, "download.csv"));
              data = {
                jobId: r.jobId,
                csv: raw,
                ...csv(raw, r),
                transport: "Chromium",
                file: "download.csv",
                sha256: digest(raw),
              };
            } finally {
              context.signal?.removeEventListener("abort", abort);
              await browser.close();
            }
          } else {
            data = (await this.http(
              d.name === "job_status"
                ? "status"
                : d.name === "job_logs"
                  ? "logs"
                  : "result",
              context.signal,
            ))!;
            if (d.name === "job_result")
              data = { ...data, ...csv(data.csv, r) };
          }
        } catch (e) {
          if (context.signal?.aborted) throw e;
          const msg = e instanceof Error ? e.message : "Tool operation failed";
          const uncertain =
            d.name === "job_retry" &&
            (e instanceof TypeError ||
              (e instanceof Error && e.name === "TimeoutError"));
          return {
            status: uncertain ? "unknown" : "failed",
            error: {
              code: uncertain
                ? "OUTCOME_UNKNOWN"
                : /^HTTP_\d+$/.test(msg)
                  ? msg
                  : "OPERATION_FAILED",
              message: uncertain
                ? "The response was lost; query job_status to reconcile before further writes."
                : msg.slice(0, 400),
              retryable: msg === "HTTP_503",
            },
          };
        }
        const stored = await this.record(d.name, args, data);
        return {
          status: "success",
          structuredContent: json({ evidenceId: stored.id, ...data }),
          references: [
            { uri: `urn:ditto:react:${stored.id}`, digest: stored.id },
          ],
        };
      },
    }));
    const tool = (
      name: string,
      effects: RegisteredTool["effects"],
      execute: RegisteredTool["execute"],
    ): RegisteredTool => ({
      name,
      inputSchema: { type: "object" },
      effects: effects ?? [],
      validate: object,
      execute,
    });
    return [
      ...modelTools,
      tool("react_authorize", ["read"], async (args) => {
        if (JSON.stringify(request(args.request)) !== JSON.stringify(r))
          throw new Error("Task request changed");
        await this.authorize();
        return { status: "success", structuredContent: { authorized: true } };
      }),
      tool("react_verify", ["read", "network"], async (args, context) => {
        await this.authorize();
        context.services.sandbox.assert("network", r.origin);
        const decision = final(args.final),
          checked = await this.verify(decision, context.signal);
        if (!checked.valid)
          return { status: "success", structuredContent: json(checked) };
        const proof = {
            fingerprint: digest(JSON.stringify(r)),
            status: decision.status,
            totalCents: decision.totalCents,
            evidenceIds: decision.evidenceIds,
            summary: checked.summary,
          },
          verificationId = digest(JSON.stringify(proof));
        await mkdir(join(this.directory, "verification"), { recursive: true });
        await immutable(
          join(this.directory, "verification", verificationId + ".json"),
          JSON.stringify(proof),
        );
        return {
          status: "success",
          structuredContent: json({ ...checked, verificationId }),
        };
      }),
      tool("react_publish", ["read", "write"], async (args, context) => {
        await this.authorize();
        const out = validateReport(args.report, r);
        for (const id of out.evidenceIds) await this.loadEvidence(id);
        for (const turn of out.turns)
          for (const [i, a] of turn.actions.entries()) {
            action(a, r);
            const o = turn.observations[i];
            if (!o) continue;
            if (o.callId !== a.id || o.source !== a.name)
              throw new Error("Observation correlation changed");
            if (o.status === "success") {
              const content = object(o.structuredContent);
              const saved = await this.loadEvidence(String(content.evidenceId));
              if (
                saved.tool !== a.name ||
                JSON.stringify(saved.arguments) !==
                  JSON.stringify(a.arguments) ||
                JSON.stringify({ evidenceId: saved.id, ...saved.data }) !==
                  JSON.stringify(content)
              )
                throw new Error("Observation evidence changed");
            }
          }

        context.signal?.throwIfAborted();
        if (out.status !== "partial") {
          const proof = {
            fingerprint: digest(JSON.stringify(r)),
            status: out.status,
            totalCents: out.totalCents,
            evidenceIds: out.evidenceIds,
            summary: out.summary,
          };
          if (
            digest(JSON.stringify(proof)) !== out.verificationId ||
            (await regular(
              join(
                this.directory,
                "verification",
                out.verificationId + ".json",
              ),
            )) !== JSON.stringify(proof)
          )
            throw new Error("Verified report changed");
        }
        // Publication replays a saved verified snapshot; it does not restart the remote operation.
        const path = join(this.directory, "output");
        await mkdir(path, { recursive: true });
        const esc = (s: string) => s.replace(/[\\`*_\[\]<>]/g, "\\$&");
        const lines = [
          "# ReAct task report",
          "",
          esc(out.goal),
          "",
          `Status: ${out.status}`,
          `Stopped: ${out.stopReason}`,
          "",
          esc(out.summary),
          "",
          "## Actions and observations",
          "",
        ];
        for (const turn of out.turns)
          for (const [i, a] of turn.actions.entries())
            lines.push(
              `- Step ${turn.step}: ${a.name} → ${turn.observations[i]?.status ?? "not executed"}`,
            );
        lines.push(
          "",
          "## Evidence",
          "",
          ...out.evidenceIds.map((id) => `- ${id}`),
          "",
          `Reserved model calls: ${out.usage.modelCalls}; action calls: ${out.usage.actionCalls}.`,
        );
        await immutable(join(path, "report.md"), lines.join("\n") + "\n");
        await immutable(
          join(path, "report.json"),
          JSON.stringify(out, null, 2) + "\n",
        );
        return {
          status: "success",
          structuredContent: {
            files: ["output/report.md", "output/report.json"],
          },
        };
      }),
    ];
  }
}
