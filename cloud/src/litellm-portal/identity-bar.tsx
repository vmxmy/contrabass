import React from "react";
import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import { Text } from "@cloudflare/kumo/components/text";
import { useDashboard } from "./hooks/use-dashboard";
import { fmt, fmtInt } from "./lib/format";

function text(value: unknown): string {
  return value == null || value === "" ? "—" : String(value);
}

function IdentityItem({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <Text variant="secondary" size="xs" className="font-semibold uppercase tracking-wider">{label}</Text>
      <Text variant={mono ? "mono" : "primary"} as="p" className="mt-1 truncate text-sm font-semibold text-kumo-strong">
        {value}
      </Text>
    </div>
  );
}

export function IdentityBar() {
  const { data } = useDashboard();
  const email = text(data?.me?.email ?? data?.email);
  const totalSpend = fmt(data?.user?.totalSpend);
  const recentSpend = data?.usage?.available === false ? "暂无数据" : fmt(data?.summary?.recentSpend);
  const modelCount = `${fmtInt(data?.summary?.availableModelCount)} 模型`;

  return (
    <LayerCard id="identity-bar-root" className="mb-8 p-4">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-[minmax(0,2fr)_repeat(3,minmax(0,1fr))] lg:items-center">
        <IdentityItem label="当前身份" value={email} mono />
        <IdentityItem label="总消费" value={totalSpend} mono />
        <IdentityItem label="30d 用量" value={recentSpend} mono />
        <IdentityItem label="模型数" value={modelCount} mono />
      </div>
    </LayerCard>
  );
}
