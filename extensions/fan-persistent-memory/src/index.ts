import type { ExtensionAPI } from "@seaagents/fan-coding-agent";
import { MemoryDatabase } from "./storage/database.js";
import { MemoryRepository, DraftRepository, ClusterRepository } from "./storage/repositories.js";
import { Retriever } from "./rag/retriever.js";
import { registerMemoryTools } from "./tools/memory-tools.js";
import { registerMemoryCommand } from "./commands/memory.js";
import { AutoExtractor } from "./intelligence/auto-extract.js";
import { MaintenancePipeline } from "./maintenance/pipeline.js";
import { loadConfig, getGlobalDbPath, getProjectDbPath } from "./config.js";
import { checkOllamaHealth } from "./rag/embeddings.js";

// ──────────────────────────────────────────────
// Persistent Memory Extension
// ──────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // Load config
  const config = loadConfig();

  // Databases
  let globalDb: MemoryDatabase;
  let projectDb: MemoryDatabase | null = null;
  let globalRepo: MemoryRepository;
  let projectRepo: MemoryRepository | null = null;
  let draftRepo: DraftRepository;
  let clusterRepo: ClusterRepository;
  let retriever: Retriever | null = null;
  let autoExtractor: AutoExtractor | null = null;

  // ─── Initialize ───────────────────────────

  async function init() {
    // Global DB (always available)
    globalDb = new MemoryDatabase(getGlobalDbPath());
    await globalDb.init();
    globalRepo = new MemoryRepository(globalDb);
    draftRepo = new DraftRepository(globalDb);
    clusterRepo = new ClusterRepository(globalDb);

    // Project DB (if we're in a project directory)
    // We'll initialize this lazily since we need ctx.cwd
  }

  async function initProjectDb(cwd: string) {
    try {
      const projectDbPath = getProjectDbPath(cwd);
      projectDb = new MemoryDatabase(projectDbPath);
      await projectDb.init();
      projectRepo = new MemoryRepository(projectDb);
    } catch (err) {
      console.error("[persistent-memory] Failed to init project DB:", err);
      projectDb = null;
      projectRepo = null;
    }

    // (Re-)create retriever with both DBs
    retriever = new Retriever(globalDb, projectDb, config);

    // (Re-)create auto-extractor
    autoExtractor = new AutoExtractor(draftRepo, config);
  }

  init().catch((err) => console.error("[persistent-memory] Failed to init global DB:", err));

  // ─── Check Ollama health ──────────────────

  let ollamaAvailable: boolean | undefined;

  // Start health check immediately
  checkOllamaHealth(config.embeddings.ollamaBaseUrl).then((available) => {
    ollamaAvailable = available;
  });

  pi.on("session_start", async (event, ctx) => {
    // Check Ollama health
    ctx.ui.setStatus("memory", "🧠 Memory: checking...");
    if (ollamaAvailable === undefined) {
      try {
        ollamaAvailable = await checkOllamaHealth(config.embeddings.ollamaBaseUrl);
      } catch {
        ollamaAvailable = false;
      }
    }
    ctx.ui.setStatus(
      "memory",
      ollamaAvailable ? "🧠 Memory: active" : "🧠 Memory: FTS-only (Ollama down)"
    );

    // Initialize project DB and run maintenance
    await initProjectDb(ctx.cwd);

    // Expire old drafts
    draftRepo.expireOld();

    // Check if maintenance is needed
    try {
      const pipeline = new MaintenancePipeline(globalDb, globalRepo, clusterRepo, draftRepo, config);
      if (pipeline.shouldRun()) {
        const report = await pipeline.run();
        if (report.steps.some((s) => s.status === "ok" && s.detail !== "0 adjusted")) {
          const summary = report.steps
            .filter((s) => s.status === "ok")
            .map((s) => `${s.name}: ${s.detail}`)
            .join("; ");
          ctx.ui.notify(`🧠 Memory maintenance: ${summary}`, "info");
        }
      }
    } catch (err) {
      console.error("[persistent-memory] Maintenance failed:", err);
    }
  });

  // ─── Context injection (RAG) ─────────────

  pi.on("before_agent_start", async (event, ctx) => {
    if (!retriever) return;

    try {
      const results = await retriever.retrieve(event.prompt, {
        limit: config.retrieval.maxMemoriesPerQuery,
        scope: "both",
        minScore: config.retrieval.minRetrievalScore,
      });

      if (results.length === 0) return undefined;

      const memoryBlock = results
        .map(
          (r) =>
            `[${r.memory.category.toUpperCase()}] [${r.memory.scope}] ${r.memory.summary || r.memory.content}`
        )
        .join("\n");

      const injection = `\n\n## Relevant Operator Memory\n${memoryBlock}\n\nUse the above context when relevant. Use memory_search tool for deeper memory lookup.`;

      return {
        systemPrompt: event.systemPrompt + injection,
      };
    } catch (err) {
      console.error("[persistent-memory] RAG retrieval failed:", err);
      return undefined;
    }
  });

  // ─── Auto-extract on turn end ─────────────

  pi.on("turn_end", async (_event, ctx) => {
    if (!autoExtractor || !ctx.sessionManager) return;

    try {
      const entries = ctx.sessionManager.getEntries();
      const recentMessages = entries
        .filter((e) => e.type === "message")
        .map((e) => e.message)
        .filter((m) => m && (m.role === "user" || m.role === "assistant"))
        .slice(-6)
        .map((m) => ({
          role: m.role,
          content: m.content
            ?.filter((c) => c.type === "text")
            .map((c) => c.text)
            .join("\n"),
        }));

      if (recentMessages.length >= 2) {
        await autoExtractor.extract(ctx, recentMessages);
      }
    } catch {
      // Silent fail
    }
  });

  // ─── Register tools ──────────────────────

  registerMemoryTools(
    pi,
    () => ({ global: globalRepo, project: projectRepo }),
    () => config,
    () => retriever
  );

  // ─── Register commands ───────────────────

  registerMemoryCommand(
    pi,
    () => ({ global: globalDb, project: projectDb }),
    () => config
  );

  // ─── Cleanup on session shutdown ──────────

  pi.on("session_shutdown", async () => {
    try { projectDb?.close(); } catch {}
    try { globalDb?.close(); } catch {}
    projectDb = null;
    projectRepo = null;
    retriever = null;
    autoExtractor = null;
  });
}
