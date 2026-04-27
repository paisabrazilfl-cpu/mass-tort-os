import { db, securityAlertsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "./logger";

// @anthropic-ai/sdk is heavy (~346 KB + iconv-lite transitive ~530 KB).
// Loaded on demand inside getAnthropicClient() so booting the API server
// (which has security-route handlers wired in but rarely calls them) doesn't
// pay the cost. Externalized in build.mjs.
type AnthropicCtor = typeof import("@anthropic-ai/sdk").default;
let anthropicClient: InstanceType<AnthropicCtor> | undefined;
async function getAnthropicClient(): Promise<InstanceType<AnthropicCtor>> {
  if (!anthropicClient) {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    anthropicClient = new Anthropic({
      apiKey: process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY,
      baseURL: process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL,
    });
  }
  return anthropicClient;
}

interface ThreatAnalysis {
  threat_level: "critical" | "high" | "medium" | "low" | "false_positive";
  attack_type: string;
  summary: string;
  recommended_action: string;
  indicators: string[];
  is_automated: boolean;
}

export async function analyzeThreats(alerts: { id: number; type: string; severity: string; source_ip: string | null; details: string; payload_sample: string | null; request_path: string | null; request_method: string | null; user_agent: string | null }[]): Promise<ThreatAnalysis> {
  if (alerts.length === 0) {
    return {
      threat_level: "low",
      attack_type: "none",
      summary: "No alerts to analyze",
      recommended_action: "No action required",
      indicators: [],
      is_automated: false,
    };
  }

  const prompt = `You are a cybersecurity threat analyst for a legal CRM system that handles ePHI (electronic Protected Health Information) and sensitive legal data. Analyze the following security alerts and provide a structured threat assessment.

SECURITY ALERTS:
${alerts.map((a, i) => `
Alert #${i + 1}:
- Type: ${a.type}
- Severity: ${a.severity}
- Source IP: ${a.source_ip || "unknown"}
- Path: ${a.request_method || "?"} ${a.request_path || "?"}
- User Agent: ${a.user_agent || "unknown"}
- Details: ${a.details}
- Payload Sample: ${a.payload_sample || "none"}
`).join("\n")}

Respond in JSON format only:
{
  "threat_level": "critical|high|medium|low|false_positive",
  "attack_type": "brief classification (e.g. 'Automated SQL injection probe', 'Manual reconnaissance')",
  "summary": "2-3 sentence analysis of the attack pattern",
  "recommended_action": "specific defensive action to take",
  "indicators": ["list", "of", "IOCs or patterns"],
  "is_automated": true/false
}`;

  try {
    const anthropic = await getAnthropicClient();
    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 1024,
      messages: [{ role: "user", content: prompt }],
    });

    const text = response.content[0].type === "text" ? response.content[0].text : "";
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error("No JSON found in AI response");
    }

    const analysis: ThreatAnalysis = JSON.parse(jsonMatch[0]);

    for (const alert of alerts) {
      await db
        .update(securityAlertsTable)
        .set({
          ai_analysis: JSON.stringify(analysis),
          status: analysis.threat_level === "false_positive" ? "dismissed" : "analyzed",
        })
        .where(eq(securityAlertsTable.id, alert.id));
    }

    logger.info(
      { alertCount: alerts.length, threatLevel: analysis.threat_level, attackType: analysis.attack_type },
      "AI threat analysis complete"
    );

    return analysis;
  } catch (err) {
    logger.error({ err }, "AI threat analysis failed");
    return {
      threat_level: "medium",
      attack_type: "analysis_failed",
      summary: "AI analysis was unable to process these alerts. Manual review recommended.",
      recommended_action: "Review alerts manually in the security dashboard",
      indicators: [],
      is_automated: false,
    };
  }
}
