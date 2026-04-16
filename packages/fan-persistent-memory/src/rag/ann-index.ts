// ──────────────────────────────────────────────
// HNSW (Hierarchical Navigable Small World)
// In-memory ANN index for fast vector search
// ──────────────────────────────────────────────
// Pure TypeScript, zero dependencies.
// Adapted from the original HNSW paper by Malkov & Yashunin.
//
// For our use case (memory extension, ~100-2000 vectors,
// 384 dimensions), a simplified implementation is sufficient.
//
// Performance expectations:
//   - 100 vectors:  ~0.1ms (vs brute-force 0.05ms)
//   - 1000 vectors: ~1ms   (vs brute-force 5-10ms)
//   - 5000 vectors: ~3ms   (vs brute-force 50ms+)
// ──────────────────────────────────────────────

// ──────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────

export interface HNSWNode {
  id: string;
  vector: Float32Array;
  level: number;
  neighbors: Map<number, string[]>;  // level → [neighborIds]
}

export interface SearchResult {
  id: string;
  score: number;
}

export interface HNSWConfig {
  /** Max number of connections per node per layer (default: 16) */
  M: number;
  /** Max number of connections per node at layer 0 (default: 32) */
  M0: number;
  /** Size of dynamic candidate list (default: 150) */
  efConstruction: number;
  /** Size of dynamic candidate list at search time (default: 50) */
  efSearch: number;
  /** Probability of level increase (default: 1/ln(M)) */
  mL: number;
  /** Distance metric (default: "cosine") */
  metric: "cosine" | "euclidean";
}

const DEFAULT_CONFIG: HNSWConfig = {
  M: 16,
  M0: 32,
  efConstruction: 150,
  efSearch: 50,
  mL: 1 / Math.LN2,
  metric: "cosine",
};

// ──────────────────────────────────────────────
// Distance functions
// ──────────────────────────────────────────────

function cosineDistance(a: Float32Array, b: Float32Array): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 1 : 1 - dot / denom;  // cosine distance: 0 = identical, 2 = opposite
}

function euclideanDistance(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i]! - b[i]!;
    sum += d * d;
  }
  return Math.sqrt(sum);
}

// ──────────────────────────────────────────────
// Min-heap for candidate selection
// ──────────────────────────────────────────────

interface Candidate {
  id: string;
  dist: number;
}

class MinHeap {
  private heap: Candidate[] = [];

  get size(): number { return this.heap.length; }

  push(c: Candidate): void {
    this.heap.push(c);
    this._bubbleUp(this.heap.length - 1);
  }

  pop(): Candidate | undefined {
    if (this.heap.length === 0) return undefined;
    const top = this.heap[0]!;
    const last = this.heap.pop()!;
    if (this.heap.length > 0) {
      this.heap[0] = last;
      this._sinkDown(0);
    }
    return top;
  }

  peek(): Candidate | undefined {
    return this.heap[0];
  }

  values(): Candidate[] {
    return [...this.heap].sort((a, b) => a.dist - b.dist);
  }

  private _bubbleUp(i: number): void {
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.heap[parent]!.dist > this.heap[i]!.dist) {
        [this.heap[parent], this.heap[i]] = [this.heap[i]!, this.heap[parent]!];
        i = parent;
      } else break;
    }
  }

  private _sinkDown(i: number): void {
    const n = this.heap.length;
    while (true) {
      let smallest = i;
      const left = 2 * i + 1;
      const right = 2 * i + 2;
      if (left < n && this.heap[left]!.dist < this.heap[smallest]!.dist) smallest = left;
      if (right < n && this.heap[right]!.dist < this.heap[smallest]!.dist) smallest = right;
      if (smallest !== i) {
        [this.heap[smallest], this.heap[i]] = [this.heap[i]!, this.heap[smallest]!];
        i = smallest;
      } else break;
    }
  }
}

// ──────────────────────────────────────────────
// HNSW Index
// ──────────────────────────────────────────────

export class HNSWIndex {
  private nodes: Map<string, HNSWNode> = new Map();
  private entryPoint: string | null = null;
  private maxLevel: number = -1;
  private config: HNSWConfig;
  private distance: (a: Float32Array, b: Float32Array) => number;
  private dimension: number = 0;

  // Stats
  private _size = 0;

  constructor(config?: Partial<HNSWConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.distance = this.config.metric === "cosine" ? cosineDistance : euclideanDistance;
  }

  // ──────────────────────────────────────────
  // Core operations
  // ──────────────────────────────────────────

  get size(): number { return this._size; }
  get isEmpty(): boolean { return this._size === 0; }

