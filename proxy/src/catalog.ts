// The catalog data lives in proxy/catalog.json (shared/catalog.ts types it).
// This module keeps the proxy-only request rewrite.

import { getModel } from "@shared/catalog.ts";

export {
  type AuthStyle,
  getModel,
  getProvider,
  type ModelEntry,
  MODELS,
  type ProviderEntry,
  PROVIDERS,
} from "@shared/catalog.ts";

// Rewrite the request body for upstream forwarding: apply the model's
// `upstream_model_slug` (when the provider namespaces/renames it — ADR 0002)
// and any `request_overrides`, with `model` placed LAST so the upstream slug
// wins over both the client's `model` and any stray `model` in the overrides.
// `clientModel` is what the client sent and stays the authority for
// authz/cost/metering — only the bytes on the wire change.
export function mergeRequestBody(
  clientModel: string,
  original: Record<string, unknown>,
): Record<string, unknown> {
  const entry = getModel(clientModel);
  const overrides = entry?.request_overrides ?? {};
  const upstreamModel = entry?.upstream_model_slug ?? clientModel;
  const needsRewrite = upstreamModel !== clientModel ||
    Object.keys(overrides).length > 0;
  return needsRewrite
    ? { ...original, ...overrides, model: upstreamModel }
    : original;
}
