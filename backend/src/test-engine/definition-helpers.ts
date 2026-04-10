import type { TestExecutionContext } from "./types.js";

export async function waitForCondition<T>(
  context: TestExecutionContext,
  stepKey: string,
  timeoutMs: number,
  poller: () => Promise<T>,
  predicate: (value: T) => boolean,
  describe: (value: T) => Record<string, unknown>,
): Promise<T> {
  const startedAt = Date.now();
  let lastValue: T | undefined;

  while (Date.now() - startedAt <= timeoutMs) {
    if (context.isCancelled()) {
      throw new Error("Test run cancelled while waiting for device state.");
    }

    lastValue = await poller();
    if (predicate(lastValue)) {
      return lastValue;
    }

    await context.wait(1000);
  }

  await context.log("error", stepKey, `Condition wait timed out after ${timeoutMs}ms`, lastValue != undefined ? describe(lastValue) : undefined);
  throw new Error(`Timeout while waiting for ${stepKey}.`);
}
