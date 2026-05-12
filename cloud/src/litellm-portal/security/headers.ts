export function securityHeaders(nonce?: string): Record<string, string> {
  const csp = buildCSP(nonce);
  return {
    "content-security-policy": csp,
    "referrer-policy": "strict-origin-when-cross-origin",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()",
  };
}

export function withSecurityHeaders(response: Response, nonce?: string): Response {
  const headers = new Headers(response.headers);
  const sec = securityHeaders(nonce);
  for (const [key, value] of Object.entries(sec)) {
    headers.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function buildCSP(nonce?: string): string {
  const scriptSrc = nonce
    ? `'self' 'nonce-${nonce}'`
    : `'self'`;

  const directives = [
    `default-src 'self'`,
    `script-src ${scriptSrc}`,
    `style-src 'self' 'unsafe-inline'`,
    `img-src 'self' data:`,
    `font-src 'self'`,
    `connect-src 'self'`,
    `object-src 'none'`,
    `frame-ancestors 'none'`,
    `base-uri 'self'`,
    `form-action 'self'`,
  ];

  return directives.join("; ");
}
