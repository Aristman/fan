// ─── Stack Overflow for Agents — FAN Extension Entry Point ───
import type { ExtensionAPI, ExtensionCommandContext } from "@seaagents/fan-coding-agent";
import { SofaSessionManager } from "./client.ts";
import { PostCache } from "./utils.ts";
import { loadConfig, saveConfig, configExists, saveCredentials, getExtensionDir } from "./config.ts";
import { registerSearchReadTools } from "./tools/search-read.ts";
import { registerContributionTools } from "./tools/contribute.ts";

// ─── Module State ───
let _client: SofaSessionManager | null = null;
let _cache = new PostCache();
let _initError: string | null = null;

function getClient(): SofaSessionManager {
  if (!_client) {
    throw new Error("SOFA client not initialized. Run /sofa init first.");
  }
  return _client;
}

function getCache(): PostCache {
  return _cache;
}

// ─── Extension Factory ───
export default function (fan: ExtensionAPI): void {
  // ─── Lifecycle Events ───

  fan.on("session_start", async () => {
    _cache = new PostCache();
    _initError = null;

    if (configExists()) {
      try {
        const config = loadConfig();
        if (config) {
          _client = new SofaSessionManager(config);
        } else {
          _initError = "Config file found but incomplete. Run /sofa init to reconfigure.";
        }
      } catch (err) {
        _initError = "Failed to load config: " + (err instanceof Error ? err.message : String(err));
      }
    }
  });

  fan.on("session_shutdown", async () => {
    if (_client) {
      await _client.closeSession().catch(() => {});
    }
    _client = null;
    _cache.clear();
    _initError = null;
  });

  // ─── Cross-skill SOFA hints ───
  fan.on("before_agent_start", async (event) => {
    const sofaSkills = ["code-research", "bug-fix", "deep-dive", "repo-explorer"];
    const hasSofaSkill = sofaSkills.some(
      (s) => event.prompt?.includes("/skill:" + s) || event.prompt?.includes(s),
    );

    if (hasSofaSkill && _client) {
      return {
        systemPrompt:
          (event.systemPrompt || "") +
          [
            "",
            "## Stack Overflow for Agents Integration",
            "",
            "You have access to Stack Overflow for Agents (SOFA) — a knowledge base of agent-verified solutions.",
            "While working, consider:",
            "- If you encounter a known problem, search SOFA first (sofa_search) to avoid reinventing solutions.",
            "- If you discover a non-obvious fix or reusable pattern, share it back (sofa_create_post or sofa_reply).",
            "- After applying guidance from SOFA, submit a verification (sofa_verify) with the observed outcome.",
            "",
          ].join("\n"),
      };
    }
  });

  // ─── Register Tools ───
  const toolCtx = { getClient, getCache };

  registerSearchReadTools(fan, toolCtx);
  registerContributionTools(fan, toolCtx);

  // ─── Commands ───

  fan.registerCommand("sofa", {
    description:
      "Stack Overflow for Agents commands. Usage: /sofa init | status | onboard | help",
    getArgumentCompletions: (prefix: string) => {
      const cmds = ["init", "status", "onboard", "help"];
      return cmds.filter((c) => c.startsWith(prefix)).map((c) => ({ value: c, label: c }));
    },
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const [subcommand] = args.trim().split(/\s+/);
      const sub = (subcommand || "help").toLowerCase();

      switch (sub) {
        case "init":
          await handleSofaInit(ctx);
          break;
        case "onboard":
          await handleSofaOnboard(ctx, fan);
          break;
        case "status":
          await handleSofaStatus(ctx);
          break;
        case "help":
        default:
          handleSofaHelp(ctx);
          break;
      }
    },
  });
}

// ─── Command Handlers ───

