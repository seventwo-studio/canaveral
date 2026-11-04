const codes: Record<number, string> = {
  400: "invalid_request", 401: "unauthenticated", 403: "forbidden", 404: "not_found",
  409: "conflict", 410: "lease_ended", 413: "payload_too_large", 429: "limit_exceeded", 503: "unavailable",
};

export class ServiceError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly outcome: "unknown" | undefined;
  constructor(message: string, readonly status = 409, options: {
    code?: string; retryable?: boolean; outcome?: "unknown";
  } = {}) {
    super(message);
    this.name = "ServiceError";
    this.code = options.code ?? codes[status] ?? "request_failed";
    this.retryable = options.retryable ?? (status === 429 || status === 503);
    this.outcome = options.outcome;
  }
}

export function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ServiceError("Expected a JSON object.", 400);
  }
  return value as Record<string, unknown>;
}

export function secret(value: unknown): string {
  if (typeof value !== "string" || /^[A-Za-z0-9_-]{43,128}$/.exec(value)?.[0] !== value) {
    throw new ServiceError("Use a securely generated token with at least 43 URL-safe characters.", 400);
  }
  return value;
}
