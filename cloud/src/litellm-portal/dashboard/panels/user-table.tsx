import React from "react";

export type UserRow = {
  userId: string; email: string; spend: number;
  maxBudget: number | null; role: "admin" | "user";
};

export function UserTable({
  rows, onSelect,
}: {
  rows: UserRow[];
  onSelect: (p: { userId: string; maxBudget: number | null }) => void;
}) {
  if (rows.length === 0) {
    return <p className="py-10 text-center text-sm text-kumo-subtle">暂无用户</p>;
  }
  return (
    <table className="w-full text-left text-sm text-kumo-default">
      <thead>
        <tr className="border-b border-kumo-line">
          <th className="pb-3 pr-3 text-xs uppercase tracking-wider text-kumo-subtle">用户</th>
          <th className="pb-3 pr-3 text-right text-xs uppercase tracking-wider text-kumo-subtle">消费</th>
          <th className="pb-3 pr-3 text-right text-xs uppercase tracking-wider text-kumo-subtle">预算</th>
          <th className="pb-3 pr-3 text-xs uppercase tracking-wider text-kumo-subtle">角色</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr
            key={r.userId}
            className="cursor-pointer border-b border-kumo-fill hover:bg-kumo-tint"
            onClick={() => onSelect({ userId: r.userId, maxBudget: r.maxBudget })}
          >
            <td className="py-3 pr-3">{r.email}<span className="ml-1 text-kumo-brand">›</span></td>
            <td className="py-3 pr-3 text-right font-mono tabular-nums">${r.spend.toFixed(2)}</td>
            <td className="py-3 pr-3 text-right font-mono tabular-nums">{r.maxBudget == null ? "—" : `$${r.maxBudget.toFixed(2)}`}</td>
            <td className="py-3 pr-3">{r.role}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
