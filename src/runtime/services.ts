import { ProviderRegistry, createHttpProvider } from "../worker/reasoning/providers/index.js";
import { Sandbox, type SandboxExecutor, type SandboxPolicy } from "./sandbox/index.js";
import { loadRuntimeConfig, type RuntimeConfig } from "./config.js";

export interface RuntimeServiceOptions {
  readonly config?: RuntimeConfig;
  readonly providers?: ProviderRegistry;
  readonly sandbox?: SandboxPolicy;
  readonly sandboxExecutor?: SandboxExecutor;
}
export interface RuntimeServices {
  readonly config: RuntimeConfig;
  readonly providers: ProviderRegistry;
  readonly sandbox: Sandbox;
}
export function createRuntimeServices(options: RuntimeServiceOptions): RuntimeServices {
  // No implicit ambient-env access. Applications explicitly opt into loadRuntimeConfig().
  const config = options.config ?? loadRuntimeConfig({});
  const sandbox = new Sandbox(config.workspace, options.sandbox ?? config.sandbox, options.sandboxExecutor);
  const providers = options.providers ?? new ProviderRegistry();
  if (!options.providers) {
    for (const [name, provider] of Object.entries(config.providers)) {
      providers.register(name, createHttpProvider({ ...provider, sandbox, timeoutMs: config.timeoutMs }));
    }
  }
  return Object.freeze({ config, sandbox, providers });
}
