import { redirect } from "@tanstack/react-router";

export function requireAdminRoute(context: { role?: "admin" | "admin_viewer" | "user" | "none" }) {
  // admin_viewer reaches admin pages read-only; server denies any write.
  if (context.role !== "admin" && context.role !== "admin_viewer") {
    throw redirect({ to: "/", replace: true });
  }
}
