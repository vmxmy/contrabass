import type { LiteLLMPortalEnv } from "../types";

/** Send a magic-link email via MailChannels.
 *  POSTs to https://api.mailchannels.net/tx/v1/send.
 *  On a non-2xx response, throws an Error so the caller can return 5xx
 *  to the user. Never swallows transport errors. */
export async function sendMagicLink(
  env: LiteLLMPortalEnv,
  options: {
    /** Recipient email address. */
    email: string;
    /** Absolute URL the user clicks to consume the magic-link nonce. */
    link: string;
    /** From address. Should match a DNS-verified sender domain. */
    from?: string;
    /** Optional company / display name for the email body. */
    companyName?: string;
  },
): Promise<void> {
  const fromEmail = options.from ?? "no-reply@gz-zhiyun.com"; // TODO: replace with a configurable env var in a follow-up
  const fromName = env.LITELLM_PORTAL_DISPLAY_NAME ?? "Portal Sign-in";
  const companyName = options.companyName ?? "the portal";
  const subject = `Sign in to ${companyName}`;

  const plainBody = [
    "Click the link below to sign in. It expires in 15 minutes.",
    "",
    options.link,
    "",
    "If you did not request this, ignore this email.",
  ].join("\n");

  const htmlBody = [
    "<!DOCTYPE html>",
    "<html><body>",
    "<p>Click the link below to sign in. It expires in 15 minutes.</p>",
    `<p><a href="${options.link}">${options.link}</a></p>`,
    "<p>If you did not request this, ignore this email.</p>",
    "</body></html>",
  ].join("\n");

  const payload = {
    personalizations: [{ to: [{ email: options.email }] }],
    from: { email: fromEmail, name: fromName },
    subject,
    content: [
      { type: "text/plain", value: plainBody },
      { type: "text/html", value: htmlBody },
    ],
  };

  const response = await fetch("https://api.mailchannels.net/tx/v1/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const snippet = await response
      .text()
      .then((t) => t.slice(0, 200))
      .catch(() => "");
    throw new Error(
      `MailChannels send failed: HTTP ${response.status} — ${snippet}`,
    );
  }
}
