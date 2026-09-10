/** Shared type protocol. Each Worker declares its own Node entries. */
export interface NodeContract<TInput, TOutput> {
  input: TInput;
  output: TOutput;
}

/** Open for declaration merging; this module owns no domain operations. */
export interface NodeContractMap {}

export type L2NodeType = keyof NodeContractMap;
export type InputOf<TNode extends L2NodeType> = NodeContractMap[TNode]["input"];
export type OutputOf<TNode extends L2NodeType> = NodeContractMap[TNode]["output"];
