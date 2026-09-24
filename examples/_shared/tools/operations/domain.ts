import { createHash } from "node:crypto";
import type { JsonObject, JsonValue } from "@codesoul-co/ditto/contracts";
export const modes = ["selection", "parameters", "api", "database", "files", "code", "browser", "desktop", "message", "system-write"] as const;
export type Mode = typeof modes[number];
export interface Request { id: string; tenant: string; mode: Mode; authorized: boolean; orderId: string; ticketId: string; quantity: number; unitCents: number; weight: number; country: string; currency: string; recipient: string; origin: string; smtpPort: number }
export interface Plan { name: string; arguments: JsonObject }
export interface Receipt { operationId: string; tool: string; value: JsonValue; evidence: JsonObject }
export const json = (v: unknown): JsonValue => JSON.parse(JSON.stringify(v));
export const digest = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
export function object(v: unknown): Record<string, unknown> { if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("Expected object"); return v as Record<string, unknown>; }
export const names: Record<Mode, string> = { selection: "order_lookup", parameters: "shipping_quote", api: "exchange_rate", database: "order_lookup", files: "file_edit", code: "run_code", browser: "browser_export", desktop: "desktop_note", message: "send_mail", "system-write": "crm_update" };
export function request(v: unknown): Request {
  const r = object(v);
  for (const key of ["id", "tenant", "orderId", "ticketId"]) if (typeof r[key] !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(r[key])) throw new Error(`Invalid ${key}`);
  if (!modes.includes(r.mode as Mode) || typeof r.authorized !== "boolean" || typeof r.origin !== "string" || new URL(r.origin).origin !== r.origin || !["http:", "https:"].includes(new URL(r.origin).protocol)) throw new Error("Invalid operation request");
  for (const key of ["quantity", "unitCents", "weight", "smtpPort"]) if (!Number.isSafeInteger(r[key]) || Number(r[key]) < 1 || Number(r[key]) > 65535) throw new Error(`Invalid ${key}`);
  if (r.country !== "SG" || r.currency !== "USD" || r.recipient !== "operations@example.test") throw new Error("Destination is outside the example controller policy");
  return { id: String(r.id), tenant: String(r.tenant), mode: r.mode as Mode, authorized: r.authorized, orderId: String(r.orderId), ticketId: String(r.ticketId), quantity: Number(r.quantity), unitCents: Number(r.unitCents), weight: Number(r.weight), smtpPort: Number(r.smtpPort), country: r.country, currency: r.currency, recipient: r.recipient, origin: r.origin };
}
const schema = (properties: Record<string, JsonValue>) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const string = { type: "string" }, number = { type: "integer" };
export const catalog = [
  { name: "order_lookup", description: "Read the payment status and total of an order from the business database.", inputSchema: schema({ orderId: string }) },
  { name: "inventory_lookup", description: "Read stock quantity for a product; does not provide order payment details.", inputSchema: schema({ sku: string }) },
  { name: "shipping_quote", description: "Calculate the carrier quote using destination country, weight and express service.", inputSchema: schema({ country: string, weight: number, service: { type: "string", enum: ["express"] } }) },
  { name: "exchange_rate", description: "Read the current exchange rate from the admitted business API.", inputSchema: schema({ currency: string }) },
  { name: "file_edit", description: "Read draft.txt, append the requested note, and create final.txt.", inputSchema: schema({ input: string, output: string, append: string }) },
  { name: "run_code", description: "Run JavaScript function BODY with parameter input in an isolated container. Return {totalCents: input.quantity * input.unitCents}. No markdown, no function declaration, no imports.", inputSchema: schema({ code: string }) },
  { name: "browser_export", description: "Use the browser's order form to look up an order and download its CSV.", inputSchema: schema({ orderId: string }) },
  { name: "desktop_note", description: "Enter title and body in the desktop notes application, then click Save.", inputSchema: schema({ title: string, body: string }) },
  { name: "send_mail", description: "Send an email to the controller-approved recipient using the configured SMTP transport.", inputSchema: schema({ to: string, subject: string, body: string }) },
  { name: "crm_update", description: "Mark a controller-approved ticket resolved with the supplied note in the CRM API.", inputSchema: schema({ ticketId: string, status: { type: "string", enum: ["resolved"] }, note: string }) },
];
export const allowed = (r: Request) => r.mode === "selection" ? ["order_lookup", "inventory_lookup"] : [names[r.mode]];
export const note = (r: Request) => `${r.ticketId}: order ${r.orderId} verified.`;
export function goal(r: Request): string {
  const goals: Record<Mode, string> = {
    selection: `Find payment status for order ${r.orderId}. Choose the suitable allowed tool.`,
    parameters: "Quote express shipping. Fill the destination and weight using the supplied context.",
    api: "Fetch the USD exchange rate through the business API.", database: `Query order ${r.orderId} and read its total and status.`,
    files: `Read draft.txt, append exactly '${note(r)}', and save final.txt.`, code: "Write and run JavaScript to compute quantity times unitCents, returning an object with totalCents.",
    browser: `Use the browser to fill the order form with ${r.orderId}, click Find, and download its CSV.`,
    desktop: `Use the desktop app to save a note titled '${r.ticketId}' with body exactly '${note(r)}'.`,
    message: `Send an email to ${r.recipient}, subject '${r.ticketId}', body exactly '${note(r)}'.`,
    "system-write": `Update ticket ${r.ticketId} to resolved, with note exactly '${note(r)}'.`,
  }; return goals[r.mode];
}
export function validatePlan(v: unknown, r: Request): Plan {
  const p = object(v); if (typeof p.name !== "string" || !allowed(r).includes(p.name)) throw new Error("Tool is not in the current allowlist");
  const args = object(p.arguments), definition = catalog.find(t => t.name === p.name)!;
  if (Object.keys(args).some(k => !definition.inputSchema.required.includes(k)) || definition.inputSchema.required.some(k => !(k in args))) throw new Error("Tool arguments do not match schema");
  if (!r.authorized && ["files", "code", "browser", "desktop", "message", "system-write"].includes(r.mode)) throw new Error("Controller authorization is required for this task");
  const expected: Record<string, unknown> = p.name === "order_lookup" || p.name === "browser_export" ? { orderId: r.orderId } : p.name === "inventory_lookup" ? { sku: "SKU-EXAMPLE" } : p.name === "shipping_quote" ? { country: r.country, weight: r.weight, service: "express" } : p.name === "exchange_rate" ? { currency: r.currency } : p.name === "file_edit" ? { input: "draft.txt", output: "final.txt", append: note(r) } : p.name === "desktop_note" ? { title: r.ticketId, body: note(r) } : p.name === "send_mail" ? { to: r.recipient, subject: r.ticketId, body: note(r) } : p.name === "crm_update" ? { ticketId: r.ticketId, status: "resolved", note: note(r) } : {};
  for (const [k, v] of Object.entries(expected)) if (args[k] !== v) throw new Error(`Tool argument violates admitted task: ${k}`);
  if (p.name === "run_code" && (typeof args.code !== "string" || !args.code.trim() || args.code.length > 4000)) throw new Error("Invalid bounded code input");
  return { name: p.name, arguments: json(args) as JsonObject };
}
export function validateReceipt(v: unknown, r: Request, plan: Plan): Receipt {
  const receipt = object(v); if (receipt.operationId !== r.id || receipt.tool !== plan.name) throw new Error("Operation receipt identity mismatch");
  const value = object(receipt.value); object(receipt.evidence);
  if (["selection", "database", "browser"].includes(r.mode) && (value.orderId !== r.orderId || value.totalCents !== r.quantity * r.unitCents)) throw new Error("Incorrect order result");
  if (r.mode === "parameters" && value.cents !== r.weight * 125 + 400) throw new Error("Incorrect shipping quote");
  if (r.mode === "api" && (value.currency !== r.currency || value.rate !== 7.2)) throw new Error("Incorrect API result");
  if (r.mode === "code" && value.totalCents !== r.quantity * r.unitCents) throw new Error("Generated code returned an incorrect total");
  if (["files", "desktop", "message", "system-write"].includes(r.mode) && value.note !== note(r)) throw new Error("Saved content differs from the approved task");
  if (r.mode === "system-write" && value.status !== "resolved") throw new Error("CRM was not updated");
  return receipt as unknown as Receipt;
}
