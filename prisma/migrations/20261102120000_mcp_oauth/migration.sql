-- CreateTable
CREATE TABLE "oauth_payloads" (
    "model" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "grant_id" TEXT,
    "user_code" TEXT,
    "uid" TEXT,
    "expires_at" TIMESTAMP(3),
    "consumed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "oauth_payloads_pkey" PRIMARY KEY ("model","id")
);

-- CreateIndex
CREATE INDEX "oauth_payloads_grant_id_idx" ON "oauth_payloads"("grant_id");

-- CreateIndex
CREATE INDEX "oauth_payloads_uid_idx" ON "oauth_payloads"("uid");

-- CreateIndex
CREATE INDEX "oauth_payloads_expires_at_idx" ON "oauth_payloads"("expires_at");

