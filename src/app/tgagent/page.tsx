import { TgConnectApp } from '@/components/tg/tg-app'

export const metadata = {
  title: 'Подключить Telegram-агента — Vebai',
  description: 'Подключи свой Telegram-аккаунт: номер + код, и агент ответит людям от твоего имени',
}

export default function TgAgentPage() {
  return <TgConnectApp />
}
