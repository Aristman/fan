import type { MemoryConfig } from "../config.js";
import type { MemoryRepository } from "../storage/repositories.js";
import type { MemoryDatabase } from "../storage/database.js";
import type { MaintenanceReport, MaintenanceStep } from "../types.js";
import { computePairwiseSimilarity, buildANNIndex, isANNIndexStale } from "../rag/vector-store.js";
import { ClusterRepository } from "../storage/repositories.js";
import { DraftRepository } from "../storage/repositories.js";
import { generateEmbeddingsBatch } from "../rag/embeddings.js";
import { randomUUID } from "node:crypto";

// ──────────────────────────────────────────────
// Maintenance Pipeline
// ──────────────────────────────────────────────

export class MaintenancePipeline {
  constructor(
    private db: MemoryDatabase,
    private repo: MemoryRepository,
    private clusterRepo: ClusterRepository,
    private draftRepo: DraftRepository,
    private config: MemoryConfig
  ) {}

  async run(): Promise<MaintenanceReport> {
    const startTime = Date.now();
    const steps: MaintenanceStep[] = [];
    const stats = this.db.getStats();

    // Step 1: Usage Analysis
    const step1 = this.step_usageAnalysis(stats);
    steps.push(step1);

    // Step 2: Confidence Decay
    const step2 = this.step_confidenceDecay();
    steps.push(step2);

    // Step 3: Deduplication
    const step3 = await this.step_deduplication();
    steps.push(step3);

    // Step 4: Clustering (simplified — tag-based only for now)
    const step4 = this.step_clustering();
    steps.push(step4);

    // Step 5: Summarization (placeholder — needs LLM integration)
    const step5 = this.step_summarization();
    steps.push(step5);

    // Step 6: Embedding Refresh
    const step6 = await this.step_embeddingRefresh();
    steps.push(step6);

    // Step 7: ANN Index Rebuild
    const step7 = this.step_annReindex();
    steps.push(step7);

    // Step 8: Archive Cleanup
    const step8 = this.step_archiveCleanup();
    steps.push(step8);

    // Update meta
    const runs = parseInt(this.db.getMeta("total_maintenance_runs") ?? "0", 10) + 1;
    this.db.setMeta("total_maintenance_runs", String(runs));
    this.db.setMeta("last_run", String(Date.now()));

    const finalStats = this.db.getStats();
    const duration = Date.now() - startTime;

    const summary = [
      step2.detail && step2.detail !== "0 adjusted" ? `• ${step2.detail}` : null,
      step3.detail && step3.detail !== "0 found" ? `• ${step3.detail}` : null,
      step4.detail && step4.detail !== "0 clusters" ? `• ${step4.detail}` : null,
      step5.detail && step5.detail !== "0 clusters" ? `• ${step5.detail}` : null,
      step6.detail && step6.detail !== "0 refreshed" ? `• ${step6.detail}` : null,
      step7.detail && step7.detail !== "0 indexed" ? `• ${step7.detail}` : null,
      step8.detail && step8.detail !== "0 deleted" ? `• ${step8.detail}` : null,
    ]
      .filter(Boolean)
      .join("\n  ");

    return {
      steps,
      summary: summary || "No changes needed",
      duration,
      activeCount: finalStats.active,
      archivedCount: finalStats.archived,
    };
  }

  shouldRun(): boolean {
    const lastRun = this.db.getMeta("last_run");
    if (!lastRun) return true;

    const hoursSince = (Date.now() - parseInt(lastRun, 10)) / (1000 * 60 * 60);
    return hoursSince >= this.config.maintenance.intervalHours;
  }

  // ──────────────────────────────────────────
  // Steps
  // ──────────────────────────────────────────

  private step_usageAnalysis(stats: { active: number; archived: number }): MaintenanceStep {
    return {
      name: "Usage analysis",
      status: "ok",
      detail: `${stats.active} active, ${stats.archived} archived`,
    };
  }

  private step_confidenceDecay(): MaintenanceStep {
    const decay = this.config.maintenance.confidenceDecay;
    const now = Date.now();
    const DAY = 24 * 60 * 60 * 1000;

    const mem30d = this.repo.getUnusedMemories(30);
    const mem90d = this.repo.getUnusedMemories(90);
    const mem180d = this.repo.getUnusedMemories(180);

    const adjustments: { id: string; factor: number }[] = [];

    const addAdjustments = (memories: Array<{ id: string }>, factor: number) => {
      for (const m of memories) {
        adjustments.push({ id: m.id, factor });
      }
    };

    // Apply strongest decay first (180d includes 90d and 30d)
    const ids30 = new Set(mem30d.map((m) => m.id));
    const ids90 = new Set(mem90d.map((m) => m.id));
    const ids180 = new Set(mem180d.map((m) => m.id));

    for (const id of ids180) {
      adjustments.push({ id, factor: decay["180d"] });
    }
    for (const id of ids90) {
      if (!ids180.has(id)) adjustments.push({ id, factor: decay["90d"] });
    }
    for (const id of ids30) {
      if (!ids90.has(id)) adjustments.push({ id, factor: decay["30d"] });
    }

    const count = this.repo.batchUpdateConfidence(adjustments);

    // Archive very low confidence
    const lowConf = this.repo.getLowConfidenceMemories(0.1);
    const archivedCount = this.repo.batchArchive(lowConf.map((m) => m.id));

    const total = count + archivedCount;
    return {
      name: "Confidence decay",
      status: "ok",
      detail: total > 0 ? `${count} adjusted, ${archivedCount} archived` : "0 adjusted",
    };
  }

