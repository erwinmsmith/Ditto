import { DatabaseSync } from "node:sqlite";
import { readFile, mkdir, lstat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import type { RegisteredTool } from "@ditto/core/worker/interaction";
import { browserSdk, electronPath, mailSdk } from "./sdk.ts";
import { catalog, allowed, validatePlan, json, object, type Request, type Receipt, type Plan } from "./domain.ts";
import { isolatedCode } from "../execution/docker.ts";
export { isolatedCode } from "../execution/docker.ts";
import { immutable } from "../execution/files.ts";
export { immutable } from "../execution/files.ts";
function childEnv() { return Object.fromEntries(["PATH", "HOME", "TMPDIR", "LANG", "DISPLAY", "XAUTHORITY", "WAYLAND_DISPLAY", "DOCKER_HOST", "DOCKER_CONFIG"].flatMap(k => process.env[k] ? [[k, process.env[k]!]] : [])); }
export class OperationAdapters {
  readonly directory: string; readonly request: Request; readonly db: DatabaseSync;
  constructor(directory: string, request: Request) { this.directory = directory; this.request = request; this.db = new DatabaseSync(join(directory, "business.sqlite"), { readOnly: true }); }
  async http(path: string, signal?: AbortSignal, method = "GET", body?: unknown, optional = false) {
    const response = await fetch(this.request.origin + path, { method, redirect: "error", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000), headers: { "content-type": "application/json", "idempotency-key": this.request.id }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (optional && response.status === 404) { await response.body?.cancel(); return undefined; }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Business API HTTP ${response.status}`); }
    const chunks: Uint8Array[] = []; let size = 0;
    if (response.body) { const reader = response.body.getReader(); try { for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > 65536) { await reader.cancel(); throw new Error("Business API response too large"); } chunks.push(part.value); } } finally { reader.releaseLock(); } }
    return object(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  }
  async perform(plan: Plan, signal?: AbortSignal): Promise<Receipt> {
    const r = this.request, a = plan.arguments; signal?.throwIfAborted();
    let value: unknown, evidence: Record<string, unknown>;
    if (plan.name === "order_lookup") { value = this.db.prepare("SELECT id AS orderId,quantity*unit_cents AS totalCents,status FROM orders WHERE id=? AND tenant=?").get(String(a.orderId), r.tenant); if (!value) throw new Error("Order not found"); evidence = { database: "business.sqlite", table: "orders", parameterized: true }; }
    else if (plan.name === "inventory_lookup") { value = this.db.prepare("SELECT sku,stock FROM inventory WHERE sku=? AND tenant=?").get(String(a.sku), r.tenant); if (!value) throw new Error("Product not found"); evidence = { database: "business.sqlite", table: "inventory", parameterized: true }; }
    else if (plan.name === "shipping_quote" || plan.name === "exchange_rate") { const path = plan.name === "shipping_quote" ? `/shipping?${new URLSearchParams({ country: String(a.country), weight: String(a.weight), service: String(a.service) })}` : `/rate?currency=${a.currency}`; value = await this.http(path, signal); evidence = { url: r.origin + path, transport: "HTTP" }; }
    else if (plan.name === "file_edit") {
      const path = join(this.directory, "draft.txt"), stat = await lstat(path); if (!stat.isFile() || stat.size > 16384) throw new Error("Invalid draft file"); const original = await readFile(path, "utf8");
      const content = original + String(a.append) + "\n"; await immutable(join(this.directory, "final.txt"), content); if (await readFile(join(this.directory, "final.txt"), "utf8") !== content) throw new Error("File readback mismatch");
      value = { note: a.append, file: "final.txt" }; evidence = { original, sha256: createHash("sha256").update(content).digest("hex") };
    } else if (plan.name === "run_code") { const result = await isolatedCode(String(a.code), { quantity: r.quantity, unitCents: r.unitCents }, signal); value = result.output; evidence = { engine: "Docker Node.js", exitCode: result.exitCode, network: "none", hostMounts: false }; }
    else if (plan.name === "browser_export") {
      const browser = await browserSdk().chromium.launch({ headless: true, env: childEnv() }); const abort = () => { void browser.close().catch(() => {}); }; signal?.addEventListener("abort", abort, { once: true });
      try { const page = await browser.newPage({ acceptDownloads: true, serviceWorkers: "block" }); await page.route("**/*", route => new URL(route.request().url()).origin === r.origin ? route.continue() : route.abort()); page.setDefaultTimeout(15000); await page.goto(r.origin + "/browser"); await page.getByLabel("Order ID").fill(String(a.orderId)); await page.getByRole("button", { name: "Find" }).click(); await page.getByRole("link", { name: "Download CSV" }).waitFor();
        const pending = page.waitForEvent("download"); await page.getByRole("link", { name: "Download CSV" }).click(); const download = await pending; const path = join(this.directory, "download.csv"); await download.saveAs(path); await page.screenshot({ path: join(this.directory, "browser.png") });
        const csv = await readFile(path, "utf8"), match = /^orderId,totalCents\n([^,]+),(\d+)\n$/.exec(csv); if (!match) throw new Error("Browser downloaded invalid CSV"); value = { orderId: match[1], totalCents: Number(match[2]) }; evidence = { engine: "Chromium", file: "download.csv", screenshot: "browser.png", suggestedFilename: download.suggestedFilename(), actions: ["fill", "click Find", "click Download CSV", "download"] };
      } finally { signal?.removeEventListener("abort", abort); await browser.close(); }
    } else if (plan.name === "desktop_note") {
      const app = await browserSdk()._electron.launch({ executablePath: electronPath(), args: [fileURLToPath(new URL("./desktop.cjs", import.meta.url))], env: { ...childEnv(), DITTO_DESKTOP_WORKSPACE: this.directory }, timeout: 20000 }); const abort = () => { void app.close().catch(() => {}); }; signal?.addEventListener("abort", abort, { once: true });
      try { const page = await app.firstWindow(); page.setDefaultTimeout(15000); const visible = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some(w => w.isVisible())); if (!visible) throw new Error("Desktop app has no visible native window");
        await page.getByLabel("Title").fill(String(a.title)); await page.getByLabel("Body").fill(String(a.body)); await page.getByRole("button", { name: "Save" }).click(); await page.locator("#status:has-text('Saved')").waitFor(); await page.screenshot({ path: join(this.directory, "desktop.png") });
        const saved = JSON.parse(await readFile(join(this.directory, "desktop-note.json"), "utf8")); if (saved.title !== a.title || saved.body !== a.body) throw new Error("Desktop save did not persist entered fields"); value = { note: saved.body, title: saved.title }; evidence = { application: "Electron Task Notes", nativeWindowVisible: visible, file: "desktop-note.json", screenshot: "desktop.png", actions: ["fill title", "fill body", "click Save", "read persisted note"] };
      } finally { signal?.removeEventListener("abort", abort); await app.close(); }
    } else if (plan.name === "send_mail") {
      const id = `${r.id}@ditto.example.test`, path = `/mailbox/${encodeURIComponent(id)}`; let mail = await this.http(path, signal, "GET", undefined, true);
      if (!mail) { const transport = mailSdk().createTransport({ host: "127.0.0.1", port: r.smtpPort, secure: false, ignoreTLS: true, connectionTimeout: 5000, greetingTimeout: 5000, socketTimeout: 5000 });
        try { await transport.sendMail({ from: "ditto@example.test", to: a.to, subject: a.subject, text: a.body, messageId: `<${id}>`, disableFileAccess: true, disableUrlAccess: true }); } finally { transport.close(); }
        mail = await this.http(path, signal);
      }
      if (!mail || mail.recipient !== a.to || mail?.subject !== a.subject || mail?.body !== a.body) throw new Error("Mailbox readback differs from approved message"); value = { note: mail.body, messageId: id, recipient: mail.recipient }; evidence = { transport: "SMTP", mailboxReadback: true };
    } else if (plan.name === "crm_update") {
      let result = await this.http(`/operations/${r.id}`, signal, "GET", undefined, true); result ??= await this.http("/crm", signal, "PATCH", a);
      if (result?.ticketId !== a.ticketId || result?.note !== a.note || result?.status !== a.status) throw new Error("CRM operation readback mismatch"); value = result; evidence = { transport: "HTTP PATCH", idempotencyKey: r.id, database: "business.sqlite" };
    } else throw new Error("Unsupported tool");
    signal?.throwIfAborted(); return { operationId: r.id, tool: plan.name, value: json(value), evidence: json(evidence) as Receipt["evidence"] };
  }
  get tools(): RegisteredTool[] { return [...catalog.filter(t => allowed(this.request).includes(t.name)).map<RegisteredTool>(t => ({ ...t, effects: ["order_lookup", "inventory_lookup", "shipping_quote", "exchange_rate"].includes(t.name) ? ["read"] : ["read", "write"], validate: args => { validatePlan({ name: t.name, arguments: args }, this.request); }, execute: async (args, context) => {
    if (["shipping_quote", "exchange_rate", "browser_export", "crm_update", "send_mail"].includes(t.name)) context.services.sandbox.assert("network", this.request.origin);
    return { status: "success", structuredContent: json(await this.perform({ name: t.name, arguments: args }, context.signal)) };
  } })), { name: "operation_publish", inputSchema: { type: "object" }, effects: ["write"],
    validate: args => { if (object(args.report).operationId !== this.request.id) throw new Error("Wrong operation report"); },
    execute: async (args, context) => { context.signal?.throwIfAborted(); const directory = join(this.directory, "artifacts"); await mkdir(directory, { recursive: true }); await immutable(join(directory, "operation.json"), JSON.stringify(args.report, null, 2) + "\n"); return { status: "success", structuredContent: { file: "artifacts/operation.json" } }; },
  }]; }
  close() { this.db.close(); }
}
