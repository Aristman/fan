import type { ExtensionAPI, ExtensionContext } from "@seaagents/fan-coding-agent";
import type { MemoryConfig } from "../config.js";
import type { MemoryDatabase } from "../storage/database.js";
import {
  MemoryRepository,
  DraftRepository,
  ClusterRepository,
} from "../storage/repositories.js";
import type { Memory, MemoryScope, MemoryCategory } from "../types.js";
import { getGlobalDbPath, getProjectDbPath } from "../config.js";

// ──────────────────────────────────────────────
// /memory command
// ──────────────────────────────────────────────

export function registerMemoryCommand(
  fan: ExtensionAPI,
  getDatabases: () => { global: MemoryDatabase; project: MemoryDatabase | null },
  getConfig: () => MemoryConfig
) {
  fan.registerCommand("memory", {
    description: "Manage persistent memory (stats, list, search, show, archive, review, maintain)",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/);
      const subcommand = parts[0] || "help";
      const subArgs = parts.slice(1);

      const { global, project } = getDatabases();
      const globalRepo = new MemoryRepository(global);
      const projectRepo = project ? new MemoryRepository(project) : null;
      const draftRepo = new DraftRepository(global);
      const config = getConfig();

      switch (subcommand) {
        case "help":
        case "":
          return showHelp(ctx);
        case "stats":
          return showStats(ctx, global, project, config);
        case "list":
          return showList(ctx, globalRepo, projectRepo, subArgs);
        case "search":
          return showSearch(ctx, globalRepo, projectRepo, subArgs.join(" "));
        case "show":
          return showMemory(ctx, globalRepo, projectRepo, subArgs[0]);
        case "archive":
          return archiveMemory(ctx, globalRepo, projectRepo, subArgs[0]);
        case "restore":
          return restoreMemory(ctx, globalRepo, projectRepo, subArgs[0]);
        case "review":
          return reviewDrafts(ctx, draftRepo, globalRepo, config);
        case "maintain":
          ctx.ui.notify("Run maintenance via /memory-maintain", "info");
          return;
        case "categories":
          return showCategories(ctx, global, project);
        default:
          ctx.ui.notify(`Unknown subcommand: ${subcommand}. Type /memory for help.`, "error");
      }
    },
  });

  // Dedicated maintain command
  fan.registerCommand("memory-maintain", {
    description: "Run memory maintenance pipeline (dedup, clustering, archiving)",
    handler: async (_args, ctx) => {
      const { global, project } = getDatabases();
      const config = getConfig();

      ctx.ui.notify("🔧 Starting memory maintenance...", "info");

      try {
        // Dynamic import to avoid circular deps
        const { MaintenancePipeline } = await import("../maintenance/pipeline.js");
        const repo = new MemoryRepository(global);
        const clusterRepo = new ClusterRepository(global);
        const draftRepo = new DraftRepository(global);

        const pipeline = new MaintenancePipeline(global, repo, clusterRepo, draftRepo, config);
        const report = await pipeline.run();

        const stepSummary = report.steps
          .map((s) => `  ${s.status === "ok" ? "✓" : s.status === "skipped" ? "○" : "✗"} ${s.name}: ${s.detail}`)
          .join("\n");

        ctx.ui.notify(
          `🔧 Memory Maintenance complete (${(report.duration / 1000).toFixed(1)}s)\n\n${stepSummary}\n\nActive: ${report.activeCount} | Archived: ${report.archivedCount}`,
          "info"
        );
      } catch (err) {
        ctx.ui.notify(`Maintenance failed: ${err instanceof Error ? err.message : String(err)}`, "error");
      }
    },
  });
}

// ──────────────────────────────────────────────
// Subcommand implementations
// ──────────────────────────────────────────────

function showHelp(ctx: ExtensionContext): void {
  ctx.ui.notify(
    `🧠 Persistent Memory

Commands:
  stats          Show memory statistics
  list [opts]    List active memories
  search <query> Search memories
  show <id>      Show memory details
  archive <id>   Archive a memory
  restore <id>   Restore from archive
  review         Review auto-extracted drafts
  maintain       Run maintenance pipeline
  categories     Show category breakdown

Options for list:
  --scope g|p    Filter by scope
  --archived     Include archived
  --cat <name>   Filter by category`,
    "info"
  );
}

