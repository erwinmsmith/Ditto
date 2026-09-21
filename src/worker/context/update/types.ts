import type {
  Context, ContextIngress, ContextItem,
} from "../../../contracts/common.js";

export interface ContextUpdateInput {
  readonly context: Context;
  readonly add?: readonly ContextItem[];
  readonly ingress?: readonly ContextIngress[];
  readonly removeIds?: readonly string[];
}

export type ContextUpdateOutput = Context;
