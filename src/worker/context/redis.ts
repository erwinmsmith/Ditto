import { randomUUID } from "node:crypto";
import type { ContextStateStore } from "./types.js";
import { checkedStoredContext, contextScopeKey } from "./state.js";
import { context, ContextError, check, nonempty } from "./validation.js";

/** Compatible with node-redis; adapt other SDKs with two small forwarding functions. */
export interface RedisContextClient {
  get(key: string): Promise<string | null>;
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
}
export interface RedisContextOptions {
  readonly keyPrefix?: string;
  readonly ttlMs?: number;
}

const compareAndSet = `
local current = redis.call('GET', KEYS[1])
if current then
  if ARGV[1] == '' or cjson.decode(current).version ~= ARGV[1] then return 0 end
elseif ARGV[1] ~= '' then
  return 0
end
redis.call('SET', KEYS[1], ARGV[2], 'PX', ARGV[3])
return 1
`;

/** One key per scope, atomic version check/write/expiry, no SDK or connection ownership. */
export function createRedisContextStore(client: RedisContextClient, options: RedisContextOptions = {}): ContextStateStore {
  const keyPrefix = options.keyPrefix ?? "ditto:context:";
  const ttlMs = options.ttlMs ?? 3_600_000;
  nonempty(keyPrefix, "keyPrefix");
  check(Number.isSafeInteger(ttlMs) && ttlMs > 0 && ttlMs <= 2 ** 31 - 1, "ttlMs must be a positive 32-bit integer");
  const key = (scope: Parameters<ContextStateStore["get"]>[0]) => keyPrefix + contextScopeKey(scope);
  return Object.freeze({
    async get(scope) {
      const raw = await client.get(key(scope));
      if (raw === null) return undefined;
      try { return checkedStoredContext(JSON.parse(raw)); }
      catch { throw new ContextError("INVALID_STATE", "Redis returned invalid Context state"); }
    },
    async compareAndSet(scope, expectedVersion, next) {
      const stateKey = key(scope);
      if (expectedVersion !== undefined) nonempty(expectedVersion, "expectedVersion");
      context(next);
      const stored = checkedStoredContext({ version: randomUUID(), context: next });
      const result = await client.eval(compareAndSet, {
        keys: [stateKey], arguments: [expectedVersion ?? "", JSON.stringify(stored), String(ttlMs)],
      });
      if (result === 0) throw new ContextError("STATE_CONFLICT", "Context changed or expired; reload before retrying");
      check(result === 1, "Redis returned an invalid CAS result", "INVALID_STATE");
      return stored;
    },
  } satisfies ContextStateStore);
}
