import type { ExtensionAPI } from "@itone/fan-coding-agent";
import { MemoryDatabase } from "./storage/database.js";
import { MemoryRepository, DraftRepository, ClusterRepository } from "./storage/repositories.js";
import { Retriever } from "./rag/retriever.js";
import { registerMemoryTools } from "./tools/memory-tools.js";
import { registerMemoryCommand } from "./commands/memory.js";
import { AutoExtractor } from "./intelligence/auto-extract.js";
import { MaintenancePipeline } from "./maintenance/pipeline.js";
import { loadConfig, getGlobalDbPath, getProjectDbPath } from "./config.js";
import { checkOllamaHealth, initEmbeddingRouter, isVectorAvailable, generateEmbedding } from "./rag/embeddings.js";
import { migrateEmbeddings, needsMigration } from "./rag/migration.js";
import { buildANNIndex, isANNIndexStale } from "./rag/vector-store.js";

// ──────────────────────────────────────────────
// Persistent Memory Extension
// ──────────────────────────────────────────────

function isTrivialPrompt(prompt: string): boolean {
  const trimmed = prompt.trim();
  if (trimmed.length < 15) return true;
  if (/^\/[\w]+$/.test(trimmed)) return true;
  if (/^(да|нет|спасибо|ок|yes|no|thanks|ok)\b/i.test(trimmed)) return true;
  return false;
}

export default function (pi: ExtensionAPI) {
  // Load config
  const config = loadConfig();

  // Initialize embedding router (must happen after config, before any embedding use)
  initEmbeddingRouter(config);

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

  function init() {
    // Global DB (always available)
    globalDb = new MemoryDatabase(getGlobalDbPath());
    globalRepo = new MemoryRepository(globalDb);
    draftRepo = new DraftRepository(globalDb);
    clusterRepo = new ClusterRepository(globalDb);

    // Project DB (if we're in a project directory)
    // We'll initialize this lazily since we need ctx.cwd
  }

  function initProjectDb(cwd: string) {
    try {
      const projectDbPath = getProjectDbPath(cwd);
      projectDb = new MemoryDatabase(projectDbPath);
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

  init();

  // ─── Check Ollama health ──────────────────

  let ollamaAvailable: boolean | undefined;

  // Start health check immediately
  checkOllamaHealth(config.embeddings.ollamaBaseUrl).then((available) => {
    ollamaAvailable = available;
  });

  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.setStatus("1-memory", "🧠 Memory: checking...");

    // Wait for Ollama health check to complete (resets Ollama provider's failed state if up)
    if (ollamaAvailable === undefined) {
      try {
        ollamaAvailable = await checkOllamaHealth(config.embeddings.ollamaBaseUrl);
      } catch {
        ollamaAvailable = false;
      }
    }

    // Try a quick test embedding to verify vector availability
    try {
      await generateEmbedding("health check", config);
    } catch {
      // Test failure is OK — status will show FTS-only
    }

    // Update status based on vector availability
    if (isVectorAvailable()) {
      ctx.ui.setStatus("1-memory", "🧠 Memory: active (Ollama)");
    } else {
      ctx.ui.setStatus("1-memory", "🧠 Memory: FTS-only");
    }
  });

  // ─── Session lifecycle ────────────────────

  pi.on("session_start", async (event, ctx) => {
    initProjectDb(ctx.cwd);

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

    // Start background embedding migration if needed (non-blocking)
    if (needsMigration(globalRepo, config)) {
      migrateEmbeddings(globalRepo, config, (current, total) => {
        if (current === 1) {
          ctx.ui.notify(`🧠 Memory: migrating ${total} embeddings to new model...`, "info");
        }
      }).then((result) => {
        if (result.migrated > 0) {
          ctx.ui.notify(
            `🧠 Memory: migrated ${result.migrated}/${result.total} embeddings (${result.errors} errors)`,
            result.errors > 0 ? "warn" : "info"
          );
        }
      }).catch(err => {
        console.error("[persistent-memory] Embedding migration failed:", err);
      });
    }

    // Build ANN index after migration (or if no migration needed)
    try {
      const count = buildANNIndex(globalDb);
      console.log(`[persistent-memory] ANN index built: ${count} vectors`);
    } catch (err) {
      console.error("[persistent-memory] ANN index build failed:", err);
    }
  });

  // ─── Context injection (RAG) ─────────────

  // Incremental RAG state
  let lastPromptEmbedding: Float32Array | null = null;
  let lastRagResults: string | null = null;
  let promptsSinceRag = 0;

  pi.on("before_agent_start", async (event, ctx) => {
    if (!retriever) return;
    if (isTrivialPrompt(event.prompt)) return undefined;

    try {
      const incrementalEnabled = config.retrieval.incrementalRag;
      const topicThreshold = config.retrieval.topicShiftThreshold;
      const maxWithoutRag = config.retrieval.maxPromptsWithoutRag;

      // Compute current prompt embedding for topic detection
      const currentEmbedding = await generateEmbedding(event.prompt, config);
      let topicShifted = true;

      if (incrementalEnabled && lastPromptEmbedding && currentEmbedding) {
        // Cosine similarity between current and last prompt
        let dot = 0, nA = 0, nB = 0;
        for (let i = 0; i < currentEmbedding.length; i++) {
          dot += currentEmbedding[i]! * lastPromptEmbedding[i]!;
          nA += currentEmbedding[i]! * currentEmbedding[i]!;
          nB += lastPromptEmbedding[i]! * lastPromptEmbedding[i]!;
        }
        const similarity = dot / (Math.sqrt(nA) * Math.sqrt(nB));
        const distance = 1 - similarity;

        topicShifted = distance >= topicThreshold || promptsSinceRag >= maxWithoutRag;
      }

      // Update state
      if (currentEmbedding) lastPromptEmbedding = currentEmbedding;
      promptsSinceRag++;

      // Reuse cached results if topic hasn't shifted
      if (incrementalEnabled && !topicShifted && lastRagResults) {
        return {
          systemPrompt: event.systemPrompt + lastRagResults,
        };
      }

      // Full RAG run
      const results = await retriever.retrieve(event.prompt, {
        limit: config.retrieval.maxMemoriesPerQuery,
        scope: "both",
        minScore: config.retrieval.minRetrievalScore,
      });

      if (results.length === 0) {
        lastRagResults = null;
        return undefined;
      }

      promptsSinceRag = 0; // reset counter on actual RAG run

      const memoryBlock = results
        .map(
          (r) =>
            `[${r.memory.category.toUpperCase()}] [${r.memory.scope}] ${r.memory.summary || r.memory.content}`
        )
        .join("\n");

      const injection = `\n\n## Relevant Operator Memory\n${memoryBlock}\n\nUse the above context when relevant. Use memory_search tool for deeper memory lookup.`;

      lastRagResults = injection;

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
}
