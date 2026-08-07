import { describe, expect, it } from "vitest";

import worker, { __test } from "./index";

const KEY_ID = "123e4567-e89b-42d3-a456-426614174000";
const RAW_KEY = new Uint8Array(32);
const PAIRING_TOKEN = `${KEY_ID}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`;

function thrownCode(run: () => unknown): string | undefined {
  try {
    run();
    return undefined;
  } catch (error) {
    return error && typeof error === "object" && "code" in error
      ? String(error.code)
      : undefined;
  }
}

describe("agent endpoint validation", () => {
  it("accepts direct HTTPS origins and normalizes the path", () => {
    expect(__test.validateAgentEndpoint("direct", "https://vps.example.com:8443/", false))
      .toBe("https://vps.example.com:8443");
  });

  it("allows acknowledged HTTP only for a literal public IP", () => {
    expect(__test.validateAgentEndpoint("direct", "http://8.8.8.8:8787", true))
      .toBe("http://8.8.8.8:8787");
    expect(thrownCode(() => __test.validateAgentEndpoint("direct", "http://8.8.8.8:8787", false)))
      .toBe("insecure_agent_url");
    expect(thrownCode(() => __test.validateAgentEndpoint("direct", "http://vps.example.com:8787", true)))
      .toBe("invalid_agent_config");
  });

  it("rejects private or reserved direct IPs for both schemes", () => {
    for (const endpoint of [
      "https://10.0.0.1",
      "http://127.0.0.1:8080",
      "https://192.168.1.10",
      "https://[fd00::1]",
      "https://203.0.113.9",
    ]) {
      expect(thrownCode(() => __test.validateAgentEndpoint("direct", endpoint, true)))
        .toBe("invalid_agent_config");
    }
  });

  it("uses a harmless Host value for an omitted VPC endpoint", () => {
    expect(__test.validateAgentEndpoint("vpc", "", false)).toBe("http://skywatch-agent.internal");
  });

  it("reports the persisted insecure acknowledgement explicitly", () => {
    const response = __test.agentConfigurationResponse({
      transport: "direct",
      endpoint: "http://8.8.8.8:8787",
      allow_insecure_http: 1,
      node_id: KEY_ID,
      node_name: "vps-01",
      agent_version: "0.1.0",
      key_id: KEY_ID,
      key_ciphertext: "encrypted",
      key_iv: "iv",
      connected_at: "2026-08-01T00:00:00.000Z",
      updated_at: "2026-08-01T00:00:00.000Z",
    });
    expect(response.id).toBe(KEY_ID);
    expect(response.allowInsecureHttp).toBe(true);
  });
});

describe("agent signing contract", () => {
  it("builds the exact request and response canonical strings", () => {
    expect(__test.agentRequestCanonical("GET", "/v1/health?full=1", "1700000000", "nonce", "abc"))
      .toBe("skywatch-agent-v1\nGET\n/v1/health?full=1\n1700000000\nnonce\nabc");
    expect(__test.agentResponseCanonical("nonce", 200, "1700000001", "def"))
      .toBe("skywatch-agent-response-v1\nnonce\n200\n1700000001\ndef");
  });

  it("parses only UUID plus base64url 32-byte pairing tokens", () => {
    const parsed = __test.parsePairingToken(PAIRING_TOKEN);
    expect(parsed.keyId).toBe(KEY_ID);
    expect([...parsed.rawKey]).toEqual([...RAW_KEY]);
    expect(thrownCode(() => __test.parsePairingToken(`${KEY_ID}.short`))).toBe("invalid_pairing_token");
    expect(thrownCode(() => __test.parsePairingToken(PAIRING_TOKEN.toUpperCase())))
      .toBe("invalid_pairing_token");
  });

  it("accepts a stable UUID node identity and rejects legacy hex IDs", () => {
    expect(__test.parseAgentNode(
      { nodeId: KEY_ID, agentVersion: "0.1.0" },
      { hostname: "vps-01" },
    )).toEqual({ id: KEY_ID, name: "vps-01", agentVersion: "0.1.0" });
    expect(thrownCode(() => __test.parseAgentNode(
      { nodeId: "a".repeat(64), agentVersion: "0.1.0" },
      { hostname: "vps-01" },
    ))).toBe("invalid_agent_response");
  });

  it("verifies a signed response and rejects a changed body", async () => {
    const nonce = "123e4567-e89b-42d3-a456-426614174001";
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const body = new TextEncoder().encode('{"status":"ok"}');
    const signed = await __test.signResponse(nonce, 200, timestamp, body, RAW_KEY);
    const response = new Response(body, {
      status: 200,
      headers: {
        "X-Skywatch-Key-Id": KEY_ID,
        "X-Skywatch-Timestamp": timestamp,
        "X-Skywatch-Nonce": nonce,
        "X-Skywatch-Content-Sha256": signed.digest,
        "X-Skywatch-Signature": signed.signature,
      },
    });

    await expect(__test.verifyAgentResponse(response, body, KEY_ID, RAW_KEY, nonce)).resolves.toBeUndefined();
    await expect(__test.verifyAgentResponse(
      response,
      new TextEncoder().encode('{"status":"degraded"}'),
      KEY_ID,
      RAW_KEY,
      nonce,
    )).rejects.toMatchObject({ code: "agent_auth_failed" });
  });

  it("rejects a response that exceeds its byte cap", async () => {
    await expect(__test.readLimitedBody(new Response("oversized"), 4))
      .rejects.toMatchObject({ code: "agent_response_too_large" });
  });
});

