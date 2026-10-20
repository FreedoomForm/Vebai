const { PrismaClient } = require('@prisma/client');
const db = new PrismaClient();
(async () => {
  const accs = await db.tgAccount.findMany({
    select: { id: true, phone: true, status: true, statusText: true, active: true, apiId: true,
      meInfo: true, phoneCodeHash: true, loginSessionEnc: true, sessionEnc: true,
      lastCheckAt: true, updatedAt: true, userId: true,
      config: { select: { systemPrompt: true } } },
    orderBy: { updatedAt: 'desc' },
  });
  console.log('TgAccount rows:', accs.length);
  for (const a of accs) {
    console.log(JSON.stringify({
      id: a.id, phone: a.phone.slice(0, 6) + '***', status: a.status, statusText: (a.statusText || '').slice(0, 160),
      active: a.active, apiId: a.apiId, hasMe: !!a.meInfo, hasHash: !!a.phoneCodeHash,
      hasLoginSess: !!a.loginSessionEnc, hasSession: !!a.sessionEnc,
      agentActive: a.config ? a.config.active : null, promptLen: a.config ? a.config.systemPrompt.length : 0,
      userId: a.userId, updatedAt: a.updatedAt,
    }));
  }
  const users = await db.user.findMany({ where: { telegramChatId: { not: null } }, select: { id: true, email: true, telegramChatId: true, telegramUsername: true } });
  console.log('Users with telegramChatId:', users.length, users.map(u => `${u.email} (chat ${String(u.telegramChatId).slice(-4)})`));
  const cfg = await db.tgAgentConfig.findMany({ select: { accountId: true } });
  console.log('TgAgentConfig:', JSON.stringify(cfg));
  await db.$disconnect();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
