'use client';
import { useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { getConversation, fetchConversationMessages, resumeConversation } from '@/lib/client/conversation';
import { getCollection } from '@/lib/client/collection';
import { rehydrateServerMessages } from '@/lib/client/chatArtifactHistory';
import { collectionPath } from '@/lib/navigation/storyRoutes';
import { useChatStore } from '@/stores/chatStore';
import { cancelPendingNextWork } from '@/app/services/continuousCreationFlow';
import { useContinuousCreationStore } from '@/stores/continuousCreationStore';
import { useGenerationStore } from '@/stores/generationStore';
import styles from '@/components/Library/storyControls.module.scss';
/** 来源记录独立读取，显式恢复才切换编辑上下文。 */
export default function ConversationRecord({ id }: { id: string }) {
  const router = useRouter();
  const editingConversationId = useChatStore((state) => state.conversationId);
  const focusMessage = useSearchParams()?.get('focusMessage');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmSwitch, setConfirmSwitch] = useState(false);
  const query = useQuery({ queryKey: ['conversation-record', id], staleTime: 0, refetchOnMount: 'always', queryFn: async () => {
    const conversation = await getConversation(id);
    const [messages, collection] = await Promise.all([fetchConversationMessages(id), conversation.collectionId ? getCollection(conversation.collectionId) : Promise.resolve(null)]);
    return { conversation, messages, collection };
  } });
  useEffect(() => { if (query.data && focusMessage) document.getElementById(`message-${focusMessage}`)?.scrollIntoView({ block: 'center' }); }, [query.data, focusMessage]);
  const resume = async () => {
    if (!query.data) return;
    const chat = useChatStore.getState();
    if (!confirmSwitch && (chat.inputValue.trim() || chat.messages.some((message) => message.status === 'sending'))) { setConfirmSwitch(true); return; }
    if (chat.conversationId === id) { router.push('/chat'); return; }
    setBusy(true); setError('');
    try {
      await chat.initForUser();
      if (useChatStore.getState().messages.some((message) => message.status === 'sending')) throw new Error('请等当前生成完成，再切换创作');
      if (!(await useChatStore.getState().flushPendingSave())) throw new Error('当前创作尚未保存成功，请重试');
      const expectedOldId = useChatStore.getState().conversationId;
      // 读取阶段保留原上下文，远端切换成功后才应用已取得快照。
      const messages = await fetchConversationMessages(id);
      const target = await resumeConversation(id, expectedOldId);
      cancelPendingNextWork();
      useContinuousCreationStore.getState().setCreationWork(null);
      useGenerationStore.getState().reset();
      useChatStore.getState().loadConversation({ conversationId: target.id, collectionId: target.collectionId, collectionTitle: query.data.collection?.title ?? null }, messages);
      cancelPendingNextWork();
      useContinuousCreationStore.getState().setCreationWork(null);
      router.push('/chat');
    } catch (err) { setError(err instanceof Error ? err.message : '无法恢复创作，请重试'); } finally { setBusy(false); }
  };
  if (query.isPending) return <p role="status">正在读取创作记录…</p>;
  if (!query.data) return <section><h1>创作记录暂不可用</h1><button onClick={() => query.refetch()}>重试</button><Link href="/library">返回故事库</Link></section>;
  const { conversation, collection, messages } = query.data;
  return <section className={styles.menuBody}>
    <nav><Link href={collection ? collectionPath(collection.id) : '/library'}>{collection ? `返回《${collection.title}》` : '返回故事库'}</Link></nav>
    <h1>{collection?.title ?? '创作记录'}</h1><p>创作记录 · 查看不会生成新故事</p>
    <button className={styles.play} disabled={busy} onClick={resume}>{busy ? '正在准备创作…' : editingConversationId === conversation.id ? '返回创作' : '续写这个故事集'}</button>
    {confirmSwitch && <div role="dialog" aria-label="切换创作"><p>当前输入会保留。切换后停止旧自动创作，已保存故事和当前收听会保留。</p><button disabled={busy} onClick={resume}>保留草稿并切换</button><button onClick={() => setConfirmSwitch(false)}>留在当前创作</button></div>}
    {error && <p role="alert">{error}</p>}
    {rehydrateServerMessages(messages).map((message) => <article key={message.id} id={`message-${message.id}`}><h2>{message.role === 'user' ? '你的想法' : '创作内容'}</h2><p style={{ whiteSpace: 'pre-wrap' }}>{message.content}</p></article>)}
  </section>;
}
