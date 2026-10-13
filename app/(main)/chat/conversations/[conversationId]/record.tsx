'use client';
import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { getConversation, fetchConversationMessages } from '@/lib/client/conversation';
import { getCollection } from '@/lib/client/collection';
import { rehydrateServerMessages } from '@/lib/client/chatArtifactHistory';
import { collectionPath } from '@/lib/navigation/storyRoutes';
import { useChatStore } from '@/stores/chatStore';
import { ConversationSwitchConfirmation } from '@/components/Library/ConversationSwitchConfirmation';
import { useConversationResume } from '@/components/Library/useConversationResume';
import styles from '@/components/Library/storyControls.module.scss';
/** 来源记录独立读取，显式恢复才切换编辑上下文。 */
export default function ConversationRecord({ id }: { id: string }) {
  const editingConversationId = useChatStore((state) => state.conversationId);
  const focusMessage = useSearchParams()?.get('focusMessage');
  const resumeFlow = useConversationResume();
  const query = useQuery({ queryKey: ['conversation-record', id], staleTime: 0, refetchOnMount: 'always', queryFn: async () => {
    const conversation = await getConversation(id);
    const [messages, collection] = await Promise.all([fetchConversationMessages(id), conversation.collectionId ? getCollection(conversation.collectionId) : Promise.resolve(null)]);
    return { conversation, messages, collection };
  } });
  useEffect(() => { if (query.data && focusMessage) document.getElementById(`message-${focusMessage}`)?.scrollIntoView({ block: 'center' }); }, [query.data, focusMessage]);
  if (query.isPending) return <p role="status">正在读取创作记录…</p>;
  if (!query.data) return <section><h1>创作记录暂不可用</h1><button onClick={() => query.refetch()}>重试</button><Link href="/library">返回故事库</Link></section>;
  const { conversation, collection, messages } = query.data;
  return <section className={styles.menuBody}>
    <ConversationSwitchConfirmation
      open={resumeFlow.confirmationOpen}
      collectionTitle={resumeFlow.confirmationTitle}
      resolve={resumeFlow.resolveConfirmation}
    />
    <nav className={styles.recordNav}><Link className={styles.navLink} href={collection ? collectionPath(collection.id) : '/library'}>{collection ? `返回《${collection.title}》` : '返回故事库'}</Link></nav>
    <h1>{collection?.title ?? '创作记录'}</h1><p>创作记录 · 查看不会生成新故事</p>
    <button className={styles.play} disabled={resumeFlow.busy} onClick={() => void resumeFlow.resume(conversation.id, collection?.title ?? null)}>{resumeFlow.busy ? '正在准备创作…' : editingConversationId === conversation.id ? '返回创作' : '续写这个故事集'}</button>
    {resumeFlow.error && <p role="alert">{resumeFlow.error}</p>}
    {rehydrateServerMessages(messages).map((message) => <article key={message.id} id={`message-${message.id}`}><h2>{message.role === 'user' ? '你的想法' : '创作内容'}</h2><p style={{ whiteSpace: 'pre-wrap' }}>{message.content}</p></article>)}
  </section>;
}
