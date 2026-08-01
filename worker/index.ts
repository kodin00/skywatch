const API_ROOT = "https://api.cloudflare.com/client/v4";
const ENCRYPTION_BINDING = "SKYWATCH_TOKEN_KEY";
const TOKEN_AAD = new TextEncoder().encode("skywatch:cloudflare-api-token:v1");
const AGENT_KEY_AAD = new TextEncoder().encode("skywatch:agent-hmac-key:v1");
const AGENT_DEFAULT_ENDPOINT = "http://skywatch-agent.internal";
const AGENT_MAX_RESPONSE_BYTES = 1024 * 1024;
const AGENT_MAX_LOG_RESPONSE_BYTES = 1024 * 1024;
const AGENT_READ_TIMEOUT_MS = 5_000;
const AGENT_MUTATION_TIMEOUT_MS = 15_000;
const AGENT_PAIR_TIMEOUT_MS = 5_000;
const AGENT_MAX_SERVERS = 100;

type RuntimeEnv = Cloudflare.Env & {
  SKYWATCH_TOKEN_KEY?: CryptoKey;
  VPS_AGENT?: Fetcher;
};

type AgentTransportName = "vpc" | "direct";
type AgentRequestMethod = "GET" | "POST" | "DELETE";
type AgentNode = { id: string; name: string; agentVersion: string };
type StoredAgentConfiguration = {
  transport: AgentTransportName;
  endpoint: string;
  allow_insecure_http: number;
  node_id: string;
  node_name: string;
  agent_version: string;
  key_id: string;
  key_ciphertext: string;
  key_iv: string;
  connected_at: string;
  updated_at: string;
};
type AgentConfigResponse = {
  id: string;
  transport: AgentTransportName;
  endpoint: string;
  allowInsecureHttp: boolean;
  node: AgentNode;
  connectedAt: string;
  updatedAt: string;
};
type AgentResponse<T> = { data: T; status: number };

type ApiEnvelope<T> = {
  success: boolean;
  result: T;
  errors?: Array<{ code?: number; message?: string }>;
  result_info?: {
    page?: number;
    per_page?: number;
    total_pages?: number;
    count?: number;
    total_count?: number;
  };
};

