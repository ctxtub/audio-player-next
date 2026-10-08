import StoryDetailPage from '../../../../[id]/index';
/** 集内正文必须校验父子资源匹配。 */
export default async function Page({ params }: { params: Promise<{ id: string; workId: string }> }) {
 const { id, workId } = await params; return <StoryDetailPage id={workId} expectedCollectionId={id} />;
}
