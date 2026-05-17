import type React from "react";

/**
 * Map a tenant brand into CSS custom properties applied to the Tenant Portal
 * shell root. Task 1 ships the final signature with a no-op body; Task 9
 * replaces the body with the real brand-variable mapping (logo/color tokens).
 */
export function applyBrandVars(_b: {
  name: string;
  logoUrl: string | null;
  primaryColor: string | null;
}): React.CSSProperties {
  return {};
}