type Account = { id: string; name: string };
type CloudflareUser = { email: string };
type Membership = { account?: Account };
type WorkerRecord = {
  id: string;
  script_name: string;
  service_name?: string;
  created_on?: string;
  modified_on?: string;
};
type WorkerDomain = {
  hostname?: string;
  service?: string;
};
type WorkerSubdomain = { subdomain?: string };
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
  self_hosted_domains?: string[];
  destinations?: Array<{ type?: string; worker_id?: string; uri?: string }>;
  policies?: AccessPolicy[];
};
type AccessReusablePolicy = AccessPolicy & { app_count?: number };
type AccessUser = {
  access_seat?: boolean;
  gateway_seat?: boolean;
};
type AccountSubscription = {
  component_values?: Array<{
    display_name?: string;
    name?: string;
    value?: number;
  }>;
  rate_plan?: {
    id?: string;
    public_name?: string;
  };
};
type SeatUsage = {
  available: boolean;
  used: number | null;
  limit: number | null;
  access: number | null;
  gateway: number | null;
  message?: string;
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
        return withHeaders(await getStatus(env));
      }
      if (request.method === "POST" && url.pathname === "/api/setup") {
        return withHeaders(await setup(request, env, url));
      }
      if (request.method === "POST" && url.pathname === "/api/protect-self") {
        return withHeaders(await protectSelf(env, url));
      }
      if (request.method === "GET" && url.pathname === "/api/workers") {
        return withHeaders(await listWorkers(env));
      }
      if (request.method === "PUT" && /^\/api\/workers\/[^/]+\/access$/.test(url.pathname)) {
        const workerId = decodeURIComponent(url.pathname.split("/")[3] ?? "");
        return withHeaders(await updateWorkerAccess(request, env, workerId));
      }
      if (url.pathname === "/api/servers" && request.method === "GET") {
        return withHeaders(await listAgentConfigurations(env));
      }
      if (url.pathname === "/api/servers" && request.method === "POST") {
        return withHeaders(await updateAgentConfiguration(request, env, null));
      }
      const serverRoute = matchServerRoute(url.pathname);
      if (serverRoute?.resource === "config" && request.method === "PUT") {
        return withHeaders(await updateAgentConfiguration(request, env, serverRoute.serverId));
      }
      if (serverRoute?.resource === "config" && request.method === "DELETE") {
        return withHeaders(await deleteAgentConfiguration(env, serverRoute.serverId));
      }
      if (serverRoute?.resource === "health" && request.method === "GET") {
        return withHeaders(await proxyAgentRead(env, serverRoute.serverId, "/v1/health"));
      }
      if (serverRoute?.resource === "system" && request.method === "GET") {
        return withHeaders(await proxyAgentRead(env, serverRoute.serverId, "/v1/system"));
      }
      if (serverRoute?.resource === "containers" && !serverRoute.containerId && request.method === "GET") {
        return withHeaders(await proxyAgentRead(env, serverRoute.serverId, "/v1/containers"));
      }
      if (serverRoute?.resource === "containers" && serverRoute.containerId && request.method === "GET" && serverRoute.operation === "inspect") {
        return withHeaders(await proxyAgentRead(env, serverRoute.serverId, `/v1/containers/${encodeURIComponent(serverRoute.containerId)}`));
      }
      if (serverRoute?.resource === "containers" && serverRoute.containerId && request.method === "GET" && serverRoute.operation === "logs") {
        const tail = parseLogTail(url.searchParams.get("tail"));
        return withHeaders(await proxyAgentRead(
          env,
          serverRoute.serverId,
          `/v1/containers/${encodeURIComponent(serverRoute.containerId)}/logs?tail=${tail}`,
          AGENT_MAX_LOG_RESPONSE_BYTES,
        ));
      }
      if (serverRoute?.resource === "containers" && serverRoute.containerId && request.method === "POST" && isContainerAction(serverRoute.operation)) {
        return withHeaders(await proxyAgentMutation(env, serverRoute.serverId, serverRoute.containerId, serverRoute.operation));
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
    db.prepare(`CREATE TABLE IF NOT EXISTS skywatch_setup_lock (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      nonce TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS skywatch_agent_config (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      transport TEXT NOT NULL CHECK (transport IN ('vpc', 'direct')),
      endpoint TEXT NOT NULL,
      allow_insecure_http INTEGER NOT NULL DEFAULT 0 CHECK (allow_insecure_http IN (0, 1)),
      node_id TEXT NOT NULL,
      node_name TEXT NOT NULL,
      agent_version TEXT NOT NULL,
      key_id TEXT NOT NULL,
      key_ciphertext TEXT NOT NULL,
      key_iv TEXT NOT NULL,
      connected_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS skywatch_agents (
      node_id TEXT PRIMARY KEY,
      transport TEXT NOT NULL CHECK (transport IN ('vpc', 'direct')),
      endpoint TEXT NOT NULL,
      allow_insecure_http INTEGER NOT NULL DEFAULT 0 CHECK (allow_insecure_http IN (0, 1)),
      node_name TEXT NOT NULL,
      agent_version TEXT NOT NULL,
      key_id TEXT NOT NULL,
      key_ciphertext TEXT NOT NULL,
      key_iv TEXT NOT NULL,
      connected_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS skywatch_agent_migrations (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      migrated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS skywatch_agent_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id TEXT NOT NULL,
      action TEXT NOT NULL,
      outcome TEXT NOT NULL CHECK (outcome IN ('success', 'failure')),
      transport TEXT,
      node_id TEXT,
      container_id TEXT,
      duration_ms INTEGER,
      error_code TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_skywatch_agent_audit_created_at ON skywatch_agent_audit(created_at)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_skywatch_agents_name ON skywatch_agents(node_name COLLATE NOCASE, node_id)"),
    db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_skywatch_agents_single_vpc ON skywatch_agents(transport) WHERE transport = 'vpc'"),
    db.prepare(`INSERT OR IGNORE INTO skywatch_agents
      (node_id, transport, endpoint, allow_insecure_http, node_name, agent_version, key_id,
       key_ciphertext, key_iv, connected_at, updated_at)
      SELECT node_id, transport, endpoint, allow_insecure_http, node_name, agent_version, key_id,
      key_ciphertext, key_iv, connected_at, updated_at
      FROM skywatch_agent_config
      WHERE id = 1
        AND NOT EXISTS (SELECT 1 FROM skywatch_agent_migrations WHERE id = 1)`),
    db.prepare("INSERT OR IGNORE INTO skywatch_agent_migrations (id) VALUES (1)"),
  ]);
}

async function getStatus(env: RuntimeEnv): Promise<Response> {
  await ensureSchema(env.DB);
  const configuration = await readConfiguration(env.DB);
  const encryption = await getEncryptionState(env, configuration);

  return json({
    configured: Boolean(configuration),
    account: configuration
      ? { id: configuration.account_id, name: configuration.account_name }
      : null,
    database: "connected",
    encryption,
  });
}

async function setup(request: Request, env: RuntimeEnv, url: URL): Promise<Response> {
  await ensureSchema(env.DB);
  if (await readConfiguration(env.DB)) {
    throw new HttpError(409, "Skywatch is already configured.", "already_configured");
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
    const owner = await getTokenOwner(token);
    const workerName = env.SKYWATCH_WORKER_NAME || inferWorkerName(url);
    const workers = await cloudflarePaginatedRequest<WorkerRecord>(
      token,
      `/accounts/${account.id}/workers/scripts-search`,
      100,
    );
    const instanceWorker = workers.find((worker) => worker.script_name === workerName || worker.service_name === workerName);
    if (!instanceWorker) {
      throw new HttpError(400, `Skywatch could not find the deployed Worker named ${workerName}.`, "worker_not_found");
    }

    let key = env.SKYWATCH_TOKEN_KEY;
    let keyCreated = false;
    if (!key) {
      const keyBytes = crypto.getRandomValues(new Uint8Array(32));
      key = await crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
      keyCreated = true;

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
    }

    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: TOKEN_AAD }, key, new TextEncoder().encode(token));

    await env.DB.prepare(`INSERT INTO skywatch_config
      (id, account_id, account_name, token_ciphertext, token_iv)
      VALUES (1, ?, ?, ?, ?)`)
      .bind(account.id, account.name, bytesToBase64(new Uint8Array(encrypted)), bytesToBase64(iv))
      .run();

    return json(
      {
        configured: true,
        account: { id: account.id, name: account.name },
        encryption: keyCreated ? "finalizing" : "ready",
        protection: { email: owner.email, pending: true },
      },
      201,
    );
  } finally {
    await env.DB.prepare("DELETE FROM skywatch_setup_lock WHERE nonce = ?").bind(lockNonce).run();
  }
}

async function protectSelf(env: RuntimeEnv, url: URL): Promise<Response> {
  const config = await requireConfiguration(env.DB);
  const token = await decryptStoredToken(env);
  const owner = await getTokenOwner(token);
  const workerName = env.SKYWATCH_WORKER_NAME || inferWorkerName(url);
  const workers = await cloudflarePaginatedRequest<WorkerRecord>(
    token,
    `/accounts/${config.account_id}/workers/scripts-search`,
    100,
  );
  const instanceWorker = workers.find((worker) => worker.script_name === workerName || worker.service_name === workerName);
  if (!instanceWorker) {
    throw new HttpError(404, `Skywatch could not find the deployed Worker named ${workerName}.`, "worker_not_found");
  }
  const protection = await ensureSkywatchAccess(token, config.account_id, instanceWorker, owner.email);
  return json({ protected: true, ...protection });
}

async function listWorkers(env: RuntimeEnv): Promise<Response> {
  const config = await requireConfiguration(env.DB);
  const token = await decryptStoredToken(env);

  const [workers, applications, domains, subdomain, seatUsage] = await Promise.all([
    cloudflarePaginatedRequest<WorkerRecord>(token, `/accounts/${config.account_id}/workers/scripts-search`, 100),
    cloudflarePaginatedRequest<AccessApplication>(token, `/accounts/${config.account_id}/access/apps`, 100),
    optionalCloudflareRequest<WorkerDomain[]>(
      token,
      `/accounts/${config.account_id}/workers/domains`,
      { method: "GET" },
      [],
    ),
    optionalCloudflareRequest<WorkerSubdomain>(
      token,
      `/accounts/${config.account_id}/workers/subdomain`,
      { method: "GET" },
      {},
    ),
    getSeatUsage(token, config.account_id),
  ]);

  const aliasesByWorker = new Map(workers.map((worker) => [
    worker.id,
    workerHostnames(worker, domains, subdomain.subdomain),
  ]));
  const appsByWorker = new Map(workers.map((worker) => [
    worker.id,
    applications.filter((app) => applicationProtectsWorker(app, worker, aliasesByWorker.get(worker.id) ?? [])),
  ]));
  const relevantApps = uniqueById([...appsByWorker.values()].flat());
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
    const apps = appsByWorker.get(worker.id) ?? [];
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

  return json({ workers: result, seatUsage, syncedAt: new Date().toISOString() });
}

async function updateWorkerAccess(request: Request, env: RuntimeEnv, workerId: string): Promise<Response> {
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

  const [applications, domains, subdomain] = await Promise.all([
    cloudflarePaginatedRequest<AccessApplication>(token, `/accounts/${config.account_id}/access/apps`, 100),
    optionalCloudflareRequest<WorkerDomain[]>(
      token,
      `/accounts/${config.account_id}/workers/domains`,
      { method: "GET" },
      [],
    ),
    optionalCloudflareRequest<WorkerSubdomain>(
      token,
      `/accounts/${config.account_id}/workers/subdomain`,
      { method: "GET" },
      {},
    ),
  ]);
  const aliases = workerHostnames(worker, domains, subdomain.subdomain);
  const matching = applications.filter((app) => applicationProtectsWorker(app, worker, aliases));
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

interface AgentTransport {
  readonly name: AgentTransportName;
  fetch(request: Request): Promise<Response>;
}

class DirectAgentTransport implements AgentTransport {
  readonly name = "direct" as const;

  async fetch(request: Request): Promise<Response> {
    return fetch(new Request(request, { redirect: "manual" }));
  }
}

class VpcAgentTransport implements AgentTransport {
  readonly name = "vpc" as const;

  constructor(private readonly binding: Fetcher) {}

  async fetch(request: Request): Promise<Response> {
    return this.binding.fetch(request);
  }
}

class AgentClient {
  private constructor(
    private readonly transport: AgentTransport,
    private readonly endpoint: string,
    private readonly node: AgentNode | null,
    private readonly keyId: string,
    private readonly key: CryptoKey,
  ) {}

  static async fromStored(env: RuntimeEnv, configuration: StoredAgentConfiguration): Promise<AgentClient> {
    const keyBytes = await decryptAgentKey(env, configuration);
    const key = await importHmacKey(keyBytes);
    return new AgentClient(
      createAgentTransport(env, configuration.transport),
      configuration.endpoint,
      storedAgentNode(configuration),
      configuration.key_id,
      key,
    );
  }

  static async candidate(
    transport: AgentTransport,
    endpoint: string,
    keyId: string,
    rawKey: Uint8Array,
  ): Promise<AgentClient> {
    return new AgentClient(transport, endpoint, null, keyId, await importHmacKey(rawKey));
  }

  async request<T>(
    pathAndQuery: string,
    method: AgentRequestMethod,
    body: unknown,
    timeoutMs: number,
    maxBytes = AGENT_MAX_RESPONSE_BYTES,
  ): Promise<AgentResponse<T>> {
    const requestId = crypto.randomUUID();
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const bodyBytes = body === undefined
      ? new Uint8Array()
      : new TextEncoder().encode(JSON.stringify(body));
    const bodyDigest = await sha256Hex(bodyBytes);
    const canonical = agentRequestCanonical(method, pathAndQuery, timestamp, requestId, bodyDigest);
    const signature = await hmacBase64Url(this.key, canonical);
    const headers = new Headers({
      Accept: "application/json",
      "X-Skywatch-Key-Id": this.keyId,
      "X-Skywatch-Timestamp": timestamp,
      "X-Skywatch-Nonce": requestId,
      "X-Skywatch-Content-Sha256": bodyDigest,
      "X-Skywatch-Signature": signature,
    });
    if (body !== undefined) headers.set("Content-Type", "application/json");

    const { response, body: responseBytes } = await fetchAgentWithTimeout(
      this.transport,
      new Request(new URL(pathAndQuery, this.endpoint), {
        method,
        headers,
        body: body === undefined ? undefined : bodyBytes,
        cache: "no-store",
        redirect: "manual",
      }),
      timeoutMs,
      maxBytes,
    );
    await verifyAgentResponse(response, responseBytes, this.keyId, this.key, requestId);
    const payload = parseAgentJson<T>(responseBytes);

    if (!response.ok) throw mapAgentHttpError(response.status, payload);
    if (pathAndQuery === "/v1/health" && this.node) assertAgentNodeIdentity(payload, this.node.id);
    return { data: payload, status: response.status };
  }
}

async function listAgentConfigurations(env: RuntimeEnv): Promise<Response> {
  await ensureSchema(env.DB);
  const configurations = await readAgentConfigurations(env.DB);
  return json({ servers: configurations.map(agentConfigurationResponse) });
}

async function updateAgentConfiguration(
  request: Request,
  env: RuntimeEnv,
  expectedNodeId: string | null,
): Promise<Response> {
  await ensureSchema(env.DB);
  const requestId = crypto.randomUUID();
  const startedAt = Date.now();
  const body = await readJson<{
    transport?: unknown;
    endpoint?: unknown;
    pairingToken?: unknown;
    allowInsecureHttp?: unknown;
  }>(request);
  let transport: AgentTransportName;
  let endpoint: string;
  const pairingToken = typeof body.pairingToken === "string" ? body.pairingToken.trim() : "";
  try {
    transport = parseAgentTransport(body.transport);
    endpoint = validateAgentEndpoint(
      transport,
      body.endpoint,
      body.allowInsecureHttp === true,
    );
    if (pairingToken.length > 512) {
      throw new HttpError(400, "Enter the one-time pairing token shown by the agent.", "invalid_pairing_token");
    }
  } catch (error) {
    await writeAgentAudit(
      env.DB,
      requestId,
      expectedNodeId ? "agent.config.update" : "agent.config.create",
      "failure",
      null,
      null,
      null,
      Date.now() - startedAt,
      agentErrorCode(error),
    );
    throw error;
  }

  try {
    const wrappingKey = requireAgentWrappingKey(env);
    const candidateTransport = createAgentTransport(env, transport);
    const previous = expectedNodeId
      ? await requireAgentConfiguration(env.DB, expectedNodeId)
      : null;
    if (!previous) {
      const count = await env.DB.prepare("SELECT COUNT(*) AS count FROM skywatch_agents")
        .first<{ count: number }>();
      if ((count?.count ?? 0) >= AGENT_MAX_SERVERS) {
        throw new HttpError(409, `Skywatch supports at most ${AGENT_MAX_SERVERS} registered servers.`, "agent_limit_reached");
      }
    }
    if (transport === "vpc") {
      const occupied = await env.DB.prepare(
        "SELECT node_id FROM skywatch_agents WHERE transport = 'vpc' AND node_id != ? LIMIT 1",
      ).bind(expectedNodeId ?? "").first<{ node_id: string }>();
      if (occupied) {
        throw new HttpError(
          409,
          "The fixed VPS_AGENT binding is already assigned to another server. Use direct HTTPS for additional servers.",
          "vpc_binding_in_use",
        );
      }
    }
    const credentials = pairingToken
      ? parsePairingToken(pairingToken)
      : previous
        ? { keyId: previous.key_id, rawKey: await decryptAgentKey(env, previous) }
        : null;
    if (!credentials) {
      throw new HttpError(400, "Enter the pairing token shown by the agent.", "invalid_pairing_token");
    }
    const { keyId, rawKey } = credentials;
    const candidate = await AgentClient.candidate(candidateTransport, endpoint, keyId, rawKey);
    const health = await candidate.request<unknown>(
      "/v1/health",
      "GET",
      undefined,
      AGENT_PAIR_TIMEOUT_MS,
    );
    const system = await candidate.request<unknown>(
      "/v1/system",
      "GET",
      undefined,
      AGENT_PAIR_TIMEOUT_MS,
    );
    const node = parseAgentNode(health.data, system.data);
    if (expectedNodeId && node.id !== expectedNodeId) {
      throw new HttpError(
        409,
        "That endpoint belongs to a different node. Add it as a new server instead.",
        "node_identity_mismatch",
      );
    }
    if (!previous && await readAgentConfiguration(env.DB, node.id)) {
      throw new HttpError(409, "That server is already registered in Skywatch.", "agent_already_registered");
    }
    const encrypted = await encryptAgentKey(wrappingKey, rawKey);
    const now = new Date().toISOString();
    const allowInsecureHttp = transport === "direct"
      && endpoint.startsWith("http://")
      && body.allowInsecureHttp === true;
    const persist = previous
      ? env.DB.prepare(`UPDATE skywatch_agents SET
          transport = ?, endpoint = ?, allow_insecure_http = ?, node_name = ?, agent_version = ?,
          key_id = ?, key_ciphertext = ?, key_iv = ?, updated_at = ?
          WHERE node_id = ?`)
        .bind(
          transport, endpoint, allowInsecureHttp ? 1 : 0, node.name, node.agentVersion,
          keyId, encrypted.ciphertext, encrypted.iv, now, node.id,
        )
      : env.DB.prepare(`INSERT INTO skywatch_agents
          (node_id, transport, endpoint, allow_insecure_http, node_name, agent_version, key_id,
           key_ciphertext, key_iv, connected_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(
          node.id, transport, endpoint, allowInsecureHttp ? 1 : 0, node.name, node.agentVersion,
          keyId, encrypted.ciphertext, encrypted.iv, now, now,
        );
    await env.DB.batch([
      persist,
      auditStatement(
        env.DB,
        requestId,
        previous ? "agent.config.update" : "agent.config.create",
        "success",
        transport,
        node.id,
        null,
        Date.now() - startedAt,
        null,
      ),
      pruneAgentAuditStatement(env.DB),
    ]);

    return json(agentConfigurationResponse(await requireAgentConfiguration(env.DB, node.id)), previous ? 200 : 201);
  } catch (error) {
    const normalizedError = !(error instanceof HttpError) && /UNIQUE constraint/i.test(String(error))
      ? new HttpError(409, "That server or VPC binding is already registered.", "agent_already_registered")
      : error;
    await writeAgentAudit(
      env.DB,
      requestId,
      expectedNodeId ? "agent.config.update" : "agent.config.create",
      "failure",
      transport,
      null,
      null,
      Date.now() - startedAt,
      agentErrorCode(normalizedError),
    );
    throw normalizedError;
  }
}

async function deleteAgentConfiguration(env: RuntimeEnv, nodeId: string): Promise<Response> {
  await ensureSchema(env.DB);
  const requestId = crypto.randomUUID();
  const startedAt = Date.now();
  const existing = await requireAgentConfiguration(env.DB, nodeId);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM skywatch_agents WHERE node_id = ?").bind(nodeId),
    auditStatement(
      env.DB,
      requestId,
      "agent.config.delete",
      "success",
      existing?.transport ?? null,
      existing?.node_id ?? null,
      null,
      Date.now() - startedAt,
      null,
    ),
    pruneAgentAuditStatement(env.DB),
  ]);
  return json({ deleted: true, id: nodeId });
}