  /**
   * Add a vector to the index.
   */
  add(id: string, vector: Float32Array): void {
    if (this.dimension === 0) {
      this.dimension = vector.length;
    }

    const level = this._randomLevel();
    const node: HNSWNode = {
      id,
      vector,
      level,
      neighbors: new Map(),
    };

    // Initialize neighbor lists for all levels
    for (let l = 0; l <= level; l++) {
      node.neighbors.set(l, []);
    }

    if (this.entryPoint === null) {
      // First node
      this.entryPoint = id;
      this.maxLevel = level;
      this.nodes.set(id, node);
      this._size++;
      return;
    }

    const ep = this.entryPoint!;
    const epNode = this.nodes.get(ep)!;

    // Find entry point at each level (top-down greedy search)
    let curr = ep;
    for (let l = this.maxLevel; l > level; l--) {
      const changed = this._greedyClosest(vector, curr, l);
      if (changed) curr = changed;
    }

    // Insert at each level from level down to 0
    for (let l = Math.min(level, this.maxLevel); l >= 0; l--) {
      const candidates = this._searchLayer(vector, curr, this.config.efConstruction, l);
      const Mmax = l === 0 ? this.config.M0 : this.config.M;

      // Select M nearest neighbors
      const neighbors = this._selectNeighbors(candidates, this.config.M);

      // Add bidirectional connections
      for (const neighbor of neighbors) {
        this._connect(node, neighbor, l, Mmax);
      }

      // Set curr to closest found at this level
      if (candidates.length > 0) {
        curr = candidates[0]!.id;
      }
    }

    // Update entry point if new node has higher level
    if (level > this.maxLevel) {
      this.entryPoint = id;
      this.maxLevel = level;
    }

    this.nodes.set(id, node);
    this._size++;
  }

  /**
   * Search for k nearest neighbors.
   * Returns results sorted by distance (ascending = best first).
   */
  search(query: Float32Array, k: number, ef?: number): SearchResult[] {
    if (this.entryPoint === null || this._size === 0) return [];

    const searchEf = ef ?? this.config.efSearch;

    // Start from entry point, greedy descent to level 1
    let curr = this.entryPoint!;
    for (let l = this.maxLevel; l > 0; l--) {
      const changed = this._greedyClosest(query, curr, l);
      if (changed) curr = changed;
    }

    // Search at level 0
    const candidates = this._searchLayer(query, curr, Math.max(searchEf, k), 0);

    // Return top k
    return candidates.slice(0, k).map((c) => ({
      id: c.id,
      score: this.config.metric === "cosine" ? 1 - c.dist : 1 / (1 + c.dist),
    }));
  }

  /**
   * Remove a vector from the index.
   * Note: HNSW deletion is complex; we do a simple removal + neighbor cleanup.
   */
  remove(id: string): boolean {
    const node = this.nodes.get(id);
    if (!node) return false;

    // Remove from all neighbors' lists
    for (let l = 0; l <= node.level; l++) {
      const neighbors = node.neighbors.get(l) ?? [];
      for (const nId of neighbors) {
        const nNode = this.nodes.get(nId);
        if (nNode) {
          const nNeighbors = nNode.neighbors.get(l) ?? [];
          const idx = nNeighbors.indexOf(id);
          if (idx !== -1) nNeighbors.splice(idx, 1);
        }
      }
    }

    // If entry point, find a replacement
    if (this.entryPoint === id) {
      this.entryPoint = null;
      for (const [nid, nnode] of this.nodes) {
        if (nid !== id) {
          this.entryPoint = nid;
          break;
        }
      }
      this.maxLevel = this.entryPoint ? (this.nodes.get(this.entryPoint)?.level ?? -1) : -1;
    }

    this.nodes.delete(id);
    this._size--;
    return true;
  }

  /**
   * Update a vector (remove + add).
   */
  update(id: string, vector: Float32Array): void {
    this.remove(id);
    this.add(id, vector);
  }

  /**
   * Check if a vector exists in the index.
   */
  has(id: string): boolean {
    return this.nodes.has(id);
  }

  /**
   * Get all IDs in the index.
   */
  getIds(): string[] {
    return [...this.nodes.keys()];
  }

  /**
   * Clear the entire index.
   */
  clear(): void {
    this.nodes.clear();
    this.entryPoint = null;
    this.maxLevel = -1;
    this._size = 0;
    this.dimension = 0;
  }

  // ──────────────────────────────────────────
  // Bulk operations
  // ──────────────────────────────────────────

  /**
   * Build index from a map of id → vector.
   */
  buildFromVectors(vectors: Map<string, Float32Array>): void {
    this.clear();
    for (const [id, vector] of vectors) {
      this.add(id, vector);
    }
  }

  /**
   * Serialize index to a JSON-compatible structure.
   * Note: this can be large for many vectors.
   */
  serialize(): {
    nodes: Array<{ id: string; vector: number[]; level: number; neighbors: Record<number, string[]> }>;
    entryPoint: string | null;
    maxLevel: number;
    dimension: number;
    config: HNSWConfig;
  } {
    const serNodes: Array<{ id: string; vector: number[]; level: number; neighbors: Record<number, string[]> }> = [];
    for (const [, node] of this.nodes) {
      const neighborsObj: Record<number, string[]> = {};
      for (const [l, ids] of node.neighbors) {
        neighborsObj[l] = ids;
      }
      serNodes.push({
        id: node.id,
        vector: Array.from(node.vector),
        level: node.level,
        neighbors: neighborsObj,
      });
    }
    return {
      nodes: serNodes,
      entryPoint: this.entryPoint,
      maxLevel: this.maxLevel,
      dimension: this.dimension,
      config: this.config,
    };
  }

