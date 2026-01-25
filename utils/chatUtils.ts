import type { ChatConversationMessage, ChatMessage } from '@/types/chat';

/**
 * 生成统一格式的时间戳，使用 ISO 字符串表达。
 */
export const createTimestamp = () => new Date().toISOString();

/**
 * 生成前缀化的临时消息 id，优先使用 crypto.randomUUID。
 * @param prefix id 前缀，区分用户或助手。
 */
export const createTempMessageId = (prefix: string) => {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return `${prefix}-${crypto.randomUUID()}`;
    }
    return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
};

/**
 * 支持透传给上游的会话角色列表。
 */
export const supportedConversationRoles: ReadonlyArray<ChatConversationMessage['role']> = [
    'system',
    'user',
    'assistant',
];

/**
 * 判断给定角色是否允许透出到会话上下文。
 * @param role 待校验的消息角色。
 */
export const isSupportedConversationRole = (
    role: ChatMessage['role'],
): role is ChatConversationMessage['role'] =>
    (supportedConversationRoles as ReadonlyArray<string>).includes(role);

/**
 * 不同角色对应的展示昵称与头像配置。
 */
export const messagePersonaMap: Record<ChatMessage['role'], { displayName: string; avatar: string }> = {
    assistant: {
        displayName: 'Agent',
        avatar: '/icons/avatar-assistant.svg',
    },
    user: {
        displayName: '我',
        avatar: '/icons/avatar-user.svg',
    },
    system: {
        displayName: '系统提示',
        avatar: '/icons/avatar-assistant.svg',
    },
    developer: {
        displayName: '系统提示',
        avatar: '/icons/avatar-assistant.svg',
    },
    function: {
        displayName: '函数输出',
        avatar: '/icons/avatar-assistant.svg',
    },
    tool: {
        displayName: '工具消息',
        avatar: '/icons/avatar-assistant.svg',
    },
};

/**
 * 为消息补全展示用的头像与昵称信息。
 * @param message 待补全的消息实体。
 */
export const withPersona = <T extends ChatMessage>(message: T): T => {
    const persona = messagePersonaMap[message.role];
    if (!persona) {
        return message;
    }
    return {
        ...message,
        displayName: message.displayName ?? persona.displayName,
        avatar: message.avatar ?? persona.avatar,
    };
};

/**
 * 将历史消息映射为上游所需的 ChatCompletionMessageParam 数组。
 * @param messages 已确认的聊天消息列表。
 */
export const mapMessagesToContext = (
    messages: ChatMessage[],
): ChatConversationMessage[] =>
    messages.reduce<ChatConversationMessage[]>((acc, item) => {
        // 仅包含角色受支持且状态正常的消息作为上下文
        if (item.status === 'failed') {
            return acc;
        }
        if (!isSupportedConversationRole(item.role)) {
            return acc;
        }
        const normalized: ChatConversationMessage = {
            role: item.role,
            content: item.content,
        };
        acc.push(normalized);
        return acc;
    }, []);

/**
 * 构造一个默认的助手占位消息，状态为发送中。
 */
export const createAssistantPlaceholder = (): ChatMessage => ({
    id: createTempMessageId('assistant'),
    role: 'assistant',
    content: '',
    status: 'sending',
    createdAt: createTimestamp(),
});