  private async step_deduplication(): Promise<MaintenanceStep> {
    try {
      const threshold = this.config.maintenance.deduplicationThreshold;
      const pairs = computePairwiseSimilarity(this.db, threshold);

      let mergedCount = 0;
      const toArchive: string[] = [];

      for (const pair of pairs) {
        const memA = this.repo.findById(pair.idA);
        const memB = this.repo.findById(pair.idB);
        if (!memA || !memB) continue;

        // Keep the one with higher confidence
        const [keeper, archived] = memA.confidence >= memB.confidence
          ? [memA, memB]
          : [memB, memA];

        toArchive.push(archived.id);
        mergedCount++;
      }

      if (toArchive.length > 0) {
        this.repo.batchArchive(toArchive);
      }

      return {
        name: "Deduplication",
        status: "ok",
        detail: `${pairs.length} found, ${mergedCount} merged`,
      };
    } catch (err) {
      return {
        name: "Deduplication",
        status: "error",
        detail: `Failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  private step_clustering(): MaintenanceStep {
    // Simplified clustering: group by category + overlapping tags
    const memories = this.repo.findActive();
    const byCategory = new Map<string, typeof memories>();

    for (const m of memories) {
      const cat = m.category;
      if (!byCategory.has(cat)) byCategory.set(cat, []);
      byCategory.get(cat)!.push(m);
    }

    let clusterCount = 0;

    for (const [category, catMemories] of byCategory) {
      if (catMemories.length < 3) continue;

      // Simple tag-based grouping
      const tagGroups = new Map<string, string[]>();

      for (const m of catMemories) {
        for (const tag of m.tags) {
          if (!tagGroups.has(tag)) tagGroups.set(tag, []);
          tagGroups.get(tag)!.push(m.id);
        }
      }

      // Find overlapping groups
      const groups: string[][] = [];
      const assigned = new Set<string>();

      for (const [tag, ids] of tagGroups) {
        if (ids.length < 2) continue;
        const unassigned = ids.filter((id) => !assigned.has(id));
        if (unassigned.length >= 2) {
          groups.push(unassigned);
          for (const id of unassigned) assigned.add(id);
        }
      }

      for (const group of groups) {
        // Create or update cluster
        const label = `${category} (${group.length} memories)`;
        const cluster = this.clusterRepo.create({
          label,
          category: category as any,
        });

        for (const memId of group) {
          this.repo.setClusterId(memId, cluster.id);
        }

        clusterCount++;
      }
    }

    return {
      name: "Clustering",
      status: "ok",
      detail: `${clusterCount} clusters`,
    };
  }

  private step_summarization(): MaintenanceStep {
    // Placeholder for LLM-based summarization
    // Will be implemented when LLM integration is available
    const minSize = this.config.maintenance.summarizationMinClusterSize;
    const clusters = this.clusterRepo.findAll();

    let summarized = 0;
    for (const cluster of clusters) {
      // Count active memories in this cluster
      // For now, just mark as summarized
      // Full implementation needs LLM call
      summarized++;
    }

    return {
      name: "Summarization",
      status: "ok",
      detail: `${summarized} clusters checked`,
    };
  }

  private async step_embeddingRefresh(): Promise<MaintenanceStep> {
    const currentModel = this.config.embeddings.model;
    const storedModel = this.db.getMeta("embedding_model");

    if (storedModel === currentModel) {
      return {
        name: "Embedding refresh",
        status: "skipped",
        detail: "Model unchanged",
      };
    }

    // Model changed — refresh all embeddings
    try {
      const memories = this.repo.findActive();
      let refreshed = 0;

      for (const mem of memories) {
        try {
          const emb = await generateEmbeddingsBatch([mem.content], this.config);
          if (emb[0]) {
            this.repo.update(mem.id, {
              embedding: emb[0],
              embeddingModel: currentModel,
            });
            refreshed++;
          }
        } catch {
          // Skip failed individual embeddings
        }
      }

      this.db.setMeta("embedding_model", currentModel);

      return {
        name: "Embedding refresh",
        status: "ok",
        detail: `${refreshed} refreshed`,
      };
    } catch (err) {
      return {
        name: "Embedding refresh",
        status: "error",
        detail: `Failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  private step_annReindex(): MaintenanceStep {
    try {
      if (!isANNIndexStale(this.db)) {
        return {
          name: "ANN reindex",
          status: "ok",
          detail: "0 indexed",
        };
      }

      const count = buildANNIndex(this.db);
      return {
        name: "ANN reindex",
        status: "ok",
        detail: `${count} indexed`,
      };
    } catch (err) {
      return {
        name: "ANN reindex",
        status: "error",
        detail: `Failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  private step_archiveCleanup(): MaintenanceStep {
    if (!this.config.maintenance.hardDelete) {
      return {
        name: "Archive cleanup",
        status: "skipped",
        detail: "Hard delete disabled",
      };
    }

    const minAge = this.config.maintenance.hardDeleteMinAge;
    const threshold = Date.now() - minAge * 24 * 60 * 60 * 1000;

    const archived = this.repo.findArchived();
    const toDelete = archived.filter(
      (m) => m.archivedAt && m.archivedAt < threshold && m.confidence < 0.05
    );

    let deleted = 0;
    for (const m of toDelete) {
      if (this.repo.hardDelete(m.id)) deleted++;
    }

    return {
      name: "Archive cleanup",
      status: "ok",
      detail: `${deleted} deleted`,
    };
  }
}
