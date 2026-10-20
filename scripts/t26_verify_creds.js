/**
 * T26 follow-up: validate owner-provided MTProto app creds against real
 * Telegram WITHOUT sending any login code to anyone. Connects to a Telegram
 * DC and invokes help.GetNearestDc — this handshake only succeeds when
 * api_id/api_hash are accepted (API_ID_INVALID otherwise).
 *
 * Usage: TELEGRAM_API_ID=... TELEGRAM_API_HASH=... node scripts/t26_verify_creds.js
 * Secrets are read from env only — never hardcoded, never printed.
 */
const path = require('path')

async function main() {
  const apiId = Number(process.env.TELEGRAM_API_ID || 0)
  const apiHash = (process.env.TELEGRAM_API_HASH || '').trim()
  if (!apiId || apiHash.length < 16) {
    console.error('FAIL: TELEGRAM_API_ID / TELEGRAM_API_HASH env not provided')
    process.exit(2)
  }

  let t
  try {
    t = require(path.join(__dirname, '..', 'node_modules', 'telegram'))
  } catch (e) {
    console.error('FAIL: telegram package not available:', e.message)
    process.exit(2)
  }

  const { TelegramClient } = t
  const { StringSession } = t.sessions
  const { Api } = t

  console.log(`connecting with api_id=${apiId}, api_hash=<${apiHash.length} chars>`)
  const client = new TelegramClient(
    new StringSession(''),
    apiId,
    apiHash,
    {
      connectionRetries: 2,
      requestRetries: 1,
      useWSS: true,
      autoReconnect: false,
      floodSleepThreshold: 0,
      deviceModel: 'Vebai Creds Check',
      systemVersion: 'vebai-six.vercel.app',
    },
  )

  try {
    await client.connect()
    // Harmless: nearest DC — no codes, no user data, proves creds accepted
    const res = await client.invoke(new Api.help.GetNearestDc())
    console.log('PASS: creds accepted by Telegram')
    console.log(`nearest dc=${res.nearestDc} country=${res.country}`)
    process.exitCode = 0
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error('FAIL: Telegram rejected the handshake:', msg)
    process.exitCode = 1
  } finally {
    try { await client.disconnect() } catch { /* gone */ }
  }
}

main()
