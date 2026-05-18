import React from "react";
import { PanelCard } from "../../ui";

export type AlertTone = "success" | "warning" | "danger";
export type AlertItem = { tone: AlertTone; title: string; text: string };

const DOT: Record<AlertTone, string> = {
  success: "bg-kumo-success",
  warning: "bg-kumo-warning",
  danger: "bg-kumo-danger",
};

export function AlertPanel({ alerts }: { alerts: AlertItem[] }) {
  if (alerts.length === 0) return null;
  return (
    <PanelCard title="告警面板">
      {alerts.map((a, i) => (
        <div key={i} className="flex items-start gap-2 border-b border-kumo-fill py-2 last:border-0 text-sm">
          <span data-dot={a.tone} className={`mt-1.5 h-2 w-2 flex-none rounded-full ${DOT[a.tone]}`} />
          <span className="text-kumo-default"><b className="text-kumo-strong">{a.title}</b> {a.text}</span>
        </div>
      ))}
    </PanelCard>
  );
}
