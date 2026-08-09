export type { PrismaClient } from "@prisma/client";
export { Prisma } from "@prisma/client";
export { closePrismaClient, ensureDatabase, getPrismaClient, initDatabase } from "./client.js";
