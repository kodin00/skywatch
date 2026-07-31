const API_ROOT = "https://api.cloudflare.com/client/v4";
const SESSION_COOKIE = "skywatch_session";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;
const ENCRYPTION_BINDING = "SKYWATCH_TOKEN_KEY";
const TOKEN_AAD = new TextEncoder().encode("skywatch:cloudflare-api-token:v1");

type RuntimeEnv = Cloudflare.Env & {
  SKYWATCH_TOKEN_KEY?: CryptoKey;
};

type ApiEnvelope<T> = {
  success: boolean;
  result: T;
  errors?: Array<{ code?: number; message?: string }>;
  result_info?: { total_pages?: number };
};

type Account = { id: string; name: string };
type Membership = { account?: Account };
type WorkerRecord = {
  id: string;
  script_name: string;
  created_on?: string;
  modified_on?: string;
};
type AccessPolicy = {
  id?: string;
  name?: string;
  decision?: string;
  include?: unknown[];
  exclude?: unknown[];
  require?: unknown[];
};
type AccessApplication = {
  id: string;
  name?: string;
  domain?: string;
  destinations?: Array<{ type?: string; worker_id?: string; uri?: string }>;
  policies?: AccessPolicy[];
};
type StoredConfiguration = {
  account_id: string;
  account_name: string;
  token_ciphertext: string;
  token_iv: string;
};

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code = "request_failed",
  ) {
    super(message);
  }
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);

    if (!url.pathname.startsWith("/api/")) {
      return env.ASSETS.fetch(request);
    }

    try {
      if (request.method !== "GET") assertSameOrigin(request);

      if (request.method === "GET" && url.pathname === "/api/status") {
        return withHeaders(await getStatus(request, env));
      }
      if (request.method === "POST" && url.pathname === "/api/setup") {
        return withHeaders(await setup(request, env, url));
      }
      if (request.method === "POST" && url.pathname === "/api/unlock") {
        return withHeaders(await unlock(request, env));
      }
      if (request.method === "POST" && url.pathname === "/api/logout") {
        return withHeaders(await logout(request, env));
      }
      if (request.method === "GET" && url.pathname === "/api/workers") {
        return withHeaders(await listWorkers(request, env));
      }
      if (request.method === "PUT" && /^\/api\/workers\/[^/]+\/access$/.test(url.pathname)) {
        const workerId = decodeURIComponent(url.pathname.split("/")[3] ?? "");
        return withHeaders(await updateWorkerAccess(request, env, workerId));
      }

      return withHeaders(json({ error: "Route not found", code: "not_found" }, 404));
    } catch (error) {
      const known = error instanceof HttpError;
      if (!known) {
        console.error({ event: "request_failed", path: url.pathname, error: String(error) });
      }
      return withHeaders(
        json(
          {
            error: known ? error.message : "Skywatch could not complete that request.",
            code: known ? error.code : "internal_error",
          },
          known ? error.status : 500,
        ),
      );
    }
  },
} satisfies ExportedHandler<Cloudflare.Env>;

