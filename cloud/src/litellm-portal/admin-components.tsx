import { Badge } from "@cloudflare/kumo/components/badge";
import { Collapsible } from "@cloudflare/kumo/components/collapsible";
import { Empty } from "@cloudflare/kumo/components/empty";
import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import { Pagination } from "@cloudflare/kumo/components/pagination";
import { Table } from "@cloudflare/kumo/components/table";
import { Text } from "@cloudflare/kumo/components/text";
import { Tooltip } from "@cloudflare/kumo/components/tooltip";
import React, { useCallback, useState } from "react";
import { PanelSkeleton, PanelError } from "./components/panel-state";
import { SsrSafeSkeleton } from "./components/ssr-safe-skeleton";
import { useAdminUsers } from "./hooks/use-admin-users";
import { useAdminTeams } from "./hooks/use-admin-teams";
import { useAdminAudit } from "./hooks/use-admin-audit";
import type { UsageTimeseries } from "./chart";
import { fmt, fmtInt } from "./lib/format";

function text(value: unknown): string {
  return value == null || value === "" ? "—" : String(value);
}

// ---------------------------------------------------------------------------
// Section 1: AdminStatusHeader
// ---------------------------------------------------------------------------

type AdminStatusSummary = {
  riskCount?: number | null;
  overBudgetUserCount?: number | null;
  overBudgetTeamCount?: number | null;
  unmanagedRoleCount?: number | null;
  noTeamUserCount?: number | null;
  limited?: boolean;
};

function deriveHealthSummary(summary: AdminStatusSummary): { message: string; tone: "success" | "warning" | "danger" } {
  const overBudgetTeams = Number(summary.overBudgetTeamCount ?? 0);
  const overBudgetUsers = Number(summary.overBudgetUserCount ?? 0);
  const riskCount = Number(summary.riskCount ?? 0);
  const unmanagedRoles = Number(summary.unmanagedRoleCount ?? 0);
  const noTeamUsers = Number(summary.noTeamUserCount ?? 0);

  if (overBudgetTeams > 0 || overBudgetUsers > 0) {
    const parts: string[] = [];
    if (overBudgetTeams > 0) parts.push(`${overBudgetTeams} 个团队超预算`);
    if (overBudgetUsers > 0) parts.push(`${overBudgetUsers} 个用户超预算`);
    const tone = riskCount >= 10 ? "danger" : "warning";
    return { message: parts.join("，"), tone };
  }

  if (riskCount > 0) {
    const parts: string[] = [];
    if (unmanagedRoles > 0) parts.push(`${unmanagedRoles} 个未映射角色`);
    if (noTeamUsers > 0) parts.push(`${noTeamUsers} 个用户未关联团队`);
    return { message: parts.join("，") || `${riskCount} 个风险项`, tone: "warning" };
  }

  return { message: "系统正常", tone: "success" };
}

