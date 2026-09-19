import { createInfer, createInferWorker, type Infer } from "@ditto/core";
import { createHttpProvider, type SampleInput, type TrajectoryStrategy } from "@ditto/core/worker/infer";
import { createDitto, type InputOf, type OutputOf } from "@ditto/core";
export function checkInferContracts(): void {
  const input: SampleInput = { messages: [{ role: "user", content: "test" }], model: { model: "m" } };
  const same: InputOf<"INFER.REASONING.SAMPLE"> = input;
  const infer = createInfer(); const runtime = createDitto({ workers: [createInferWorker()] });
  const output: Promise<OutputOf<"INFER.REASONING.SAMPLE">> = runtime.invoke("INFER.REASONING.SAMPLE", same);
  const local: Promise<Infer.NodeResult<Infer.SampleOutput>> = infer.reasoning.sample(input);
  const generic = infer.execute<SampleInput, Infer.SampleOutput>("INFER.REASONING.SAMPLE", input);
  void output; void local; void generic; void createHttpProvider;
  // @ts-expect-error Required model config cannot be omitted.
  void infer.reasoning.sample({ messages: [] });
  // @ts-expect-error Runtime keeps the new node input contract.
  void runtime.invoke("INFER.CACHE.LOOKUP", { scope: "sample", key: "k" });
  const strategy: TrajectoryStrategy = async ctx => (await ctx.sample(ctx.messages)).message;
  const computeOnly: TrajectoryStrategy = async ctx => {
    // @ts-expect-error Cross-Worker orchestration belongs to Runtime Graphs.
    void ctx.invoke;
    // @ts-expect-error Actions belong to Runtime Graphs.
    void ctx.act;
    return (await ctx.sample(ctx.messages)).message;
  };
  void strategy; void computeOnly;
}
