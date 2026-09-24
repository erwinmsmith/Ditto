import { createDitto, type RuntimeConfig } from "@ditto/core/runtime";
import type { WorkerDefinition } from "@ditto/core/worker";
import { createInferWorker } from "@ditto/core/worker/infer";
import { createInteractionWorker } from "@ditto/core/worker/interaction";
import { openAgentStorage } from "../../examples/_shared/tools/storage/workers.ts";
import {
  ReviewApplication,
  type Request,
} from "../../examples/_shared/tools/human-loop/adapters.ts";
export async function observedHumanLoop(
  directory: string,
  r: Request,
  config: RuntimeConfig,
  observe: (w: WorkerDefinition) => WorkerDefinition,
) {
  const adapters = await ReviewApplication.open(directory, r);
  let storage;
  try {
    storage = await openAgentStorage(directory, config);
  } catch (error) {
    adapters.close();
    throw error;
  }
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
        createInteractionWorker({
          tools: adapters.tools,
          output: adapters.output,
        }),
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