async function proxyAgentRead(
  env: RuntimeEnv,
  nodeId: string,
  pathAndQuery: string,
  maxBytes = AGENT_MAX_RESPONSE_BYTES,
): Promise<Response> {
  await ensureSchema(env.DB);
  const config = await requireAgentConfiguration(env.DB, nodeId);
  const client = await AgentClient.fromStored(env, config);
  const response = await client.request<unknown>(pathAndQuery, "GET", undefined, AGENT_READ_TIMEOUT_MS, maxBytes);
  return json(normalizeAgentPayload(pathAndQuery, response.data, config), response.status);
}

async function proxyAgentMutation(
  env: RuntimeEnv,
  nodeId: string,
  containerId: string,
  action: "start" | "stop" | "restart",
): Promise<Response> {
  await ensureSchema(env.DB);
  const config = await requireAgentConfiguration(env.DB, nodeId);
  const requestId = crypto.randomUUID();
  const startedAt = Date.now();
  try {
    const client = await AgentClient.fromStored(env, config);
    const response = await client.request<unknown>(
      `/v1/containers/${encodeURIComponent(containerId)}/${action}`,
      "POST",
      undefined,
      AGENT_MUTATION_TIMEOUT_MS,
    );
    await writeAgentAudit(
      env.DB,
      requestId,
      `agent.container.${action}`,
      "success",
      config.transport,
      config.node_id,
      containerId,
      Date.now() - startedAt,
      null,
    );
    return json(normalizeAgentAction(response.data), response.status);
  } catch (error) {
    await writeAgentAudit(
      env.DB,
      requestId,
      `agent.container.${action}`,
      "failure",
      config.transport,
      config.node_id,
      containerId,
      Date.now() - startedAt,
      agentErrorCode(error),
    );
    throw error;
  }
}

