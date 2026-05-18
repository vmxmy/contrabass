import React, { useState } from "react";
import { Badge } from "@cloudflare/kumo/components/badge";
import { Collapsible } from "@cloudflare/kumo/components/collapsible";
import { modelBadgeColor, MODEL_CELL_PREVIEW_LIMIT } from "./utils";

export function ModelBadges({ models }: { models: string[] }) {
  if (models.length === 0) {
    return <Badge variant="secondary">团队暂未配置可用模型</Badge>;
  }

  return (
    <>
      {models.map((model) => (
        <Badge
          key={model}
          variant="secondary"
          className={`rounded-full px-2.5 py-1 font-mono text-xs ${modelBadgeColor(model)}`}
        >
          {model}
        </Badge>
      ))}
    </>
  );
}

export function ModelsCell({ models }: { models: string[] }) {
  const [open, setOpen] = useState(false);
  if (models.length === 0) return <span className="text-kumo-subtle">—</span>;
  const visible = models.slice(0, MODEL_CELL_PREVIEW_LIMIT);
  const rest = models.slice(MODEL_CELL_PREVIEW_LIMIT);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5">
        <ModelBadges models={visible} />
      </div>
      {rest.length > 0 ? (
        <Collapsible.Root open={open} onOpenChange={setOpen}>
          <Collapsible.DefaultTrigger className="text-xs font-semibold text-kumo-brand hover:text-kumo-brand-hover">
            {open ? "收起模型" : `展开全部，另有 ${rest.length} 个`}
          </Collapsible.DefaultTrigger>
          {open ? (
            <div className="mt-2 flex max-w-xl flex-wrap gap-1.5 rounded-lg bg-kumo-recessed p-3" role="region" aria-label="API Key 完整模型列表">
              <ModelBadges models={models} />
            </div>
          ) : null}
        </Collapsible.Root>
      ) : null}
    </div>
  );
}
