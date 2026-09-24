import { createDitto, type RuntimeConfig } from "@ditto/core/runtime";
import type { WorkerDefinition } from "@ditto/core/worker";
import { createInferWorker } from "@ditto/core/worker/infer";
import { createInteractionWorker } from "@ditto/core/worker/interaction";
import { openAgentStorage } from "../../examples/_shared/tools/storage/workers.ts";
import { ReflectionAdapters } from "../../examples/_shared/tools/reflection/adapters.ts";
import type { Request } from "../../examples/_shared/tools/reflection/domain.ts";
export async function observedReflection(
  directory: string,
  r: Request,
  config: RuntimeConfig,
  observe: (w: WorkerDefinition) => WorkerDefinition,
) {
  const adapters = new ReflectionAdapters(directory, r),
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
          await storage.close();
        }
      },
    };
  } catch (e) {
    await storage.close();
    throw e;
  }
}
