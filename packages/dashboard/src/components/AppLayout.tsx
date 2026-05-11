import { useEffect, useMemo, useRef, useState } from "react";
import { Badge, Grid, GridItem, LayerCard, Sidebar, Text } from "@cloudflare/kumo";
import type {
  BackoffEntry,
  DetailSelection,
  DetailSelectionKind,
  Issue,
  RunningEntry,
  SheetData,
  StateSnapshot,
  TeamSnapshot,
  AgentLogEvent,
} from "../types";
import type { QueueEventPayload } from "../hooks/useSSE";
import { AppSidebar, type QueueId } from "./AppSidebar";
import { IssueDataTable } from "./IssueDataTable";
import { IssueDetailSheet } from "./IssueDetailSheet";
import { QueuePanel } from "./QueuePanel";
import { CloudDashboardViews, type CloudDashboardView } from "./CloudDashboardViews";
import type { CloudBoardSnapshot } from "../cloudModels";

interface AppLayoutProps {
  state: StateSnapshot;
  connected: boolean;
  runtimeLabel: string;
  queueEvents?: QueueEventPayload[];
  activeTeamId: string | null;
  activeCloudView: CloudDashboardView;
  onTeamChange: (teamId: string, view?: CloudDashboardView) => void;
  onCloudViewChange: (view: CloudDashboardView) => void;
  onApplyBoardFrame: (board: CloudBoardSnapshot) => void;
  teamSnapshot: TeamSnapshot | null;
  agentLogs: AgentLogEvent[];
}

interface QueueDef {
  id: QueueId;
  title: string;
  rows: RunningEntry[];
  emptyText: string;
}

export function getLinearState(issue: Issue): string | undefined {
  const meta = issue.tracker_meta as Record<string, unknown> | undefined;
  if (!meta) return undefined;
  const v = meta["linear_state"];
  return typeof v === "string" ? v : undefined;
}

function backoffAsRunningRow(entry: BackoffEntry, issue?: Issue): RunningEntry {
  return {
    issue_id: entry.issue_id,
    attempt: entry.attempt,
    pid: 0,
    session_id: "",
    workspace: "",
    started_at: entry.retry_at,
    phase: 0,
    tokens_in: 0,
    tokens_out: 0,
    last_activity_at: issue?.updated_at,
    last_activity_kind: "backoff_enqueued",
    diff_added: 0,
    diff_removed: 0,
    diff_files: 0,
    diff_status: "ok",
    phase_label: `attempt ${entry.attempt}`,
  };
}

function issueAsTodoRow(issue: Issue): RunningEntry {
  return {
    issue_id: issue.id,
    attempt: 0,
    pid: 0,
    session_id: issue.identifier ?? "",
    workspace: "",
    started_at: issue.updated_at ?? "",
    phase: 0,
    tokens_in: 0,
    tokens_out: 0,
    phase_label: issue.identifier,
    last_activity_kind: issue.title,
    diff_status: "ok",
  };
}

function queueIdToKind(qid: QueueId): DetailSelectionKind {
  switch (qid) {
    case "running":
      return "running";
    case "backoff":
      return "backoff";
    case "todo":
      return "todo";
    case "backlog":
      return "todo";
    case "recent_done":
      return "done";
    case "canceled":
      return "canceled";
  }
}

