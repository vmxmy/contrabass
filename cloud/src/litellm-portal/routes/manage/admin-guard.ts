import { redirect } from "@tanstack/react-router";

export function requireAdminRoute(context: { role?: "admin" | "user" | "none" }) {
  if (context.role !== "admin") {
    throw redirect({ to: "/", replace: true });
  }
}