function createAgentTransport(env: RuntimeEnv, transport: AgentTransportName): AgentTransport {
  if (transport === "direct") return new DirectAgentTransport();
  if (!env.VPS_AGENT) {
    throw new HttpError(
      503,
      "The VPS_AGENT VPC Service binding is not attached to this Worker.",
      "agent_transport_unavailable",
    );
  }
  return new VpcAgentTransport(env.VPS_AGENT);
}

function parsePairingToken(value: string): { keyId: string; rawKey: Uint8Array } {
  const separator = value.indexOf(".");
  if (separator < 1 || value.indexOf(".", separator + 1) !== -1) {
    throw new HttpError(400, "The agent pairing token has an invalid format.", "invalid_pairing_token");
  }
  const keyId = value.slice(0, separator);
  const encodedKey = value.slice(separator + 1);
  if (!isCanonicalUuid(keyId)
    || !/^[A-Za-z0-9_-]{43}$/.test(encodedKey)) {
    throw new HttpError(400, "The agent pairing token has an invalid format.", "invalid_pairing_token");
  }
  let rawKey: Uint8Array;
  try {
    rawKey = base64UrlToBytes(encodedKey);
  } catch {
    throw new HttpError(400, "The agent pairing token has an invalid key.", "invalid_pairing_token");
  }
  if (rawKey.byteLength !== 32) {
    throw new HttpError(400, "The agent pairing key must be 32 bytes.", "invalid_pairing_token");
  }
  return { keyId, rawKey };
}

function isCanonicalUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
}

async function fetchAgentWithTimeout(
  transport: AgentTransport,
  request: Request,
  timeoutMs: number,
  maxBytes: number,
): Promise<{ response: Response; body: Uint8Array }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("agent timeout"), timeoutMs);
  const timedRequest = new Request(request, { signal: controller.signal });
  try {
    const response = await transport.fetch(timedRequest);
    const body = await readLimitedBody(response, maxBytes);
    return { response, body };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (controller.signal.aborted || (error instanceof DOMException && error.name === "AbortError")) {
      throw new HttpError(504, "The VPS agent did not respond in time.", "agent_timeout");
    }
    console.warn({ event: "agent_unreachable", transport: transport.name, error: String(error) });
    throw new HttpError(502, "Skywatch could not reach the VPS agent.", "agent_unreachable");
  } finally {
    clearTimeout(timer);
  }
}

async function verifyAgentResponse(
  response: Response,
  body: Uint8Array,
  expectedKeyId: string,
  key: CryptoKey,
  expectedNonce: string,
): Promise<void> {
  const keyId = response.headers.get("X-Skywatch-Key-Id") ?? "";
  const timestamp = response.headers.get("X-Skywatch-Timestamp") ?? "";
  const nonce = response.headers.get("X-Skywatch-Nonce") ?? "";
  const claimedDigest = response.headers.get("X-Skywatch-Content-Sha256") ?? "";
  const signature = response.headers.get("X-Skywatch-Signature") ?? "";
  if (keyId !== expectedKeyId || nonce !== expectedNonce || !/^\d{10}$/.test(timestamp)) {
    throw new HttpError(502, "The VPS agent response could not be authenticated.", "agent_auth_failed");
  }
  const skew = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
  if (skew > 60) {
    throw new HttpError(502, "The VPS agent response timestamp is outside the allowed window.", "agent_auth_failed");
  }
  const actualDigest = await sha256Hex(body);
  if (!/^[a-f0-9]{64}$/.test(claimedDigest) || !(await timingSafeStringEqual(claimedDigest, actualDigest))) {
    throw new HttpError(502, "The VPS agent response body failed integrity verification.", "agent_auth_failed");
  }
  if (!/^[A-Za-z0-9_-]{43}$/.test(signature)) {
    throw new HttpError(502, "The VPS agent response signature is missing or invalid.", "agent_auth_failed");
  }
  const canonical = agentResponseCanonical(expectedNonce, response.status, timestamp, actualDigest);
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    base64UrlToBytes(signature),
    new TextEncoder().encode(canonical),
  );
  if (!valid) {
    throw new HttpError(502, "The VPS agent response signature is invalid.", "agent_auth_failed");
  }
}

function agentRequestCanonical(
  method: AgentRequestMethod,
  pathAndQuery: string,
  timestamp: string,
  nonce: string,
  bodyDigest: string,
): string {
  return `skywatch-agent-v1\n${method}\n${pathAndQuery}\n${timestamp}\n${nonce}\n${bodyDigest}`;
}

function agentResponseCanonical(nonce: string, status: number, timestamp: string, bodyDigest: string): string {
  return `skywatch-agent-response-v1\n${nonce}\n${status}\n${timestamp}\n${bodyDigest}`;
}