  // ──────────────────────────────────────────
  // Internal: layer search
  // ──────────────────────────────────────────

  private _searchLayer(
    query: Float32Array,
    entryId: string,
    ef: number,
    level: number
  ): Candidate[] {
    const visited = new Set<string>([entryId]);
    const entryNode = this.nodes.get(entryId)!;
    const entryDist = this.distance(query, entryNode.vector);

    const candidates = new MinHeap();
    const results = new MinHeap();

    candidates.push({ id: entryId, dist: entryDist });
    results.push({ id: entryId, dist: entryDist });

    while (candidates.size > 0) {
      const c = candidates.pop()!;
      const f = results.peek()!;

      // Stop if closest candidate is farther than farthest result
      if (c.dist > f.dist) break;

      const cNode = this.nodes.get(c.id)!;
      const neighbors = cNode.neighbors.get(level) ?? [];

      for (const nId of neighbors) {
        if (visited.has(nId)) continue;
        visited.add(nId);

        const nNode = this.nodes.get(nId);
        if (!nNode) continue;

        const nDist = this.distance(query, nNode.vector);
        const fResult = results.peek()!;

        if (nDist < fResult.dist || results.size < ef) {
          candidates.push({ id: nId, dist: nDist });
          results.push({ id: nId, dist: nDist });
          if (results.size > ef) {
            results.pop();
          }
        }
      }
    }

    return results.values();
  }

  // ──────────────────────────────────────────
  // Internal: greedy closest at level
  // ──────────────────────────────────────────

  private _greedyClosest(query: Float32Array, entryId: string, level: number): string | null {
    let curr = entryId;
    let currDist = this.distance(query, this.nodes.get(curr)!.vector);
    let changed = false;

    const maxIterations = 200;
    let iterations = 0;

    while (iterations++ < maxIterations) {
      const node = this.nodes.get(curr)!;
      const neighbors = node.neighbors.get(level) ?? [];
      let bestNeighbor = false;

      for (const nId of neighbors) {
        const nNode = this.nodes.get(nId);
        if (!nNode) continue;

        const nDist = this.distance(query, nNode.vector);
        if (nDist < currDist) {
          curr = nId;
          currDist = nDist;
          bestNeighbor = true;
        }
      }

      if (!bestNeighbor) break;
    }

    return changed ? curr : null;
  }

  // ──────────────────────────────────────────
  // Internal: neighbor selection
  // ──────────────────────────────────────────

  private _selectNeighbors(candidates: Candidate[], M: number): Candidate[] {
    // Simple selection: just take M nearest
    // A more sophisticated approach would use heuristic selection
    return candidates.slice(0, M);
  }

  // ──────────────────────────────────────────
  // Internal: connect two nodes
  // ──────────────────────────────────────────

  private _connect(nodeA: HNSWNode, candidate: Candidate, level: number, Mmax: number): void {
    const neighborId = candidate.id;
    const neighborNode = this.nodes.get(neighborId);
    if (!neighborNode || neighborNode.level < level) return;

    // A → neighbor
    const aNeighbors = nodeA.neighbors.get(level) ?? [];
    if (!aNeighbors.includes(neighborId)) {
      aNeighbors.push(neighborId);
      // Shrink if over capacity
      if (aNeighbors.length > Mmax) {
        const vectors = aNeighbors.map((nId) => {
          const n = this.nodes.get(nId);
          return n ? { id: nId, dist: this.distance(nodeA.vector, n.vector) } : null;
        }).filter((x): x is Candidate => x !== null);
        vectors.sort((a, b) => a.dist - b.dist);
        const kept = vectors.slice(0, Mmax).map((v) => v.id);
        nodeA.neighbors.set(level, kept);
      } else {
        nodeA.neighbors.set(level, aNeighbors);
      }
    }

    // neighbor → A (if neighbor's level supports it)
    if (neighborNode.level >= level) {
      const bNeighbors = neighborNode.neighbors.get(level) ?? [];
      if (!bNeighbors.includes(nodeA.id)) {
        bNeighbors.push(nodeA.id);
        if (bNeighbors.length > Mmax) {
          const vectors = bNeighbors.map((nId) => {
            const n = this.nodes.get(nId);
            return n ? { id: nId, dist: this.distance(neighborNode.vector, n.vector) } : null;
          }).filter((x): x is Candidate => x !== null);
          vectors.sort((a, b) => a.dist - b.dist);
          const kept = vectors.slice(0, Mmax).map((v) => v.id);
          neighborNode.neighbors.set(level, kept);
        } else {
          neighborNode.neighbors.set(level, bNeighbors);
        }
      }
    }
  }

  // ──────────────────────────────────────────
  // Internal: random level
  // ──────────────────────────────────────────

  private _randomLevel(): number {
    const r = Math.random();
    let level = 0;
    while (r < Math.exp(-level / this.config.mL) && level < 16) {
      level++;
    }
    return level;
  }
}
