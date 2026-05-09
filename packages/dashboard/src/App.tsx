import { useEffect, useMemo, useState } from "react";
import { AppLayout } from "./components/AppLayout";
import type { CloudDashboardView } from "./components/CloudDashboardViews";
import type { CloudBoardSnapshot } from "./cloudModels";
import { TooltipProvider } from "./components/ui/tooltip";
import { useSSE } from "./hooks/useSSE";
import { useTeamSubscription } from "./hooks/useTeamSubscription";
import { formatDuration } from "./i18n/format";
import { zhCN } from "./i18n/messages";

function computeRuntimeSeconds(startTime: string | undefined): number {
  if (!startTime) {
    return 0;
  }

  const start = Date.parse(startTime);
  // Guard against Go zero time ("0001-01-01T00:00:00Z") and other pre-epoch dates
  if (Number.isNaN(start) || start <= 0) {
    return 0;
  }

  return Math.max(0, Math.floor((Date.now() - start) / 1000));
}

function activeTeamIdFromPath(pathname: string): string | null {
  const match = /^\/t\/([^/]+)/u.exec(pathname);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

function cloudViewFromPath(pathname: string): CloudDashboardView {
  const match = /^\/t\/[^/]+\/([^/]+)/u.exec(pathname);
  switch (match?.[1]) {
    case "runs":
      return "runs";
    case "config":
      return "config";
    case "tracker":
      return "tracker";
    case "board":
    default:
      return "board";
  }
}

function teamPath(teamId: string, view: CloudDashboardView): string {
  return `/t/${encodeURIComponent(teamId)}/${view}`;
}

function App() {
  const {
    state,
    connected,
    error,
    queueEvents,
    teamSnapshot,
    agentLogs,
    applyDashboardFrame,
  } = useSSE();
  const [pathname, setPathname] = useState(window.location.pathname);
  const activeTeamId = activeTeamIdFromPath(pathname);
  const activeCloudView = cloudViewFromPath(pathname);
  const teamSubscription = useTeamSubscription(activeTeamId);
  const [runtimeSeconds, setRuntimeSeconds] = useState(0);
  const startTime = state?.stats.StartTime;

  useEffect(() => {
    const handlePopState = () => setPathname(window.location.pathname);
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  function navigateTeam(teamId: string, view: CloudDashboardView = activeCloudView) {
    const nextPath = teamPath(teamId, view);
    window.history.pushState({}, "", nextPath);
    setPathname(nextPath);
  }

  function navigateView(view: CloudDashboardView) {
    if (!activeTeamId) {
      return;
    }
    navigateTeam(activeTeamId, view);
  }

  function applyBoardSnapshot(board: CloudBoardSnapshot) {
    applyDashboardFrame({ type: "board-update", board });
  }

  useEffect(() => {
    if (teamSubscription.latestFrame) {
      applyDashboardFrame(teamSubscription.latestFrame);
    }
  }, [applyDashboardFrame, teamSubscription.latestFrame]);

  useEffect(() => {
    if (!startTime) {
      setRuntimeSeconds(0);
      return;
    }

    setRuntimeSeconds(computeRuntimeSeconds(startTime));

    const timer = window.setInterval(() => {
      setRuntimeSeconds(computeRuntimeSeconds(startTime));
    }, 1000);

    return () => window.clearInterval(timer);
  }, [startTime]);

  const runtimeLabel = useMemo(
    () => formatDuration(runtimeSeconds),
    [runtimeSeconds],
  );

  if (!state) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-background px-6 text-muted-foreground">
        <div className="rounded-2xl border border-border/70 bg-card/80 px-6 py-5 text-center shadow-lg">
          <p className="text-xs font-semibold uppercase tracking-[0.22em] text-primary">
            Contrabass
          </p>
          <p className="mt-2 text-sm">{zhCN.app.sections.runningSessions}…</p>
        </div>
      </div>
    );
  }

  return (
    <TooltipProvider>
      <div className="flex h-dvh w-full flex-col overflow-hidden bg-background text-foreground">
        {teamSubscription.reconnecting ? (
          <div
            className="border-b border-amber-500/40 bg-amber-500/15 px-4 py-2 text-xs font-medium text-amber-700"
            role="status"
          >
            Reconnecting to live team updates…
          </div>
        ) : null}
        {error || teamSubscription.error ? (
          <div
            className="border-b border-destructive/40 bg-destructive/15 px-4 py-2 text-xs font-medium text-destructive"
            role="alert"
          >
            {zhCN.app.connectionError}: {error ?? teamSubscription.error}
          </div>
        ) : null}
        <div className="flex-1 overflow-hidden">
          <AppLayout
            state={state}
            connected={connected}
            runtimeLabel={runtimeLabel}
            queueEvents={queueEvents}
            activeTeamId={activeTeamId}
            activeCloudView={activeCloudView}
            onTeamChange={navigateTeam}
            onCloudViewChange={navigateView}
            onApplyBoardFrame={applyBoardSnapshot}
            teamSnapshot={teamSnapshot}
            agentLogs={agentLogs}
          />
        </div>
      </div>
    </TooltipProvider>
  );
}

export default App;
