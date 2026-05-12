import { useCallback, useEffect, useRef } from "react";

export type ClientErrorEvent = {
  message: string;
  stack?: string;
  sessionId: string;
  ts: string;
};

const BATCH_SIZE = 5;
const FLUSH_INTERVAL_MS = 10_000;

function getOrCreateSessionId(): string {
  if (typeof sessionStorage === "undefined") return "unknown";
  const key = "_portal_session_id";
  const existing = sessionStorage.getItem(key);
  if (existing) return existing;
  const id = crypto.randomUUID();
  sessionStorage.setItem(key, id);
  return id;
}

async function postErrors(events: ClientErrorEvent[]): Promise<void> {
  try {
    await fetch("/api/_internal/client-error", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ events }),
    });
  } catch {
    // best-effort: network failures are silently dropped
  }
}

type ErrorReporter = {
  queueError: (message: string, stack?: string) => void;
  flush: () => Promise<void>;
};

export function useErrorReporter(): ErrorReporter {
  const queueRef = useRef<ClientErrorEvent[]>([]);
  const sessionIdRef = useRef<string>("");

  useEffect(() => {
    sessionIdRef.current = getOrCreateSessionId();
  }, []);

  const flush = useCallback(async () => {
    const events = queueRef.current.splice(0);
    if (events.length === 0) return;
    await postErrors(events);
  }, []);

  const queueError = useCallback((message: string, stack?: string) => {
    queueRef.current.push({
      message,
      stack,
      sessionId: sessionIdRef.current || getOrCreateSessionId(),
      ts: new Date().toISOString(),
    });
    if (queueRef.current.length >= BATCH_SIZE) {
      void flush();
    }
  }, [flush]);

  useEffect(() => {
    const timer = setInterval(() => {
      void flush();
    }, FLUSH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [flush]);

  return { queueError, flush };
}