async function importHmacKey(rawKey: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", concreteBytes(rawKey), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

async function hmacBase64Url(key: CryptoKey, value: string): Promise<string> {
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return bytesToBase64Url(new Uint8Array(signature));
}

async function sha256Hex(value: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", concreteBytes(value)));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function readLimitedBody(response: Response, maximum: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get("Content-Length") ?? "0");
  if (Number.isFinite(declared) && declared > maximum) {
    await response.body?.cancel();
    throw new HttpError(502, "The VPS agent response was too large.", "agent_response_too_large");
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > maximum) {
        await reader.cancel();
        throw new HttpError(502, "The VPS agent response was too large.", "agent_response_too_large");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function parseAgentJson<T>(body: Uint8Array): T {
  if (body.byteLength === 0) return {} as T;
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(body));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("object required");
    return value as T;
  } catch {
    throw new HttpError(502, "The VPS agent returned an invalid response.", "invalid_agent_response");
  }
}

function mapAgentHttpError(status: number, payload: unknown): HttpError {
  const object = isRecord(payload) ? payload : {};
  const nestedError = isRecord(object.error) ? object.error : null;
  const upstreamMessage = typeof object.error === "string" && object.error.length <= 240
    ? object.error
    : typeof nestedError?.message === "string" && nestedError.message.length <= 240
      ? nestedError.message
      : null;
  if (status === 401 || status === 403) {
    return new HttpError(502, "The VPS agent rejected Skywatch authentication.", "agent_auth_failed");
  }
  if (status === 404) {
    return new HttpError(404, upstreamMessage ?? "The requested agent resource was not found.", "agent_resource_not_found");
  }
  if (status === 409) {
    return new HttpError(409, upstreamMessage ?? "The VPS agent could not apply that operation.", "agent_conflict");
  }
  if (status === 429 || status === 503) {
    return new HttpError(503, "The VPS agent is temporarily unavailable.", "agent_busy");
  }
  return new HttpError(502, "The VPS agent returned an unexpected error.", "agent_error");
}

function assertAgentNodeIdentity(payload: unknown, expectedNodeId: string): void {
  if (!isRecord(payload) || payload.nodeId !== expectedNodeId) {
    throw new HttpError(409, "The connected VPS agent identity changed. Pair it again.", "node_identity_mismatch");
  }
}

function parseAgentNode(health: unknown, system: unknown): AgentNode {
  if (!isRecord(health) || !isRecord(system)) {
    throw new HttpError(502, "The VPS agent did not return its node identity.", "invalid_agent_response");
  }
  const id = typeof health.nodeId === "string" ? health.nodeId.trim() : "";
  const name = typeof system.hostname === "string" ? system.hostname.trim() : "";
  const agentVersion = typeof health.agentVersion === "string" ? health.agentVersion.trim() : "";
  if (!isCanonicalUuid(id) || name.length < 1 || name.length > 128 || agentVersion.length < 1 || agentVersion.length > 64) {
    throw new HttpError(502, "The VPS agent returned an invalid node identity.", "invalid_agent_response");
  }
  return { id, name, agentVersion };
}

function normalizeAgentPayload(pathAndQuery: string, payload: unknown, config: StoredAgentConfiguration): unknown {
  if (!isRecord(payload)) {
    throw new HttpError(502, "The VPS agent returned an invalid response.", "invalid_agent_response");
  }
  if (pathAndQuery === "/v1/health") {
    const status = payload.status;
    if (payload.apiVersion !== "v1"
      || (status !== "ok" && status !== "degraded")
      || typeof payload.dockerAvailable !== "boolean") {
      throw new HttpError(502, "The VPS agent returned an invalid response.", "invalid_agent_response");
    }
    return {
      status,
      node: storedAgentNode(config),
      agentVersion: stringValue(payload.agentVersion),
      uptimeSeconds: typeof payload.uptimeSeconds === "number" ? numberValue(payload.uptimeSeconds) : 0,
      dockerAvailable: payload.dockerAvailable,
      collectedAt: stringValue(payload.sampledAt),
    };
  }
  if (pathAndQuery === "/v1/system") return normalizeAgentSystem(payload, config);
  if (pathAndQuery === "/v1/containers") {
    const containers = arrayValue(payload.containers).map(normalizeContainerSummary);
    containers.sort(compareNormalizedContainers);
    return {
      containers,
      collectedAt: typeof payload.collectedAt === "string"
        ? payload.collectedAt
        : stringValue(payload.sampledAt),
    };
  }
  if (/\/logs\?tail=/.test(pathAndQuery)) {
    const entries = arrayValue(payload.entries);
    return {
      containerId: stringValue(payload.containerId),
      logs: typeof payload.logs === "string"
        ? payload.logs
        : entries.map((entry) => isRecord(entry) ? stringValue(entry.message) : "").join("\n"),
      truncated: payload.truncated === true,
      collectedAt: typeof payload.collectedAt === "string" ? payload.collectedAt : new Date().toISOString(),
    };
  }
  if (/^\/v1\/containers\//.test(pathAndQuery)) {
    return { container: normalizeContainerInspect(payload), collectedAt: new Date().toISOString() };
  }
  return payload;
}

function compareNormalizedContainers(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): number {
  const leftName = stringValue(left.name);
  const rightName = stringValue(right.name);
  const folded = compareText(leftName.toLowerCase(), rightName.toLowerCase());
  if (folded !== 0) return folded;
  const exact = compareText(leftName, rightName);
  if (exact !== 0) return exact;
  return compareText(stringValue(left.id), stringValue(right.id));
}

function compareText(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function normalizeAgentSystem(payload: Record<string, unknown>, config: StoredAgentConfiguration): unknown {
  const cpu = recordValue(payload.cpu);
  const load = recordValue(cpu.loadAverage);
  const memory = recordValue(payload.memory);
  return {
    node: storedAgentNode(config),
    cpu: {
      usagePercent: numberValue(cpu.usagePercent),
      cores: numberValue(cpu.logicalCores),
    },
    memory: {
      usedBytes: numberValue(memory.usedBytes),
      totalBytes: numberValue(memory.totalBytes),
    },
    storage: arrayValue(payload.disks).map((disk) => {
      const item = recordValue(disk);
      const totalBytes = numberValue(item.totalBytes);
      const availableBytes = numberValue(item.availableBytes);
      return {
        mount: stringValue(item.mountPoint),
        usedBytes: Math.max(0, totalBytes - availableBytes),
        totalBytes,
      };
    }),
    load: {
      one: numberValue(load.one),
      five: numberValue(load.five),
      fifteen: numberValue(load.fifteen),
    },
    uptimeSeconds: numberValue(payload.uptimeSeconds),
    collectedAt: stringValue(payload.sampledAt),
  };
}

function normalizeContainerSummary(value: unknown): Record<string, unknown> {
  const item = recordValue(value);
  return {
    id: stringValue(item.id),
    name: stringValue(item.name),
    image: stringValue(item.image),
    state: stringValue(item.state),
    status: stringValue(item.status),
    health: typeof item.health === "string" ? item.health : null,
    createdAt: unixSecondsToIso(item.createdAt),
    startedAt: null,
    ports: normalizePortBindings(item.ports),
    stats: item.stats ?? null,
  };
}

function normalizeContainerInspect(value: unknown): Record<string, unknown> {
  const item = recordValue(value);
  return {
    ...normalizeContainerSummary(item),
    restartCount: numberValue(item.restartCount),
    ports: normalizePortBindings(item.ports),
  };
}

function normalizePortBindings(value: unknown): Array<Record<string, unknown>> {
  if (value === undefined) return [];
  return arrayValue(value).map((port) => {
    const entry = recordValue(port);
    return {
      privatePort: numberValue(entry.privatePort),
      publicPort: typeof entry.publicPort === "number" ? entry.publicPort : null,
      type: typeof entry.type === "string" ? entry.type : stringValue(entry.protocol),
      hostIp: typeof entry.hostIp === "string" ? entry.hostIp : null,
    };
  });
}

function normalizeAgentAction(value: unknown): unknown {
  const payload = recordValue(value);
  return {
    action: stringValue(payload.action),
    changed: payload.changed === true,
    container: normalizeContainerSummary(payload.container),
    completedAt: typeof payload.completedAt === "string" ? payload.completedAt : new Date().toISOString(),
  };
}

function recordValue(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new HttpError(502, "The VPS agent returned an invalid response.", "invalid_agent_response");
  return value;
}

function arrayValue(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new HttpError(502, "The VPS agent returned an invalid response.", "invalid_agent_response");
  return value;
}

function stringValue(value: unknown): string {
  if (typeof value !== "string") throw new HttpError(502, "The VPS agent returned an invalid response.", "invalid_agent_response");
  return value;
}

function numberValue(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new HttpError(502, "The VPS agent returned an invalid response.", "invalid_agent_response");
  }
  return value;
}

function unixSecondsToIso(value: unknown): string | null {
  if (value === null) return null;
  const seconds = numberValue(value);
  const date = new Date(seconds * 1000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function parseAgentTransport(value: unknown): AgentTransportName {
  if (value !== "vpc" && value !== "direct") {
    throw new HttpError(400, "Choose VPC or direct transport.", "invalid_agent_config");
  }
  return value;
}

function validateAgentEndpoint(
  transport: AgentTransportName,
  value: unknown,
  allowInsecureHttp: boolean,
): string {
  const supplied = typeof value === "string" ? value.trim() : "";
  const candidate = supplied || (transport === "vpc" ? AGENT_DEFAULT_ENDPOINT : "");
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new HttpError(400, "Enter a valid agent endpoint URL.", "invalid_agent_config");
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:")
    || url.username
    || url.password
    || (url.pathname !== "/" && url.pathname !== "")
    || url.search
    || url.hash) {
    throw new HttpError(400, "The agent endpoint must be an HTTP(S) origin without credentials, a path, query, or fragment.", "invalid_agent_config");
  }

  if (transport === "direct") {
    const hostname = stripIpv6Brackets(url.hostname).toLowerCase();
    const literalIp = isIpv4Address(hostname) || isIpv6Address(hostname);
    if (literalIp && !isPublicIpAddress(hostname)) {
      throw new HttpError(400, "Direct transport requires a public IP address.", "invalid_agent_config");
    }
    if (!literalIp && (!isSafePublicHostname(hostname) || url.protocol !== "https:")) {
      throw new HttpError(400, "Direct hostnames must be public and use HTTPS.", "invalid_agent_config");
    }
    if (url.protocol === "http:" && (!literalIp || !allowInsecureHttp)) {
      throw new HttpError(
        400,
        "Plain HTTP is allowed only for an explicit public IP after acknowledging the insecure connection.",
        "insecure_agent_url",
      );
    }
  }

  return url.origin;
}

function isSafePublicHostname(hostname: string): boolean {
  return hostname.includes(".")
    && hostname.length <= 253
    && /^[a-z0-9.-]+$/.test(hostname)
    && !hostname.endsWith(".")
    && !hostname.endsWith(".local")
    && !hostname.endsWith(".localhost")
    && !hostname.endsWith(".internal");
}

function isIpv4Address(hostname: string): boolean {
  const parts = hostname.split(".");
  return parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

function isIpv6Address(hostname: string): boolean {
  return hostname.includes(":") && /^[a-f0-9:]+$/i.test(hostname);
}

function isPublicIpAddress(hostname: string): boolean {
  if (isIpv4Address(hostname)) {
    const [a, b, c] = hostname.split(".").map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && (b === 0 || b === 168)) return false;
    if (a === 192 && b === 0 && c === 2) return false;
    if (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) return false;
    if (a === 203 && b === 0 && c === 113) return false;
    return true;
  }
  if (!isIpv6Address(hostname)) return false;
  const first = Number.parseInt(hostname.split(":")[0] || "0", 16);
  return first >= 0x2000 && first <= 0x3fff && !hostname.toLowerCase().startsWith("2001:db8:");
}

function stripIpv6Brackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

type ServerRoute = {
  serverId: string;
  resource: "config" | "health" | "system" | "containers";
  containerId: string | null;
  operation: "inspect" | "logs" | "start" | "stop" | "restart" | null;
};

function matchServerRoute(pathname: string): ServerRoute | null {
  const segments = pathname.split("/").filter(Boolean);
  if (segments[0] !== "api" || segments[1] !== "servers" || segments.length < 3) return null;
  let serverId: string;
  try {
    serverId = decodeURIComponent(segments[2]);
  } catch {
    throw new HttpError(400, "Server identifier is invalid.", "invalid_server_id");
  }
  if (!isCanonicalUuid(serverId)) {
    throw new HttpError(400, "Server identifier is invalid.", "invalid_server_id");
  }
  if (segments.length === 3) {
    return { serverId, resource: "config", containerId: null, operation: null };
  }
  if (segments.length === 4 && (segments[3] === "health" || segments[3] === "system")) {
    return { serverId, resource: segments[3], containerId: null, operation: null };
  }
  if (segments[3] !== "containers" || segments.length > 6) return null;
  if (segments.length === 4) {
    return { serverId, resource: "containers", containerId: null, operation: null };
  }
  let containerId: string;
  try {
    containerId = decodeURIComponent(segments[4]);
  } catch {
    throw new HttpError(400, "Container identifier is invalid.", "invalid_container_id");
  }
  if (!/^[a-f0-9]{64}$/.test(containerId)) {
    throw new HttpError(400, "Container identifier is invalid.", "invalid_container_id");
  }
  const operation = segments[5] ?? "inspect";
  if (!["inspect", "logs", "start", "stop", "restart"].includes(operation)) return null;
  return {
    serverId,
    resource: "containers",
    containerId,
    operation: operation as ServerRoute["operation"],
  };
}

function isContainerAction(value: unknown): value is "start" | "stop" | "restart" {
  return value === "start" || value === "stop" || value === "restart";
}

function parseLogTail(value: string | null): number {
  if (value === null || value === "") return 200;
  if (!/^\d{1,4}$/.test(value)) throw new HttpError(400, "Log tail must be between 1 and 1000.", "invalid_log_tail");
  const tail = Number(value);
  if (tail < 1 || tail > 1000) throw new HttpError(400, "Log tail must be between 1 and 1000.", "invalid_log_tail");
  return tail;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
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

async function getTokenOwner(token: string): Promise<CloudflareUser> {
  try {
    const user = await cloudflareRequest<CloudflareUser>(token, "/user", { method: "GET" });
    const email = user.email?.trim().toLowerCase();
    if (!email || !isEmail(email)) {
      throw new HttpError(502, "Cloudflare did not return a valid email for this token owner.", "owner_email_unavailable");
    }
    return { email };
  } catch (error) {
    if (error instanceof HttpError && error.status === 403) {
      throw new HttpError(
        403,
        "Add User → User Details → Read to the API token so Skywatch can protect itself for your email.",
        "user_details_permission_required",
      );
    }
    throw error;
  }
}

async function ensureSkywatchAccess(
  token: string,
  accountId: string,
  worker: WorkerRecord,
  ownerEmail: string,
): Promise<{ appId: string; email: string }> {
  const applications = await cloudflarePaginatedRequest<AccessApplication>(
    token,
    `/accounts/${accountId}/access/apps`,
    100,
  );
  const existing = applications.find((app) =>
    app.destinations?.some((destination) =>
      destination.type === "worker"
      && (destination.worker_id === worker.id
        || destination.worker_id === worker.script_name
        || destination.worker_id === worker.service_name),
    ),
  );
  if (existing) return { appId: existing.id, email: ownerEmail };

  const policyName = `${managedAppName(worker.script_name)} · owner`;
  const policies = await cloudflarePaginatedRequest<AccessReusablePolicy>(
    token,
    `/accounts/${accountId}/access/policies`,
    100,
  );
  let policy = policies.find((candidate) =>
    candidate.name === policyName
    && candidate.decision === "allow"
    && extractEmails(candidate).length === 1
    && extractEmails(candidate)[0] === ownerEmail,
  );
  let policyCreated = false;
  if (!policy) {
    policy = await cloudflareRequest<AccessReusablePolicy>(token, `/accounts/${accountId}/access/policies`, {
      method: "POST",
      body: {
        name: policyName,
        decision: "allow",
        include: [{ email: { email: ownerEmail } }],
        session_duration: "24h",
      },
    });
    policyCreated = true;
  }
  if (!policy.id) throw new HttpError(502, "Cloudflare did not return the owner Access policy ID.", "access_policy_failed");

  try {
    const app = await cloudflareRequest<AccessApplication>(token, `/accounts/${accountId}/access/apps`, {
      method: "POST",
      body: {
        name: managedAppName(worker.script_name),
        type: "self_hosted",
        session_duration: "24h",
        app_launcher_visible: true,
        http_only_cookie_attribute: true,
        destinations: [{ type: "worker", worker_id: worker.id }],
        policies: [{ id: policy.id, precedence: 1 }],
      },
    });
    return { appId: app.id, email: ownerEmail };
  } catch (error) {
    if (policyCreated) {
      await optionalCloudflareRequest(
        token,
        `/accounts/${accountId}/access/policies/${policy.id}`,
        { method: "DELETE" },
        null,
      );
    }
    throw error;
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
  return (await cloudflareEnvelopeRequest<T>(token, path, init)).result;
}

async function cloudflareEnvelopeRequest<T>(
  token: string,
  path: string,
  init: { method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; body?: unknown },
): Promise<ApiEnvelope<T>> {
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
  return data;
}

async function cloudflarePaginatedRequest<T>(token: string, path: string, perPage: number): Promise<T[]> {
  const results: T[] = [];
  for (let page = 1; page <= 100; page += 1) {
    const separator = path.includes("?") ? "&" : "?";
    const data = await cloudflareEnvelopeRequest<T[]>(
      token,
      `${path}${separator}page=${page}&per_page=${perPage}`,
      { method: "GET" },
    );
    results.push(...data.result);
    const totalPages = data.result_info?.total_pages;
    if (typeof totalPages === "number" ? page >= totalPages : data.result.length < perPage) break;
  }
  return results;
}

async function optionalCloudflareRequest<T>(
  token: string,
  path: string,
  init: { method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; body?: unknown },
  fallback: T,
): Promise<T> {
  try {
    return await cloudflareRequest<T>(token, path, init);
  } catch (error) {
    console.warn({ event: "optional_cloudflare_request_failed", path, error: String(error) });
    return fallback;
  }
}

async function getSeatUsage(token: string, accountId: string): Promise<SeatUsage> {
  try {
    const users = await cloudflarePaginatedRequest<AccessUser>(
      token,
      `/accounts/${accountId}/access/users`,
      1000,
    );
    const subscriptions = await optionalCloudflareRequest<AccountSubscription[]>(
      token,
      `/accounts/${accountId}/subscriptions`,
      { method: "GET" },
      [],
    );
    const access = users.filter((user) => user.access_seat).length;
    const gateway = users.filter((user) => user.gateway_seat).length;
    const used = users.filter((user) => user.access_seat || user.gateway_seat).length;
    return {
      available: true,
      used,
      limit: findSeatLimit(subscriptions, used),
      access,
      gateway,
    };
  } catch (error) {
    console.warn({ event: "seat_usage_unavailable", error: String(error) });
    const detail = error instanceof HttpError ? ` Cloudflare response: ${error.message}` : "";
    return {
      available: false,
      used: null,
      limit: null,
      access: null,
      gateway: null,
      message: `Add Account → Access: Audit Logs → Read to the API token, then refresh.${detail}`,
    };
  }
}

function findSeatLimit(subscriptions: AccountSubscription[], used: number): number | null {
  const zeroTrustSubscriptions = subscriptions.filter((subscription) => {
    const plan = `${subscription.rate_plan?.id ?? ""} ${subscription.rate_plan?.public_name ?? ""}`.toLowerCase();
    return /zero[ -]?trust|cloudflare one|teams|access|gateway/.test(plan);
  });
  const candidates = zeroTrustSubscriptions
    .flatMap((subscription) => subscription.component_values ?? [])
    .filter((component) => /seat|user/.test(`${component.name ?? ""} ${component.display_name ?? ""}`.toLowerCase()))
    .map((component) => component.value)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value >= used);
  return candidates.length ? Math.min(...candidates) : null;
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

async function getEncryptionState(
  env: RuntimeEnv,
  configuration: StoredConfiguration | null,
): Promise<"pending" | "finalizing" | "ready" | "mismatch"> {
  if (!configuration) return env.SKYWATCH_TOKEN_KEY ? "ready" : "pending";
  if (!env.SKYWATCH_TOKEN_KEY) return "finalizing";
  try {
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: base64ToBytes(configuration.token_iv), additionalData: TOKEN_AAD },
      env.SKYWATCH_TOKEN_KEY,
      base64ToBytes(configuration.token_ciphertext),
    );
    return "ready";
  } catch {
    return "mismatch";
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

async function readAgentConfigurations(db: D1Database): Promise<StoredAgentConfiguration[]> {
  const result = await db.prepare(`SELECT transport, endpoint, allow_insecure_http, node_id, node_name, agent_version, key_id,
    key_ciphertext, key_iv, connected_at, updated_at
    FROM skywatch_agents ORDER BY node_name COLLATE NOCASE, node_id`).all<StoredAgentConfiguration>();
  return result.results;
}

async function readAgentConfiguration(db: D1Database, nodeId: string): Promise<StoredAgentConfiguration | null> {
  return db.prepare(`SELECT transport, endpoint, allow_insecure_http, node_id, node_name, agent_version, key_id,
    key_ciphertext, key_iv, connected_at, updated_at
    FROM skywatch_agents WHERE node_id = ? LIMIT 1`).bind(nodeId).first<StoredAgentConfiguration>();
}

async function requireAgentConfiguration(db: D1Database, nodeId: string): Promise<StoredAgentConfiguration> {
  const configuration = await readAgentConfiguration(db, nodeId);
  if (!configuration) {
    throw new HttpError(404, "That registered server was not found.", "agent_not_configured");
  }
  return configuration;
}

function agentConfigurationResponse(configuration: StoredAgentConfiguration): AgentConfigResponse {
  return {
    id: configuration.node_id,
    transport: configuration.transport,
    endpoint: configuration.endpoint,
    allowInsecureHttp: configuration.allow_insecure_http === 1,
    node: storedAgentNode(configuration),
    connectedAt: configuration.connected_at,
    updatedAt: configuration.updated_at,
  };
}

function storedAgentNode(configuration: StoredAgentConfiguration): AgentNode {
  return {
    id: configuration.node_id,
    name: configuration.node_name,
    agentVersion: configuration.agent_version,
  };
}

function requireAgentWrappingKey(env: RuntimeEnv): CryptoKey {
  if (!env.SKYWATCH_TOKEN_KEY) {
    throw new HttpError(503, "The encryption key is not available yet.", "setup_finalizing");
  }
  return env.SKYWATCH_TOKEN_KEY;
}

async function encryptAgentKey(
  wrappingKey: CryptoKey,
  rawKey: Uint8Array,
): Promise<{ ciphertext: string; iv: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const clear = Uint8Array.from(rawKey);
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: AGENT_KEY_AAD },
    wrappingKey,
    clear,
  );
  return {
    ciphertext: bytesToBase64(new Uint8Array(encrypted)),
    iv: bytesToBase64(iv),
  };
}

async function decryptAgentKey(env: RuntimeEnv, configuration: StoredAgentConfiguration): Promise<Uint8Array<ArrayBuffer>> {
  const wrappingKey = requireAgentWrappingKey(env);
  try {
    const clear = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: base64ToBytes(configuration.key_iv),
        additionalData: AGENT_KEY_AAD,
      },
      wrappingKey,
      base64ToBytes(configuration.key_ciphertext),
    );
    const result = new Uint8Array(clear);
    if (result.byteLength !== 32) throw new Error("invalid key length");
    return result;
  } catch {
    throw new HttpError(500, "The stored agent key could not be decrypted.", "agent_key_decryption_failed");
  }
}

