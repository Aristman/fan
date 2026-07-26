-- AlterTable
ALTER TABLE "ClientToken" ADD COLUMN "projectScope" TEXT;

-- CreateIndex
CREATE INDEX "ClientToken_projectScope_idx" ON "ClientToken"("projectScope");
