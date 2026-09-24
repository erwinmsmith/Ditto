import { createDitto, type RuntimeConfig } from "@codesoul-co/ditto/runtime";
import type { WorkerDefinition } from "@codesoul-co/ditto/worker";
import { createInferWorker } from "@codesoul-co/ditto/worker/infer";
import { createInteractionWorker } from "@codesoul-co/ditto/worker/interaction";
import { openAgentStorage } from "../../examples/_shared/tools/storage/workers.ts";
import { PlanAdapters } from "../../examples/_shared/tools/plan-execute/adapters.ts";
import type { Request } from "../../examples/_shared/tools/plan-execute/domain.ts";
export async function observedPlanExecute(
  directory: string,
  r: Request,
  config: RuntimeConfig,
  observe: (w: WorkerDefinition) => WorkerDefinition,
) {
  const adapters = new PlanAdapters(directory, r),
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
        createInferWorker(),
        createInteractionWorker({ tools: adapters.tools }),
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
          try {
            await storage.close();
          } finally {
            adapters.close();
          }
        }
      },
    };
  } catch (e) {
    try {
      await storage.close();
    } finally {
      adapters.close();
    }
    throw e;
  }
}
