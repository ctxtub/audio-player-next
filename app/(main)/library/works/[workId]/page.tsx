import StoryDetailPage from '../../[id]/index';
/** 独立正文与只读归属解析入口。 */
export default async function Page({ params }: { params: Promise<{ workId: string }> }) {
 const { workId } = await params; return <StoryDetailPage id={workId} />;
}
