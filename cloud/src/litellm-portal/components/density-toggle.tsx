import React from "react";
import { Button } from "@cloudflare/kumo/components/button";
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { Density } from "./density";

/**
 * §F.1 comfortable↔compact toggle. Controlled + presentational; the Ops shell
 * passes the resolved current density and an onChange that persists via
 * useUpdatePreferences (Step 5). Keyboard-reachable (Kumo Button = real
 * <button>, Tab + Enter/Space). NOT mounted on the Tenant Portal (Tenant stays
 * comfortable by design — §F.1).
 */
export function DensityToggle({
  current,
  onChange,
}: {
  current: Density;
  onChange: (next: Density) => void;
}) {
  const next: Density = current === "compact" ? "comfortable" : "compact";
  return (
    <Button
      variant="ghost"
      size="sm"
      aria-pressed={current === "compact"}
      aria-label={t`切换显示密度`}
      onClick={() => onChange(next)}
    >
      {current === "compact" ? <Trans>紧凑</Trans> : <Trans>宽松</Trans>}
    </Button>
  );
}
