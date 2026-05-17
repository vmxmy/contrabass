/**
 * TenantAlertsScreen — Budget & Alert Webhook config screen for the Tenant Portal.
 *
 * Identity gate: `useMe().data?.tenantRole === "tenant_admin"` is a CLIENT-SIDE
 * UX guard only. The authoritative security boundary is the server-side
 * `requireTenantAdmin` middleware on every `/api/tenant/alert-webhook` endpoint.
 * This client gate prevents accidental deep-link rendering for non-admins.
 *
 * SSRF / URL validation: the client performs NO validation of the webhook URL.
 * The server's `SetTeamAlertWebhookBodySchema` (https-only + isSafeWebhookHost)
 * is the authoritative P0 boundary. Any 422 rejection from the server is echoed
 * inline via a Banner — the client never reimplements the security check.
 */
import React, { useCallback, useState } from "react";
import { Banner } from "@cloudflare/kumo/components/banner";
import { Button } from "@cloudflare/kumo/components/button";
import { Empty } from "@cloudflare/kumo/components/empty";
import { Field } from "@cloudflare/kumo/components/field";
import { Input } from "@cloudflare/kumo/components/input";
import { SkeletonLine } from "@cloudflare/kumo/components/loader";
import { Select } from "@cloudflare/kumo/components/select";
import { Text } from "@cloudflare/kumo/components/text";
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { useMe } from "../../hooks/use-me";
import {
  useTenantWebhook,
  useSetTenantWebhook,
  useClearTenantWebhook,
} from "../hooks";
import { MemberForbidden } from "../routes";

// Reason presets mirror WriteReasonSchema REASON_PRESETS from schemas.ts.
const REASON_OPTIONS = [
  "routine_maintenance",
  "security_incident",
  "user_request",
  "budget_adjustment",
  "other",
] as const;

type ReasonOption = (typeof REASON_OPTIONS)[number];

// ---------------------------------------------------------------------------
// WebhookConfigForm — the set/clear form
// ---------------------------------------------------------------------------

function WebhookConfigForm() {
  const [url, setUrl] = useState("");
  const [reason, setReason] = useState<ReasonOption>("routine_maintenance");
  const [error, setError] = useState<string | null>(null);
  const setWebhook = useSetTenantWebhook();
  const clearWebhook = useClearTenantWebhook();

  const handleSave = useCallback(() => {
    setError(null);
    setWebhook.mutate(
      { reason, url },
      {
        onSuccess: () => {
          setUrl("");
          setError(null);
        },
        onError: (err: unknown) => {
          setError(err instanceof Error ? err.message : t`保存失败`);
        },
      },
    );
  }, [reason, url, setWebhook]);

  const handleClear = useCallback(() => {
    setError(null);
    clearWebhook.mutate(
      { reason },
      {
        onSuccess: () => {
          setError(null);
          setUrl("");
        },
        onError: (err: unknown) => {
          setError(err instanceof Error ? err.message : t`清除失败`);
        },
      },
    );
  }, [reason, clearWebhook]);

  const isPending = setWebhook.isPending || clearWebhook.isPending;

  return (
    <div className="space-y-5 p-6">
      {error ? (
        <Banner variant="error" title={t`操作失败`} description={error} />
      ) : null}
      <Field label={t`Webhook URL`} description={t`仅接受 HTTPS 地址，服务端校验 SSRF 安全。`}>
        <Input
          id="alert-webhook-url"
          size="lg"
          type="url"
          placeholder="https://hooks.example.com/notify"
          value={url}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
            setUrl(e.target.value)
          }
          aria-label={t`Webhook URL`}
        />
      </Field>
      <Select
        label={t`变更原因`}
        className="w-full"
        size="lg"
        value={reason}
        onValueChange={(value) => setReason(value as ReasonOption)}
      >
        <Select.Option value="routine_maintenance"><Trans>常规维护</Trans></Select.Option>
        <Select.Option value="security_incident"><Trans>安全事件</Trans></Select.Option>
        <Select.Option value="user_request"><Trans>用户申请</Trans></Select.Option>
        <Select.Option value="budget_adjustment"><Trans>预算调整</Trans></Select.Option>
        <Select.Option value="other"><Trans>其他</Trans></Select.Option>
      </Select>
      <div className="flex justify-end gap-2">
        <Button
          variant="secondary-destructive"
          size="sm"
          loading={clearWebhook.isPending}
          disabled={isPending}
          onClick={handleClear}
        >
          <Trans>清除</Trans>
        </Button>
        <Button
          variant="primary"
          size="sm"
          loading={setWebhook.isPending}
          disabled={isPending}
          onClick={handleSave}
        >
          <Trans>保存</Trans>
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// CurrentWebhookStatus — shows the current configured URL / empty state
// ---------------------------------------------------------------------------

function CurrentWebhookStatus() {
  const { data, isLoading, isError, error } = useTenantWebhook();

  if (isLoading) {
    return (
      <div className="space-y-3 p-6">
        <SkeletonLine minWidth={200} maxWidth={400} blockHeight={16} />
        <SkeletonLine minWidth={200} maxWidth={400} blockHeight={16} />
      </div>
    );
  }

  if (isError) {
    return (
      <Banner
        variant="error"
        title={t`Webhook 配置加载失败`}
        description={
          error instanceof Error ? error.message : t`网络请求失败`
        }
      />
    );
  }

  if (!data?.url) {
    return (
      <div className="p-6">
        <Empty size="sm" title={t`未配置告警 Webhook`} />
      </div>
    );
  }

  return (
    <div className="space-y-2 p-6">
      <Text variant="secondary" as="p">
        <Trans>当前 Webhook URL</Trans>
      </Text>
      <Text as="p" className="font-mono text-kumo-default break-all">
        {data.url}
      </Text>
      {data.updatedAt ? (
        <Text variant="secondary" as="p" className="text-xs">
          {data.updatedAt}
        </Text>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// TenantAlertsScreen — exported screen component
// ---------------------------------------------------------------------------

export function TenantAlertsScreen() {
  // Derived identity gate — no state+effect, per react-useeffect rule.
  // CLIENT-SIDE UX ONLY: the authoritative gate is server requireTenantAdmin.
  const me = useMe().data;
  if (me?.tenantRole !== "tenant_admin") {
    return <MemberForbidden />;
  }

  return (
    <div id="tenant-alerts-root" className="space-y-6">
      <article className="overflow-hidden rounded-xl bg-kumo-base ring-1 ring-kumo-line">
        <div className="border-b border-kumo-line bg-kumo-elevated p-6">
          <Text variant="heading3" as="p"><Trans>告警 Webhook</Trans></Text>
          <Text variant="secondary" as="p">
            <Trans>配置预算告警通知的 Webhook 地址。</Trans>
          </Text>
        </div>
        <CurrentWebhookStatus />
      </article>
      <article className="overflow-hidden rounded-xl bg-kumo-base ring-1 ring-kumo-line">
        <div className="border-b border-kumo-line bg-kumo-elevated p-6">
          <Text variant="heading3" as="p"><Trans>更新 Webhook</Trans></Text>
          <Text variant="secondary" as="p">
            <Trans>设置或清除告警 Webhook URL。客户端不校验 URL，服务端负责安全验证。</Trans>
          </Text>
        </div>
        <WebhookConfigForm />
      </article>
    </div>
  );
}