describe("agent transport selection", () => {
  it("never falls back when the VPC binding is missing", () => {
    expect(thrownCode(() => __test.selectAgentTransport("vpc"))).toBe("agent_transport_unavailable");
    expect(__test.selectAgentTransport("direct")).toBe("direct");
  });
});

describe("server-scoped agent routes", () => {
  it("keeps server and container identities explicit in every live route", () => {
    const containerId = "a".repeat(64);
    expect(__test.matchServerRoute(`/api/servers/${KEY_ID}/system`)).toEqual({
      serverId: KEY_ID,
      resource: "system",
      containerId: null,
      operation: null,
    });
    expect(__test.matchServerRoute(`/api/servers/${KEY_ID}/containers/${containerId}/restart`)).toEqual({
      serverId: KEY_ID,
      resource: "containers",
      containerId,
      operation: "restart",
    });
    expect(thrownCode(() => __test.matchServerRoute("/api/servers/not-a-uuid/system")))
      .toBe("invalid_server_id");
  });
});

describe("agent response normalization", () => {
  it("sorts concurrently sampled containers by name and ID", () => {
    const config = {
      transport: "direct",
      endpoint: "https://agent.example.com",
      allow_insecure_http: 0,
      node_id: KEY_ID,
      node_name: "vps-01",
      agent_version: "0.1.1",
      key_id: KEY_ID,
      key_ciphertext: "encrypted",
      key_iv: "iv",
      connected_at: "2026-08-01T00:00:00.000Z",
      updated_at: "2026-08-01T00:00:00.000Z",
    } as const;
    const container = (name: string, id: string) => ({
      id,
      name,
      image: "example/image:latest",
      state: "running",
      status: "Up 1 minute",
      health: null,
      createdAt: 1_700_000_000,
      ports: [],
      stats: null,
    });

    const normalized = __test.normalizeAgentPayload("/v1/containers", {
      containers: [
        container("web", "b".repeat(64)),
        container("api", "c".repeat(64)),
        container("api", "a".repeat(64)),
      ],
      collectedAt: "2026-08-01T00:00:00.000Z",
    }, config) as { containers: Array<{ id: string; name: string }> };

    expect(normalized.containers.map(({ id }) => id)).toEqual([
      "a".repeat(64),
      "c".repeat(64),
      "b".repeat(64),
    ]);
  });
});

describe("project payload validation", () => {
  it("rejects unknown source types", () => {
    expect(thrownCode(() => __test.validateProjectPayload({
      name: "app",
      sourceType: "svn",
      sourceConfig: {},
    }))).toBe("invalid_source_type");
  });

  it("rejects github configs without a valid repo URL", () => {
    for (const repoUrl of ["ftp://example.com/repo", "example.com/repo", ""]) {
      expect(thrownCode(() => __test.validateProjectPayload({
        name: "app",
        sourceType: "github",
        sourceConfig: { repoUrl, buildMode: "docker" },
      }))).toBe("invalid_source_config");
    }
  });

  it("requires a build command for command builds", () => {
    expect(thrownCode(() => __test.validateProjectPayload({
      name: "app",
      sourceType: "github",
      sourceConfig: { repoUrl: "https://github.com/example/repo", buildMode: "command" },
    }))).toBe("invalid_source_config");
    expect(thrownCode(() => __test.validateProjectPayload({
      name: "app",
      sourceType: "github",
      sourceConfig: { repoUrl: "https://github.com/example/repo", buildMode: "command", buildCommand: "  " },
    }))).toBe("invalid_source_config");
  });

  it("normalizes a valid github payload", () => {
    const payload = __test.validateProjectPayload({
      name: "  app  ",
      sourceType: "github",
      sourceConfig: {
        repoUrl: "git@github.com:example/repo.git",
        branch: "main",
        buildMode: "command",
        buildCommand: "make release",
      },
      env: "A=1",
    });
    expect(payload.name).toBe("app");
    expect(payload.sourceConfig).toEqual({
      repoUrl: "git@github.com:example/repo.git",
      branch: "main",
      buildMode: "command",
      buildCommand: "make release",
    });
    expect(payload.env).toBe("A=1");
  });

  it("enforces per-type size limits and required content", () => {
    expect(thrownCode(() => __test.validateProjectPayload({
      name: "app",
      sourceType: "image",
      sourceConfig: { image: "x".repeat(513) },
    }))).toBe("invalid_source_config");
    expect(thrownCode(() => __test.validateProjectPayload({
      name: "app",
      sourceType: "compose",
      sourceConfig: { compose: "   " },
    }))).toBe("invalid_source_config");
    expect(thrownCode(() => __test.validateProjectPayload({
      name: "app",
      sourceType: "script",
      sourceConfig: { script: "" },
    }))).toBe("invalid_source_config");
    expect(thrownCode(() => __test.validateProjectPayload({
      name: "app",
      sourceType: "image",
      sourceConfig: { image: "example/image:latest" },
      env: "x".repeat(64 * 1024 + 1),
    }))).toBe("invalid_env");
  });
});

