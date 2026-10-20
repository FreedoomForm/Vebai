// T19e: swap the persistent bottom reply keyboard for inline buttons.
// 1) remove_keyboard for the owner chat (kills the old bottom menu)
// 2) immediately send an inline greeting so the in-chat menu is visible
const TOKEN = process.env.TELEGRAM_BOT_TOKEN || ''
const OWNER = process.env.OWNER_CHAT_ID || '6413804768'
const BASE = `https://api.telegram.org/bot${TOKEN}`

async function call(method, body) {
  const r = await fetch(`${BASE}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  })
  return r.json()
}

const inlineMenu = {
  inline_keyboard: [
    [
      { text: '🆕 Создать чат', callback_data: 'newchat' },
      { text: '📂 Чаты', callback_data: 'chatlist' },
    ],
  ],
}

async function main() {
  const rm = await call('sendMessage', {
    chat_id: OWNER,
    text: 'Перенёс кнопки внутрь чата — нижнюю клавиатуру убираю.',
    reply_markup: { remove_keyboard: true },
  })
  console.log('remove_keyboard msg ok =', rm.ok, rm.result?.message_id || rm.description || '')
  const hi = await call('sendMessage', {
    chat_id: OWNER,
    text: '🤖 Теперь кнопки живут прямо в сообщениях: «Создать чат» и «Чаты» под этим сообщением. Обычный текст — задача агенту, «?текст» — быстрый вопрос.',
    reply_markup: inlineMenu,
  })
  console.log('inline greeting ok =', hi.ok, hi.result?.message_id || hi.description || '')
}

main().catch((e) => { console.error('ERR', e.message); process.exit(1) })
