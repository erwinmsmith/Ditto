import type {
  Actor, Artifact, CommunicationReceipt, ExternalResult, McpCapability,
  Message, Observation, OutputReceipt, ToolCall,
} from "../../contracts/common.js";

export type {
  Actor, CommunicationReceipt, ExternalResult, McpCapability,
  Observation, OutputReceipt, ToolCall,
} from "../../contracts/common.js";

export interface InteractionToolInput { call: ToolCall; }
export type InteractionToolOutput = ExternalResult;
export type InteractionMcpInput =
  | { operation: "discover"; server?: string }
  | { operation: "invoke"; server: string; call: ToolCall };
export type InteractionMcpOutput =
  | { operation: "discover"; capabilities: readonly McpCapability[] }
  | { operation: "invoke"; result: ExternalResult };
export interface InteractionObserveInput { result: ExternalResult; }
export type InteractionObserveOutput = Observation;
export interface InteractionCommunicateInput { message: Message; recipients: readonly Actor[]; }
export type InteractionCommunicateOutput = CommunicationReceipt;
export interface InteractionOutputInput { message: Message; artifacts?: readonly Artifact[]; }
export type InteractionOutputOutput = OutputReceipt;

declare module "../../contracts/node-contract-map.js" {
  interface NodeContractMap {
    "INTERACTION.ACT.TOOL": NodeContract<InteractionToolInput, InteractionToolOutput>;
    "INTERACTION.ACT.MCP": NodeContract<InteractionMcpInput, InteractionMcpOutput>;
    "INTERACTION.OBSERVE": NodeContract<InteractionObserveInput, InteractionObserveOutput>;
    "INTERACTION.COMMUNICATE": NodeContract<InteractionCommunicateInput, InteractionCommunicateOutput>;
    "INTERACTION.OUTPUT": NodeContract<InteractionOutputInput, InteractionOutputOutput>;
  }
}
