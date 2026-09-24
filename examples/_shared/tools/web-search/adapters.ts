import { lstat, readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  createWebSearchTool,
  type RegisteredTool,
} from "@ditto/core/worker/interaction";
import { immutable } from "../execution/files.ts";
import { readable } from "../retrieval/web.ts";
import { searchProvider, type SearchConfig } from "./providers.ts";
import { download, permitted, type TransportOptions } from "./http.ts";
import {
  canonical,
  digest,
  json,
  object,
  request,
  validateReport,
  type Request,
  type Page,
  type Evidence,
} from "./domain.ts";
async function regular(path: string) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024)
    throw new Error("Invalid snapshot file");
  return readFile(path, "utf8");
}
function decode(html: string) {
  const data = readable(html),
    blocks = data.blocks
      .flatMap((b) =>
        Array.from({ length: Math.ceil(b.length / 1400) }, (_, i) =>
          b.slice(i * 1400, (i + 1) * 1400),
        ),
      )
      .slice(0, 120);
  if (blocks.join("\n").length > 100000)
    throw new Error("Page text budget exceeded");
  return { title: data.title.slice(0, 200), blocks };
}
export async function createTask(
  directory: string,
  input: Request,
  config: SearchConfig,
) {
  const r = request(input);
  await mkdir(directory, { recursive: true });
  const origin =
    config.engine === "brave"
      ? "https://api.search.brave.com"
      : new URL(config.endpoint ?? "https://en.wikipedia.org/w/api.php").origin;
  await immutable(join(directory, "request.json"), JSON.stringify(r, null, 2));
  await immutable(
    join(directory, "policy.json"),
    JSON.stringify(
      {
        fingerprint: digest(JSON.stringify(r)),
        enabled: true,
        principals: [r.principal],
        searchOrigin: origin,
      },
      null,
      2,
    ),
  );
  return r;
}
export class WebAdapters {
  readonly directory: string;
  readonly request: Request;
  readonly transport: TransportOptions;
  readonly provider: ReturnType<typeof searchProvider>;
  constructor(
    directory: string,
    input: Request,
    config: SearchConfig,
    transport: TransportOptions = {},
  ) {
    this.directory = directory;
    this.request = request(input);
    this.transport = transport;
    const provider = searchProvider(config, transport);
    this.provider = {
      origin: provider.origin,
      search: async (input, options) => {
        await this.authorize();
        options?.signal?.throwIfAborted();
        const path = join(
          directory,
          "search",
          digest(JSON.stringify(input)) + ".json",
        );
        try {
          const saved = object(JSON.parse(await regular(path)));
          if (
            saved.fingerprint !== digest(JSON.stringify(this.request)) ||
            saved.query !== input.query ||
            saved.origin !== provider.origin ||
            !Array.isArray(saved.results)
          )
            throw new Error("Search checkpoint identity mismatch");
          return saved.results as Awaited<ReturnType<typeof provider.search>>;
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        }
        const results = await provider.search(input, options);
        options?.signal?.throwIfAborted();
        await mkdir(join(directory, "search"), { recursive: true });
        await immutable(
          path,
          JSON.stringify({
            fingerprint: digest(JSON.stringify(this.request)),
            query: input.query,
            origin: provider.origin,
            results,
          }),
        );
        return results;
      },
    };
  }
  async authorize() {
    const saved = request(
        JSON.parse(await regular(join(this.directory, "request.json"))),
      ),
      policy = object(
        JSON.parse(await regular(join(this.directory, "policy.json"))),
      );
    if (
      JSON.stringify(saved) !== JSON.stringify(this.request) ||
      policy.fingerprint !== digest(JSON.stringify(saved))
    )
      throw new Error("Task request changed");
    if (
      policy.enabled !== true ||
      !Array.isArray(policy.principals) ||
      !policy.principals.includes(saved.principal) ||
      policy.searchOrigin !== this.provider.origin
    )
      throw new Error("Task permission revoked or provider changed");
    for (const origin of saved.allowedOrigins)
      permitted(origin, saved.allowedOrigins, this.transport.allowLoopbackTest);
  }
  async savedPage(key: string): Promise<Page> {
    if (!/^[a-f0-9]{64}$/.test(key)) throw new Error("Invalid page key");
    const saved = object(
        JSON.parse(await regular(join(this.directory, "pages", key + ".json"))),
      ),
      p = saved.page as Page;
    if (
      typeof saved.html !== "string" ||
      !p ||
      digest(p.requestedUrl) !== key ||
      digest(saved.html) !== p.snapshot
    )
      throw new Error("Snapshot checksum mismatch");
    permitted(
      p.requestedUrl,
      this.request.allowedOrigins,
      this.transport.allowLoopbackTest,
    );
    permitted(
      p.url,
      this.request.allowedOrigins,
      this.transport.allowLoopbackTest,
    );
    const decoded = decode(saved.html);
    if (
      JSON.stringify(decoded.blocks) !== JSON.stringify(p.blocks) ||
      decoded.title !== p.title ||
      digest(p.blocks.join("\n")) !== p.textHash ||
      !Number.isFinite(Date.parse(p.fetchedAt))
    )
      throw new Error("Snapshot content mismatch");
    return p;
  }
  async check(evidence: Evidence[]) {
    await this.authorize();
    for (const e of evidence) {
      const p = await this.savedPage(e.pageKey),
        index = e.startLine - 1;
      if (
        e.id !== digest(p.url + p.snapshot + index).slice(0, 24) ||
        e.endLine !== e.startLine ||
        p.blocks[index] !== e.text ||
        e.uri !== p.url ||
        e.snapshot !== p.snapshot ||
        e.title !== p.title ||
        e.fetchedAt !== p.fetchedAt ||
        e.hostname !== new URL(p.url).hostname
      )
        throw new Error("Citation snapshot mismatch");
    }
  }
  get tools(): RegisteredTool[] {
    const tool = (
      name: string,
      effects: RegisteredTool["effects"],
      execute: RegisteredTool["execute"],
    ): RegisteredTool => ({
      name,
      effects: effects ?? [],
      inputSchema: { type: "object" },
      validate: object,
      execute,
    });
    return [
      createWebSearchTool({ provider: this.provider }),
      tool("web_authorize", ["read"], async (args) => {
        if (
          JSON.stringify(request(args.request)) !== JSON.stringify(this.request)
        )
          throw new Error("Task request changed");
        await this.authorize();
        return { status: "success", structuredContent: { authorized: true } };
      }),
      tool("web_read", ["network", "read", "write"], async (args, context) => {
        await this.authorize();
        const url = canonical(args.url),
          key = digest(url);
        permitted(
          url,
          this.request.allowedOrigins,
          this.transport.allowLoopbackTest,
        );
        context.services.sandbox.assert("network", new URL(url).origin);
        try {
          return {
            status: "success",
            structuredContent: json(await this.savedPage(key)),
          };
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        }
        // Redirects are also checked by the application origin policy and pinned transport.
        const fetched = await download(
            url,
            this.request.allowedOrigins,
            "html",
            this.transport,
            context.signal,
          ),
          decoded = decode(fetched.body);
        const page: Page = {
          requestedUrl: url,
          url: fetched.url,
          ...decoded,
          snapshot: digest(fetched.body),
          textHash: digest(decoded.blocks.join("\n")),
          fetchedAt: new Date().toISOString(),
        };
        context.signal?.throwIfAborted();
        await mkdir(join(this.directory, "pages"), { recursive: true });
        await immutable(
          join(this.directory, "pages", key + ".json"),
          JSON.stringify({ page, html: fetched.body }),
        );
        return { status: "success", structuredContent: json(page) };
      }),
      tool("web_check", ["read"], async (args) => {
        if (!Array.isArray(args.evidence)) throw new Error("Missing evidence");
        await this.check(args.evidence as unknown as Evidence[]);
        return { status: "success", structuredContent: { checked: true } };
      }),
      tool("web_publish", ["read", "write"], async (args, context) => {
        await this.authorize();
        const report = validateReport(args.report, this.request);
        await this.check(report.evidence);
        context.signal?.throwIfAborted();
        const escaped = (s: string) => s.replace(/[\\`*_\[\]<>]/g, "\\$&");
        const lines = [
          "# Web answer",
          "",
          escaped(report.question),
          "",
          `Status: ${report.answer.status}`,
          `Generated: ${report.generatedAt}`,
          "",
        ];
        for (const c of report.answer.claims) {
          lines.push(escaped(c.text), "");
          for (const cite of c.citations) {
            const e = report.evidence.find((e) => e.id === cite.chunkId)!;
            lines.push(
              `> ${escaped(cite.quote).replaceAll("\n", "\n> ")}`,
              "",
              `[${escaped(e.title)}](${e.uri.replaceAll("(", "%28").replaceAll(")", "%29")}) — extracted paragraph ${e.startLine}; fetched ${e.fetchedAt}; SHA256 ${e.snapshot}`,
              "",
            );
          }
        }
        lines.push(
          ...report.answer.limitations.map(escaped),
          ...report.failures.map(
            (f) =>
              `Unavailable ${f.stage} source: ${escaped(f.target)} (${escaped(f.code)})`,
          ),
        );
        if (report.omittedUrls.length)
          lines.push(
            `Page budget omitted ${report.omittedUrls.length} discovered URLs.`,
          );
        const directory = join(this.directory, "output");
        await mkdir(directory, { recursive: true });
        await immutable(join(directory, "answer.md"), lines.join("\n") + "\n");
        await immutable(
          join(directory, "answer.json"),
          JSON.stringify(report, null, 2) + "\n",
        );
        return {
          status: "success",
          structuredContent: {
            files: ["output/answer.md", "output/answer.json"],
          },
        };
      }),
    ];
  }
}
