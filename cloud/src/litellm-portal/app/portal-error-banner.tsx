import React, { useState } from "react";
import { Banner } from "@cloudflare/kumo/components/banner";
import type { Dashboard } from "../schemas";

export function PortalErrorBanner({ initialData }: { initialData?: Dashboard | null }) {
  const [message, setMessage] = useState<string | null>(() => {
    const err = initialData?.error;
    return typeof err === "string" && err.length > 0 ? err : null;
  });

  if (!message) return null;

  return (
    <div className="mt-6" role="alert" aria-live="assertive">
      <Banner variant="error" title="页面数据加载失败" description={message} />
    </div>
  );
}
