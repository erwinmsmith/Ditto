import type { JsonObject, JsonValue } from "../contracts/index.js";
import type { ModelMessage, ModelResponse } from "../providers/index.js";
import type { Skill } from "./skills.js";

export interface AgentInput { readonly messages: readonly ModelMessage[]; readonly skills?: readonly string[] }
export interface AgentOutput { readonly content: string; readonly messages: readonly ModelMessage[]; readonly turns: number }

declare module "../contracts/node-contract-map.js" {
  interface NodeContractMap {
    "AGENT.RUN": NodeContract<AgentInput, AgentOutput>;
    "AGENT.GENERATE": NodeContract<{ readonly messages: readonly ModelMessage[] }, ModelResponse>;
    "AGENT.TOOL": NodeContract<{ readonly name: string; readonly arguments: JsonObject }, JsonValue>;
    "AGENT.SKILL": NodeContract<{ readonly name: string }, Skill>;
  }
}