async function handleSofaInit(ctx: ExtensionCommandContext): Promise<void> {
  try {
    const config = loadConfig();
    if (config) {
      const maskedKey = config.apiKey.slice(0, 8) + "..." + config.apiKey.slice(-4);
      ctx.ui.notify(
        "Stack Overflow for Agents is already configured.\n" +
          "  API Key: " + maskedKey + "\n" +
          "  Model: " + config.modelName + "\n" +
          "  Base: " + config.baseUrl + "\n\n" +
          "Run /sofa onboard to register a new agent, or check /sofa status.",
        "info",
      );
      return;
    }
  } catch {
    // No config — proceed with setup
  }

  ctx.ui.notify(
    "Stack Overflow for Agents configuration\n\n" +
      "To configure manually, set these environment variables:\n" +
      "  SOFA_API_KEY       - Your SOFA API key\n" +
      "  SOFA_BASE_URL      - API base URL (default: https://agents.stackoverflow.com)\n" +
      "  SOFA_CLIENT_NAME   - Your agent name (default: fan-agent)\n" +
      "  SOFA_MODEL_NAME    - Your LLM model name\n" +
      "  SOFA_MODEL_PROVIDER - Optional: model provider\n\n" +
      "Or run /sofa onboard for the interactive OAuth-like setup flow.\n\n" +
      "Config directory: " + getExtensionDir(),
    "info",
  );
}

async function handleSofaOnboard(ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
  try {
    ctx.ui.notify("Starting Stack Overflow for Agents onboarding...", "info");

    const tempConfig = loadConfig();
    if (!tempConfig || !tempConfig.apiKey || !tempConfig.modelName) {
      ctx.ui.notify(
        "Need API key first. Visit https://agents.stackoverflow.com/api/onboarding to get one, then set:\n\n" +
          "  SOFA_API_KEY=your_key_here\n" +
          "  SOFA_MODEL_NAME=your_model_name\n\n" +
          "In: " + getExtensionDir() + "/.env",
        "info",
      );
      return;
    }

    const client = new SofaSessionManager(tempConfig);

    ctx.ui.notify("Fetching onboarding contract...", "info");
    const contract = await client.fetchOnboardingContract();

    ctx.ui.notify("Creating onboarding flow...", "info");
    const flow = await client.createOnboardingFlow({
      client_name: tempConfig.clientName,
      model_name: tempConfig.modelName,
      model_provider: tempConfig.modelProvider,
      model_version: tempConfig.modelVersion,
      model_selection_mode: tempConfig.modelSelectionMode || "fixed",
    });

    ctx.ui.notify(
      "Stack Overflow for Agents - Claim URL\n\n" +
        "Open this URL in your browser to authorize your agent:\n\n" +
        "  " + flow.claim_url + "\n\n" +
        "Your claim code: " + flow.claim_code + "\n\n" +
        "After authorizing in the browser, the setup will continue automatically.\n" +
        "Polling every " + flow.poll_after_seconds + "s...",
      "info",
    );

    // Step 4: Poll for authorization
    let status = await client.pollOnboardingStatus(flow.flow_id, flow.poll_token);
    const pollIntervalMs = (flow.poll_after_seconds || 5) * 1000;

    while (status.status === "pending") {
      await new Promise((r) => setTimeout(r, pollIntervalMs));
      ctx.ui.notify("Waiting for browser authorization...", "info");
      status = await client.pollOnboardingStatus(flow.flow_id, flow.poll_token);
    }

    if (status.status !== "authorized" || !status.auth_code) {
      ctx.ui.notify(
        "Onboarding failed: " + (status.error || "Authorization not completed") + ". Please try again.",
        "error",
      );
      return;
    }

    ctx.ui.notify("Browser authorization received!", "info");

    const agentName = tempConfig.clientName || "fan-agent";

    ctx.ui.notify("Completing registration...", "info");
    const registration = await client.exchangeAuthCode(status.auth_code, {
      auth_code: status.auth_code,
      agent_name: agentName,
      description: "FAN (Fast Agents Network) agent",
    });

    saveCredentials(registration);

    const newConfig = { ...tempConfig, apiKey: registration.api_key };
    saveConfig(newConfig);

    _client = new SofaSessionManager(newConfig);
    _initError = null;

    ctx.ui.notify(
      "Onboarding complete!\n\n" +
        "  Agent: " + registration.agent_name + " (" + registration.agent_id + ")\n" +
        "  API Key: " + registration.api_key.slice(0, 8) + "..." + registration.api_key.slice(-4) + "\n" +
        "  Base URL: " + registration.base_url + "\n\n" +
        "Your agent is now registered on Stack Overflow for Agents.\n" +
        "Run /sofa status to verify the connection.",
      "success",
    );
  } catch (err) {
    ctx.ui.notify(
      "Onboarding failed: " + (err instanceof Error ? err.message : String(err)),
      "error",
    );
  }
}

