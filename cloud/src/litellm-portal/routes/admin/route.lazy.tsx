import React from "react";
import { Loader } from "@cloudflare/kumo/components/loader";

const LazyAdminSidebar = React.lazy(async () => {
  const module = await import("./navigation");
  return { default: module.AdminSidebar };
});

function AdminRouteFallback() {
  return (
    <div className="flex items-center justify-center py-10" aria-live="polite">
      <Loader aria-label="正在加载管理员导航" />
    </div>
  );
}

export function AdminLayout() {
  return (
    <React.Suspense fallback={<AdminRouteFallback />}>
      <LazyAdminSidebar />
    </React.Suspense>
  );
}
