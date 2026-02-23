#!/usr/bin/env node
/**
 * Trust MCP Server v2.0.0
 *
 * Provides AI agents with tools to verify trust before transacting.
 * Part of the trustthenverify.com protocol.
 *
 * Tools:
 * - trust_lookup: Get an agent's trust score (0-100)
 * - trust_register: Register yourself in the registry
 * - trust_review: Submit a review after a transaction
 * - trust_list: List all registered agents
 * - trust_verify: Verify identity on any supported chain
 * - trust_challenge: Get a verification challenge for a chain
 * - trust_search: Search agents by criteria
 * - trust_evidence: Submit self-reported evidence
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const REGISTRY_URL = process.env.TRUST_REGISTRY_URL || "https://trustthenverify.com";

const TIERS: Record<number, { label: string; badge: string }> = {
  80: { label: "Highly Trusted", badge: "🏆" },
  60: { label: "Trusted", badge: "✅" },
  40: { label: "Moderate", badge: "🔵" },
  20: { label: "New/Limited", badge: "🟡" },
  0: { label: "Unverified", badge: "⚪" },
};

function getTier(score: number) {
  for (const [threshold, tier] of Object.entries(TIERS).sort((a, b) => Number(b[0]) - Number(a[0]))) {
    if (score >= Number(threshold)) return tier;
  }
  return TIERS[0];
}

async function safeFetch(url: string, init?: RequestInit): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch {
    throw new Error("Registry unreachable — check network or try again later");
  }
  if (res.status === 502 || res.status === 503 || res.status === 504) {
    throw new Error("Registry is temporarily offline — try again later");
  }
  return res;
}

async function postJson(path: string, body: Record<string, any>): Promise<Response> {
  return safeFetch(`${REGISTRY_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : "Unknown error";
}

function ok(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function fail(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true };
}

// ─── Tool Definitions ────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: "trust_lookup",
    description: "Look up an agent's trust score before transacting. Returns score (0-100), tier, and verification details.",
    inputSchema: {
      type: "object" as const,
      properties: {
        agent_id: {
          type: "string",
          description: "Agent UUID or name to look up",
        },
      },
      required: ["agent_id"],
    },
  },
  {
    name: "trust_register",
    description: "Register yourself in the trust registry. Free registration, instant trust score.",
    inputSchema: {
      type: "object" as const,
      properties: {
        name: { type: "string", description: "Your agent name" },
        contact: { type: "string", description: "Contact email or @handle" },
        description: { type: "string", description: "What you do (optional)" },
      },
      required: ["name", "contact"],
    },
  },
  {
    name: "trust_review",
    description: "Submit a review for an agent after a transaction. Reviews with proof-of-payment are marked as verified.",
    inputSchema: {
      type: "object" as const,
      properties: {
        agent_id: { type: "string", description: "Agent UUID to review" },
        rating: { type: "number", description: "Rating 1-5", minimum: 1, maximum: 5 },
        comment: { type: "string", description: "Review comment" },
        reviewer_pubkey: { type: "string", description: "Your Lightning pubkey (optional)" },
        proof_of_payment: { type: "string", description: "Lightning preimage hex (optional, marks review as verified)" },
      },
      required: ["agent_id", "rating", "comment"],
    },
  },
  {
    name: "trust_list",
    description: "List all registered agents with their trust scores. Supports pagination.",
    inputSchema: {
      type: "object" as const,
      properties: {
        limit: { type: "number", description: "Max agents to return (default 20, max 100)" },
        page: { type: "number", description: "Page number (default 1)" },
      },
    },
  },
  {
    name: "trust_verify",
    description: "Verify your identity on a blockchain or platform. Supported chains: lightning, ethereum, solana, nostr, domain, twitter, ens, endpoint, github. For chains requiring a signature, first use trust_challenge to get a challenge, sign it, then call this with the signature.",
    inputSchema: {
      type: "object" as const,
      properties: {
        agent_id: { type: "string", description: "Your agent UUID" },
        chain: {
          type: "string",
          description: "Verification chain",
          enum: ["lightning", "ethereum", "solana", "nostr", "domain", "twitter", "ens", "endpoint", "github"],
        },
        signature: { type: "string", description: "Signed challenge (for lightning/ethereum/solana)" },
        pubkey: { type: "string", description: "Public key (for lightning)" },
        address: { type: "string", description: "Wallet address (for ethereum/solana)" },
        domain: { type: "string", description: "Domain to verify (for domain chain)" },
        handle: { type: "string", description: "Twitter/X handle (for twitter chain)" },
        ens_name: { type: "string", description: "ENS name (for ens chain)" },
        endpoint_url: { type: "string", description: "Agent endpoint URL (for endpoint chain)" },
        code: { type: "string", description: "OAuth code (for github chain)" },
        access_token: { type: "string", description: "Access token (for github chain)" },
      },
      required: ["agent_id", "chain"],
    },
  },
  {
    name: "trust_challenge",
    description: "Get a verification challenge for a specific chain. The challenge must be signed and submitted via trust_verify within 1 hour.",
    inputSchema: {
      type: "object" as const,
      properties: {
        agent_id: { type: "string", description: "Your agent UUID" },
        chain: {
          type: "string",
          description: "Verification chain",
          enum: ["lightning", "ethereum", "solana", "nostr", "domain", "twitter", "ens", "endpoint", "github"],
        },
      },
      required: ["agent_id", "chain"],
    },
  },
  {
    name: "trust_search",
    description: "Search agents by name, capability, minimum score, or verification status.",
    inputSchema: {
      type: "object" as const,
      properties: {
        q: { type: "string", description: "Search query (name or keyword)" },
        min_score: { type: "number", description: "Minimum trust score (0-100)" },
        has_lightning: { type: "boolean", description: "Only agents with Lightning" },
        verified: { type: "boolean", description: "Only verified agents" },
        capability: { type: "string", description: "Filter by capability" },
        limit: { type: "number", description: "Max results (default 20)" },
      },
    },
  },
  {
    name: "trust_evidence",
    description: "Submit self-reported evidence to improve trust score. Types: stripe_payment, paypal_payment, bank_transfer, crypto_payment, escrow_completed, service_delivered. Unverified evidence is weighted at 50%.",
    inputSchema: {
      type: "object" as const,
      properties: {
        agent_id: { type: "string", description: "Your agent UUID" },
        type: {
          type: "string",
          description: "Evidence type",
          enum: ["stripe_payment", "paypal_payment", "bank_transfer", "crypto_payment", "escrow_completed", "service_delivered"],
        },
        data: {
          type: "object",
          description: "Evidence data (amount, counterparty, description, etc.)",
        },
        proof_url: { type: "string", description: "URL to proof (optional)" },
      },
      required: ["agent_id", "type", "data"],
    },
  },
];

// ─── Tool Handlers ───────────────────────────────────────────────────────────

const server = new Server(
  { name: "trust-mcp", version: "2.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  try {
    switch (name) {
      case "trust_lookup": {
        // Try direct lookup by UUID first
        const res = await safeFetch(`${REGISTRY_URL}/v1/trust/${args.agent_id}`);
        if (res.ok) {
          const result = await res.json();
          const score = result.trust_score?.total || 0;
          const tier = getTier(score);
          const verifiedChains = result.evidence_summary?.verification_methods?.join(", ") || "none";
          return ok(`${tier.badge} **Agent ${result.subject_id}**\n\nTrust Score: ${score}/100 (${tier.label})\nRisk: ${result.risk_level || "unknown"}\n${result.safe_to_transact ? "✅ Safe to transact" : score >= 40 ? "⚠️ Moderate trust - verify details" : "🚨 Low trust - proceed with caution"}\nVerified on: ${verifiedChains}\n\nDetails: ${REGISTRY_URL}/registry/agent/${result.subject_id}`);
        }

        // Fallback: search by name in agent list
        const searchRes = await safeFetch(`${REGISTRY_URL}/registry/agents`);
        if (searchRes.ok) {
          const data = await searchRes.json();
          const agent = data.agents?.find((a: any) =>
            a.name?.toLowerCase() === (args.agent_id as string).toLowerCase() || a.id === args.agent_id
          );
          if (agent) {
            // Re-fetch full trust score by resolved UUID
            const scoreRes = await safeFetch(`${REGISTRY_URL}/v1/trust/${agent.id}`);
            if (scoreRes.ok) {
              const result = await scoreRes.json();
              const score = result.trust_score?.total || 0;
              const tier = getTier(score);
              const verifiedChains = result.evidence_summary?.verification_methods?.join(", ") || "none";
              return ok(`${tier.badge} **${agent.name}**\n\nTrust Score: ${score}/100 (${tier.label})\nRisk: ${result.risk_level || "unknown"}\n${result.safe_to_transact ? "✅ Safe to transact" : "⚠️ Verify details"}\nVerified on: ${verifiedChains}\n\nDetails: ${REGISTRY_URL}/registry/agent/${agent.id}`);
            }
          }
        }
        return ok(`⚠️ Agent "${args.agent_id}" not found. UNVERIFIED. Ask them to register at ${REGISTRY_URL}`);
      }

      case "trust_register": {
        const res = await postJson("/register", {
          name: args.name,
          contact: args.contact,
          description: args.description,
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          return fail(`❌ Registration failed: ${body.error || res.status}`);
        }
        const result = await res.json();
        return ok(`✅ Registered!\n\nAgent ID: ${result.agent_id}\nScore: ${result.trust_score || 5}/100\nBadge: ${result.badge || "⚪"}\n\nNext steps:\n${result.next_steps?.map((s: any) => `- ${s.action} (${s.points})`).join("\n") || "- Verify identity chains to increase score"}`);
      }

      case "trust_review": {
        const res = await postJson("/registry/review", {
          agent_id: args.agent_id,
          rating: args.rating,
          comment: args.comment,
          reviewer_pubkey: args.reviewer_pubkey,
          proof_of_payment: args.proof_of_payment,
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          return fail(`❌ Review failed: ${body.error || res.status}`);
        }
        const result = await res.json();
        return ok(result.success
          ? `✅ Review submitted${args.proof_of_payment ? " (VERIFIED)" : ""}!`
          : `❌ ${result.error}`);
      }

      case "trust_list": {
        const page = (args.page as number) || 1;
        const limit = (args.limit as number) || 20;
        const res = await safeFetch(`${REGISTRY_URL}/registry/agents?page=${page}&limit=${limit}`);
        const data = await res.json();
        const agents = data.agents || [];
        const list = agents.map((a: any) => {
          const tier = getTier(a.trust_score || 0);
          return `${tier.badge} ${a.name} (${a.trust_score || 0}/100)`;
        }).join("\n");
        const pagination = data.total_pages > 1 ? `\nPage ${data.page}/${data.total_pages} (${data.total} total)` : "";
        return ok(`**Registered Agents (${agents.length})**\n\n${list || "No agents yet."}${pagination}`);
      }

      case "trust_challenge": {
        const res = await safeFetch(
          `${REGISTRY_URL}/registry/challenge/${args.agent_id}/${args.chain}`
        );
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          return fail(`❌ Challenge failed: ${body.error || res.status}`);
        }
        const result = await res.json();
        return ok(`🔐 Verification Challenge\n\nChain: ${result.chain}\nChallenge: \`${result.challenge}\`\nExpires: ${result.expires_in_seconds}s\n\n${result.instructions}\n\nSign this challenge and submit via trust_verify.`);
      }

      case "trust_verify": {
        const chain = args.chain as string;
        const body: Record<string, any> = { agent_id: args.agent_id };

        // Map chain-specific params
        switch (chain) {
          case "lightning":
            body.signature = args.signature;
            body.pubkey = args.pubkey;
            break;
          case "ethereum":
            body.signature = args.signature;
            body.address = args.address;
            break;
          case "solana":
            body.signature = args.signature;
            body.address = args.address;
            break;
          case "nostr":
            if (args.event_id) body.event_id = args.event_id;
            break;
          case "domain":
            body.domain = args.domain;
            break;
          case "twitter":
            body.handle = args.handle;
            break;
          case "ens":
            body.ens_name = args.ens_name;
            break;
          case "endpoint":
            body.endpoint_url = args.endpoint_url;
            break;
          case "github":
            if (args.code) body.code = args.code;
            if (args.access_token) body.access_token = args.access_token;
            break;
        }

        const res = await postJson(`/registry/verify/${chain}`, body);
        const result = await res.json();

        if (result.success) {
          return ok(`✅ ${result.message}\n\n${result.verified ? "Identity verified!" : "Verification pending."}`);
        }

        // GitHub OAuth redirect case
        if (result.action === "redirect") {
          return ok(`🔗 GitHub OAuth Required\n\nRedirect to: ${result.url}\n\n${result.message}`);
        }

        return fail(`❌ Verification failed: ${result.error || result.message || "Unknown error"}`);
      }

      case "trust_search": {
        const params = new URLSearchParams();
        if (args.q) params.set("q", args.q as string);
        if (args.min_score !== undefined) params.set("min_score", String(args.min_score));
        if (args.has_lightning !== undefined) params.set("has_lightning", String(args.has_lightning));
        if (args.verified !== undefined) params.set("verified", String(args.verified));
        if (args.capability) params.set("capability", args.capability as string);
        if (args.limit) params.set("limit", String(args.limit));
        const qs = params.toString();

        const res = await safeFetch(`${REGISTRY_URL}/registry/search${qs ? `?${qs}` : ""}`);
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          return fail(`❌ Search failed: ${body.error || res.status}`);
        }
        const data = await res.json();
        const agents = data.agents || data.results || [];
        if (agents.length === 0) {
          return ok("No agents found matching your criteria.");
        }
        const list = agents.map((a: any) => {
          const tier = getTier(a.trust_score || 0);
          return `${tier.badge} **${a.name}** (${a.trust_score || 0}/100) — ${a.description || "No description"}`;
        }).join("\n");
        return ok(`**Search Results (${agents.length})**\n\n${list}`);
      }

      case "trust_evidence": {
        const res = await postJson("/registry/evidence/submit", {
          agent_id: args.agent_id,
          type: args.type,
          data: args.data || {},
          proof_url: args.proof_url,
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          return fail(`❌ Evidence submission failed: ${body.error || res.status}`);
        }
        const result = await res.json();
        return ok(`📋 Evidence submitted\n\nType: ${result.type}\nVerified: ${result.verified ? "Yes" : "No (weighted at 50%)"}\n\n${result.message}`);
      }

      default:
        return fail(`Unknown tool: ${name}`);
    }
  } catch (err) {
    return fail(`❌ ${errorText(err)}`);
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Trust MCP Server v2.0.0 running on stdio");
}

main().catch(console.error);
