// Slot accounting shared by the executor and the readers (status, waiting). A call on `provider/id` holds one slot of
// its provider (hold{pool: provider}) and, when `providers.<provider>.models[id]` exists, one slot of that model on the
// provider (hold{pool: "<provider>/<id>"}; a provider name has no "/", so the two kinds of pool cannot collide).
// A model without an entry is limited by its provider's slots only; a provider with `models` and no `slots` has no
// provider-wide limit. Without `models` nothing here changes what 1.3.2 did.
import type { OrchestratorConfig } from "./contract.ts";

type Providers = OrchestratorConfig["providers"];

/** The pool name of the slots of model `id` on `provider` in hold/release entries. */
export const modelPool = (provider: string, id: string) => `${provider}/${id}`;
/** Whether a held pool is a model's (`modelPool`), not a provider's or memory. */
export const isModelPool = (pool: string) => pool.includes("/");
/** The provider-wide slot limit, undefined for none. */
export const providerLimit = (providers: Providers, provider: string | undefined): number | undefined =>
  provider === undefined ? undefined : providers?.[provider]?.slots;
/** The slot limit of model `id` on `provider` (the id compared exactly), undefined for none. */
export function modelLimit(providers: Providers, provider: string | undefined, id: string): number | undefined {
  const models = provider === undefined ? undefined : providers?.[provider]?.models;
  return models && Object.hasOwn(models, id) ? models[id]!.slots : undefined;
}
/** How many holdings are on `pool`. */
export function heldOn(held: Iterable<{ pool: string }>, pool: string): number {
  let n = 0; for (const h of held) if (h.pool === pool) n++;
  return n;
}
/** Which level is full for one more call on `provider/id`: the provider's slots, the model's, both or neither. */
export function slotsFull(providers: Providers, held: Iterable<{ pool: string }>, provider: string | undefined, id: string): { provider: boolean; model: boolean } {
  if (provider === undefined) return { provider: false, model: false };
  const list = [...held], pl = providerLimit(providers, provider), ml = modelLimit(providers, provider, id);
  return { provider: pl !== undefined && heldOn(list, provider) >= pl, model: ml !== undefined && heldOn(list, modelPool(provider, id)) >= ml };
}
