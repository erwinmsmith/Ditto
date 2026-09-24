import { createDitto, type RuntimeConfig } from "@ditto/core/runtime";
import type { WorkerDefinition } from "@ditto/core/worker";
import { createInferWorker } from "@ditto/core/worker/infer";
import { createInteractionWorker } from "@ditto/core/worker/interaction";
import { openAgentStorage } from "../../examples/_shared/tools/storage/workers.ts";
import { WebAdapters } from "../../examples/_shared/tools/web-search/adapters.ts";
import type { Request } from "../../examples/_shared/tools/web-search/domain.ts";
import type { SearchConfig } from "../../examples/_shared/tools/web-search/providers.ts";
import type { TransportOptions } from "../../examples/_shared/tools/web-search/http.ts";
export async function observedWeb(
  directory: string,
  r: Request,
  config: RuntimeConfig,
  search: SearchConfig,
  transport: TransportOptions,
  observe: (w: WorkerDefinition) => WorkerDefinition,
) {
  const adapters = new WebAdapters(directory, r, search, transport),
    storage = await openAgentStorage(directory, config);
  try {
    const runtime = createDitto({
      config,
      sandbox: {
        ...config.sandbox,
        tools: adapters.tools.map((t) => t.name),
        network: [
          ...(config.sandbox?.network ?? []),
          adapters.provider.origin,
          ...r.allowedOrigins,
        ],
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
