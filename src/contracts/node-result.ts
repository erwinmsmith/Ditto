export interface NodeResult<T> {
  executionId: string;
  node: string;
  status: "success" | "failed" | "cancelled" | "timeout";
  output?: T;
  error?: { code: string; message: string };
}
