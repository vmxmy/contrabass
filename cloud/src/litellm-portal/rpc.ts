import { hc } from "hono/client";
import type { AppType } from "./routes";

// Relative base URL so the client works in both dev and production.
export const client = hc<AppType>("/");
