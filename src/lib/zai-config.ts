/**
 * Shared Z.ai configuration constants (no side effects, safe to import
 * from any route). The API key itself is only read server-side in zai.ts.
 */

/** Primary free chat model (glm-4.7-flash is free on the official API). */
export const DEFAULT_CHAT_MODEL = process.env.ZAI_MODEL || 'glm-4.7-flash'

/** Automatic fallback when the primary model is overloaded. */
export const FALLBACK_CHAT_MODEL = 'glm-4.5-flash'

/** Official OpenAI-compatible endpoint (international Z.ai / mainland Zhipu). */
export const DEFAULT_BASE_URL = 'https://open.bigmodel.cn/api/paas/v4'

/** Free image generation model (CogView-3-Flash). */
export const DEFAULT_IMAGE_MODEL = process.env.ZAI_IMAGE_MODEL || 'cogview-3-flash'
