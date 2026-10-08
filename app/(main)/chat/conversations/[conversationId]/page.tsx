import ConversationRecord from './record';
/** 来源会话页面，读取不改变 active。 */
export default async function Page({ params }: { params: Promise<{ conversationId: string }> }) {
  const { conversationId } = await params;
  return <ConversationRecord id={conversationId} />;
}