describe("worker name validation", () => {
  it("accepts lowercase dashed names up to 63 characters", () => {
    expect(__test.validateWorkerName("a")).toBe("a");
    expect(__test.validateWorkerName("my-worker-1")).toBe("my-worker-1");
    expect(__test.validateWorkerName("a".repeat(63))).toBe("a".repeat(63));
  });

  it("rejects malformed names", () => {
    for (const name of ["", "-bad", "bad-", "Bad", "bad_name", "a".repeat(64), "bad..name"]) {
      expect(thrownCode(() => __test.validateWorkerName(name))).toBe("invalid_worker_name");
    }
  });
});

describe("dotenv parsing", () => {
  it("parses KEY=VALUE lines and skips comments and malformed lines", () => {
    expect(__test.parseDotEnv([
      "# a comment",
      "",
      "FOO=bar",
      'QUOTED="hello world"',
      "SINGLE='x y'",
      "EMPTY=",
      "NO_SEPARATOR",
      "1BAD=skipped",
      "SPACED = padded ",
    ].join("\n"))).toEqual([
      { name: "FOO", value: "bar" },
      { name: "QUOTED", value: "hello world" },
      { name: "SINGLE", value: "x y" },
      { name: "EMPTY", value: "" },
      { name: "SPACED", value: "padded" },
    ]);
  });

  it("returns no bindings for empty content", () => {
    expect(__test.parseDotEnv("")).toEqual([]);
  });
});

describe("project and deployment route matching", () => {
  it("matches project routes and validates UUID path params", () => {
    expect(__test.matchProjectRoute(`/api/projects/${KEY_ID}`))
      .toEqual({ projectId: KEY_ID, action: null });
    expect(__test.matchProjectRoute(`/api/projects/${KEY_ID}/deploy`))
      .toEqual({ projectId: KEY_ID, action: "deploy" });
    expect(__test.matchProjectRoute("/api/projects")).toBeNull();
    expect(__test.matchProjectRoute(`/api/projects/${KEY_ID}/unknown`)).toBeNull();
    expect(thrownCode(() => __test.matchProjectRoute("/api/projects/not-a-uuid")))
      .toBe("invalid_project_id");
  });

  it("matches deployment routes and validates UUID path params", () => {
    expect(__test.matchDeploymentRoute(`/api/deployments/${KEY_ID}`))
      .toEqual({ deploymentId: KEY_ID });
    expect(__test.matchDeploymentRoute("/api/deployments")).toBeNull();
    expect(thrownCode(() => __test.matchDeploymentRoute("/api/deployments/not-a-uuid")))
      .toBe("invalid_deployment_id");
  });
});

describe("project and deployment route 404s", () => {
  const CONFIG_ROW = {
    account_id: "account-1",
    account_name: "Test Account",
    token_ciphertext: "ciphertext",
    token_iv: "iv",
  };

  function fakeDb(): D1Database {
    const makeStatement = (sql: string) => {
      const statement = {
        bind: () => statement,
        first: async () => (sql.includes("FROM skywatch_config") ? CONFIG_ROW : null),
        all: async () => ({ results: [] }),
        run: async () => ({ meta: { changes: 1 } }),
      };
      return statement;
    };
    return {
      prepare: (sql: string) => makeStatement(sql),
      batch: async () => [],
    } as unknown as D1Database;
  }

  const env = { DB: fakeDb() } as unknown as Cloudflare.Env;

  async function fetchCode(path: string): Promise<{ status: number; code: string | undefined }> {
    const request = new Request(`https://skywatch.example${path}`) as unknown as Parameters<typeof worker.fetch>[0];
    const response = await worker.fetch(request, env);
    const body = await response.json() as { code?: string };
    return { status: response.status, code: body.code };
  }

  it("returns project_not_found for unknown project ids", async () => {
    expect(await fetchCode(`/api/projects/${KEY_ID}`))
      .toEqual({ status: 404, code: "project_not_found" });
  });

  it("returns deployment_not_found for unknown deployment ids", async () => {
    expect(await fetchCode(`/api/deployments/${KEY_ID}`))
      .toEqual({ status: 404, code: "deployment_not_found" });
  });

  it("returns not_found for unknown api routes", async () => {
    expect(await fetchCode("/api/definitely-not-a-route"))
      .toEqual({ status: 404, code: "not_found" });
  });
});
