import { Miniflare } from "miniflare";

// Local only. Kept within the pinned workerd 1.20260730.1 release's supported
// compatibility range. This does not change any deployed Worker configuration.
export const LOCAL_COMPATIBILITY_DATE = "2026-07-30";
export function createLocalRuntime(options) {
  return new Miniflare({
    ...options,
    compatibilityDate: LOCAL_COMPATIBILITY_DATE,
  });
}
