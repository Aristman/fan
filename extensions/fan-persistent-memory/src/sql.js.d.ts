declare module "sql.js" {
  export interface SqlJsStatic {
    Database: new (data?: ArrayLike<number> | Buffer | null) => SqlJsDatabase;
  }
  export interface SqlJsDatabase {
    run(sql: string, params?: unknown[]): SqlJsDatabase;
    exec(sql: string): SqlJsExecResult[];
    prepare(sql: string): SqlJsStmt;
    export(): Uint8Array;
    close(): void;
    getRowsModified(): number;
  }
  export interface SqlJsStmt {
    bind(params?: unknown[]): boolean;
    step(): boolean;
    getAsObject(params?: Record<string, unknown>): Record<string, unknown>;
    reset(): boolean;
    free(): boolean;
  }
  export interface SqlJsExecResult {
    columns: string[];
    values: unknown[][];
  }
  export interface SqlJsConfig {
    locateFile?: (file: string) => string;
  }
  export default function initSqlJs(config?: SqlJsConfig): Promise<SqlJsStatic>;
}
