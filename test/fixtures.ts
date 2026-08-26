import type { CapabilityManifest, ProbeProtocol } from "../src/domain/manifest.ts";

function compatibility(protocol: ProbeProtocol, id: string) {
  return { protocol, status: "VERIFIED" as const, confidence: 0.99, evidenceIds: [id] };
}

export function verifiedManifest(): CapabilityManifest {
  const levels = ["none", "minimal", "low", "medium", "high", "xhigh", "max"].map((canonical) => ({
    canonical: canonical as CapabilityManifest["reasoning"]["levels"][number]["canonical"],
    wireValue: canonical,
    status: "VERIFIED" as const,
    confidence: 0.98,
    evidenceIds: ["reasoning-responses"],
  }));
  return {
    schemaVersion: "0.1.0",
    kind: "probemux.capability-manifest",
    identity: {
      providerId: "fixture-gateway",
      modelId: "fixture-reasoning-model",
      endpointFingerprint: "https://api.example.invalid/v1",
    },
    protocols: {
      responses: {
        protocol: "responses",
        endpointPath: "/v1/responses",
        status: "VERIFIED",
        confidence: 0.99,
        evidenceIds: ["protocol-responses"],
      },
      "chat-completions": {
        protocol: "chat-completions",
        endpointPath: "/v1/chat/completions",
        status: "VERIFIED",
        confidence: 0.99,
        evidenceIds: ["protocol-chat"],
      },
    },
    reasoning: {
      status: "VERIFIED",
      confidence: 0.98,
      evidenceIds: ["reasoning-responses", "reasoning-chat"],
      levels,
      dialects: [
        {
          protocol: "responses",
          parameterPath: "reasoning.effort",
          status: "VERIFIED",
          confidence: 0.98,
          evidenceIds: ["reasoning-responses"],
          levels,
        },
        {
          protocol: "chat-completions",
          parameterPath: "reasoning_effort",
          status: "VERIFIED",
          confidence: 0.98,
          evidenceIds: ["reasoning-chat"],
          levels: levels.map((level) => ({ ...level, evidenceIds: ["reasoning-chat"] })),
        },
      ],
    },
    messageRoles: {
      system: {
        status: "VERIFIED",
        confidence: 0.99,
        evidenceIds: ["role-system"],
        byProtocol: [compatibility("responses", "role-system"), compatibility("chat-completions", "role-system")],
      },
      developer: {
        status: "VERIFIED",
        confidence: 0.99,
        evidenceIds: ["role-developer"],
        byProtocol: [compatibility("responses", "role-developer"), compatibility("chat-completions", "role-developer")],
      },
    },
    toolCalling: {
      status: "VERIFIED",
      confidence: 0.99,
      evidenceIds: ["tools"],
      byProtocol: [compatibility("responses", "tools"), compatibility("chat-completions", "tools")],
    },
    evidence: [],
    conflicts: [],
    generatedAt: "2026-08-25T00:00:00.000Z",
  };
}

export const deepSeekProfile = verifiedManifest;
