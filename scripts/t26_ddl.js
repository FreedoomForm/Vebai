// T26 DDL: create TgAccount / TgAgentConfig / TgAgentMessage via raw SQL.
// Additive-only (IF NOT EXISTS + DO guards) so the richer prod DB (User.telegramChatId
// etc.) is never touched — `prisma db push` wanted to drop those columns.
const { PrismaClient } = require('@prisma/client')
const p = new PrismaClient()

const stmts = [
  `CREATE TABLE IF NOT EXISTS "TgAccount" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "apiId" INTEGER NOT NULL,
    "apiHashEnc" TEXT NOT NULL,
    "sessionEnc" TEXT,
    "phoneCodeHash" TEXT,
    "loginSessionEnc" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "statusText" TEXT,
    "meInfo" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "lastCheckAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "TgAccount_pkey" PRIMARY KEY ("id")
  )`,
  `DO $$ BEGIN
    ALTER TABLE "TgAccount" ADD CONSTRAINT "TgAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "TgAccount_userId_phone_key" ON "TgAccount"("userId", "phone")`,
  `CREATE INDEX IF NOT EXISTS "TgAccount_status_active_idx" ON "TgAccount"("status", "active")`,

  `CREATE TABLE IF NOT EXISTS "TgAgentConfig" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "systemPrompt" TEXT NOT NULL DEFAULT '',
    "examples" TEXT NOT NULL DEFAULT '[]',
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "TgAgentConfig_pkey" PRIMARY KEY ("id")
  )`,
  `DO $$ BEGIN
    ALTER TABLE "TgAgentConfig" ADD CONSTRAINT "TgAgentConfig_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "TgAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "TgAgentConfig_accountId_key" ON "TgAgentConfig"("accountId")`,

  `CREATE TABLE IF NOT EXISTS "TgAgentMessage" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "chatName" TEXT,
    "msgId" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TgAgentMessage_pkey" PRIMARY KEY ("id")
  )`,
  `DO $$ BEGIN
    ALTER TABLE "TgAgentMessage" ADD CONSTRAINT "TgAgentMessage_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "TgAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "TgAgentMessage_accountId_chatId_msgId_direction_key" ON "TgAgentMessage"("accountId", "chatId", "msgId", "direction")`,
  `CREATE INDEX IF NOT EXISTS "TgAgentMessage_accountId_createdAt_idx" ON "TgAgentMessage"("accountId", "createdAt")`,
]

async function main() {
  for (const sql of stmts) {
    await p.$executeRawUnsafe(sql)
    console.log('ok:', sql.split('\n')[0].slice(0, 70))
  }
  const tables = await p.$queryRawUnsafe(
    `SELECT table_name FROM information_schema.tables WHERE table_name LIKE 'Tg%' ORDER BY 1`,
  )
  console.log('Tg tables now:', JSON.stringify(tables))
  await p.$disconnect()
}

main().catch((e) => { console.error('FATAL:', e.message); process.exit(1) })
