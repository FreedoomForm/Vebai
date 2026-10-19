/**
 * T26: POST /api/tg/verify — step 2 of the login: { accountId, code, password? }.
 * Verifies the code (auth.signIn) on the SAME login session created by
 * /connect; handles the 2FA path (SESSION_PASSWORD_NEEDED → account.GetPassword
 * + computeCheck + auth.CheckPassword). On success the long-lived GramJS
 * StringSession is encrypted and stored, the account becomes 'connected' and
 * gets a default agent config.
 */
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/auth'
import { gramjs, clientOpts, tgErrorText, decryptSecret, encryptSecret, getOwnedAccount, readRulesDraft, clearRulesDraft, DEFAULT_AGENT_PROMPT } from '@/lib/tguser'

export const runtime = 'nodejs'
export const maxDuration = 30

export async function POST(req: Request) {
  const { user, unauthorized } = await requireAuth(req)
  if (unauthorized) return unauthorized
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const body = await req.json().catch(() => ({}))
  const account = await getOwnedAccount(user.id, String(body.accountId || ''))
  if (!account) return NextResponse.json({ error: 'аккаунт не найден' }, { status: 404 })
  if (!account.phoneCodeHash || !account.loginSessionEnc)
    return NextResponse.json({ error: 'сначала запроси код (/connect)' }, { status: 400 })

  const code = String(body.code || '').replace(/\D/g, '')
  const password = String(body.password || '')
  if (account.status !== '2fa' && code.length < 4)
    return NextResponse.json({ error: 'введи код подтверждения' }, { status: 400 })
  if (account.status === '2fa' && !password)
    return NextResponse.json({ needPassword: true, error: 'введи облачный пароль (2FA)' }, { status: 400 })

  const { TelegramClient, StringSession, computeCheck, Api } = await gramjs()
  const apiHash = decryptSecret(account.apiHashEnc)
  let client
  try {
    client = new TelegramClient(
      new StringSession(decryptSecret(account.loginSessionEnc)),
      account.apiId, apiHash, clientOpts(),
    )
    await client.connect()
    if (account.status === '2fa' || (!code && password)) {
      const pwdInfo = await client.invoke(new Api.account.GetPassword())
      const check = await computeCheck(pwdInfo, password)
      await client.invoke(new Api.auth.CheckPassword({ password: check }))
    } else {
      await client.invoke(
        new Api.auth.SignIn({
          phoneNumber: account.phone,
          phoneCodeHash: account.phoneCodeHash,
          phoneCode: code,
        }),
      )
    }
    const me = await client.getMe()
    const meInfo = JSON.stringify({
      id: String(me.id),
      firstName: me.firstName || '',
      username: me.username || '',
      phone: account.phone,
    })
    const sessionEnc = encryptSecret((client.session.save() as unknown as string) || '')
    await db.tgAccount.update({
      where: { id: account.id },
      data: {
        sessionEnc,
        status: 'connected',
        statusText: 'подключено',
        meInfo,
        phoneCodeHash: null,
        loginSessionEnc: null,
      },
    })
    // migrate the pre-connection rules draft into the agent config
    const draft = await readRulesDraft(user.id)
    await db.tgAgentConfig.upsert({
      where: { accountId: account.id },
      update: {},
      create: {
        accountId: account.id,
        systemPrompt: draft.systemPrompt || DEFAULT_AGENT_PROMPT,
        examples: JSON.stringify(draft.examples || []),
      },
    })
    await clearRulesDraft(user.id)
    return NextResponse.json({ ok: true, me: JSON.parse(meInfo) })
  } catch (e) {
    const msg = tgErrorText(e)
    if (/двухфакторн|SESSION_PASSWORD_NEEDED/i.test(msg)) {
      await db.tgAccount.update({
        where: { id: account.id },
        data: { status: '2fa', statusText: 'включена двухфакторная защита — введи облачный пароль' },
      }).catch(() => {})
      return NextResponse.json({ needPassword: true, error: msg }, { status: 400 })
    }
    // keep 'pending' so the user can retry code/2FA without a fresh code
    await db.tgAccount.update({
      where: { id: account.id },
      data: { statusText: msg },
    }).catch(() => {})
    return NextResponse.json({ error: msg }, { status: 400 })
  } finally {
    try { if (client) await client.disconnect() } catch { /* already gone */ }
  }
}