export function AppLayout({
  state,
  connected,
  runtimeLabel,
  queueEvents = [],
  activeTeamId,
  activeCloudView,
  onTeamChange,
  onCloudViewChange,
  onApplyBoardFrame,
  teamSnapshot,
  agentLogs,
}: AppLayoutProps) {
  const [active, setActive] = useState<QueueId>("running");
  const [selection, setSelection] = useState<DetailSelection | null>(null);
  const lastKnownSheetRef = useRef<SheetData | null>(null);

  const issuesArray = useMemo<Issue[]>(
    () => Object.values(state.issues ?? {}),
    [state.issues],
  );

  const queues = useMemo<Record<QueueId, QueueDef>>(() => {
    const running = state.running ?? [];
    const backoff = state.backoff ?? [];
    const todo = issuesArray.filter((i) => getLinearState(i) === "Todo");
    const backlog = issuesArray.filter((i) => getLinearState(i) === "Backlog");
    const done = issuesArray.filter((i) => {
      const s = getLinearState(i);
      return s === "Done" || s === "Released";
    });
    const canceled = issuesArray.filter((i) => {
      const s = getLinearState(i);
      return s === "Canceled" || s === "Won't Do";
    });

    return {
      running: {
        id: "running",
        title: "运行中",
        rows: running,
        emptyText: "暂无运行中任务",
      },
      backoff: {
        id: "backoff",
        title: "退避队列",
        rows: backoff.map((b) =>
          backoffAsRunningRow(b, state.issues?.[b.issue_id]),
        ),
        emptyText: "退避队列为空",
      },
      todo: {
        id: "todo",
        title: "待办",
        rows: todo.map(issueAsTodoRow),
        emptyText: "Todo 列表为空",
      },
      backlog: {
        id: "backlog",
        title: "Backlog",
        rows: backlog.map(issueAsTodoRow),
        emptyText: "Backlog 列表为空",
      },
      recent_done: {
        id: "recent_done",
        title: "最近完成",
        rows: done.slice(0, 50).map(issueAsTodoRow),
        emptyText: "暂无近期完成任务",
      },
      canceled: {
        id: "canceled",
        title: "取消",
        rows: canceled.map(issueAsTodoRow),
        emptyText: "暂无取消任务",
      },
    };
  }, [state.running, state.backoff, state.issues, issuesArray]);

  const counts: Partial<Record<QueueId, number>> = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(queues).map(([k, q]) => [k, q.rows.length]),
      ) as Partial<Record<QueueId, number>>,
    [queues],
  );

  const sheetData = useMemo<SheetData | null>(() => {
    if (!selection) return null;
    const { kind, issueId } = selection;
    const issue = state.issues?.[issueId];
    if (kind === "running") {
      const running = state.running?.find((e) => e.issue_id === issueId);
      return { kind, issue, running, backoff: undefined };
    }
    if (kind === "backoff") {
      const backoff = state.backoff?.find((e) => e.issue_id === issueId);
      return { kind, issue, running: undefined, backoff };
    }
    return { kind, issue, running: undefined, backoff: undefined };
  }, [selection, state.running, state.backoff, state.issues]);

  useEffect(() => {
    if (sheetData) lastKnownSheetRef.current = sheetData;
  }, [sheetData]);

  const currentQueue = queues[active];
  const queuedTotal =
    (counts.backoff ?? 0) + (counts.todo ?? 0) + (counts.backlog ?? 0);
  const doneTotal = (counts.recent_done ?? 0) + (counts.canceled ?? 0);

  return (
    <Sidebar.Provider className="flex h-full min-h-0 bg-kumo-canvas">
      <AppSidebar
        active={active}
        onSelect={(id) => {
          setActive(id);
          setSelection(null);
        }}
        counts={counts}
        connected={connected}
        runtimeLabel={runtimeLabel}
      />
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <LayerCard className="m-3 flex shrink-0 flex-wrap items-center gap-3 p-3">
          <Sidebar.Trigger />
          <div className="min-w-0 flex-1">
            <Text variant="secondary" size="sm">Control Queue</Text>
            <Text variant="heading3" as="h2" truncate>{currentQueue.title}</Text>
          </div>
          <Badge variant="secondary">{currentQueue.rows.length} 项</Badge>
          {state.build_info && state.build_info.commit ? (
            <Badge variant="outline">
              {state.build_info.version}@{state.build_info.commit}
            </Badge>
          ) : null}
        </LayerCard>
        <div className="min-h-0 flex-1 overflow-hidden p-3 pt-0">
          <div className="mx-auto flex h-full max-w-screen-2xl min-w-0 flex-col gap-4">
            <section aria-label="队列摘要">
              <Grid variant="4up" gap="sm">
                <GridItem>
                  <OverviewCard
                    label="连接"
                    value={connected ? "在线" : "离线"}
                    tone={connected ? "live" : "warn"}
                  />
                </GridItem>
                <GridItem>
                  <OverviewCard
                    label="运行负载"
                    value={`${state.stats.Running}/${state.stats.MaxAgents}`}
                  />
                </GridItem>
                <GridItem>
                  <OverviewCard label="待处理" value={queuedTotal} />
                </GridItem>
                <GridItem>
                  <OverviewCard
                    label="归档"
                    value={doneTotal}
                  />
                </GridItem>
              </Grid>
            </section>

            <section className="min-h-0 flex-1 overflow-hidden">
              <CloudDashboardViews
                teamId={activeTeamId}
                view={activeCloudView}
                state={state}
                teamSnapshot={teamSnapshot}
                agentLogs={agentLogs}
                onTeamChange={onTeamChange}
                onViewChange={onCloudViewChange}
                onApplyBoardFrame={onApplyBoardFrame}
              />
            </section>

            <QueuePanel events={queueEvents} />

            <section className="max-h-72 overflow-hidden">
              <IssueDataTable
                entries={currentQueue.rows}
                emptyText={currentQueue.emptyText}
                onSelect={(entry) =>
                  setSelection({
                    kind: queueIdToKind(active),
                    issueId: entry.issue_id,
                  })
                }
                selectedId={selection?.issueId ?? null}
              />
            </section>
          </div>
        </div>
      </div>
      <IssueDetailSheet
        data={selection ? (sheetData ?? lastKnownSheetRef.current) : null}
        isStale={!!selection && !sheetData}
        onOpenChange={(open) => {
          if (!open) setSelection(null);
        }}
      />
    </Sidebar.Provider>
  );
}

function OverviewCard({
  label,
  value,
  subtle,
  tone,
}: {
  label: string;
  value: string | number;
  subtle?: string;
  tone?: "live" | "warn";
}) {
  return (
    <LayerCard className="p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <Text variant="secondary" size="sm">{label}</Text>
          <Text variant="heading2" as="p">{value}</Text>
        </div>
        {tone ? (
          <Badge variant={tone === "live" ? "success" : "warning"}>
            {tone === "live" ? "Live" : "Warn"}
          </Badge>
        ) : null}
      </div>
      {subtle ? <Text variant="mono-secondary" truncate>{subtle}</Text> : null}
    </LayerCard>
  );
}
