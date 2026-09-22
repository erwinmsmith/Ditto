import type {
  Context, JsonObject, MessageContent, Reference,
} from "../../../contracts/common.js";

export type ContextSelectPurpose = "infer" | "memory";

export type ContextSelectStrategy =
  | { readonly kind: "default" }
  | { readonly kind: "rag"; readonly corpus?: Reference; readonly options?: JsonObject }
  | { readonly kind: "provider"; readonly name: string; readonly options?: JsonObject };

export interface ContextSelectInput {
  readonly context: Context;
  readonly purpose: ContextSelectPurpose;
  readonly query?: MessageContent;
  readonly limit?: number;
  readonly maxTokens?: number;
  readonly strategy?: ContextSelectStrategy;
}

export interface ContextSelection {
  readonly purpose: ContextSelectPurpose;
  readonly context: Context;
  readonly selectedItemIds: readonly string[];
}

export type ContextSelectOutput = ContextSelection;
