/**
 * Nav icon set (Phase-3 §B.1; §E-2 RESOLVED — C3).
 *
 * @cloudflare/kumo@2.1.0 ships NO icon export (verified: 100 exports, zero
 * icon). @phosphor-icons/react is a Kumo peerDependency but is FORBIDDEN here
 * (adding a real runtime dependency edge defeats the spec's "no new icon
 * dependency" rule). These are hand-authored, zero-dependency, 16×16,
 * currentColor-stroked, aria-hidden inline SVGs. SideNav recolors via
 * currentColor (subtle at rest, accent when active).
 */
import React from "react";

export type NavIconName =
  | "overview"
  | "usage"
  | "keys"
  | "members"
  | "budget"
  | "billing"
  | "tenant-overview"
  | "provisioning"
  | "audit"
  | "settings";

const PATHS: Record<NavIconName, React.ReactNode> = {
  // grid / dashboard
  overview: (
    <>
      <rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1" />
      <rect x="9" y="2.5" width="4.5" height="4.5" rx="1" />
      <rect x="2.5" y="9" width="4.5" height="4.5" rx="1" />
      <rect x="9" y="9" width="4.5" height="4.5" rx="1" />
    </>
  ),
  // ascending bars
  usage: (
    <>
      <line x1="3" y1="13" x2="3" y2="9" />
      <line x1="6.5" y1="13" x2="6.5" y2="6" />
      <line x1="10" y1="13" x2="10" y2="8" />
      <line x1="13" y1="13" x2="13" y2="4" />
    </>
  ),
  // key
  keys: (
    <>
      <circle cx="5.5" cy="6" r="2.75" />
      <path d="M7.4 7.9 L13 13.5 M11 11.5 l1.5 -1.5 M12.3 12.8 l1.2 -1.2" />
    </>
  ),
  // two people
  members: (
    <>
      <circle cx="6" cy="5.5" r="2.25" />
      <path d="M2.5 13 c0 -2.5 7 -2.5 7 0" />
      <path d="M10 4 a2.25 2.25 0 0 1 0 4.4 M11 13 c0 -1.7 -1 -2.6 -2.2 -3" />
    </>
  ),
  // gauge
  budget: (
    <>
      <path d="M2.5 12 a5.5 5.5 0 0 1 11 0" />
      <line x1="8" y1="12" x2="11" y2="7.5" />
      <circle cx="8" cy="12" r="0.9" fill="currentColor" stroke="none" />
    </>
  ),
  // document with lines
  billing: (
    <>
      <path d="M4 2.5 h5 l3 3 v8 h-8 z" />
      <path d="M9 2.5 v3 h3" />
      <line x1="5.75" y1="9" x2="10.25" y2="9" />
      <line x1="5.75" y1="11.25" x2="10.25" y2="11.25" />
    </>
  ),
  // building (tenants overview)
  "tenant-overview": (
    <>
      <rect x="3" y="2.75" width="7" height="10.5" rx="0.5" />
      <line x1="11.5" y1="6" x2="13" y2="6" /><line x1="11.5" y1="6" x2="11.5" y2="13.25" />
      <line x1="5" y1="5" x2="6" y2="5" /><line x1="7" y1="5" x2="8" y2="5" />
      <line x1="5" y1="7.5" x2="6" y2="7.5" /><line x1="7" y1="7.5" x2="8" y2="7.5" />
    </>
  ),
  // person-plus (provisioning / invites)
  provisioning: (
    <>
      <circle cx="6" cy="5.5" r="2.25" />
      <path d="M2.5 13 c0 -2.6 7 -2.6 7 0" />
      <line x1="11.75" y1="6" x2="11.75" y2="10" /><line x1="9.75" y1="8" x2="13.75" y2="8" />
    </>
  ),
  // checklist (audit)
  audit: (
    <>
      <path d="M4 2.75 h8 v10.5 h-8 z" />
      <path d="M5.5 6 l1 1 l2 -2.2" />
      <line x1="9.5" y1="5.75" x2="11" y2="5.75" />
      <path d="M5.5 9.75 l1 1 l2 -2.2" />
      <line x1="9.5" y1="9.5" x2="11" y2="9.5" />
    </>
  ),
  // gear (settings)
  settings: (
    <>
      <circle cx="8" cy="8" r="2" />
      <path d="M8 1.75 v1.6 M8 12.65 v1.6 M1.75 8 h1.6 M12.65 8 h1.6 M3.6 3.6 l1.15 1.15 M11.25 11.25 l1.15 1.15 M12.4 3.6 l-1.15 1.15 M4.75 11.25 l-1.15 1.15" />
    </>
  ),
};

export function NavIcon({ name }: { name: NavIconName }): React.ReactElement {
  return (
    <span
      data-nav-icon
      className="inline-flex h-4 w-4 shrink-0 items-center justify-center text-kumo-subtle"
    >
      <svg
        aria-hidden="true"
        width="16"
        height="16"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {PATHS[name]}
      </svg>
    </span>
  );
}
