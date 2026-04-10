import { PrismaClient } from "@prisma/client";

let _client: PrismaClient | null = null;

export function getPrismaClient(): PrismaClient {
	if (!_client) {
		const logLevel = process.env["FNA_DB_LOG"] ?? ["error"];
		_client = new PrismaClient({
			log: Array.isArray(logLevel) ? (logLevel as Array<"query" | "info" | "warn" | "error">) : [logLevel as "query" | "info" | "warn" | "error"],
		});
	}
	return _client;
}

export function closePrismaClient(): Promise<void> {
	if (_client) {
		const client = _client;
		_client = null;
		return client.$disconnect();
	}
	return Promise.resolve();
}
