import type { SearchParams, SearchResult, TlsConfig } from "../types.js";
import type { ReaderParams, ReaderResult } from "../types.js";

export interface SearchProvider {
  readonly id: string;
  readonly name: string;
  readonly requiresConfig: boolean;
  probe(signal?: AbortSignal): Promise<boolean>;
  search(params: SearchParams, signal?: AbortSignal): Promise<SearchResult>;
  /** Set TLS config for outbound connections */
  setTlsConfig?(config: TlsConfig): void;
}

export interface ReaderProvider {
  readonly id: string;
  readonly name: string;
  read(params: ReaderParams, html: string, signal?: AbortSignal): Promise<ReaderResult>;
}
