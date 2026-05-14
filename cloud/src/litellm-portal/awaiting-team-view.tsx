import { Trans } from "@lingui/react/macro";

export function AwaitingTeamView({ email }: { email: string }): JSX.Element {
  return (
    <div className="awaiting-team-view">
      <h1>
        <Trans>Welcome!</Trans>
      </h1>
      <p>
        <Trans>
          Your account ({email}) is signed in, but you have not been assigned to
          a team yet. Ask an administrator to attach your account to a team to
          unlock the portal.
        </Trans>
      </p>
      <p className="awaiting-team-view__hint">
        <Trans>
          Once your team is assigned, you can sign in again to see your
          dashboard.
        </Trans>
      </p>
    </div>
  );
}
