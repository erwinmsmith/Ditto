/** Reuse complete task assertions for per-capability release coverage without repeating every fault case. */
export function limitCapabilityCases<T extends { mode: string }>(
  cases: T[],
  coverage = process.env.DITTO_EXAMPLE_CAPABILITY_COVERAGE ?? "complete",
) {
  if (coverage === "complete") return;
  if (coverage !== "capabilities")
    throw new Error("Choose complete or capabilities coverage");
  const seen = new Set<string>();
  cases.splice(
    0,
    cases.length,
    ...cases.filter((item) => {
      if (seen.has(item.mode)) return false;
      seen.add(item.mode);
      return true;
    }),
  );
}