function auditStatement(
  db: D1Database,
  requestId: string,
  action: string,
  outcome: "success" | "failure",
  transport: AgentTransportName | null,
  nodeId: string | null,
  containerId: string | null,
  durationMs: number | null,
  errorCode: string | null,
): D1PreparedStatement {
  return db.prepare(`INSERT INTO skywatch_agent_audit
    (request_id, action, outcome, transport, node_id, container_id, duration_ms, error_code)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(requestId, action, outcome, transport, nodeId, containerId, durationMs, errorCode);
}

function pruneAgentAuditStatement(db: D1Database): D1PreparedStatement {
  return db.prepare(`DELETE FROM skywatch_agent_audit
    WHERE id NOT IN (SELECT id FROM skywatch_agent_audit ORDER BY id DESC LIMIT 1000)`);
}

async function writeAgentAudit(
  db: D1Database,
  requestId: string,
  action: string,
  outcome: "success" | "failure",
  transport: AgentTransportName | null,
  nodeId: string | null,
  containerId: string | null,
  durationMs: number | null,
  errorCode: string | null,
): Promise<void> {
  try {
    await db.batch([
      auditStatement(db, requestId, action, outcome, transport, nodeId, containerId, durationMs, errorCode),
      pruneAgentAuditStatement(db),
    ]);
  } catch (error) {
    console.error({ event: "agent_audit_failed", requestId, error: String(error) });
  }
}

function agentErrorCode(error: unknown): string {
  return error instanceof HttpError ? error.code : "internal_error";
}

function workerHostnames(worker: WorkerRecord, domains: WorkerDomain[], accountSubdomain?: string): string[] {
  const serviceNames = new Set([worker.id, worker.script_name, worker.service_name].filter(Boolean));
  const hostnames = domains
    .filter((domain) => domain.service && serviceNames.has(domain.service))
    .map((domain) => normalizeHostname(domain.hostname));
  const subdomain = normalizeHostname(accountSubdomain);
  if (subdomain) {
    hostnames.push(`${worker.script_name}.${subdomain}.workers.dev`);
    if (worker.service_name && worker.service_name !== worker.script_name) {
      hostnames.push(`${worker.service_name}.${subdomain}.workers.dev`);
    }
  }
  return unique(hostnames.filter(Boolean));
}

function applicationProtectsWorker(app: AccessApplication, worker: WorkerRecord, hostnames: string[]): boolean {
  if (app.destinations?.some((destination) => destination.type === "all_workers")) return true;
  if (app.destinations?.some((destination) =>
    destination.type === "worker"
    && (
      destination.worker_id === worker.id
      || destination.worker_id === worker.script_name
      || destination.worker_id === worker.service_name
    ),
  )) return true;

  const protectedUris = [
    app.domain,
    ...(app.self_hosted_domains ?? []),
    ...(app.destinations ?? [])
      .filter((destination) => destination.type === "public")
      .map((destination) => destination.uri),
  ].filter((value): value is string => typeof value === "string" && value.length > 0);

  return protectedUris.some((uri) => {
    const pattern = normalizeHostname(uri);
    if (!pattern) return false;
    if (hostnames.some((hostname) => hostnameMatches(pattern, hostname))) return true;
    const firstLabel = pattern.split(".")[0];
    return pattern.endsWith(".workers.dev")
      && (firstLabel === worker.script_name || firstLabel === worker.service_name);
  });
}

function normalizeHostname(value: string | undefined): string {
  if (!value) return "";
  const withoutScheme = value.trim().toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  return withoutScheme.split("/")[0]?.split(":")[0]?.replace(/\.$/, "") ?? "";
}

function hostnameMatches(pattern: string, hostname: string): boolean {
  if (!pattern.includes("*")) return pattern === hostname;
  const expression = pattern
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${expression}$`, "i").test(hostname);
}

