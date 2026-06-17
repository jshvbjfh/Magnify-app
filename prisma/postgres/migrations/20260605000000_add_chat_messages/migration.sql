CREATE TABLE IF NOT EXISTS "chat_messages" (
    "id"        TEXT         NOT NULL,
    "userId"    TEXT         NOT NULL,
    "role"      TEXT         NOT NULL,
    "content"   TEXT         NOT NULL,
    "images"    TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "chat_messages_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "chat_messages_userId_createdAt_idx" ON "chat_messages"("userId", "createdAt");
