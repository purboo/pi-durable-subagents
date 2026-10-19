/** A live JSONL session may end in an unfinished write. Parse complete records only; malformed complete records throw. */
export function sessionRows(text: string): any[] {
  return text.slice(0, text.lastIndexOf("\n") + 1).split("\n").filter(Boolean).map(line => JSON.parse(line));
}