export function AdminStatusHeader({ summary, loading }: { summary: AdminStatusSummary; loading?: boolean }) {
  const { message, tone } = loading ? { message: "", tone: "success" as const } : deriveHealthSummary(summary);
  const healthVariant = tone === "success" ? "success" : tone === "danger" ? "danger" : "warning";

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-kumo-line bg-kumo-elevated px-4 py-3">
      <div className="flex flex-1 flex-wrap items-center gap-2">
        {loading ? (
          <SsrSafeSkeleton minWidth={160} maxWidth={280} blockHeight={16} />
        ) : (
          <Text size="sm" className={tone === "success" ? "text-kumo-success" : tone === "danger" ? "text-kumo-danger" : "text-kumo-warning"}>
            {message}
          </Text>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="neutral">只读</Badge>
        <Badge variant="warning">仅管理员可见</Badge>
        {summary.limited ? <Badge variant="info">样本视图</Badge> : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Section 4.1: AccountCell — identity rendering with fallback hierarchy
// ---------------------------------------------------------------------------

export function AccountCell({ email, userId }: { email: string | null | undefined; userId: string | null | undefined }) {
  const hasEmail = email != null && email !== "";
  const hasUserId = userId != null && userId !== "";

  if (hasEmail) {
    return (
      <div>
        <Tooltip content={email}>
          <span className="block max-w-[200px] truncate font-mono text-kumo-default">{email}</span>
        </Tooltip>
        {hasUserId ? (
          <span className="block max-w-[200px] truncate font-mono text-xs text-kumo-subtle">{userId}</span>
        ) : null}
      </div>
    );
  }

  if (hasUserId) {
    return (
      <div>
        <span className="block max-w-[200px] truncate font-mono text-kumo-default">{userId}</span>
        <Badge variant="neutral" className="mt-1 text-xs">无邮箱</Badge>
      </div>
    );
  }

  return <span className="font-mono text-kumo-subtle">(unknown)</span>;
}

// ---------------------------------------------------------------------------
// Section 4.2: RoleBadge — role column rendering
// ---------------------------------------------------------------------------

function RoleBadge({ role }: { role: string | null | undefined }) {
  if (role == null || role === "") return <span className="text-kumo-subtle">—</span>;
  const lower = role.toLowerCase();
  if (lower.includes("admin") || lower === "proxy_admin") {
    return <Badge variant="danger">{role}</Badge>;
  }
  if (lower === "internal_user" || lower.includes("user")) {
    return <Badge variant="info">{role}</Badge>;
  }
  return <Badge variant="neutral">{role}</Badge>;
}

// ---------------------------------------------------------------------------
// Section 4.3: ModelChips — chip list with +N overflow and tooltip
// ---------------------------------------------------------------------------

const MAX_VISIBLE_MODELS = 3;

function ModelChips({ models }: { models: string[] }) {
  if (models.length === 0) return <span className="text-kumo-subtle">—</span>;

  const visible = models.slice(0, MAX_VISIBLE_MODELS);
  const overflow = models.slice(MAX_VISIBLE_MODELS);

  return (
    <div className="flex flex-wrap items-center gap-1">
      {visible.map((model) => (
        <Badge key={model} variant="neutral" className="font-mono text-xs">{model}</Badge>
      ))}
      {overflow.length > 0 ? (
        <Tooltip content={overflow.join(", ")}>
          <Badge variant="info" className="cursor-default text-xs">+{overflow.length} 更多</Badge>
        </Tooltip>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Section 3.3: TopModelsPanel — rank + share + spend
// ---------------------------------------------------------------------------

export function TopModelsPanel({ data, loading }: { data: UsageTimeseries | null; loading: boolean }) {
  if (loading) {
    return (
      <div className="flex flex-col gap-3">
        {Array.from({ length: 3 }, (_, index) => (
          <div key={index} className="rounded-lg bg-kumo-recessed p-4">
            <SsrSafeSkeleton minWidth={120} maxWidth={220} blockHeight={16} />
            <SsrSafeSkeleton className="mt-2" minWidth={180} maxWidth={260} blockHeight={13} />
          </div>
        ))}
      </div>
    );
  }

  const models = data?.topModels ?? [];
  if (models.length === 0) {
    return <Text variant="secondary">暂无模型用量拆分。</Text>;
  }

  const totalSpend = models.reduce((sum, m) => sum + m.spend, 0);

  return (
    <div className="flex flex-col gap-2">
      {models.map((model, index) => {
        const share = totalSpend > 0 ? ((model.spend / totalSpend) * 100).toFixed(1) : "0.0";
        return (
          <div key={model.model} className="rounded-lg bg-kumo-recessed p-4 transition-colors hover:bg-kumo-tint">
            <div className="flex items-center gap-2">
              <Badge variant="neutral" className="shrink-0 font-mono text-xs">#{index + 1}</Badge>
              <Text variant="mono" className="truncate font-semibold">{model.model}</Text>
            </div>
            <Text variant="secondary" size="xs" as="p" className="mt-2">
              {fmt(model.spend)} · {share}% · {fmtInt(model.totalTokens)} tokens
            </Text>
          </div>
        );
      })}
    </div>
  );
}

type PortalRole = "admin" | "user" | "none";



const ADMIN_PAGE_SIZE = 50;

function AdminLoadingSkeleton() {
  return <PanelSkeleton lines={4} />;
}

function AdminErrorBanner({ message }: { message: string }) {
  return <PanelError title="数据加载失败" error={new Error(message)} />;
}

function AdminPager({
  page,
  setPage,
  totalCount,
  perPage,
}: {
  page: number;
  setPage: (next: number) => void;
  totalCount: number;
  perPage: number;
}) {
  if (totalCount <= perPage) return null;
  return (
    <Pagination
      className="border-t border-kumo-line px-6 py-4"
      controls="simple"
      page={page}
      setPage={setPage}
      perPage={perPage}
      totalCount={totalCount}
      labels={{
        navigation: "分页",
        firstPage: "首页",
        previousPage: "上一页",
        nextPage: "下一页",
        lastPage: "末页",
        pageNumber: "页码",
        pageSize: "每页条数",
      }}
    />
  );
}

export function AdminUsersTable() {
  const [page, setPage] = useState(1);
  const { data, isLoading, isError, error } = useAdminUsers(page, ADMIN_PAGE_SIZE);

  if (isLoading) {
    return <AdminLoadingSkeleton />;
  }
  if (isError) {
    return <AdminErrorBanner message={error instanceof Error ? error.message : "全员账户加载失败"} />;
  }
  if (!data || data.users.length === 0) {
    return <Empty size="sm" title="暂无用户数据" />;
  }

  return (
    <div>
      <div className="overflow-x-auto">
        <Table className="w-full text-left text-sm text-kumo-default">
          <Table.Header>
            <Table.Row className="border-b border-kumo-line">
              <Table.Head className="bg-kumo-base p-5 text-xs font-semibold uppercase tracking-wider text-kumo-subtle">账户</Table.Head>
              <Table.Head className="bg-kumo-base p-5 text-xs font-semibold uppercase tracking-wider text-kumo-subtle">角色</Table.Head>
              <Table.Head className="bg-kumo-base p-5 text-right text-xs font-semibold uppercase tracking-wider text-kumo-subtle">累计消费</Table.Head>
              <Table.Head className="bg-kumo-base p-5 text-right text-xs font-semibold uppercase tracking-wider text-kumo-subtle">团队数</Table.Head>
              <Table.Head className="bg-kumo-base p-5 text-right text-xs font-semibold uppercase tracking-wider text-kumo-subtle">最大预算</Table.Head>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {data.users.map((user) => (
              <Table.Row key={user.userId} className="border-b border-kumo-fill transition-colors hover:bg-kumo-tint">
                <Table.Cell className="py-3 pl-5 pr-3">
                  <AccountCell email={user.email} userId={user.userId} />
                </Table.Cell>
                <Table.Cell className="py-3 pr-3">
                  <RoleBadge role={user.role} />
                </Table.Cell>
                <Table.Cell className="py-3 pr-3 text-right font-mono text-kumo-default">{fmt(user.spend)}</Table.Cell>
                <Table.Cell className="py-3 pr-3 text-right font-mono text-kumo-default">{fmtInt(user.teamIds.length)}</Table.Cell>
                <Table.Cell className="py-3 pr-5 text-right font-mono text-kumo-default">{user.maxBudget == null ? "—" : fmt(user.maxBudget)}</Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table>
      </div>
      <AdminPager
        page={page}
        setPage={setPage}
        totalCount={data.totalCount}
        perPage={ADMIN_PAGE_SIZE}
      />
    </div>
  );
}

export function AdminTeamsTable() {
  const { data, isLoading, isError, error } = useAdminTeams();

  if (isLoading) {
    return <AdminLoadingSkeleton />;
  }
  if (isError) {
    return <AdminErrorBanner message={error instanceof Error ? error.message : "全部团队加载失败"} />;
  }
  if (!data || data.teams.length === 0) {
    return <Empty size="sm" title="暂无团队数据" />;
  }

  return (
    <div className="overflow-x-auto">
      <Table className="w-full text-left text-sm text-kumo-default">
        <Table.Header>
          <Table.Row className="border-b border-kumo-line">
            <Table.Head className="bg-kumo-base p-5 text-xs font-semibold uppercase tracking-wider text-kumo-subtle">ID</Table.Head>
            <Table.Head className="bg-kumo-base p-5 text-xs font-semibold uppercase tracking-wider text-kumo-subtle">别名</Table.Head>
            <Table.Head className="bg-kumo-base p-5 text-xs font-semibold uppercase tracking-wider text-kumo-subtle">可用模型</Table.Head>
            <Table.Head className="bg-kumo-base p-5 text-right text-xs font-semibold uppercase tracking-wider text-kumo-subtle">消费</Table.Head>
            <Table.Head className="bg-kumo-base p-5 text-right text-xs font-semibold uppercase tracking-wider text-kumo-subtle">TPM</Table.Head>
            <Table.Head className="bg-kumo-base p-5 text-right text-xs font-semibold uppercase tracking-wider text-kumo-subtle">RPM</Table.Head>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {data.teams.map((team) => (
            <Table.Row key={team.id} className="border-b border-kumo-fill transition-colors hover:bg-kumo-tint">
              <Table.Cell className="py-3 pl-5 pr-3 font-mono text-xs text-kumo-subtle">
                <Tooltip content={team.id}>
                  <span className="block max-w-[120px] truncate">{text(team.id)}</span>
                </Tooltip>
              </Table.Cell>
              <Table.Cell className="py-3 pr-3 text-kumo-default">{text(team.alias)}</Table.Cell>
              <Table.Cell className="py-3 pr-3">
                <ModelChips models={team.models} />
              </Table.Cell>
              <Table.Cell className="py-3 pr-3 text-right font-mono text-kumo-default">{fmt(team.spend)}</Table.Cell>
              <Table.Cell className="py-3 pr-3 text-right font-mono text-kumo-default">{team.tpmLimit == null ? "—" : fmtInt(team.tpmLimit)}</Table.Cell>
              <Table.Cell className="py-3 pr-5 text-right font-mono text-kumo-default">{team.rpmLimit == null ? "—" : fmtInt(team.rpmLimit)}</Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table>
    </div>
  );
}

export function AdminAuditFeed() {
  const [page, setPage] = useState(1);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const { data, isLoading, isError, error } = useAdminAudit({ page, size: ADMIN_PAGE_SIZE });

  const toggleRow = useCallback((id: string) => {
    setExpandedId((prev) => (prev === id ? null : id));
  }, []);

  if (isLoading) {
    return <AdminLoadingSkeleton />;
  }
  if (isError) {
    return <AdminErrorBanner message={error instanceof Error ? error.message : "审计日志加载失败"} />;
  }
  if (!data || data.events.length === 0) {
    return (
      <div className="p-6">
        <Empty
          size="sm"
          title="暂无审计日志"
          description="尚未记录管理员操作，admin 写操作开启后此处会出现条目。"
        />
      </div>
    );
  }

  return (
    <div>
      <div className="overflow-x-auto">
        <Table className="w-full text-left text-sm text-kumo-default">
          <Table.Header>
            <Table.Row className="border-b border-kumo-line">
              <Table.Head className="bg-kumo-base p-5 text-xs font-semibold uppercase tracking-wider text-kumo-subtle">创建时间</Table.Head>
              <Table.Head className="bg-kumo-base p-5 text-xs font-semibold uppercase tracking-wider text-kumo-subtle">操作</Table.Head>
              <Table.Head className="bg-kumo-base p-5 text-xs font-semibold uppercase tracking-wider text-kumo-subtle">操作者</Table.Head>
              <Table.Head className="bg-kumo-base p-5 text-xs font-semibold uppercase tracking-wider text-kumo-subtle">对象类型</Table.Head>
              <Table.Head className="bg-kumo-base p-5 text-xs font-semibold uppercase tracking-wider text-kumo-subtle">对象 ID</Table.Head>
              <Table.Head className="bg-kumo-base p-5 text-xs font-semibold uppercase tracking-wider text-kumo-subtle">详情</Table.Head>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {data.events.map((event) => (
              <React.Fragment key={event.id}>
                <Table.Row className="border-b border-kumo-fill transition-colors hover:bg-kumo-tint">
                  <Table.Cell className="py-3 pl-5 pr-3 font-mono text-xs text-kumo-subtle">{event.createdAt ? event.createdAt.slice(0, 19).replace("T", " ") : "—"}</Table.Cell>
                  <Table.Cell className="py-3 pr-3 text-kumo-default">{text(event.action)}</Table.Cell>
                  <Table.Cell className="py-3 pr-3 text-kumo-default">
                    <Tooltip content={event.actorUserEmail ?? event.actorUserId}>
                      <span className="block max-w-[160px] truncate">{text(event.actorUserEmail ?? event.actorUserId)}</span>
                    </Tooltip>
                  </Table.Cell>
                  <Table.Cell className="py-3 pr-3 text-kumo-subtle">{text(event.objectType)}</Table.Cell>
                  <Table.Cell className="py-3 pr-3 font-mono text-xs text-kumo-subtle">
                    <Tooltip content={event.objectId}>
                      <span className="block max-w-[120px] truncate">{text(event.objectId)}</span>
                    </Tooltip>
                  </Table.Cell>
                  <Table.Cell className="py-3 pr-5">
                    <button
                      type="button"
                      className="text-xs font-semibold text-kumo-brand hover:text-kumo-brand-hover"
                      onClick={() => toggleRow(event.id)}
                      aria-expanded={expandedId === event.id}
                    >
                      {expandedId === event.id ? "收起" : "展开"}
                    </button>
                  </Table.Cell>
                </Table.Row>
                {expandedId === event.id ? (
                  <Table.Row className="border-b border-kumo-fill bg-kumo-recessed">
                    <Table.Cell colSpan={6} className="px-5 py-4">
                      <div className="space-y-4 text-xs">
                        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-3">
                          <div>
                            <dt className="font-semibold uppercase tracking-wider text-kumo-subtle">操作者</dt>
                            <dd className="mt-1 font-mono text-kumo-default">{text(event.actorUserEmail ?? event.actorUserId)}</dd>
                          </div>
                          <div>
                            <dt className="font-semibold uppercase tracking-wider text-kumo-subtle">操作</dt>
                            <dd className="mt-1 text-kumo-default">{text(event.action)}</dd>
                          </div>
                          <div>
                            <dt className="font-semibold uppercase tracking-wider text-kumo-subtle">对象</dt>
                            <dd className="mt-1 font-mono text-kumo-default">{text(event.objectType)} {text(event.objectId)}</dd>
                          </div>
                          <div>
                            <dt className="font-semibold uppercase tracking-wider text-kumo-subtle">时间</dt>
                            <dd className="mt-1 font-mono text-kumo-subtle">{event.createdAt ? event.createdAt.slice(0, 19).replace("T", " ") : "—"}</dd>
                          </div>
                        </dl>
                        <div>
                          <Text variant="secondary" size="xs" className="mb-1 font-semibold uppercase tracking-wider">原始数据</Text>
                          <pre className="overflow-x-auto rounded-lg bg-kumo-base p-3 font-mono text-kumo-default ring-1 ring-kumo-line">{JSON.stringify(event, null, 2)}</pre>
                        </div>
                      </div>
                    </Table.Cell>
                  </Table.Row>
                ) : null}
              </React.Fragment>
            ))}
          </Table.Body>
        </Table>
      </div>
      <AdminPager
        page={page}
        setPage={setPage}
        totalCount={data.totalCount}
        perPage={ADMIN_PAGE_SIZE}
      />
    </div>
  );
}

export function AdminCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <LayerCard className="overflow-hidden p-0">
      <Collapsible.Root defaultOpen>
        <div className="flex items-center justify-between border-b border-kumo-line bg-kumo-elevated px-6 py-5">
          <Text variant="heading3" as="p">{title}</Text>
          <Collapsible.DefaultTrigger className="text-sm font-medium text-kumo-brand hover:text-kumo-brand-hover">
            <span className="sr-only">折叠或展开</span>
          </Collapsible.DefaultTrigger>
        </div>
        <Collapsible.Panel>
          {children}
        </Collapsible.Panel>
      </Collapsible.Root>
    </LayerCard>
  );
}

export function AdminSection({ role }: { role: PortalRole }) {
  if (role !== "admin") return null;

  return (
    <section className="space-y-8" aria-label="全局管理（只读）">
      <div className="flex flex-wrap items-center gap-3">
        <Text variant="heading2" as="h2">全局管理（只读）</Text>
        <Badge variant="secondary" className="rounded-full bg-kumo-warning-tint text-kumo-warning">仅管理员可见</Badge>
      </div>
      <div className="space-y-4">
        <div>
          <Text variant="secondary" as="p" className="font-semibold uppercase tracking-wider">资源与权限</Text>
          <Text variant="secondary" as="p" className="mt-1">账户、团队和模型范围保持和个人视图相同的数据语言。</Text>
        </div>
        <AdminCard title="全员账户">
          <AdminUsersTable />
        </AdminCard>
        <AdminCard title="全部团队">
          <AdminTeamsTable />
        </AdminCard>
      </div>
      <div className="space-y-4">
        <div>
          <Text variant="secondary" as="p" className="font-semibold uppercase tracking-wider">审计与风险</Text>
          <Text variant="secondary" as="p" className="mt-1">用于核对近期变更和风险线索，当前保持只读。</Text>
        </div>
        <AdminCard title="审计日志">
        <AdminAuditFeed />
        </AdminCard>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Section 5: SyncStatusBadge — per-row DO sync state indicator
// ---------------------------------------------------------------------------

export type SyncStatusBadgeProps = {
  lastSyncedAt?: string | null;
  lastSyncError?: string | null;
  dirty?: boolean;
};

function relativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(diffMs) || diffMs < 0) return "just now";
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return "just now";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}d ago`;
}

export function SyncStatusBadge({ lastSyncedAt, lastSyncError, dirty }: SyncStatusBadgeProps): JSX.Element | null {
  if (lastSyncError) {
    return (
      <Tooltip content={lastSyncError}>
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-kumo-danger" title={lastSyncError}>
          <span className="inline-block h-2 w-2 shrink-0 rounded-full bg-kumo-danger" aria-hidden="true" />
          Sync failed
        </span>
      </Tooltip>
    );
  }
  if (dirty) {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-kumo-warning" title="A change is queued for sync to LiteLLM.">
        <span className="inline-block h-2 w-2 shrink-0 rounded-full bg-kumo-warning" aria-hidden="true" />
        Syncing…
      </span>
    );
  }
  if (lastSyncedAt) {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-kumo-success" title={`Last synced at ${lastSyncedAt}`}>
        <span className="inline-block h-2 w-2 shrink-0 rounded-full bg-kumo-success" aria-hidden="true" />
        Synced {relativeTime(lastSyncedAt)}
      </span>
    );
  }
  return null;
}
