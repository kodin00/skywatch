import { describe, expect, it } from "vitest";

import { __test } from "./index";

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
