import { resolve } from "node:path";
import type { SandboxPolicy } from "./sandbox/index.js";

export interface ModelSelection { readonly provider: string; readonly model: string }
export interface ProviderConfig {
  readonly kind: "openai-compatible" | "anthropic";
  readonly baseUrl: string;
  readonly apiKey?: string;
}
export interface RuntimeConfig {
  readonly environment: "development" | "test" | "production";
  readonly workspace: string;
  readonly model: ModelSelection | undefined;
  readonly providers: Readonly<Record<string, ProviderConfig>>;
  readonly timeoutMs: number;
  readonly maxTurns: number;
  readonly sandbox: SandboxPolicy;
}

function positive(value: string | undefined, fallback: number, name: string): number {
  const result = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(result) || result < 1) throw new Error(`${name} must be a positive integer`);
  return result;
}

/** Explicit env parsing: importing the library never loads files or changes process.env. */
export function loadRuntimeConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const environment = env.DITTO_ENV ?? "development";
  if (!["development", "test", "production"].includes(environment)) throw new Error("Invalid DITTO_ENV");
  const providers: Record<string, ProviderConfig> = Object.create(null) as Record<string, ProviderConfig>;
  for (const name of (env.DITTO_PROVIDERS ?? "").split(",").map((name) => name.trim()).filter(Boolean)) {
    if (!/^[a-z][a-z0-9_]*$/.test(name) || Object.hasOwn(providers, name)) throw new Error(`Invalid or duplicate provider: ${name}`);
    const prefix = `DITTO_PROVIDER_${name.toUpperCase()}_`;
    const kind = env[`${prefix}KIND`] ?? "openai-compatible";
    if (kind !== "openai-compatible" && kind !== "anthropic") throw new Error(`Invalid provider kind: ${name}`);
    const url = new URL(env[`${prefix}BASE_URL`] ?? (kind === "anthropic" ? "https://api.anthropic.com/v1" : "https://api.openai.com/v1"));
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error(`Invalid provider URL: ${name}`);
    }
    const apiKey = env[`${prefix}API_KEY`];
    providers[name] = Object.freeze({ kind, baseUrl: url.href.replace(/\/$/, ""), ...(apiKey ? { apiKey } : {}) });
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
    timeoutMs: positive(env.DITTO_TIMEOUT_MS, 30_000, "DITTO_TIMEOUT_MS"),
    maxTurns: positive(env.DITTO_MAX_TURNS, 8, "DITTO_MAX_TURNS"),
    sandbox: Object.freeze({ tools: list("DITTO_ALLOW_TOOLS"), mcp: list("DITTO_ALLOW_MCP"),
      skills: list("DITTO_ALLOW_SKILLS"), network: list("DITTO_ALLOW_NETWORK"),
      read: flag("DITTO_ALLOW_READ"), write: flag("DITTO_ALLOW_WRITE"), execute: flag("DITTO_ALLOW_EXECUTE") }),
  });
}
