/**
 * tRPC 根 Router
 *
 * 聚合所有子 router，导出类型供客户端使用。
 */

import { router } from '../init';
import { authRouter } from './auth';
import { configRouter } from './config';
import { ttsRouter } from './tts';
import { agentRouter } from './agent';
import { promptHistoryRouter } from './promptHistory';
import { generationHistoryRouter } from './generationHistory';
import { chatConversationRouter } from './chatConversation';

/**
 * 应用根 Router。
 */
export const appRouter = router({
    auth: authRouter,
    config: configRouter,
    tts: ttsRouter,
    agent: agentRouter,
    promptHistory: promptHistoryRouter,
    generationHistory: generationHistoryRouter,
    chat: chatConversationRouter,
});

/**
 * 导出类型供客户端类型推导。
 */
export type AppRouter = typeof appRouter;
