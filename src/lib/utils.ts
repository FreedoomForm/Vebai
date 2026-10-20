import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/** human-readable size: 0 -> "0 Б", 1536 -> "1.5 КБ", 5242880 -> "5 МБ" */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 Б'
  if (n < 1024) return `${n} Б`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} КБ`
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} МБ`
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} ГБ`
}
