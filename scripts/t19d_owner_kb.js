// T19d: proactive owner message WITH the persistent reply keyboard,
// so the «Создать чат»/«Список чатов» menu re-appears immediately.
const TOKEN = process.env.TELEGRAM_BOT_TOKEN || ''
const OWNER = process.env.OWNER_CHAT_ID || '6413804768'
const kb = {
  keyboard: [[{ text: '🆕 Создать чат' }], [{ text: '📂 Список чатов' }]],
  resize_keyboard: true,
  input_field_placeholder: 'Опиши задачу для агента…',
}
fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    chat_id: OWNER,
    text: '🤖 Бот на связи. Внизу должно появиться меню (Создать чат / Список чатов).\n\nНапиши любую задачу обычным сообщением — агент выполнит и пришлёт результат. Если раньше сообщения пропадали — это уже исправлено, теперь всё доходит.',
    reply_markup: kb,
  }),
  signal: AbortSignal.timeout(20000),
})
  .then((r) => r.json())
  .then((j) => console.log('sendMessage ok =', j.ok, j.result?.message_id || j.description || ''))
  .catch((e) => { console.error('ERR', e.message); process.exit(1) })
