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
import { chatConversationRouter } from './chatConversation';
import { conversationRouter } from './conversation';
import { collectionRouter } from './collection';
import { playbackRouter } from './playback';
import { libraryRouter } from './library';
import { storyAudioRouter } from './storyAudio';

/**
 * 应用根 Router。
 */
export const appRouter = router({
    auth: authRouter,
    config: configRouter,
    tts: ttsRouter,
    agent: agentRouter,
    chat: chatConversationRouter,
    conversation: conversationRouter,
    collection: collectionRouter,
    playback: playbackRouter,
    library: libraryRouter,
    storyAudio: storyAudioRouter,
});

/**
 * 导出类型供客户端类型推导。
 */
export type AppRouter = typeof appRouter;
