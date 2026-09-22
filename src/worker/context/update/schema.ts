import type { ContextUpdateInput } from "./types.js";
import {
  check, context, contextItem, ingress, nonempty, object,
} from "../validation.js";

export function validateUpdate(value: unknown): asserts value is ContextUpdateInput {
  const input = object(value, "input");
  context(input.context);
  if (input.add !== undefined) {
    check(Array.isArray(input.add), "add must be an array");
    input.add.forEach((item, index) => contextItem(item, `add[${index}]`));
  }
  if (input.ingress !== undefined) {
    check(Array.isArray(input.ingress), "ingress must be an array");
    input.ingress.forEach((entry, index) => ingress(entry, `ingress[${index}]`));
  }
  if (input.removeIds !== undefined) {
    check(Array.isArray(input.removeIds), "removeIds must be an array");
    input.removeIds.forEach((id, index) => nonempty(id, `removeIds[${index}]`));
  }
}
