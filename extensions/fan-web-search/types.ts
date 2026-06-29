export interface TlsConfig {
  /** Reject unauthorized TLS certificates. Default: false */
  rejectUnauthorized: boolean;
  /** Path to custom CA certificate bundle (.pem/.crt). Optional. */
  caPath?: string;
}

export const RECENCY_FILTERS = ["noLimit", "oneDay", "oneWeek", "oneMonth", "oneYear"] as const;
export type RecencyFilter = (typeof RECENCY_FILTERS)[number];

export interface SearchParams {
  query: string;
  count: number;
  recencyFilter?: RecencyFilter;
  domainFilter?: string;
}

export interface SearchItem {
  title: string;
  url: string;
  snippet: string;
  source?: string;
  date?: string;
}

export interface SearchResult {
  items: SearchItem[];
  provider: string;
  query: string;
}

export interface ReaderParams {
  url: string;
  returnFormat: "markdown" | "text";
  withLinksSummary: boolean;
  withImagesSummary: boolean;
}

export interface ReaderResult {
  title: string;
  url: string;
  description: string;
  content: string;
  links?: Array<{ title: string; url: string }>;
  images?: Array<{ alt: string; url: string }>;
  provider: string;
}

export interface ProviderError {
  provider: string;
  error: string;
}

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
  isError?: boolean;
}

export interface MetaSearchProviderConfig {
  enabled: boolean;
  priority: number;
  userAgent: string;
  probeTimeoutMs: number;
  engines: {
    mojeek: { enabled: boolean; url: string };
  };
}

export interface SearXNGProviderConfig {
  enabled: boolean;
  url: string;
  priority: number;
}

export interface BraveProviderConfig {
  enabled: boolean;
  url: string;
  priority: number;
}

export interface YandexProviderConfig {
  enabled: boolean;
  url: string;
  priority: number;
  maxPassages: number;
  groupsOnPage: number;
}

export interface ZaiProviderConfig {
  enabled: boolean;
  url: string;
  priority: number;
  mcpTool: string;
  mcpProtocol: string;
  location: string;
  contentSize: string;
  clientName: string;
  clientVersion: string;
}

export interface SearchConfig {
  defaultCount: number;
  timeout: number;
  probeTimeout: number;
  providers: {
    "meta-search": MetaSearchProviderConfig;
    searxng: SearXNGProviderConfig;
    brave: BraveProviderConfig;
    yandex: YandexProviderConfig;
    zai: ZaiProviderConfig;
  };
}

export interface ReaderConfig {
  defaultFormat: string;
  timeout: number;
  minContentLength: number;
  maxLinks: number;
  maxImages: number;
  maxConsecutiveNewlines: number;
  userAgent: string;
}

export interface FormatConfig {
  maxLinks: number;
  maxImages: number;
}

export interface ApiKeysConfig {
  braveApiKey: string;
  zaiApiKey: string;
  yandexApiKey: string;
  yandexFolderId: string;
}

export interface WebSearchConfig {
  search: SearchConfig;
  reader: ReaderConfig;
  format: FormatConfig;
  tls: TlsConfig;
  apiKeys: ApiKeysConfig;
  healthCacheTtlMs: number;
}
