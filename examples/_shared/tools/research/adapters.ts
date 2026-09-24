import { readFile, lstat, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { RegisteredTool } from "@codesoul-co/ditto/worker/interaction";
import {
  WebAdapters,
  createTask as createWebTask,
} from "../web-search/adapters.ts";
import type { SearchConfig } from "../web-search/providers.ts";
import type { TransportOptions } from "../web-search/http.ts";
import { immutable } from "../execution/files.ts";
import { digest, object } from "../evidence.ts";
import { request, webInput, validateReport, type Request } from "./domain.ts";
async function saved(path: string) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 100000)
    throw new Error("Invalid research policy file");
  return JSON.parse(await readFile(path, "utf8"));
}
export async function createTask(
  directory: string,
  input: Request,
  config: SearchConfig,
) {
  const r = request(input);
  await createWebTask(directory, webInput(r), config);
  await immutable(
    join(directory, "research-request.json"),
    JSON.stringify(r, null, 2),
  );
  await immutable(
    join(directory, "research-policy.json"),
    JSON.stringify({
      fingerprint: digest(JSON.stringify(r)),
      enabled: true,
      principals: [r.principal],
    }),
  );
  return r;
}
/** Third-party IO stays in registered application tools; Core only dispatches them. */
export class ResearchAdapters extends WebAdapters {
  readonly researchRequest: Request;
  constructor(
    directory: string,
    input: Request,
    config: SearchConfig,
    transport: TransportOptions = {},
  ) {
    const r = request(input);
    super(directory, webInput(r), config, transport);
    this.researchRequest = r;
  }
  override async authorize() {
    await super.authorize();
    const r = request(
        await saved(join(this.directory, "research-request.json")),
      ),
      policy = object(
        await saved(join(this.directory, "research-policy.json")),
      );
    if (
      JSON.stringify(r) !== JSON.stringify(this.researchRequest) ||
      policy.fingerprint !== digest(JSON.stringify(r))
    )
      throw new Error("Research request changed");
    if (
      policy.enabled !== true ||
      !Array.isArray(policy.principals) ||
      !policy.principals.includes(r.principal)
    )
      throw new Error("Research permission revoked");
  }
  override get tools(): RegisteredTool[] {
    return [
      ...super.tools.filter(
        (t) => !["web_authorize", "web_publish"].includes(t.name),
      ),
      {
        name: "research_authorize",
        effects: ["read"],
        inputSchema: { type: "object" },
        validate: object,
        execute: async (args) => {
          if (
            JSON.stringify(request(args.request)) !==
            JSON.stringify(this.researchRequest)
          )
            throw new Error("Research request changed");
          await this.authorize();
          return { status: "success", structuredContent: { authorized: true } };
        },
      },
      {
        name: "research_publish",
        effects: ["read", "write"],
        inputSchema: { type: "object" },
        validate: object,
        execute: async (args, context) => {
          await this.authorize();
          const report = validateReport(args.report, this.researchRequest);
          await this.check(report.evidence);
          context.signal?.throwIfAborted();
          const esc = (s: string) => s.replace(/[\\`*_\[\]<>]/g, "\\$&");
          const lines = [
            "# Research report",
            "",
            esc(report.question),
            "",
            `Scope: ${esc(report.scope)}`,
            `Audience: ${esc(report.audience)}`,
            `Status: ${report.answer.status}`,
            `Stopped: ${report.stopReason}`,
            `Generated: ${report.generatedAt}`,
            "",
            "## Research coverage",
            "",
          ];
          for (const c of report.assessment.coverage)
            lines.push(
              `- ${esc(report.plan.subquestions.find((q) => q.id === c.id)!.question)}: ${c.status}${c.gap ? " — " + esc(c.gap) : ""}`,
            );
          lines.push("", "## Findings", "");
          for (const [i, c] of report.answer.claims.entries()) {
            lines.push(
              esc(c.text),
              "",
              `Evidence check: ${report.verification[i]!.status}`,
              "",
            );
            for (const cite of c.citations) {
              const e = report.evidence.find((e) => e.id === cite.chunkId)!;
              lines.push(
                `> ${esc(cite.quote).replaceAll("\n", "\n> ")}`,
                "",
                `[${esc(e.title)}](${e.uri.replaceAll("(", "%28").replaceAll(")", "%29")}) — paragraph ${e.startLine}; fetched ${e.fetchedAt}; SHA256 ${e.snapshot}`,
                "",
              );
            }
          }
          lines.push(
            "## Limitations",
            "",
            ...report.answer.limitations.map((s) => `- ${esc(s)}`),
            ...report.failures.map(
              (f) =>
                `- Unavailable ${f.stage}: ${esc(f.target)} (${esc(f.code)})`,
            ),
            `- ${report.omittedUrls.length} URLs omitted by page/context budgets.`,
            "- Different origins do not by themselves prove independent publishers.",
            "",
            "## Research trail",
            "",
          );
          for (const round of report.rounds)
            lines.push(
              `- Round ${round.number}: ${round.queries.map(esc).join("; ")}; ${round.newEvidence} new excerpts.`,
            );
          lines.push(
            "",
            `Reserved attempts: ${report.usage.searches} searches; ${report.usage.pages} page reads; ${report.usage.modelCalls} model calls.`,
          );
          await mkdir(join(this.directory, "output"), { recursive: true });
          await immutable(
            join(this.directory, "output/report.md"),
            lines.join("\n") + "\n",
          );
          await immutable(
            join(this.directory, "output/report.json"),
            JSON.stringify(report, null, 2) + "\n",
          );
          return {
            status: "success",
            structuredContent: {
              files: ["output/report.md", "output/report.json"],
            },
          };
        },
      },
    ];
  }
}
