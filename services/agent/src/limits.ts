/** Finite research policy, mirrored by Rust settings and execution deadlines. */
export const WEB_CALL_LIMIT = 100;
export type ExecutionLimits = { turns: number; tools: number; timeoutMs: number };
export const DEFAULT_LIMITS: ExecutionLimits = { turns: 256, tools: 240, timeoutMs: 20 * 60 * 1000 };
export const EVENT_LIMITS = { chat: 6000, task: 2000 };
