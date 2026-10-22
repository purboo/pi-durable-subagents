// EX4: the splice of an exact child's provider payload.
//
// The parent capture supplies every top-level field of the request (system/instructions, tools, tool choice, model,
// thinking/reasoning, max tokens, prompt cache key, metadata and every other field) byte for byte; only the
// conversation differs: the parent's conversation followed by the child's own conversation (the child's payload
// conversation from its first user message on).
//
// The child's own system prompt, context files and skills never reach the provider: the parent's fields replace
// them.
//
// Anthropic cache breakpoints: the parent's conversation keeps its own `cache_control` markers (the provider wrote
// the cache there). The child's markers are kept only while the total stays within the provider limit of 4; the
// child's earliest marker is dropped first.
import type { ProviderPayload } from "./capture.ts";

/** The conversation field of an api: the array the parent and the child are concatenated in. */
export const CONVERSATION: Record<string, string> = {
  "anthropic-messages": "messages",
  "openai-responses": "input",
};
/** The provider limit of anthropic cache breakpoints per request. */
export const CACHE_BREAKPOINT_LIMIT = 4;

/** A deep copy of a JSON value (the child's conversation is copied before its markers are dropped). */
export function clone<T>(value: T): T {
  if (Array.isArray(value)) return value.map(clone) as unknown as T;
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, clone(v)])) as T;
  return value;
}

/** The role of a conversation item ("user", "assistant", "system", ...), when it has one. */
const roleOf = (item: unknown): string | undefined => {
  if (!item || typeof item !== "object") return undefined;
  const record = item as Record<string, unknown>;
  if (typeof record.role === "string") return record.role;
  if (record.type === "message" && record.message && typeof record.message === "object") {
    const role = (record.message as Record<string, unknown>).role;
    return typeof role === "string" ? role : undefined;
  }
  return undefined;
};

/**
 * The child's own conversation: its payload conversation from its first user message on. The messages before it are
 * the child's system prompt (and the provider's own instruction blocks), which the parent's fields replace.
 */
export function childConversation(conversation: unknown): unknown[] {
  if (!Array.isArray(conversation)) return [];
  const first = conversation.findIndex(item => roleOf(item) === "user");
  return first < 0 ? [] : conversation.slice(first);
}

/** Every `cache_control` marker of a value, in document order (the paths to the objects that carry them). */
export function cacheMarkers(value: unknown, path: (string | number)[] = []): (string | number)[][] {
  const found: (string | number)[][] = [];
  const walk = (node: unknown, at: (string | number)[]) => {
    if (Array.isArray(node)) { node.forEach((item, index) => walk(item, [...at, index])); return; }
    if (!node || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    if (Object.hasOwn(record, "cache_control")) found.push(at);
    for (const [key, child] of Object.entries(record)) if (key !== "cache_control") walk(child, [...at, key]);
  };
  walk(value, path);
  return found;
}

/** The number of `cache_control` markers of a value. */
export const markerCount = (value: unknown) => cacheMarkers(value).length;

/** Remove the marker at `path` (the `cache_control` property of the object it names). */
function dropMarker(root: unknown, path: (string | number)[]): void {
  let node = root as Record<string | number, unknown> | undefined;
  for (const step of path) {
    if (node === undefined || node === null) return;
    node = (node as Record<string | number, unknown>)[step] as Record<string | number, unknown> | undefined;
  }
  if (node && typeof node === "object") delete (node as Record<string, unknown>).cache_control;
}

/**
 * The spliced payload: the parent's fields, byte for byte, with the conversation replaced by the parent's
 * conversation followed by the child's own.
 */
export function splicePayload(parent: ProviderPayload, child: ProviderPayload, api: string): ProviderPayload {
  const field = CONVERSATION[api];
  if (!field) throw new Error(`unsupported api: ${api}`);
  const parentConversation = Array.isArray(parent[field]) ? parent[field] as unknown[] : [];
  const own = childConversation(child[field]);
  const result: ProviderPayload = { ...parent };
  if (api === "anthropic-messages") {
    // The parent's markers stay; the child's are kept only while the total stays within the provider's limit.
    const budget = CACHE_BREAKPOINT_LIMIT - markerCount(parent);
    const conversation = clone(own);
    if (budget < 0) {
      for (const path of cacheMarkers(conversation)) dropMarker(conversation, path);
    } else if (markerCount(conversation) > budget) {
      const paths = cacheMarkers(conversation);
      for (const path of paths.slice(0, paths.length - budget)) dropMarker(conversation, path);
    }
    result[field] = [...parentConversation, ...conversation];
  } else {
    result[field] = [...parentConversation, ...clone(own)];
  }
  return result;
}

/** The tool names a payload declares (anthropic `tools[].name`, openai-responses `tools[].name`/`function.name`). */
export function payloadTools(payload: ProviderPayload): string[] {
  const tools = payload.tools;
  if (!Array.isArray(tools)) return [];
  return tools.flatMap(tool => {
    if (!tool || typeof tool !== "object") return [];
    const record = tool as Record<string, unknown>;
    if (typeof record.name === "string") return [record.name];
    const fn = record.function as Record<string, unknown> | undefined;
    return fn && typeof fn.name === "string" ? [fn.name] : [];
  });
}