async function ensureSchema(db: D1Database): Promise<void> {
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS skywatch_config (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      account_id TEXT NOT NULL,
      account_name TEXT NOT NULL,
      token_ciphertext TEXT NOT NULL,
      token_iv TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS skywatch_sessions (
      token_hash TEXT PRIMARY KEY,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      expires_at TEXT NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS skywatch_setup_lock (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      nonce TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`),
  ]);
}

async function getStatus(request: Request, env: RuntimeEnv): Promise<Response> {
  await ensureSchema(env.DB);
  const configuration = await readConfiguration(env.DB);
  const authenticated = configuration ? await isAuthenticated(request, env.DB) : false;

  return json({
    configured: Boolean(configuration),
    authenticated,
    account: authenticated && configuration
      ? { id: configuration.account_id, name: configuration.account_name }
      : null,
    database: "connected",
    encryption: env.SKYWATCH_TOKEN_KEY ? "ready" : configuration ? "finalizing" : "pending",
  });
}

async function setup(request: Request, env: RuntimeEnv, url: URL): Promise<Response> {
  await ensureSchema(env.DB);
  if (await readConfiguration(env.DB)) {
    throw new HttpError(409, "Skywatch is already configured. Unlock it with the original API token.", "already_configured");
  }

  const body = await readJson<{ token?: unknown }>(request);
  const token = typeof body.token === "string" ? body.token.trim() : "";
  if (token.length < 20 || token.length > 2048) {
    throw new HttpError(400, "Enter a valid Cloudflare API token.", "invalid_token");
  }

  const lockNonce = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare("DELETE FROM skywatch_setup_lock WHERE created_at < ?").bind(now - 600).run();
  const lock = await env.DB.prepare(
    "INSERT INTO skywatch_setup_lock (id, nonce, created_at) VALUES (1, ?, ?) ON CONFLICT(id) DO NOTHING",
  ).bind(lockNonce, now).run();
  if (!lock.meta.changes) {
    throw new HttpError(409, "Another setup is already in progress. Try again in a moment.", "setup_in_progress");
  }

  try {
    await verifyApiToken(token);
    const memberships = await cloudflareRequest<Membership[]>(token, "/memberships?status=accepted&per_page=100", { method: "GET" });
    const account = await discoverScopedAccount(token, memberships);
    const keyBytes = crypto.getRandomValues(new Uint8Array(32));
    const key = await crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: TOKEN_AAD }, key, new TextEncoder().encode(token));

    const workerName = env.SKYWATCH_WORKER_NAME || inferWorkerName(url);
    await cloudflareRequest(
      token,
      `/accounts/${account.id}/workers/scripts/${encodeURIComponent(workerName)}/secrets`,
      {
        method: "PUT",
        body: {
          name: ENCRYPTION_BINDING,
          type: "secret_key",
          format: "raw",
          algorithm: { name: "AES-GCM" },
          usages: ["encrypt", "decrypt"],
          key_base64: bytesToBase64(keyBytes),
        },
      },
    );

    await env.DB.prepare(`INSERT INTO skywatch_config
      (id, account_id, account_name, token_ciphertext, token_iv)
      VALUES (1, ?, ?, ?, ?)`)
      .bind(account.id, account.name, bytesToBase64(new Uint8Array(encrypted)), bytesToBase64(iv))
      .run();

    const sessionCookie = await createSession(env.DB);
    return json(
      { configured: true, account: { id: account.id, name: account.name }, encryption: "finalizing" },
      201,
      { "Set-Cookie": sessionCookie },
    );
  } finally {
    await env.DB.prepare("DELETE FROM skywatch_setup_lock WHERE nonce = ?").bind(lockNonce).run();
  }
}

async function unlock(request: Request, env: RuntimeEnv): Promise<Response> {
  await ensureSchema(env.DB);
  const body = await readJson<{ token?: unknown }>(request);
  const suppliedToken = typeof body.token === "string" ? body.token.trim() : "";
  const storedToken = await decryptStoredToken(env);
  const matches = await timingSafeStringEqual(suppliedToken, storedToken);
  if (!matches) throw new HttpError(401, "That API token does not match this Skywatch instance.", "invalid_token");

  const sessionCookie = await createSession(env.DB);
  return json({ authenticated: true }, 200, { "Set-Cookie": sessionCookie });
}

async function logout(request: Request, env: RuntimeEnv): Promise<Response> {
  const token = getCookie(request, SESSION_COOKIE);
  if (token) {
    await env.DB.prepare("DELETE FROM skywatch_sessions WHERE token_hash = ?").bind(await sha256Base64(token)).run();
  }
  return json({ authenticated: false }, 200, {
    "Set-Cookie": `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`,
  });
}

async function listWorkers(request: Request, env: RuntimeEnv): Promise<Response> {
  await requireAuthentication(request, env.DB);
  const config = await requireConfiguration(env.DB);
  const token = await decryptStoredToken(env);

  const [workers, applications] = await Promise.all([
    cloudflareRequest<WorkerRecord[]>(token, `/accounts/${config.account_id}/workers/scripts-search?per_page=100`, { method: "GET" }),
    cloudflareRequest<AccessApplication[]>(token, `/accounts/${config.account_id}/access/apps?per_page=100`, { method: "GET" }),
  ]);

  const relevantApps = applications.filter((app) =>
    app.destinations?.some((destination) => destination.type === "worker" || destination.type === "all_workers"),
  );
  const policiesByApp = new Map<string, AccessPolicy[]>();
  await Promise.all(relevantApps.map(async (app) => {
    if (app.policies?.length) {
      policiesByApp.set(app.id, app.policies);
      return;
    }
    const policies = await cloudflareRequest<AccessPolicy[]>(
      token,
      `/accounts/${config.account_id}/access/apps/${app.id}/policies`,
      { method: "GET" },
    );
    policiesByApp.set(app.id, policies);
  }));

  const result = workers.map((worker) => {
    const apps = relevantApps.filter((app) => app.destinations?.some((destination) =>
      destination.type === "all_workers" || (destination.type === "worker" && destination.worker_id === worker.id),
    ));
    const policies = apps.flatMap((app) => policiesByApp.get(app.id) ?? []);
    return {
      id: worker.id,
      name: worker.script_name,
      createdAt: worker.created_on ?? null,
      modifiedAt: worker.modified_on ?? null,
      accessStatus: apps.length ? "protected" : "public",
      accessApplication: apps[0] ? { id: apps[0].id, name: apps[0].name ?? null } : null,
      emails: unique(policies.flatMap(extractEmails)),
      policyCount: policies.length,
      managedBySkywatch: apps.some((app) => app.name === managedAppName(worker.script_name)),
    };
  });

  return json({ workers: result, syncedAt: new Date().toISOString() });
}

async function updateWorkerAccess(request: Request, env: RuntimeEnv, workerId: string): Promise<Response> {
  await requireAuthentication(request, env.DB);
  const config = await requireConfiguration(env.DB);
  const token = await decryptStoredToken(env);
  const body = await readJson<{ mode?: unknown; emails?: unknown }>(request);
  const mode = body.mode;
  const emails = Array.isArray(body.emails)
    ? unique(body.emails.filter((email): email is string => typeof email === "string").map((email) => email.trim().toLowerCase()).filter(isEmail))
    : [];
  if (mode !== "public" && mode !== "protected") {
    throw new HttpError(400, "Choose public or Cloudflare Access.", "invalid_access_mode");
  }
  if (mode === "protected" && emails.length === 0) {
    throw new HttpError(400, "Add at least one allowed email address.", "email_required");
  }

  const workers = await cloudflareRequest<WorkerRecord[]>(
    token,
    `/accounts/${config.account_id}/workers/scripts-search?id=${encodeURIComponent(workerId)}`,
    { method: "GET" },
  );
  const worker = workers[0];
  if (!worker) throw new HttpError(404, "Worker not found.", "worker_not_found");

  const applications = await cloudflareRequest<AccessApplication[]>(
    token,
    `/accounts/${config.account_id}/access/apps?per_page=100`,
    { method: "GET" },
  );
  const matching = applications.filter((app) => app.destinations?.some((destination) =>
    destination.type === "worker" && destination.worker_id === worker.id,
  ));
  const managed = matching.find((app) => app.name === managedAppName(worker.script_name));

  if (mode === "public") {
    if (!managed && matching.length) {
      throw new HttpError(409, "This Access application was not created by Skywatch, so it was left unchanged.", "external_access_policy");
    }
    if (managed) {
      await cloudflareRequest(token, `/accounts/${config.account_id}/access/apps/${managed.id}`, { method: "DELETE" });
    }
    return json({ accessStatus: "public", emails: [] });
  }

  if (matching.some((app) => app.id !== managed?.id)) {
    throw new HttpError(409, "This Worker already has an Access application managed outside Skywatch.", "external_access_policy");
  }

  const app = managed ?? await cloudflareRequest<AccessApplication>(
    token,
    `/accounts/${config.account_id}/access/apps`,
    {
      method: "POST",
      body: {
        name: managedAppName(worker.script_name),
        type: "self_hosted",
        session_duration: "24h",
        destinations: [{ type: "worker", worker_id: worker.id }],
      },
    },
  );

  const policies = await cloudflareRequest<AccessPolicy[]>(
    token,
    `/accounts/${config.account_id}/access/apps/${app.id}/policies`,
    { method: "GET" },
  );
  const managedPolicy = policies.find((policy) => policy.name === "Skywatch · allowed emails");
  const policyBody = {
    name: "Skywatch · allowed emails",
    decision: "allow",
    precedence: 1,
    include: emails.map((email) => ({ email: { email } })),
  };
  if (managedPolicy?.id) {
    await cloudflareRequest(
      token,
      `/accounts/${config.account_id}/access/apps/${app.id}/policies/${managedPolicy.id}`,
      { method: "PUT", body: policyBody },
    );
  } else {
    await cloudflareRequest(token, `/accounts/${config.account_id}/access/apps/${app.id}/policies`, {
      method: "POST",
      body: policyBody,
    });
  }

  return json({ accessStatus: "protected", emails });
}

async function verifyApiToken(token: string): Promise<void> {
  const response = await fetch(`${API_ROOT}/user/tokens/verify`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await parseEnvelope<unknown>(response);
  if (!response.ok || !data.success) {
    throw new HttpError(401, "Cloudflare rejected this API token. Check the token and required permissions.", "token_verification_failed");
  }
}

async function discoverScopedAccount(token: string, memberships: Membership[]): Promise<Account> {
  const candidates = uniqueAccounts(
    memberships.map((membership) => membership.account).filter((account): account is Account => Boolean(account)),
  );
  if (candidates.length === 0) {
    throw new HttpError(
      400,
      "This token cannot discover a Cloudflare account. Add User Memberships: Read and include one account.",
      "account_scope_required",
    );
  }

  const accessible = (await Promise.all(candidates.map(async (account) => {
    const response = await fetch(
      `${API_ROOT}/accounts/${account.id}/workers/scripts-search?per_page=1`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const data = await parseEnvelope<unknown>(response);
    return response.ok && data.success ? account : null;
  }))).filter((account): account is Account => Boolean(account));

  if (accessible.length !== 1) {
    throw new HttpError(
      400,
      accessible.length === 0
        ? "This token cannot read Workers in the selected account. Check Workers Scripts: Read and the included account."
        : "This token can access more than one Cloudflare account. Include only one account.",
      "account_scope_required",
    );
  }
  return accessible[0];
}

async function cloudflareRequest<T>(
  token: string,
  path: string,
  init: { method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; body?: unknown },
): Promise<T> {
  const response = await fetch(`${API_ROOT}${path}`, {
    method: init.method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const data = await parseEnvelope<T>(response);
  if (!response.ok || !data.success) {
    const message = data.errors?.map((error) => error.message).filter(Boolean).join(" ") || `Cloudflare API returned ${response.status}.`;
    const status = response.status === 401 || response.status === 403 ? 403 : 502;
    throw new HttpError(status, message, "cloudflare_api_error");
  }
  return data.result;
}

async function parseEnvelope<T>(response: Response): Promise<ApiEnvelope<T>> {
  const data: unknown = await response.json().catch(() => null);
  if (!data || typeof data !== "object" || !("success" in data) || !("result" in data)) {
    throw new HttpError(502, "Cloudflare returned an unexpected response.", "invalid_cloudflare_response");
  }
  return data as ApiEnvelope<T>;
}

async function decryptStoredToken(env: RuntimeEnv): Promise<string> {
  const config = await requireConfiguration(env.DB);
  const key = env.SKYWATCH_TOKEN_KEY;
  if (!key) {
    throw new HttpError(503, "The encryption key is still being attached. Retry in a few seconds.", "setup_finalizing");
  }
  try {
    const clear = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: base64ToBytes(config.token_iv), additionalData: TOKEN_AAD },
      key,
      base64ToBytes(config.token_ciphertext),
    );
    return new TextDecoder().decode(clear);
  } catch {
    throw new HttpError(500, "The stored API token could not be decrypted.", "token_decryption_failed");
  }
}

async function readConfiguration(db: D1Database): Promise<StoredConfiguration | null> {
  return db.prepare(
    "SELECT account_id, account_name, token_ciphertext, token_iv FROM skywatch_config WHERE id = 1",
  ).first<StoredConfiguration>();
}

async function requireConfiguration(db: D1Database): Promise<StoredConfiguration> {
  const config = await readConfiguration(db);
  if (!config) throw new HttpError(409, "Finish setting up Skywatch first.", "not_configured");
  return config;
}

async function createSession(db: D1Database): Promise<string> {
  const token = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  const hash = await sha256Base64(token);
  const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000).toISOString();
  await db.prepare("DELETE FROM skywatch_sessions WHERE expires_at <= CURRENT_TIMESTAMP").run();
  await db.prepare("INSERT INTO skywatch_sessions (token_hash, expires_at) VALUES (?, ?)").bind(hash, expiresAt).run();
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_TTL_SECONDS}`;
}

async function isAuthenticated(request: Request, db: D1Database): Promise<boolean> {
  const token = getCookie(request, SESSION_COOKIE);
  if (!token) return false;
  const row = await db.prepare(
    "SELECT 1 AS valid FROM skywatch_sessions WHERE token_hash = ? AND expires_at > CURRENT_TIMESTAMP",
  ).bind(await sha256Base64(token)).first<{ valid: number }>();
  return row?.valid === 1;
}

async function requireAuthentication(request: Request, db: D1Database): Promise<void> {
  if (!(await isAuthenticated(request, db))) {
    throw new HttpError(401, "Unlock Skywatch to continue.", "authentication_required");
  }
}

function extractEmails(policy: AccessPolicy): string[] {
  return [policy.include, policy.require, policy.exclude]
    .flatMap((rules) => rules ?? [])
    .flatMap((rule) => collectEmails(rule));
}

function collectEmails(value: unknown): string[] {
  if (typeof value === "string") return isEmail(value) ? [value.toLowerCase()] : [];
  if (Array.isArray(value)) return value.flatMap(collectEmails);
  if (!value || typeof value !== "object") return [];
  return Object.values(value).flatMap(collectEmails);
}

function managedAppName(workerName: string): string {
  return `Skywatch · ${workerName}`;
}

function uniqueAccounts(accounts: Account[]): Account[] {
  return [...new Map(accounts.map((account) => [account.id, account])).values()];
}

function inferWorkerName(url: URL): string {
  const firstLabel = url.hostname.split(".")[0];
  if (!firstLabel || !/^[a-z0-9_][a-z0-9-_]*$/.test(firstLabel)) {
    throw new HttpError(400, "Set SKYWATCH_WORKER_NAME to this deployed Worker name and retry setup.", "worker_name_required");
  }
  return firstLabel;
}

function assertSameOrigin(request: Request): void {
  const origin = request.headers.get("Origin");
  if (origin && origin !== new URL(request.url).origin) {
    throw new HttpError(403, "Cross-origin requests are not allowed.", "invalid_origin");
  }
}

async function readJson<T>(request: Request): Promise<T> {
  if (!request.headers.get("Content-Type")?.toLowerCase().includes("application/json")) {
    throw new HttpError(415, "Send this request as JSON.", "invalid_content_type");
  }
  const length = Number(request.headers.get("Content-Length") ?? "0");
  if (length > 16_384) throw new HttpError(413, "Request body is too large.", "body_too_large");
  try {
    return await request.json<T>();
  } catch {
    throw new HttpError(400, "Request body is not valid JSON.", "invalid_json");
  }
}

function getCookie(request: Request, name: string): string | null {
  const cookies = request.headers.get("Cookie") ?? "";
  for (const item of cookies.split(";")) {
    const [key, ...parts] = item.trim().split("=");
    if (key === name) return parts.join("=");
  }
  return null;
}

async function sha256Base64(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return bytesToBase64(new Uint8Array(digest));
}

async function timingSafeStringEqual(left: string, right: string): Promise<boolean> {
  const [leftHash, rightHash] = await Promise.all([sha256Base64(left), sha256Base64(right)]);
  const leftBytes = new TextEncoder().encode(leftHash);
  const rightBytes = new TextEncoder().encode(rightHash);
  if (leftBytes.byteLength !== rightBytes.byteLength) return false;
  const subtle = crypto.subtle as SubtleCrypto & {
    timingSafeEqual(a: ArrayBufferView, b: ArrayBufferView): boolean;
  };
  return subtle.timingSafeEqual(leftBytes, rightBytes);
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 254;
}

function json(body: unknown, status = 200, headers: HeadersInit = {}): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store", ...headers },
  });
}

function withHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
