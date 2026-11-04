import type { Provider, Teammate } from "./types";

/** Whether a provider can actually answer a request.
 *
 *  A provider row can exist while still missing its connection details (an
 *  openai-compatible entry with no base URL or key is a placeholder, not a
 *  model). Counting those as ready is what let the old Home screen say
 *  "setup complete" above a disabled composer. Local and mock providers are
 *  usable as soon as they exist. */
export function providerIsUsable(provider: Provider): boolean {
  if (provider.status === "disabled") return false;
  if (provider.kind === "mock") return true;
  if (provider.kind !== "openai-compatible") return false;
  const config = provider.config ?? {};
  const baseUrl =
    typeof config.base_url === "string" ? config.base_url.trim() : "";
  const inlineKey =
    typeof config.api_key === "string" ? config.api_key.trim() : "";
  const envKey =
    typeof config.api_key_env === "string" ? config.api_key_env.trim() : "";
  return baseUrl !== "" && (inlineKey !== "" || envKey !== "");
}

export function usableProviders(providers: Provider[] | undefined): Provider[] {
  return (providers ?? []).filter(providerIsUsable);
}

/** The model a teammate will think with: its own attachment, or the
 *  project's default (the first usable provider). */
export function modelFor(
  teammate: Teammate,
  providers: Provider[] | undefined,
): Provider | undefined {
  const usable = usableProviders(providers);
  if (teammate.provider_id) {
    return usable.find((provider) => provider.id === teammate.provider_id);
  }
  return usable[0];
}