function uniqueById<T extends { id: string }>(values: T[]): T[] {
  return [...new Map(values.map((value) => [value.id, value])).values()];
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
    const text = await request.text();
    if (new TextEncoder().encode(text).byteLength > 16_384) {
      throw new HttpError(413, "Request body is too large.", "body_too_large");
    }
    return JSON.parse(text) as T;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "Request body is not valid JSON.", "invalid_json");
  }
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
    timingSafeEqual?(a: ArrayBufferView, b: ArrayBufferView): boolean;
  };
  if (subtle.timingSafeEqual) return subtle.timingSafeEqual(leftBytes, rightBytes);
  let difference = 0;
  for (let index = 0; index < leftBytes.byteLength; index += 1) {
    difference |= leftBytes[index] ^ rightBytes[index];
  }
  return difference === 0;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - value.length % 4) % 4);
  return base64ToBytes(value.replaceAll("-", "+").replaceAll("_", "/") + padding);
}

function concreteBytes(value: Uint8Array): Uint8Array<ArrayBuffer> {
  const result = new Uint8Array(new ArrayBuffer(value.byteLength));
  result.set(value);
  return result;
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

export const __test = {
  validateAgentEndpoint,
  parsePairingToken,
  parseAgentNode,
  normalizeAgentPayload,
  agentConfigurationResponse,
  matchServerRoute,
  agentRequestCanonical,
  agentResponseCanonical,
  selectAgentTransport(transport: AgentTransportName, binding?: Fetcher): AgentTransportName {
    return createAgentTransport({ VPS_AGENT: binding } as RuntimeEnv, transport).name;
  },
  async verifyAgentResponse(
    response: Response,
    body: Uint8Array,
    expectedKeyId: string,
    rawKey: Uint8Array,
    expectedNonce: string,
  ): Promise<void> {
    return verifyAgentResponse(response, body, expectedKeyId, await importHmacKey(rawKey), expectedNonce);
  },
  async signResponse(
    nonce: string,
    status: number,
    timestamp: string,
    body: Uint8Array,
    rawKey: Uint8Array,
  ): Promise<{ digest: string; signature: string }> {
    const digest = await sha256Hex(body);
    const key = await importHmacKey(rawKey);
    return {
      digest,
      signature: await hmacBase64Url(key, agentResponseCanonical(nonce, status, timestamp, digest)),
    };
  },
  readLimitedBody,
};
