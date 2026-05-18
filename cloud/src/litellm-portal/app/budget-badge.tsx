import React from "react";
import { Badge } from "@cloudflare/kumo/components/badge";
import { Popover } from "@cloudflare/kumo/components/popover";
import { statusTone, budgetLabel } from "./utils";

export function BudgetInfoPopover() {
  return (
    <Popover>
      <Popover.Trigger
        render={
          <button
            type="button"
            className="inline-flex h-4 w-4 items-center justify-center rounded-full text-[10px] font-bold leading-none text-kumo-subtle ring-1 ring-kumo-line hover:bg-kumo-tint hover:text-kumo-default focus:outline-none focus-visible:ring-2 focus-visible:ring-kumo-focus"
            aria-label="预算阈值说明"
          >
            ?
          </button>
        }
      />
      <Popover.Content className="max-w-xs p-4">
        <Popover.Title className="mb-2 text-sm font-semibold text-kumo-strong">预算阈值说明</Popover.Title>
        <Popover.Description className="space-y-1 text-xs text-kumo-subtle">
          <p><span className="font-semibold text-kumo-success">正常</span>：花费低于预算的 80%</p>
          <p><span className="font-semibold text-kumo-warning">即将超支</span>：花费达到预算的 80%–99%</p>
          <p><span className="font-semibold text-kumo-danger">超预算</span>：花费已达到或超过预算</p>
        </Popover.Description>
      </Popover.Content>
    </Popover>
  );
}

export function BudgetBadge({ spend, maxBudget }: { spend: unknown; maxBudget: unknown }) {
  const tone = statusTone(spend, maxBudget);
  if (!tone) return null;
  const variant = tone === "danger" ? "error" : tone === "warning" ? "warning" : "success";
  return (
    <>
      <Badge variant={variant} className="ml-2">
        {budgetLabel(tone)}
      </Badge>
      <BudgetInfoPopover />
    </>
  );
}
