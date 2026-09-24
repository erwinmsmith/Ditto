import type { RegisteredTool } from "@ditto/core/worker/interaction";

export interface PickupRecord { readonly code: string; readonly quantity: number }

/** A real in-memory business adapter. Replace it with an authenticated, idempotent application service. */
export function createPickupTool(ledger: Map<string, PickupRecord>): RegisteredTool {
  return {
    name: "record_pickup", effects: ["write"],
    inputSchema: { type: "object", required: ["id", "code", "quantity"], properties: {
      id: { type: "string" }, code: { type: "string" }, quantity: { type: "integer", minimum: 0 },
    }, additionalProperties: false },
    validate(args) {
      if (typeof args.id !== "string" || !args.id.trim() || typeof args.code !== "string" || !args.code.trim()
        || typeof args.quantity !== "number" || !Number.isSafeInteger(args.quantity) || args.quantity < 0) throw new Error("Invalid pickup arguments");
    },
    async execute(args) {
      const id = String(args.id);
      const value = { code: String(args.code), quantity: Number(args.quantity) };
      const existing = ledger.get(id);
      if (existing && (existing.code !== value.code || existing.quantity !== value.quantity)) throw new Error("Conflicting pickup id");
      ledger.set(id, value);
      return { status: "success", structuredContent: { id, ...value } };
    },
  };
}
