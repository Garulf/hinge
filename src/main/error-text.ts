/** An error's message without its "Error:" prefix, for logs and notices. */
export function reasonOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
