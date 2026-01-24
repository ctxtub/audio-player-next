/**
 * tRPC 根 Router
 *
 * 聚合所有子 router，导出类型供客户端使用。
 */

import { router } from '../init';
import { authRouter } from './auth';
import { chatRouter } from './chat';
import { configRouter } from './config';
import { ttsRouter } from './tts';
import { agentRouter } from './agent';

/**
 * 应用根 Router。
 */
export const appRouter = router({
    auth: authRouter,
    chat: chatRouter,
    config: configRouter,
    tts: ttsRouter,
    agent: agentRouter,
});

/**
 * 导出类型供客户端类型推导。
 */
export type AppRouter = typeof appRouter;