function showStats(
  ctx: ExtensionContext,
  global: MemoryDatabase,
  project: MemoryDatabase | null,
  config: MemoryConfig
): void {
  const gStats = global.getStats();
  const pStats = project ? project.getStats() : { active: 0, archived: 0, byCategory: {} as Record<string, number> };

  const lastRun = global.getMeta("last_run");
  const lastRunStr = lastRun
    ? `${Math.round((Date.now() - parseInt(lastRun, 10)) / (1000 * 60 * 60))}h ago`
    : "never";

  const catLines = Object.entries({ ...gStats.byCategory, ...pStats.byCategory })
    .map(([k, v]) => `  ${k.padEnd(15)} ${v}`)
    .join("\n");

  ctx.ui.notify(
    `🧠 Memory Statistics

                    Active    Archived    Total
Global               ${String(gStats.active).padStart(4)}        ${String(gStats.archived).padStart(4)}       ${gStats.active + gStats.archived}
Project              ${String(pStats.active).padStart(4)}        ${String(pStats.archived).padStart(4)}       ${pStats.active + pStats.archived}
────────────────────────────────────────────────
Total                ${String(gStats.active + pStats.active).padStart(4)}        ${String(gStats.archived + pStats.archived).padStart(4)}       ${gStats.active + pStats.active + gStats.archived + pStats.archived}

By Category:
${catLines}

Embeddings: ${config.embeddings.model} (${config.embeddings.dimension}d)
Last maintenance: ${lastRunStr}`,
    "info"
  );
}

function showList(
  ctx: ExtensionContext,
  globalRepo: MemoryRepository,
  projectRepo: MemoryRepository | null,
  args: string[]
): void {
  const scope = args.includes("--scope") ? (args[args.indexOf("--scope") + 1] as MemoryScope | "g" | "p") : undefined;
  const showArchived = args.includes("--archived");

  const effectiveScope = scope === "g" ? "global" : scope === "p" ? "project" : scope;

  const memories = [
    ...globalRepo.findActive(effectiveScope ? { scope: effectiveScope as MemoryScope } : {}),
    ...(projectRepo?.findActive(effectiveScope ? { scope: effectiveScope as MemoryScope } : {}) ?? []),
  ];

  if (showArchived) {
    memories.push(...globalRepo.findArchived());
    memories.push(...(projectRepo?.findArchived() ?? []));
  }

  // Deduplicate
  const seen = new Set<string>();
  const unique = memories.filter((m) => {
    if (seen.has(m.id)) return false;
    seen.add(m.id);
    return true;
  });

  if (unique.length === 0) {
    ctx.ui.notify("No memories found.", "info");
    return;
  }

  const lines = unique.slice(0, 20).map((m, i) => {
    const catAbbr = m.category.slice(0, 4).toUpperCase();
    const content = (m.summary ?? m.content).slice(0, 60);
    const tags = m.tags.slice(0, 3).join(", ");
    return `${i + 1}. [${catAbbr}] "${content}"\n   Tags: [${tags}] | Confidence: ${m.confidence.toFixed(1)} | ${m.scope} | Accessed: ${m.accessCount}x`;
  });

  ctx.ui.notify(`Memories (${unique.length} total):\n\n${lines.join("\n\n")}`, "info");
}

async function showSearch(
  ctx: ExtensionContext,
  globalRepo: MemoryRepository,
  projectRepo: MemoryRepository | null,
  query: string
): Promise<void> {
  if (!query) {
    ctx.ui.notify("Usage: /memory search <query>", "info");
    return;
  }

  const all = [
    ...globalRepo.findActive(),
    ...(projectRepo?.findActive() ?? []),
  ];

  const queryLower = query.toLowerCase();
  const keywords = queryLower.split(/\s+/).filter((w) => w.length > 2);

  const results = all.filter(
    (m) =>
      m.content.toLowerCase().includes(queryLower) ||
      m.summary?.toLowerCase().includes(queryLower) ||
      m.tags.some((t) => keywords.some((k) => t.toLowerCase().includes(k)))
  );

  if (results.length === 0) {
    ctx.ui.notify(`No results for "${query}"`, "info");
    return;
  }

  const lines = results.slice(0, 10).map((m, i) => {
    const catAbbr = m.category.slice(0, 4).toUpperCase();
    return `${i + 1}. [${catAbbr}] [${m.scope}] ${(m.summary ?? m.content).slice(0, 80)}`;
  });

  ctx.ui.notify(`Found ${results.length} results for "${query}":\n\n${lines.join("\n")}`, "info");
}

