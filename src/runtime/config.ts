import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { validateRuntimeSettings, type RuntimeSettings, type InferSettings } from "./settings.js";
export type { RuntimeSettings, InferSettings } from "./settings.js";
import { resolve } from "node:path";
import type { SandboxPolicy } from "./sandbox/index.js";

export interface ModelSelection { readonly provider: string; readonly model: string }
export interface ProviderConfig {
  readonly kind: "openai-compatible" | "anthropic" | "gemini";
  readonly baseUrl: string;
  readonly apiKey?: string;
  /** Optional per-provider model selection for application/Worker configuration. */
  readonly model?: string;
  readonly maxTokensField?: "max_tokens" | "max_completion_tokens";
  readonly providerOptions?: Readonly<Record<string, unknown>>;
}
export interface RuntimeConfig {
  readonly environment: "development" | "test" | "production";
  readonly workspace: string;
  readonly model: ModelSelection | undefined;
  readonly providers: Readonly<Record<string, ProviderConfig>>;
  readonly timeoutMs: number;
  readonly maxTurns: number;
  readonly infer: InferSettings;
  readonly react: NonNullable<RuntimeSettings["react"]>;
  readonly sandbox: SandboxPolicy;
}

/** Explicit env parsing: importing the library never loads files or changes process.env. */
export function loadRuntimeConfig(env: NodeJS.ProcessEnv = process.env, settings: RuntimeSettings = {}): RuntimeConfig {
  settings = validateRuntimeSettings(settings);
  for (const key of Object.keys(env)) {
    if (env[key] !== undefined && (/^DITTO_(TIMEOUT_MS|MAX_TURNS)$/.test(key) || /^DITTO_PROVIDER_.+_(OPTIONS|MAX_TOKENS_FIELD)$/.test(key))) {
      throw new Error(`${key} moved to ditto.yaml; remove it from env`);
    }
  }
  const environment = env.DITTO_ENV ?? "development";
  if (!["development", "test", "production"].includes(environment)) throw new Error("Invalid DITTO_ENV");
  const providers: Record<string, ProviderConfig> = Object.create(null) as Record<string, ProviderConfig>;
  for (const name of (env.DITTO_PROVIDERS ?? "").split(",").map((name) => name.trim()).filter(Boolean)) {
    if (!/^[a-z][a-z0-9_]*$/.test(name) || Object.hasOwn(providers, name)) throw new Error(`Invalid or duplicate provider: ${name}`);
    const prefix = `DITTO_PROVIDER_${name.toUpperCase()}_`;
    const kind = env[`${prefix}KIND`] ?? "openai-compatible";
    if (kind !== "openai-compatible" && kind !== "anthropic" && kind !== "gemini") throw new Error(`Invalid provider kind: ${name}`);
    const url = new URL(env[`${prefix}BASE_URL`] ?? (kind === "anthropic" ? "https://api.anthropic.com/v1" : kind === "gemini" ? "https://generativelanguage.googleapis.com/v1beta" : "https://api.openai.com/v1"));
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error(`Invalid provider URL: ${name}`);
    }
    const apiKey = env[`${prefix}API_KEY`];
    const model = env[`${prefix}MODEL`];
    const maxTokensField = settings.providers?.[name]?.maxTokensField;
    if (maxTokensField && (kind !== "openai-compatible" || !["max_tokens", "max_completion_tokens"].includes(maxTokensField))) throw new Error(`Invalid max tokens field: ${name}`);
    const providerOptions = settings.providers?.[name]?.options;
    providers[name] = Object.freeze({ kind, baseUrl: url.href.replace(/\/$/, ""), ...(apiKey ? { apiKey } : {}),
      ...(model ? { model } : {}), ...(maxTokensField ? { maxTokensField: maxTokensField as "max_tokens" | "max_completion_tokens" } : {}),
      ...(providerOptions ? { providerOptions } : {}) });
  }
  const provider = env.DITTO_MODEL_PROVIDER;
  const model = env.DITTO_MODEL;
  if (Boolean(provider) !== Boolean(model)) throw new Error("Set DITTO_MODEL_PROVIDER and DITTO_MODEL together");
  if (provider && !Object.hasOwn(providers, provider)) throw new Error(`Default provider is not configured: ${provider}`);
  const list = (name: string): readonly string[] => Object.freeze((env[name] ?? "").split(",").map((value) => value.trim()).filter(Boolean));
  const flag = (name: string): boolean => {
    const value = env[name] ?? "false";
    if (value !== "true" && value !== "false") throw new Error(`${name} must be true or false`);
    return value === "true";
  };
  return Object.freeze({
    environment: environment as RuntimeConfig["environment"],
    workspace: resolve(env.DITTO_WORKSPACE ?? process.cwd()),
    model: provider && model ? Object.freeze({ provider, model }) : undefined,
    providers: Object.freeze(providers),
    timeoutMs: settings.runtime?.timeoutMs ?? 30_000,
    maxTurns: settings.runtime?.maxTurns ?? 8,
    infer: settings.infer ?? Object.freeze({}),
    react: settings.react ?? Object.freeze({}),
    sandbox: Object.freeze({ tools: list("DITTO_ALLOW_TOOLS"), mcp: list("DITTO_ALLOW_MCP"),
      skills: list("DITTO_ALLOW_SKILLS"), network: list("DITTO_ALLOW_NETWORK"),
      read: flag("DITTO_ALLOW_READ"), write: flag("DITTO_ALLOW_WRITE"), execute: flag("DITTO_ALLOW_EXECUTE") }),
  });
}

/** Explicit file loading; .env is loaded by the application/Node --env-file, never by this function. */
export function loadRuntimeConfigFile(path = "ditto.yaml", env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  // No aliases/merge keys: configuration stays a plain, reviewable tree.
  const settings: unknown = parse(readFileSync(path, "utf8"), { maxAliasCount: 0, merge: false });
  return loadRuntimeConfig(env, settings as RuntimeSettings);
}
