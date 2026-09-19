/** Shared open type protocol. Capability modules add their own leaf contracts. */
export interface NodeContract<Input, Output> {
  readonly input: Input;
  readonly output: Output;
}

export interface NodeContractMap {}
export type NodeType = keyof NodeContractMap & string;
export type InputOf<T extends NodeType> = NodeContractMap[T]["input"];
export type OutputOf<T extends NodeType> = NodeContractMap[T]["output"];
