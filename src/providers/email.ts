export interface EmailSendInput {
  from: { email: string; name?: string };
  to: string;
  subject: string;
  html: string;
  text?: string;
  idempotencyKey?: string;
}

export interface EmailSendResult {
  messageId: string;
}

export interface EmailProvider {
  send(input: EmailSendInput): Promise<EmailSendResult>;
  validateConnection(): Promise<{ ok: boolean; detail?: string }>;
}

export type EmailProviderErrorKind = "quota" | "auth" | "rejected" | "retryable" | "unknown";

export class EmailProviderError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly kind: EmailProviderErrorKind,
  ) {
    super(message);
    this.name = "EmailProviderError";
  }

  get safeToFallback(): boolean {
    return this.kind === "quota" || this.kind === "auth";
  }
}

function base64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export class GmailProvider implements EmailProvider {
  constructor(private readonly accessToken: string) {}

  async send(input: EmailSendInput): Promise<EmailSendResult> {
    const from = input.from.name ? `${input.from.name} <${input.from.email}>` : input.from.email;
    const boundary = `dmflow_${crypto.randomUUID().replaceAll("-", "")}`;
    const raw = [
      `From: ${from}`,
      `To: ${input.to}`,
      `Subject: ${input.subject}`,
      "MIME-Version: 1.0",
      `Content-Type: multipart/alternative; boundary=${boundary}`,
      "",
      `--${boundary}`,
      "Content-Type: text/plain; charset=UTF-8",
      "",
      input.text ?? input.html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
      `--${boundary}`,
      "Content-Type: text/html; charset=UTF-8",
      "",
      input.html,
      `--${boundary}--`,
    ].join("\r\n");
    const response = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
      method: "POST",
      headers: { authorization: `Bearer ${this.accessToken}`, "content-type": "application/json" },
      body: JSON.stringify({ raw: base64Url(raw) }),
    });
    const body = await response.json() as { id?: string; error?: { message?: string } };
    if (!response.ok || !body.id) throw providerError("Gmail", response.status, body.error?.message);
    return { messageId: body.id };
  }

  async validateConnection(): Promise<{ ok: boolean; detail?: string }> {
    const response = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", { headers: { authorization: `Bearer ${this.accessToken}` } });
    return { ok: response.ok, detail: response.ok ? undefined : `Gmail HTTP ${response.status}` };
  }
}

export class BrevoProvider implements EmailProvider {
  constructor(private readonly apiKey: string) {}

  async send(input: EmailSendInput): Promise<EmailSendResult> {
    const response = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: { "api-key": this.apiKey, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        sender: { email: input.from.email, name: input.from.name },
        to: [{ email: input.to }],
        subject: input.subject,
        htmlContent: input.html,
        textContent: input.text,
      }),
    });
    const body = await response.json() as { messageId?: string; message?: string };
    if (!response.ok || !body.messageId) throw providerError("Brevo", response.status, body.message);
    return { messageId: body.messageId };
  }

  async validateConnection(): Promise<{ ok: boolean; detail?: string }> {
    const response = await fetch("https://api.brevo.com/v3/account", { headers: { "api-key": this.apiKey, accept: "application/json" } });
    return { ok: response.ok, detail: response.ok ? undefined : `Brevo HTTP ${response.status}` };
  }
}

export class ResendProvider implements EmailProvider {
  constructor(private readonly apiKey: string) {}

  async send(input: EmailSendInput): Promise<EmailSendResult> {
    const from = input.from.name ? `${input.from.name} <${input.from.email}>` : input.from.email;
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json",
        ...(input.idempotencyKey ? { "Idempotency-Key": input.idempotencyKey } : {}),
      },
      body: JSON.stringify({ from, to: [input.to], subject: input.subject, html: input.html, text: input.text }),
    });
    const body = await response.json() as { id?: string; message?: string; name?: string };
    if (!response.ok || !body.id) throw providerError("Resend", response.status, body.message ?? body.name);
    return { messageId: body.id };
  }

  async validateConnection(): Promise<{ ok: boolean; detail?: string }> {
    if (!this.apiKey.startsWith("re_") || this.apiKey.length < 12) return { ok: false, detail: "Resend API key must start with re_" };
    const response = await fetch("https://api.resend.com/domains", {
      headers: { authorization: `Bearer ${this.apiKey}`, accept: "application/json" },
    });
    // Sending-only keys intentionally cannot list domains. A 403 still proves that Resend
    // recognized the key, while a 401 means the credential itself is invalid.
    if (response.ok || response.status === 403) return { ok: true };
    return { ok: false, detail: `Resend HTTP ${response.status}` };
  }
}

export class MockEmailProvider implements EmailProvider {
  async send(): Promise<EmailSendResult> {
    return { messageId: `mock_${crypto.randomUUID()}` };
  }
  async validateConnection(): Promise<{ ok: boolean }> {
    return { ok: true };
  }
}

function providerError(provider: string, status: number, detail?: string): EmailProviderError {
  const kind: EmailProviderErrorKind = status === 429
    ? "quota"
    : [401, 402, 403].includes(status)
      ? "auth"
      : status >= 500
        ? "retryable"
        : status >= 400
          ? "rejected"
          : "unknown";
  return new EmailProviderError(detail ?? `${provider} HTTP ${status}`, status, kind);
}
