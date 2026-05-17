import { useEffect, useState } from "react";

/**
 * #418-safe hydration gate. Returns `false` during SSR AND during the client's
 * first (hydration) render — so any subtree gated on it renders the SAME
 * deterministic markup on both, eliminating hydration mismatches. Flips to
 * `true` in a post-commit `useEffect` (client-only), after which non-
 * deterministic / browser-only UI may mount. Same discipline as the Task-3
 * post-hydration warm-up: dynamic bits appear only AFTER hydrateRoot.
 *
 * Pure: no `window`/`document` access during render (the effect is the only
 * client-only touch), SSR-safe, no deps.
 */
export function useHasHydrated(): boolean {
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    setHydrated(true);
  }, []);
  return hydrated;
}
