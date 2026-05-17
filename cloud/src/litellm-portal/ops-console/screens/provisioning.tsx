/**
 * OpsProvisioningScreen — Provisioning & Invites screen for the Ops Console.
 *
 * Bare-body screen: identity gating is performed by the OpsLayout /
 * OpsConsoleShell wrapper and the server-side `requireOwner` middleware on
 * every `/api/admin/*` endpoint. This component does NOT self-gate.
 */
import React, { useCallback, useState } from "react";
import { Banner } from "@cloudflare/kumo/components/banner";
import { Button } from "@cloudflare/kumo/components/button";
import { Field } from "@cloudflare/kumo/components/field";
import { Input } from "@cloudflare/kumo/components/input";
import { Select } from "@cloudflare/kumo/components/select";
import { Text } from "@cloudflare/kumo/components/text";
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
  useOpsCreateTeam,
  useOpsCreateInvite,
  useOpsSetTenantRole,
} from "../hooks";

const REASON = "ops_provisioning";

// ---------------------------------------------------------------------------
// CreateTeamForm
// ---------------------------------------------------------------------------

function CreateTeamForm() {
  const [alias, setAlias] = useState("");
  const [error, setError] = useState<string | null>(null);
  const createTeam = useOpsCreateTeam();

  const handleSubmit = useCallback(() => {
    const trimmed = alias.trim();
    if (!trimmed) {
      setError(t`请输入团队名称`);
      return;
    }
    setError(null);
    createTeam.mutate(
      { alias: trimmed, reason: REASON },
      {
        onSuccess: () => {
          setAlias("");
          setError(null);
        },
        onError: (err: unknown) => {
          setError(err instanceof Error ? err.message : t`创建团队失败`);
        },
      },
    );
  }, [alias, createTeam]);

  return (
    <article className="overflow-hidden rounded-xl bg-kumo-base ring-1 ring-kumo-line">
      <div className="border-b border-kumo-line bg-kumo-elevated p-6">
        <Text variant="heading3" as="p"><Trans>创建团队</Trans></Text>
        <Text variant="secondary" as="p">
          <Trans>为新租户创建一个团队。</Trans>
        </Text>
      </div>
      <div className="space-y-5 p-6">
        {error ? (
          <Banner variant="error" title={t`创建团队失败`} description={error} />
        ) : null}
        <Field label={t`团队名称`} required={true}>
          <Input
            id="ops-create-team-alias"
            size="lg"
            placeholder={t`团队名称`}
            value={alias}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
              setAlias(e.target.value)
            }
          />
        </Field>
        <div className="flex justify-end">
          <Button
            variant="primary"
            size="sm"
            loading={createTeam.isPending}
            onClick={handleSubmit}
          >
            <Trans>创建团队</Trans>
          </Button>
        </div>
      </div>
    </article>
  );
}

// ---------------------------------------------------------------------------
// InviteForm
// ---------------------------------------------------------------------------

function InviteForm() {
  const [email, setEmail] = useState("");
  const [teamId, setTeamId] = useState("");
  const [teamRole, setTeamRole] = useState<"user" | "admin">("user");
  const [error, setError] = useState<string | null>(null);
  const createInvite = useOpsCreateInvite();

  const handleSubmit = useCallback(() => {
    const trimmedEmail = email.trim();
    const trimmedTeamId = teamId.trim();
    if (!trimmedEmail || !trimmedTeamId) {
      setError(t`请输入邮箱与团队 ID`);
      return;
    }
    setError(null);
    createInvite.mutate(
      { email: trimmedEmail, teamId: trimmedTeamId, teamRole, reason: REASON },
      {
        onSuccess: () => {
          setEmail("");
          setTeamId("");
          setTeamRole("user");
          setError(null);
        },
        onError: (err: unknown) => {
          setError(err instanceof Error ? err.message : t`邀请发送失败`);
        },
      } as never,
    );
  }, [email, teamId, teamRole, createInvite]);

  return (
    <article className="overflow-hidden rounded-xl bg-kumo-base ring-1 ring-kumo-line">
      <div className="border-b border-kumo-line bg-kumo-elevated p-6">
        <Text variant="heading3" as="p"><Trans>发送邀请</Trans></Text>
        <Text variant="secondary" as="p">
          <Trans>邀请用户加入指定团队。</Trans>
        </Text>
      </div>
      <div className="space-y-5 p-6">
        {error ? (
          <Banner variant="error" title={t`邀请发送失败`} description={error} />
        ) : null}
        <Field label={t`邮箱`} required={true}>
          <Input
            id="ops-invite-email"
            size="lg"
            type="email"
            placeholder={t`请输入邮箱`}
            value={email}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
              setEmail(e.target.value)
            }
          />
        </Field>
        <Field label={t`所属团队`} required={true}>
          <Input
            id="ops-invite-team-id"
            size="lg"
            placeholder={t`所属团队标识`}
            value={teamId}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
              setTeamId(e.target.value)
            }
          />
        </Field>
        <Select
          label={t`角色`}
          className="w-full"
          size="lg"
          value={teamRole}
          onValueChange={(value) => setTeamRole(value as "user" | "admin")}
        >
          <Select.Option value="user"><Trans>成员</Trans></Select.Option>
          <Select.Option value="admin"><Trans>管理员</Trans></Select.Option>
        </Select>
        <div className="flex justify-end">
          <Button
            variant="primary"
            size="sm"
            loading={createInvite.isPending}
            onClick={handleSubmit}
          >
            <Trans>发送邀请</Trans>
          </Button>
        </div>
      </div>
    </article>
  );
}

