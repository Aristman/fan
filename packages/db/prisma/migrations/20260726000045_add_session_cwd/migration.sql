-- AlterTable
ALTER TABLE "Session" ADD COLUMN "cwd" TEXT;

-- CreateIndex
CREATE INDEX "Session_cwd_idx" ON "Session"("cwd");
