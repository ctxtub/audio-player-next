import { redirect } from 'next/navigation';
import { libraryPath } from '@/lib/navigation/storyRoutes';
import LibraryPage from './index';
/** 旧视图参数归一到明确的管理路径。 */
export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  if (typeof params.view === 'string') redirect(libraryPath(params.view, typeof params.q === 'string' ? params.q : undefined, typeof params.type === 'string' ? params.type : undefined));
  return <LibraryPage />;
}
