/**
 * Shared Z.ai configuration constants (no side effects, safe to import
 * from any route). The API key itself is only read server-side in zai.ts.
 */

/** Primary free chat model (owner request, 2026-10-16: glm-4.7-flash is free
 * and is now the default; it's a thinking model, briefly overloaded at times). */
export const DEFAULT_CHAT_MODEL = process.env.ZAI_MODEL || 'glm-4.7-flash'

/** T52c (owner report 2026-10-23: «писание 3-летнего малыша: GLM-4.5-Flash»):
 * when 4.7-flash is overloaded the chain used to drop straight to the WEAKEST
 * free model (4.5-flash) — messages it writes read like a toddler's. The free
 * Flash line also has glm-4.6-flash (itsfree.ai, verified 2026-09): newer
 * generation than 4.5, now the MIDDLE rung so the quality floor is higher.
 * 4.5-flash stays only as the last resort. */
export const MIDDLE_CHAT_MODEL = 'glm-4.6-flash'

/** Last-resort free model (weakest of the Flash line). */
export const FALLBACK_CHAT_MODEL = 'glm-4.5-flash'

/** Official OpenAI-compatible endpoint (international Z.ai / mainland Zhipu). */
export const DEFAULT_BASE_URL = 'https://open.bigmodel.cn/api/paas/v4'

/** Image generation is DISABLED (CogView became a paid API — owner request).
 * The constant stays only so legacy zai.images imports keep compiling. */
export const DEFAULT_IMAGE_MODEL = process.env.ZAI_IMAGE_MODEL || 'cogview-3-flash'
