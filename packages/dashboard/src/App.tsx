import { useEffect, useMemo, useState } from "react";
import { AppLayout } from "./components/AppLayout";
import { VersionSkewBanner } from "./components/VersionSkewBanner";
import type { CloudDashboardView } from "./components/CloudDashboardViews";
import type { CloudBoardSnapshot } from "./cloudModels";
import { Banner, LayerCard, Loader, Text, TooltipProvider } from "@cloudflare/kumo";
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
      <div className="flex min-h-dvh items-center justify-center bg-kumo-canvas p-6">
        <LayerCard className="grid justify-items-center gap-3 p-6">
          <Text variant="heading3" as="p">Contrabass</Text>
          <Loader aria-label={zhCN.app.sections.runningSessions} />
          <Text variant="secondary" size="sm">{zhCN.app.sections.runningSessions}…</Text>
        </LayerCard>
      </div>
    );
  }

  return (
    <TooltipProvider>
      <div className="flex h-dvh w-full flex-col overflow-hidden bg-kumo-canvas text-kumo-default">
        <VersionSkewBanner />
        {teamSubscription.reconnecting ? (
          <Banner variant="alert" title="Reconnecting to live team updates…" />
        ) : null}
        {error || teamSubscription.error ? (
          <Banner
            variant="error"
            title={zhCN.app.connectionError}
            description={error ?? teamSubscription.error}
          />
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
