export function nowIso(): string {
  return new Date().toISOString();
}

export function durationMs(startAt: number): number {
  return Date.now() - startAt;
}
