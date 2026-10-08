/**
 * Structured JSON logs (06a §5). Callers pass ids, codes and counts only: never a
 * patient name or phone, prescription text, an item name, or a patient↔item pair.
 */
type Sink = (line: string) => void;
let sink: Sink = (line) => console.log(line);

export function log(event: string, fields: Record<string, unknown> = {}): void {
  sink(JSON.stringify({ ts: new Date().toISOString(), event, ...fields }));
}

/** Tests only: capture log lines (06b captureLogs()). Returns a restore function. */
export function setLogSink(next: Sink): () => void {
  const prev = sink;
  sink = next;
  return () => {
    sink = prev;
  };
}
