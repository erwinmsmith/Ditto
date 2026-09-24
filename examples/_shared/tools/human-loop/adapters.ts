import { mkdir, readFile, lstat } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  RegisteredTool,
  OutputSink,
} from "@codesoul-co/ditto/worker/interaction";
import {
  HumanReviewStore,
  brief,
  digest,
  identifier,
  object,
  json,
  type Brief,
  type Draft,
  type ReviewerPolicy,
  type HumanJob,
  type Version,
  type ReviewRequest,
} from "../human-review-store.ts";
import { immutable } from "../execution/files.ts";
export interface Request {
  id: string;
  tenant: string;
  principal: string;
  goal: string;
  sourceDigest: string;
  maxModelCalls: number;
  deadlineSeconds: number;
}
export interface State {
  job: HumanJob;
  artifact: Version | null;
  request: ReviewRequest | null;
}
export interface Result {
  status: "awaiting-human" | "completed" | "rejected" | "escalated" | "partial";
  reason: string;
  state: State;
  usage: { modelCalls: number; startedAt: string };
}
export function request(input: unknown): Request {
  const r = object(input);
  if (
    typeof r.goal !== "string" ||
    !r.goal.trim() ||
    r.goal.length > 2000 ||
    typeof r.sourceDigest !== "string" ||
    !/^[a-f0-9]{64}$/.test(r.sourceDigest)
  )
    throw new Error("Invalid request");
  for (const [name, max] of [
    ["maxModelCalls", 8],
    ["deadlineSeconds", 86400],
  ] as const)
    if (
      !Number.isSafeInteger(r[name]) ||
      Number(r[name]) < 1 ||
      Number(r[name]) > max
    )
      throw new Error("Invalid budget");
  return {
    id: identifier(r.id),
    tenant: identifier(r.tenant),
    principal: identifier(r.principal),
    goal: r.goal,
    sourceDigest: r.sourceDigest,
    maxModelCalls: Number(r.maxModelCalls),
    deadlineSeconds: Number(r.deadlineSeconds),
  };
}
async function file(path: string) {
  const s = await lstat(path);
  if (!s.isFile() || s.isSymbolicLink() || s.size > 500000)
    throw new Error("Invalid task file");
  return readFile(path, "utf8");
}
export async function createDemo(
  directory: string,
  options: Partial<Omit<Request, "sourceDigest">> = {},
  conflict = false,
) {
  await mkdir(directory, { recursive: true });
  const id = options.id ?? randomUUID(),
    source: Brief = {
      releaseId: "REL-204",
      title: "Export release",
      change: "Add CSV export with explicit column headers.",
      sources: [
        { id: "release-plan", date: "2026-12-10" },
        { id: "release-ticket", date: conflict ? "2026-12-14" : "2026-12-10" },
      ],
    },
    r = request({
      id,
      tenant: "demo",
      principal: "operator",
      goal: "根据发布资料起草公告，等待人工确认或编辑后发布。",
      maxModelCalls: 4,
      deadlineSeconds: 3600,
      ...options,
      sourceDigest: digest(source),
    });
  await immutable(join(directory, "request.json"), JSON.stringify(r, null, 2));
  await immutable(
    join(directory, `${r.id}.source.json`),
    JSON.stringify(source),
  );
  await immutable(
    join(directory, `${r.id}.deployment.json`),
    JSON.stringify({ releaseId: source.releaseId, active: false }),
  );
  await immutable(
    join(directory, "policy.json"),
    JSON.stringify({
      enabled: true,
      principals: [r.principal],
      reviewers: {
        "example-publisher": ["publish"],
        "example-triager": ["handoff"],
      },
    }),
  );
  const app = await ReviewApplication.open(directory, r);
  try {
    await app.store.create(r.id, "publish");
  } finally {
    app.close();
  }
  return r;
}
export class ReviewApplication {
  readonly directory: string;
  readonly request: Request;
  readonly store: HumanReviewStore;
  private constructor(
    directory: string,
    r: Request,
    reviewers: ReviewerPolicy,
  ) {
    this.directory = directory;
    this.request = request(r);
    this.store = new HumanReviewStore(directory, reviewers);
  }
  static async open(directory: string, r: Request) {
    const p = object(JSON.parse(await file(join(directory, "policy.json"))));
    return new ReviewApplication(
      directory,
      r,
      object(p.reviewers) as ReviewerPolicy,
    );
  }
  async authorize() {
    const r = request(
        JSON.parse(await file(join(this.directory, "request.json"))),
      ),
      policy = object(
        JSON.parse(await file(join(this.directory, "policy.json"))),
      );
    if (digest(r) !== digest(this.request))
      throw new Error("Task request changed");
    if (
      policy.enabled !== true ||
      !Array.isArray(policy.principals) ||
      !policy.principals.includes(r.principal)
    )
      throw new Error("Task permission revoked");
    const source = brief(
      JSON.parse(await file(join(this.directory, `${r.id}.source.json`))),
    );
    if (digest(source) !== r.sourceDigest) throw new Error("Source changed");
    return { source, policy };
  }
  state(): State {
    const job = this.store.job(this.request.id);
    if (
      job.mode !== "publish" ||
      job.sourceDigest !== this.request.sourceDigest
    )
      throw new Error("Task scope changed");
    return {
      job,
      artifact: job.currentVersion ? this.store.version(job.id) : null,
      request: job.gateId ? this.store.request(job.gateId) : null,
    };
  }
  async actor(actor: string, purpose: string) {
    const { policy } = await this.authorize();
    const roles = object(policy.reviewers)[actor];
    if (!Array.isArray(roles) || !roles.includes(purpose))
      throw new Error("Reviewer permission denied");
  }
  async decide(input: {
    requestId: string;
    expectedToken: string;
    choice: "approve" | "reject";
    actor: string;
    note?: string;
  }) {
    const gate = this.store.request(input.requestId);
    if (gate.taskId !== this.request.id) throw new Error("Task scope changed");
    await this.actor(input.actor, gate.snapshot.purpose);
    return this.store.decide(input);
  }
  async edit(input: {
    requestId: string;
    expectedToken: string;
    replacement: Draft;
    actor: string;
    note: string;
  }) {
    const gate = this.store.request(input.requestId);
    if (gate.taskId !== this.request.id) throw new Error("Task scope changed");
    await this.actor(input.actor, "publish");
    return this.store.edit(input);
  }
  async claim(input: {
    requestId: string;
    expectedToken: string;
    actor: string;
    note: string;
  }) {
    const gate = this.store.request(input.requestId);
    if (gate.taskId !== this.request.id) throw new Error("Task scope changed");
    await this.actor(input.actor, "handoff");
    return this.store.claim(input);
  }
  async verify() {
    const s = this.state();
    if (s.job.stage !== "completed") return s;
    const a = s.artifact!,
      gate = s.request!,
      published = JSON.parse(
        await file(
          join(this.directory, "published", `${this.request.id}.json`),
        ),
      );
    if (
      gate.status !== "approved" ||
      published.version !== a.version ||
      published.digest !== a.digest ||
      published.reviewToken !== gate.token ||
      digest(published.content) !== digest(a.draft)
    )
      throw new Error("Published version mismatch");
    const expected = `# ${a.draft.title}\n\n${a.draft.body}\n\nRelease: ${a.draft.releaseId}\nDate: ${a.draft.date}\n`;
    if (
      (await file(
        join(this.directory, "published", `${this.request.id}.md`),
      )) !== expected
    )
      throw new Error("Published bytes changed");
    return s;
  }
  get tools(): RegisteredTool[] {
    const own = (
      name: string,
      handler: RegisteredTool["execute"],
    ): RegisteredTool => ({
      name,
      effects: ["read", "write"],
      inputSchema: { type: "object" },
      validate: object,
      execute: handler,
    });
    const base = this.store.tools.filter(
      (t) => !["human_report"].includes(t.name),
    );
    const tools = [
      ...base,
      own("hitl_check", async (a) => {
        const s = this.state();
        if (
          s.job.stage !== "approved" ||
          s.artifact?.digest !== a.digest ||
          s.artifact?.version !== a.version
        )
          return { status: "success", structuredContent: { current: false } };
        const v = object(a.result),
          d = s.artifact!.draft;
        if (
          v.releaseId !== d.releaseId ||
          v.date !== d.date ||
          v.title !== d.title ||
          v.digest !== s.artifact!.digest ||
          v.version !== s.artifact!.version ||
          v.ready !== true
        )
          throw new Error("Continuation must use the approved version");
        return { status: "success", structuredContent: { current: true } };
      }),
      own("hitl_verify", async () => ({
        status: "success",
        structuredContent: json(await this.verify()),
      })),
      own("hitl_report", async (a) => {
        const result = a.result as unknown as Result;
        if (result.state.job.id !== this.request.id)
          throw new Error("Report scope changed");
        if (digest(result.state) !== digest(await this.verify()))
          throw new Error("Report state changed");
        const dir = join(this.directory, "reports");
        await mkdir(dir, { recursive: true });
        const id = digest(result);
        await immutable(
          join(dir, id + ".json"),
          JSON.stringify(result, null, 2) + "\n",
        );
        return { status: "success", structuredContent: { reportId: id } };
      }),
    ];
    return tools.map((t) => {
      const { execute: handle, ...definition } = t;
      return {
        ...definition,
        execute: async (args, context) => {
          await this.authorize();
          context.signal?.throwIfAborted();
          if (t.name.startsWith("human_") && args.id !== this.request.id)
            throw new Error("Task scope changed");
          if (t.name === "human_apply") {
            const s = this.state();
            if (!s.request?.actor) throw new Error("Human approval required");
            await this.actor(s.request.actor, "publish");
          }
          return handle(args, context);
        },
      };
    });
  }
  readonly output: OutputSink = {
    deliver: async (input, context) => {
      await this.authorize();
      const gate = this.store.request(input.deliveryId);
      if (gate.taskId !== this.request.id)
        throw new Error("Review scope changed");
      return this.store.output.deliver(input, context);
    },
  };
  close() {
    this.store.close();
  }
}
