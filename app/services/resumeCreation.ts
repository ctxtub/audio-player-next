import { fetchConversationMessages, resumeConversation } from '@/lib/client/conversation';
import { cancelPendingNextWork } from '@/app/services/continuousCreationFlow';
import { useChatStore } from '@/stores/chatStore';
import { useContinuousCreationStore } from '@/stores/continuousCreationStore';
import { useGenerationStore } from '@/stores/generationStore';

const GENERATION_SETTLE_TIMEOUT_MS = 120_000;

function abortError(): Error {
  const error = new Error('创作切换已取消');
  error.name = 'AbortError';
  return error;
}

function hasSendingMessages(): boolean {
  return useChatStore.getState().messages.some((message) =>
    message.status === 'sending' ||
    message.parts?.some((part) => part.type === 'storyArtifact' && part.artifact.status === 'promoting'),
  );
}

/** Wait for the active stream to settle; always remove the store subscription. */
function waitForGenerationToSettle(signal?: AbortSignal): Promise<void> {
  if (!hasSendingMessages()) return Promise.resolve();
  if (signal?.aborted) return Promise.reject(abortError());

  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = useChatStore.subscribe(() => {
      if (!hasSendingMessages()) finish();
    });
    const onAbort = () => finish(abortError());
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      unsubscribe();
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve();
    };

    timer = setTimeout(() => finish(new Error('当前生成等待超时，请稍后重试')), GENERATION_SETTLE_TIMEOUT_MS);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    else if (!hasSendingMessages()) finish();
  });
}

function hasUnsentDraft(): boolean {
  const state = useChatStore.getState();
  return Boolean(
    state.inputValue.trim() ||
    state.pendingAutoSend?.trim() ||
    state.messages.some((message) =>
      message.status === 'sending' ||
      message.parts?.some((part) => part.type === 'storyArtifact' && part.artifact.status !== 'ready'),
    ),
  );
}

export type ResumeCreationResult = { conversationId: string; collectionId: string | null };

export type ResumeCreationOptions = {
  conversationId: string;
  collectionTitle?: string | null;
  confirmSwitch: () => Promise<boolean>;
  signal?: AbortSignal;
};

/**
 * Resume an existing conversation for editing. The server CAS is the commit point:
 * do not replace the local conversation snapshot or stop its autoplay before it succeeds.
 */
export async function resumeCreationConversation({
  conversationId,
  collectionTitle,
  confirmSwitch,
  signal,
}: ResumeCreationOptions): Promise<ResumeCreationResult | null> {
  const chat = useChatStore.getState();
  if (chat.conversationId === conversationId) {
    return { conversationId, collectionId: chat.collectionId };
  }

  await chat.initForUser();
  if (signal?.aborted) throw abortError();

  if (hasUnsentDraft() && !(await confirmSwitch())) {
    return null;
  }
  if (signal?.aborted) throw abortError();

  await waitForGenerationToSettle(signal);
  if (signal?.aborted) throw abortError();

  const current = useChatStore.getState();
  if (current.conversationId === conversationId) {
    return { conversationId, collectionId: current.collectionId };
  }
  if (current.pendingAutoSend && current.inputValue) {
    throw new Error('当前同时有待发送建议和输入草稿，请返回创作处理后再切换');
  }
  if (hasSendingMessages()) {
    throw new Error('当前生成尚未完成，请稍后重试');
  }
  const draftAtFlush = current.inputValue;
  const pendingAtFlush = current.pendingAutoSend;
  const conversationIdAtFlush = current.conversationId;
  const epochAtFlush = current.epoch;
  const messagesAtFlush = current.messages;
  if (!(await current.flushPendingSave())) {
    throw new Error('当前创作尚未保存成功，请重试');
  }
  if (signal?.aborted) throw abortError();

  // Freeze the active identity immediately after saving; asynchronous target reads
  // must not turn a later identity change into a newly authorized CAS value.
  const expectedOldId = useChatStore.getState().conversationId;
  if (expectedOldId !== conversationIdAtFlush || useChatStore.getState().epoch !== epochAtFlush) {
    throw new Error('当前创作已变化，请确认后重试切换');
  }

  // Resolve target data while the current conversation remains active.
  const messages = await fetchConversationMessages(conversationId);
  if (signal?.aborted) throw abortError();

  const beforeSwitch = useChatStore.getState();
  if (
    beforeSwitch.conversationId !== expectedOldId ||
    beforeSwitch.epoch !== epochAtFlush ||
    hasSendingMessages() ||
    beforeSwitch.messages !== messagesAtFlush ||
    beforeSwitch.inputValue !== draftAtFlush ||
    beforeSwitch.pendingAutoSend !== pendingAtFlush
  ) {
    throw new Error('当前创作已变化，请确认后重试切换');
  }
  const target = await resumeConversation(conversationId, expectedOldId);
  const afterCommit = useChatStore.getState();
  if (
    afterCommit.epoch !== epochAtFlush ||
    !afterCommit.syncEnabled ||
    afterCommit.conversationId !== expectedOldId ||
    afterCommit.messages !== beforeSwitch.messages ||
    hasSendingMessages() ||
    afterCommit.pendingAutoSend !== beforeSwitch.pendingAutoSend
  ) {
    throw new Error('服务端已完成恢复，但本地创作期间发生变化；请重新进入这份创作或刷新恢复');
  }

  cancelPendingNextWork();
  useContinuousCreationStore.getState().setCreationWork(null);
  useGenerationStore.getState().reset();
  // Preserve a queued but unsent suggestion as ordinary editable draft text;
  // loadConversation stores the previous input per conversation.
  const pendingDraft = useChatStore.getState();
  if (!pendingDraft.inputValue && pendingDraft.pendingAutoSend) {
    pendingDraft.setInputValue(pendingDraft.pendingAutoSend);
  }
  useChatStore.getState().loadConversation({
    conversationId: target.id,
    collectionId: target.collectionId,
    collectionTitle: collectionTitle ?? null,
  }, messages);

  return { conversationId: target.id, collectionId: target.collectionId };
}
