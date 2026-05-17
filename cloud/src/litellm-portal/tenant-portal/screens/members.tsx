/**
 * TenantMembersScreen — Members & Invites screen for the Tenant Portal.
 *
 * Identity gate: `useMe().data?.tenantRole === "tenant_admin"` is a CLIENT-SIDE
 * UX guard only. The authoritative security boundary is the server-side
 * `requireTenantAdmin` middleware on every `/api/tenant/invites` endpoint.
 * This client gate prevents accidental deep-link rendering for non-admins.
 */
import React, { useCallback, useState } from "react";
import { Badge } from "@cloudflare/kumo/components/badge";
import { Banner } from "@cloudflare/kumo/components/banner";
import { Button } from "@cloudflare/kumo/components/button";
import { Dialog } from "@cloudflare/kumo/components/dialog";
import { Empty } from "@cloudflare/kumo/components/empty";
import { Field } from "@cloudflare/kumo/components/field";
import { Input } from "@cloudflare/kumo/components/input";
import { SkeletonLine } from "@cloudflare/kumo/components/loader";
import { Select } from "@cloudflare/kumo/components/select";
import { Table } from "@cloudflare/kumo/components/table";
import { Text } from "@cloudflare/kumo/components/text";
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { useMe } from "../../hooks/use-me";
import {
  useTenantInvites,
  useCreateTenantInvite,
  useRevokeTenantInvite,
} from "../hooks";
import { MemberForbidden } from "../routes";

// ---------------------------------------------------------------------------
// RevokeInviteDialog — typed-confirm dialog mirroring DeleteKeyButton idiom
// ---------------------------------------------------------------------------

function RevokeInviteDialog({ email }: { email: string }) {
  const [open, setOpen] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const revoke = useRevokeTenantInvite();

  const handleOpenChange = useCallback((nextOpen: boolean) => {
    setOpen(nextOpen);
    if (!nextOpen) {
      setConfirmText("");
      setError(null);
    }
  }, []);

  const canConfirm = confirmText === email;

  const handleRevoke = useCallback(() => {
    if (!canConfirm) return;
    setError(null);
    revoke.mutate(
      { email, confirmEmail: email, reason: "tenant_admin_revoke" },
      {
        onSuccess: () => {
          setConfirmText("");
          setError(null);
          setOpen(false);
        },
        onError: (err: unknown) => {
          setError(err instanceof Error ? err.message : t`撤销失败`);
        },
      },
    );
  }, [canConfirm, email, revoke]);

  return (
    <Dialog.Root role="alertdialog" open={open} onOpenChange={handleOpenChange}>
      <Dialog.Trigger
        render={(props) => (
          <Button {...props} variant="secondary-destructive" size="xs">
            <Trans>撤销</Trans>
          </Button>
        )}
      />
      <Dialog size="sm" className="space-y-5 p-6">
        <Dialog.Title>
          <Text variant="heading3" as="h2"><Trans>撤销邀请？</Trans></Text>
        </Dialog.Title>
        <Dialog.Description>
          <Text variant="secondary">
            <Trans>将撤销「{email}」的邀请。此操作不可撤销。</Trans>
          </Text>
        </Dialog.Description>
        {error ? (
          <Banner variant="error" title={t`撤销失败`} description={error} />
        ) : null}
        <Field
          label={t`输入邮箱确认`}
          description={t`请输入「${email}」以确认撤销`}
        >
          <Input
            id={`revoke-confirm-${email}`}
            size="lg"
            placeholder={email}
            value={confirmText}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
              setConfirmText(e.target.value)
            }
          />
        </Field>
        <div className="flex justify-end gap-2">
          <Dialog.Close
            render={(props) => (
              <Button
                {...props}
                variant="secondary"
                size="sm"
                disabled={revoke.isPending}
              >
                <Trans>取消</Trans>
              </Button>
            )}
          />
          <Button
            variant="destructive"
            size="sm"
            loading={revoke.isPending}
            disabled={!canConfirm}
            onClick={handleRevoke}
          >
            <Trans>确认撤销</Trans>
          </Button>
        </div>
      </Dialog>
    </Dialog.Root>
  );
}

// ---------------------------------------------------------------------------
// Status pill
// ---------------------------------------------------------------------------

function InviteStatusBadge({ status }: { status: "pending" | "consumed" | "revoked" }) {
  const variant =
    status === "consumed"
      ? "success"
      : status === "revoked"
        ? "error"
        : "warning";
  return <Badge variant={variant}>{status}</Badge>;
}

// ---------------------------------------------------------------------------
// CreateInviteForm
// ---------------------------------------------------------------------------

