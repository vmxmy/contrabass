import React from "react";
import { Empty } from "@cloudflare/kumo/components/empty";
import { SkeletonLine } from "@cloudflare/kumo/components/loader";
import { Table } from "@cloudflare/kumo/components/table";
import { Text } from "@cloudflare/kumo/components/text";
import { fmt } from "../lib/format";
import { useDashboard } from "../hooks/use-dashboard";
import { normalizeKeys, text } from "./utils";
import { BudgetBadge } from "./budget-badge";
import { ModelsCell } from "./model-badges";
import { DeleteKeyButton } from "./delete-key-button";
import { CreateKeyButton } from "./create-key-button";
import { PanelCard } from "../ui";

export function ApiKeysCard() {
  const { data, isLoading } = useDashboard();
  const keys = normalizeKeys(data?.keys?.items);
  const loaded = !isLoading;

  return (
    <PanelCard
      title="API Keys"
      subtitle="仅列出当前 LiteLLM 用户拥有的密钥。"
      actions={<CreateKeyButton />}
      padded={false}
    >
      <div className="overflow-x-auto">
        {!loaded ? (
          <div className="space-y-3 p-6" aria-live="polite">
            {Array.from({ length: 4 }, (_, index) => (
              <SkeletonLine key={index} minWidth={260} maxWidth={760} blockHeight={20} />
            ))}
          </div>
        ) : keys.length === 0 ? (
          <Empty size="sm" title="暂无 API Key" />
        ) : (
          <Table className="w-full text-left text-sm text-kumo-default">
            <Table.Header>
              <Table.Row className="border-b border-kumo-line">
                <Table.Head className="bg-kumo-base p-5 text-xs font-semibold uppercase tracking-wider text-kumo-subtle">名称</Table.Head>
                <Table.Head className="bg-kumo-base p-5 text-xs font-semibold uppercase tracking-wider text-kumo-subtle">Key</Table.Head>
                <Table.Head className="bg-kumo-base p-5 text-xs font-semibold uppercase tracking-wider text-kumo-subtle">模型</Table.Head>
                <Table.Head className="bg-kumo-base p-5 text-right text-xs font-semibold uppercase tracking-wider text-kumo-subtle">花费</Table.Head>
                <Table.Head className="bg-kumo-base p-5 text-right text-xs font-semibold uppercase tracking-wider text-kumo-subtle">预算</Table.Head>
                <Table.Head className="bg-kumo-base p-5 text-xs font-semibold uppercase tracking-wider text-kumo-subtle">过期时间</Table.Head>
                <Table.Head className="bg-kumo-base p-5 text-right text-xs font-semibold uppercase tracking-wider text-kumo-subtle">操作</Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {keys.map((key, index) => {
                const displayKey = text(key.displayKey);
                const spend = Number(key.spend || 0);
                const spendColor = spend > 100 ? "text-kumo-danger" : spend > 10 ? "text-kumo-warning" : "text-kumo-default";
                const models = Array.isArray(key.models) ? key.models : [];
                return (
                  <Table.Row key={key.id ?? key.alias ?? index} className="border-b border-kumo-fill transition-colors hover:bg-kumo-tint">
                    <Table.Cell className="py-3 pl-5 pr-3 text-kumo-default">{text(key.alias)}</Table.Cell>
                    <Table.Cell className="py-3 pr-3 text-kumo-default">
                      <code className="font-mono text-sm text-kumo-subtle">{displayKey}</code>
                    </Table.Cell>
                    <Table.Cell className="py-3 pr-3 text-kumo-default">
                      <ModelsCell models={models} />
                    </Table.Cell>
                    <Table.Cell className={`py-3 pr-3 text-right font-mono ${spendColor}`}>{fmt(key.spend)}</Table.Cell>
                    <Table.Cell className="py-3 pr-3 text-right font-mono text-kumo-default">
                      {key.maxBudget == null ? "—" : fmt(key.maxBudget)}
                      <BudgetBadge spend={key.spend} maxBudget={key.maxBudget} />
                    </Table.Cell>
                    <Table.Cell className="py-3 pr-5 text-kumo-default">{text(key.expiresAt)}</Table.Cell>
                    <Table.Cell className="py-3 pr-5 text-right">
                      <DeleteKeyButton apiKey={key} />
                    </Table.Cell>
                  </Table.Row>
                );
              })}
            </Table.Body>
          </Table>
        )}
      </div>
    </PanelCard>
  );
}