function showMemory(
  ctx: ExtensionContext,
  globalRepo: MemoryRepository,
  projectRepo: MemoryRepository | null,
  id: string | undefined
): void {
  if (!id) {
    ctx.ui.notify("Usage: /memory show <id>", "info");
    return;
  }

  const mem = globalRepo.findById(id) ?? projectRepo?.findById(id);
  if (!mem) {
    ctx.ui.notify(`Memory not found: ${id}`, "error");
    return;
  }

  const created = new Date(mem.createdAt).toLocaleString();
  const updated = new Date(mem.updatedAt).toLocaleString();
  const lastAccess = mem.lastAccessedAt ? new Date(mem.lastAccessedAt).toLocaleString() : "never";

  ctx.ui.notify(
    `📋 Memory Detail

ID:          ${mem.id}
Content:     ${mem.content}
Summary:     ${mem.summary ?? "(none)"}
Category:    ${mem.category}
Tags:        [${mem.tags.join(", ")}]
Scope:       ${mem.scope}
Confidence:  ${mem.confidence.toFixed(2)}
Created:     ${created}
Updated:     ${updated}
Last access: ${lastAccess}
Access count: ${mem.accessCount}
Cluster:     ${mem.clusterId ?? "(none)"}
Embedding:   ${mem.embeddingModel ?? "(none)"}`,
    "info"
  );
}

function archiveMemory(
  ctx: ExtensionContext,
  globalRepo: MemoryRepository,
  projectRepo: MemoryRepository | null,
  id: string | undefined
): void {
  if (!id) {
    ctx.ui.notify("Usage: /memory archive <id>", "info");
    return;
  }

  const ok = globalRepo.archive(id) || (projectRepo?.archive(id) ?? false);
  if (ok) {
    ctx.ui.notify(`Archived: ${id}`, "info");
  } else {
    ctx.ui.notify(`Memory not found or already archived: ${id}`, "error");
  }
}

function restoreMemory(
  ctx: ExtensionContext,
  globalRepo: MemoryRepository,
  projectRepo: MemoryRepository | null,
  id: string | undefined
): void {
  if (!id) {
    ctx.ui.notify("Usage: /memory restore <id>", "info");
    return;
  }

  const ok = globalRepo.restore(id) || (projectRepo?.restore(id) ?? false);
  if (ok) {
    ctx.ui.notify(`Restored: ${id}`, "info");
  } else {
    ctx.ui.notify(`Memory not found or not archived: ${id}`, "error");
  }
}

function reviewDrafts(
  ctx: ExtensionContext,
  draftRepo: DraftRepository,
  memRepo: MemoryRepository,
  config: MemoryConfig
): void {
  // Expire old drafts first
  draftRepo.expireOld();

  const pending = draftRepo.findPending();
  if (pending.length === 0) {
    ctx.ui.notify("No pending drafts to review.", "info");
    return;
  }

  const lines = pending.slice(0, 10).map((d, i) => {
    const cat = d.category ?? "?";
    const tags = d.tags.join(", ");
    return `${i + 1}. "${d.content.slice(0, 80)}"\n   Category: ${cat} | Tags: [${tags}]`;
  });

  ctx.ui.notify(
    `📝 Draft Review (${pending.length} pending)\n\n${lines.join("\n\n")}\n\nUse memory_remember tool to save approved drafts, or /memory to manage.`,
    "info"
  );
}

function showCategories(
  ctx: ExtensionContext,
  global: MemoryDatabase,
  project: MemoryDatabase | null
): void {
  const gStats = global.getStats();
  const pStats = project?.getStats() ?? { byCategory: {} as Record<string, number> };

  const combined: Record<string, number> = {};
  for (const [k, v] of Object.entries(gStats.byCategory)) combined[k] = (combined[k] ?? 0) + v;
  for (const [k, v] of Object.entries(pStats.byCategory)) combined[k] = (combined[k] ?? 0) + v;

  const lines = Object.entries(combined)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `  ${k.padEnd(15)} ${v}`);

  ctx.ui.notify(`Memory by Category:\n${lines.join("\n")}`, "info");
}