function CreateInviteForm() {
  const [email, setEmail] = useState("");
  const [teamRole, setTeamRole] = useState<"user" | "admin">("user");
  const [emailError, setEmailError] = useState<string | null>(null);
  const createInvite = useCreateTenantInvite();

  const handleSubmit = useCallback(() => {
    const trimmed = email.trim();
    if (!trimmed) {
      setEmailError(t`请输入邮箱`);
      return;
    }
    setEmailError(null);
    createInvite.mutate(
      { email: trimmed, teamRole, reason: "tenant_admin_invite" },
      {
        onSuccess: () => {
          setEmail("");
          setTeamRole("user");
        },
        onError: (err: unknown) => {
          setEmailError(
            err instanceof Error ? err.message : t`邀请发送失败`,
          );
        },
      },
    );
  }, [email, teamRole, createInvite]);

  return (
    <article className="overflow-hidden rounded-xl bg-kumo-base ring-1 ring-kumo-line">
      <div className="border-b border-kumo-line bg-kumo-elevated p-6">
        <Text variant="heading3" as="p"><Trans>发送邀请</Trans></Text>
        <Text variant="secondary" as="p">
          <Trans>邀请新成员加入当前团队。</Trans>
        </Text>
      </div>
      <div className="space-y-5 p-6">
        <Field
          label={t`邮箱`}
          required={true}
          error={emailError ? { message: emailError, match: true } : undefined}
        >
          <Input
            id="invite-email"
            size="lg"
            type="email"
            placeholder="email"
            value={email}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
              setEmail(e.target.value)
            }
          />
        </Field>
        <Select
          label={t`角色`}
          className="w-full"
          size="lg"
          value={teamRole}
          onValueChange={(value) =>
            setTeamRole(value as "user" | "admin")
          }
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
            <Trans>邀请</Trans>
          </Button>
        </div>
      </div>
    </article>
  );
}

// ---------------------------------------------------------------------------
// InvitesTable
// ---------------------------------------------------------------------------

function InvitesTable() {
  const { data, isLoading, isError, error } = useTenantInvites();

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
        title={t`邀请列表加载失败`}
        description={
          error instanceof Error ? error.message : t`网络请求失败`
        }
      />
    );
  }

  const invites = data?.invites ?? [];

  if (invites.length === 0) {
    return (
      <Empty size="sm" title={t`暂无邀请记录`} />
    );
  }

  return (
    <div className="overflow-x-auto">
      <Table className="w-full text-sm">
        <Table.Header>
          <Table.Row>
            <Table.Head className="text-xs font-semibold uppercase tracking-wider text-kumo-subtle">
              <Trans>邮箱</Trans>
            </Table.Head>
            <Table.Head className="text-xs font-semibold uppercase tracking-wider text-kumo-subtle">
              <Trans>角色</Trans>
            </Table.Head>
            <Table.Head className="text-xs font-semibold uppercase tracking-wider text-kumo-subtle">
              <Trans>状态</Trans>
            </Table.Head>
            <Table.Head className="text-right text-xs font-semibold uppercase tracking-wider text-kumo-subtle">
              <Trans>操作</Trans>
            </Table.Head>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {invites.map((invite) => (
            <Table.Row key={invite.email}>
              <Table.Cell className="font-mono text-kumo-default">
                {invite.email}
              </Table.Cell>
              <Table.Cell className="text-kumo-default">
                {invite.teamRole}
              </Table.Cell>
              <Table.Cell>
                <InviteStatusBadge status={invite.status} />
              </Table.Cell>
              <Table.Cell className="text-right">
                {invite.status === "pending" ? (
                  <RevokeInviteDialog email={invite.email} />
                ) : (
                  <span className="text-kumo-subtle">—</span>
                )}
              </Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// TenantMembersScreen — exported screen component
// ---------------------------------------------------------------------------

export function TenantMembersScreen() {
  // Derived identity gate — no state+effect, per react-useeffect rule.
  // CLIENT-SIDE UX ONLY: the authoritative gate is server requireTenantAdmin.
  const me = useMe().data;
  if (me?.tenantRole !== "tenant_admin") {
    return <MemberForbidden />;
  }

  return (
    <div id="tenant-members-root" className="space-y-6">
      <article className="overflow-hidden rounded-xl bg-kumo-base ring-1 ring-kumo-line">
        <div className="border-b border-kumo-line bg-kumo-elevated p-6">
          <Text variant="heading3" as="p"><Trans>成员与邀请</Trans></Text>
          <Text variant="secondary" as="p">
            <Trans>管理团队成员的邀请状态。</Trans>
          </Text>
        </div>
        <InvitesTable />
      </article>
      <CreateInviteForm />
    </div>
  );
}
