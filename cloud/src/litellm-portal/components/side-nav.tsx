/**
 * Shared left navigation (Phase-3 §B.1). Both shells render this; the shell
 * supplies `accent` ("brand" = tenant brand `--kumo-brand`; "steel" = Ops
 * fixed steel, also delivered via `--kumo-brand` set by OPS_STEEL_ACCENT) and
 * `currentPath` (from the shell's useRouterState). Structure is identical
 * across shells; tone differs only by accent + the shell's density wrapper.
 *
 * Per item: 16px icon + label; matched route gets a 2px left accent bar
 * (data-active-accent-bar), bg-kumo-tint, text-kumo-strong, aria-current=page.
 * Hover = bg-kumo-tint. Focus = shared FOCUS_RING. Group headings = subtle
 * 12px uppercase tracking-wider. No shadows; only Kumo tokens + utilities.
 */
import React from "react";
import { Text } from "@cloudflare/kumo/components/text";
import { FOCUS_RING } from "../a11y/focus";
import { NavIcon, type NavIconName } from "./nav-icons";

export type SideNavItem = { href: string; label: React.ReactNode; icon: NavIconName };
export type SideNavGroup = { heading?: string; items: SideNavItem[] };
export type SideNavAccent = "brand" | "steel";

export function SideNav({
  groups,
  currentPath,
  accent,
  ariaLabel,
}: {
  groups: SideNavGroup[];
  currentPath: string;
  accent: SideNavAccent;
  ariaLabel: string;
}) {
  // Both accents resolve through --kumo-brand (the shell sets it: tenant brand
  // or OPS_STEEL_ACCENT steel). The accent bar uses bg-kumo-brand either way;
  // `accent` exists for explicitness/testing, not a second color path.
  return (
    <nav aria-label={ariaLabel} className="w-56 shrink-0 border-r border-kumo-line bg-kumo-elevated px-3 py-6">
      <div className="space-y-6">
        {groups.map((group, gi) => (
          <div key={group.heading ?? `g${gi}`} className="space-y-1">
            {group.heading ? (
              <Text
                as="p"
                variant="secondary"
                size="xs"
                className="px-3 pb-1 font-semibold uppercase tracking-wider text-kumo-subtle"
              >
                {group.heading}
              </Text>
            ) : null}
            <ul className="space-y-1">
              {group.items.map((item) => {
                const isActive = currentPath === item.href;
                return (
                  <li key={item.href}>
                    <a
                      href={item.href}
                      aria-current={isActive ? "page" : undefined}
                      data-accent={accent}
                      className={`relative flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors motion-safe:duration-100 hover:bg-kumo-tint hover:text-kumo-strong ${
                        isActive ? "bg-kumo-tint text-kumo-strong" : "text-kumo-default"
                      } ${FOCUS_RING}`}
                    >
                      {isActive ? (
                        <span
                          data-active-accent-bar
                          aria-hidden="true"
                          className="absolute inset-y-1 left-0 w-0.5 rounded-full bg-kumo-brand transition-all motion-safe:duration-150"
                        />
                      ) : null}
                      <NavIcon name={item.icon} />
                      <span className="truncate">{item.label}</span>
                    </a>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
    </nav>
  );
}
