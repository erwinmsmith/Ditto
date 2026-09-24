import { createDitto, type RuntimeConfig } from "@ditto/core/runtime";
import type { WorkerDefinition } from "@ditto/core/worker";
import { createInferWorker } from "@ditto/core/worker/infer";
import { createInteractionWorker } from "@ditto/core/worker/interaction";
import { openAgentStorage } from "../../examples/_shared/tools/storage/workers.ts";
import { RoutingAdapters } from "../../examples/_shared/tools/specialist-routing/adapters.ts";
import type { Request } from "../../examples/_shared/tools/specialist-routing/domain.ts";
export async function observedSpecialistRouting(
  directory: string,
  r: Request,
  config: RuntimeConfig,
  observe: (w: WorkerDefinition) => WorkerDefinition,
) {
  const adapters = new RoutingAdapters(directory, r),
    storage = await openAgentStorage(directory, config);
  try {
    const runtime = createDitto({
      config,
      sandbox: {
        ...config.sandbox,
        tools: adapters.tools.map((t) => t.name),
      },
      workers: [
        ...storage.workers,
        createInferWorker({ concurrency: 1 }),
        createInteractionWorker({ tools: adapters.tools, concurrency: 1 }),
      ].map(observe),
    });
    return {
      runtime,
      storage,
      adapters,
      async close() {
        try {
          await runtime.close();
        } finally {
          await storage.close();
        }
      },
    };
  } catch (e) {
    await storage.close();
    throw e;
  }
}