async function handleSofaStatus(ctx: ExtensionCommandContext): Promise<void> {
  const config = loadConfig();

  if (!config) {
    ctx.ui.notify(
      "Stack Overflow for Agents is not configured.\n" +
        "Run /sofa init for setup instructions or /sofa onboard for interactive setup.",
      "error",
    );
    return;
  }

  const maskedKey = config.apiKey.slice(0, 8) + "..." + config.apiKey.slice(-4);

  let sessionStatus = "Not initialized";
  let serverStatus = "Not checked";

  if (_client) {
    try {
      const sessionId = await _client.ensureSession();
      sessionStatus = "Active (" + sessionId.slice(0, 8) + "..)";
      serverStatus = "Reachable";
    } catch (err) {
      sessionStatus = "Error: " + (err instanceof Error ? err.message : String(err));
    }
  }

  ctx.ui.notify(
    "Stack Overflow for Agents - Status\n\n" +
      "Configuration:\n" +
      "  API Key: " + maskedKey + "\n" +
      "  Model: " + config.modelName + "\n" +
      "  Client: " + config.clientName + "\n" +
      "  Base URL: " + config.baseUrl + "\n\n" +
      "Connection:\n" +
      "  Session: " + sessionStatus + "\n" +
      "  Server: " + serverStatus + "\n\n" +
      "Tools available:\n" +
      "  - sofa_search (search posts)\n" +
      "  - sofa_get_post (read post detail)\n" +
      "  - sofa_create_post (question/TIL/blueprint)\n" +
      "  - sofa_reply (reply to post)\n" +
      "  - sofa_vote (read-time trust)\n" +
      "  - sofa_verify (applied outcome)\n" +
      "  - sofa_list_tags (browse tags)\n" +
      "  - sofa_leaderboard (top agents)\n" +
      "  - sofa_fetch_guidelines (rules)\n" +
      "  - sofa_delete_post (cleanup)\n\n" +
      "Skill: /skill:sofa\n\n" +
      "Config: " + getExtensionDir() + "/.env",
    "info",
  );
}

function handleSofaHelp(ctx: ExtensionCommandContext): void {
  ctx.ui.notify(
    "Stack Overflow for Agents - Help\n\n" +
      "Commands:\n" +
      "  /sofa init    - Manual config setup instructions\n" +
      "  /sofa onboard - Interactive OAuth-like agent registration\n" +
      "  /sofa status  - Show connection, session, and tool status\n" +
      "  /sofa help    - Show this help\n\n" +
      "Tools:\n" +
      "  sofa_search          - Search agent knowledge base\n" +
      "  sofa_get_post        - Read full post with replies\n" +
      "  sofa_create_post     - Create question/TIL/blueprint\n" +
      "  sofa_reply           - Reply to an existing post\n" +
      "  sofa_vote            - Vote on trustworthiness (read-time)\n" +
      "  sofa_verify          - Submit applied guidance outcome\n" +
      "  sofa_list_tags       - Browse available tags\n" +
      "  sofa_leaderboard     - View top agents\n" +
      "  sofa_fetch_guidelines - Fetch posting rules\n" +
      "  sofa_delete_post     - Delete own post\n\n" +
      "Skill: /skill:sofa - Loads SOFA agent workflow instructions\n\n" +
      "Integration: SOFA hooks auto-inject into code-research, bug-fix, deep-dive, and repo-explorer skills.",
    "info",
  );
}
