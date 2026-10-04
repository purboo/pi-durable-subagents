import type { CallResult } from "../types.ts";

export type ResultInput = Omit<CallResult, "ok" | "output"> & { output: string; report?: { text?: string; data: unknown } };

/** P24, AC3: Preserve the complete final text and its legacy final line after a report. */
export function buildCallResult({ report, ...input }: ResultInput): CallResult {
  if (!report) return { ...input, ok: input.status === "ok" };
  const text = report.text ?? (typeof report.data === "string" ? report.data : JSON.stringify(report.data));
  return { ...input, ok: input.status === "ok", data: report.data, output: `${text ?? ""}\n${input.output}` };
}