// ---------------------------------------------------------------------------
// TenantRoleForm
// ---------------------------------------------------------------------------

function TenantRoleForm() {
  const [teamId, setTeamId] = useState("");
  const [userId, setUserId] = useState("");
  const [tenantRole, setTenantRole] = useState<"tenant_admin" | "member">("member");
  const [error, setError] = useState<string | null>(null);
  const setRole = useOpsSetTenantRole();

  const handleSubmit = useCallback(() => {
    const trimmedTeamId = teamId.trim();
    const trimmedUserId = userId.trim();
    if (!trimmedTeamId || !trimmedUserId) {
      setError(t`请输入团队 ID 与用户 ID`);
      return;
    }
    setError(null);
    setRole.mutate(
      { teamId: trimmedTeamId, userId: trimmedUserId, tenantRole, reason: REASON },
      {
        onSuccess: () => {
          setTeamId("");
          setUserId("");
          setTenantRole("member");
          setError(null);
        },
        onError: (err: unknown) => {
          setError(err instanceof Error ? err.message : t`指派角色失败`);
        },
      },
    );
  }, [teamId, userId, tenantRole, setRole]);

  return (
    <article className="overflow-hidden rounded-xl bg-kumo-base ring-1 ring-kumo-line">
      <div className="border-b border-kumo-line bg-kumo-elevated p-6">
        <Text variant="heading3" as="p"><Trans>指派租户角色</Trans></Text>
        <Text variant="secondary" as="p">
          <Trans>为团队成员指派租户管理员或成员角色。</Trans>
        </Text>
      </div>
      <div className="space-y-5 p-6">
        {error ? (
          <Banner variant="error" title={t`指派角色失败`} description={error} />
        ) : null}
        <Field label={t`团队 ID`} required={true}>
          <Input
            id="ops-role-team-id"
            size="lg"
            placeholder={t`团队 ID`}
            value={teamId}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
              setTeamId(e.target.value)
            }
          />
        </Field>
        <Field label={t`用户 ID`} required={true}>
          <Input
            id="ops-role-user-id"
            size="lg"
            placeholder={t`用户 ID`}
            value={userId}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
              setUserId(e.target.value)
            }
          />
        </Field>
        <Select
          label={t`租户角色`}
          className="w-full"
          size="lg"
          value={tenantRole}
          onValueChange={(value) =>
            setTenantRole(value as "tenant_admin" | "member")
          }
        >
          <Select.Option value="member"><Trans>成员</Trans></Select.Option>
          <Select.Option value="tenant_admin"><Trans>租户管理员</Trans></Select.Option>
        </Select>
        <div className="flex justify-end">
          <Button
            variant="primary"
            size="sm"
            loading={setRole.isPending}
            onClick={handleSubmit}
          >
            <Trans>指派角色</Trans>
          </Button>
        </div>
      </div>
    </article>
  );
}

// ---------------------------------------------------------------------------
// OpsProvisioningScreen — exported screen component
// ---------------------------------------------------------------------------

export function OpsProvisioningScreen() {
  return (
    <div id="ops-provisioning-root" className="space-y-6">
      <CreateTeamForm />
      <InviteForm />
      <TenantRoleForm />
    </div>
  );
}
