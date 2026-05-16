import React from "react";
import { DASHBOARD_WINDOWS, type DashboardWindow } from "../dashboard-schemas";

export function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-4 rounded-xl border border-kumo-line bg-kumo-base">
      <div className="border-b border-kumo-line bg-kumo-elevated px-5 py-3 text-sm font-semibold text-kumo-strong">{title}</div>
      <div className="p-5">{children}</div>
    </div>
  );
}

export function WindowSelector({
  value,
  onChange,
}: {
  value: DashboardWindow;
  onChange: (next: DashboardWindow) => void;
}) {
  return (
    <div className="mb-4 flex flex-wrap gap-1" aria-label="用量时间窗口">
      {DASHBOARD_WINDOWS.map((windowValue) => (
        <button
          key={windowValue}
          type="button"
          onClick={() => onChange(windowValue)}
          className={`rounded-full px-4 py-1.5 text-sm ${
            windowValue === value
              ? "bg-kumo-brand text-kumo-inverse"
              : "text-kumo-subtle hover:bg-kumo-tint"
          }`}
        >
          {windowValue}
        </button>
      ))}
    </div>
  );
}
