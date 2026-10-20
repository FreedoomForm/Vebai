/**
 * T26/T27: POST /api/tg/verify — step 2 of the login: { accountId, code, password? }.
 * Verifies the code (auth.signIn) on the SAME login session created by
 * /connect; handles the 2FA path (SESSION_PASSWORD_NEEDED → account.GetPassword
 * + computeCheck + auth.CheckPassword). On success the long-lived GramJS
 * StringSession is encrypted and stored, the account becomes 'connected' and
 * gets a default agent config (rules draft migrates here too).
 */
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth } from '@/lib/auth'
import {
  mtprotoVerifyCode,
  NeedPasswordError,
  humanTgError,
  encryptSecret,
  getOwnedAccount,
  migrateRulesDraft,
  bindChatToUser,
} from '@/lib/tguser'

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

  try {
    const res = await mtprotoVerifyCode({
      apiId: account.apiId,
      apiHashEnc: account.apiHashEnc,
      loginSessionEnc: account.loginSessionEnc,
      phone: account.phone,
      phoneCodeHash: account.phoneCodeHash,
      status: account.status,
      code,
      password,
    })
    const meInfo = JSON.stringify(res.me)
    await db.tgAccount.update({
      where: { id: account.id },
      data: {
        sessionEnc: encryptSecret(res.session),
        status: 'connected',
        statusText: 'подключено',
        // T34: connect creates the row with active:false (re-login safety);
        // a VERIFIED session must be active, or /api/tg/work never hands the
        // account to the worker and the personal agent never listens
        active: true,
        meInfo,
        phoneCodeHash: null,
        loginSessionEnc: null,
      },
    })
    // migrate the pre-connection rules draft into the agent config
    await migrateRulesDraft(user.id, account.id)
    // T41: connecting on the SITE must make the BOT see the account too.
    // res.me.id IS this person's telegram user id — bind the chat to the site
    // user (same merge /start connect_<token> does) unless the user is already
    // bound to a different chat. After this the bot menu/status/toggles read
    // the same TgAccount row — connected in one place == connected everywhere.
    const tgId = res.me?.id ? String(res.me.id) : ''
    const freshUser = await db.user.findUnique({ where: { id: user.id }, select: { telegramChatId: true } })
    if (/^\d+$/.test(tgId) && freshUser && (!freshUser.telegramChatId || freshUser.telegramChatId === tgId))
      await bindChatToUser(tgId, user.id, res.me?.username || null).catch(() => {})
    return NextResponse.json({ ok: true, me: res.me })
  } catch (e) {
    if (e instanceof NeedPasswordError) {
      await db.tgAccount.update({
        where: { id: account.id },
        data: { status: '2fa', statusText: 'включена двухфакторная защита — введи облачный пароль' },
      }).catch(() => {})
      return NextResponse.json({ needPassword: true, error: 'Включена двухфакторная защита — нужен облачный пароль' }, { status: 400 })
    }
    // keep 'pending' so the user can retry code/2FA without a fresh code
    await db.tgAccount.update({
      where: { id: account.id },
      data: { statusText: humanTgError(e) },
    }).catch(() => {})
    return NextResponse.json({ error: humanTgError(e) }, { status: 400 })
  }
}
