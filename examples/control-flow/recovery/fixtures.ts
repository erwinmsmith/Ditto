import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Order, ServiceFaults } from "../../_shared/tools/fulfillment-service.ts";
export type Mode = "retry" | "fallback" | "timeout" | "checkpoint" | "pause" | "session" | "compensation" | "side-effect";
export interface Fixture { expected: Order; stock: number; faults: ServiceFaults; requiresApproval: boolean }
export async function createFixture(directory: string, mode: Mode): Promise<Fixture> {
  const expected = { sku: `SKU-${randomBytes(4).toString("hex")}`, quantity: 2, address: `Dock-${randomBytes(3).toString("hex")}` };
  const faults: ServiceFaults = mode === "fallback" ? { primaryUnavailable: true } : mode === "timeout" ? { catalogDelayMs: 500 }
    : mode === "compensation" ? { rejectShipping: true } : mode === "side-effect" ? { dropReservationResponse: true } : {};
  const fixture = { expected, stock: 20, faults, requiresApproval: mode === "pause" };
  await writeFile(join(directory, "task.txt"), `Fulfillment request. SKU: ${expected.sku}; quantity: ${expected.quantity}; delivery address: ${expected.address}. Preserve the address without the trailing sentence punctuation.\n`);
  await writeFile(join(directory, "fixture.json"), JSON.stringify(fixture, null, 2));
  return fixture;
}
