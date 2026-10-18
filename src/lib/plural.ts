/** Russian plural form by cardinal rules:
 * plural(1, 'задача', 'задачи', 'задач') -> 'задача'
 * plural(2, 'задача', 'задачи', 'задач') -> 'задачи'
 * plural(5, 'задача', 'задачи', 'задач') -> 'задач' */
export function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10
  const m100 = n % 100
  if (m10 === 1 && m100 !== 11) return one
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few
  return many
}
