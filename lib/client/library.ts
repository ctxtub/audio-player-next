/**
 * Library (StoryWork) Client Facade
 *
 * M3（Library UI）消费公开故事库资产的稳定客户端门面。
 * 遵循严格原则：
 * 1. 仅通过类型安全 tRPC Client 调用已冻结的 8 个 canonical Procedure；
 * 2. 严禁包含任何 server-internal 实现细节与数据模型；
 * 3. 绝对不包含也不暴露测试接缝或全局可变状态；
 * 4. 纯净依赖，不引入 TanStack Query（由 M3 UI 组件层按需结合）。
 */

import { trpc } from '@/lib/trpc/client';
import { createLibraryFacade } from '@/lib/client/internal/libraryFacadeFactory';

export type {
  LibraryListInput,
  LibraryListOutput,
  LibraryGetInput,
  LibraryCreateInput,
  LibraryRenameInput,
  LibrarySetFavoriteInput,
  LibraryTrashInput,
  LibraryRestoreInput,
  LibraryDeletePermanentlyInput,
  LibraryDeletePermanentlyOutput,
  StoryWorkSummaryDTO,
  StoryWorkDetailDTO,
  LibraryView,
  StoryAudioProjection,
  StoryAudioStatus,
} from '@/lib/trpc/schemas/library';

const defaultFacade = createLibraryFacade(trpc);

export const fetchLibraryList = defaultFacade.fetchLibraryList;
export const fetchLibraryDetail = defaultFacade.fetchLibraryDetail;
export const createStoryWork = defaultFacade.createStoryWork;
export const renameStoryWork = defaultFacade.renameStoryWork;
export const setStoryWorkFavorite = defaultFacade.setStoryWorkFavorite;
export const moveToTrash = defaultFacade.moveToTrash;
export const restoreStoryWork = defaultFacade.restoreStoryWork;
export const deletePermanently = defaultFacade.deletePermanently;

// 别名
export const listStoryWorks = defaultFacade.listStoryWorks;
export const getStoryWork = defaultFacade.getStoryWork;
export const trashStoryWork = defaultFacade.trashStoryWork;
export const permanentDeleteStoryWork = defaultFacade.permanentDeleteStoryWork;
export const deletePermanentlyStoryWork = defaultFacade.deletePermanentlyStoryWork;

export const libraryClient = defaultFacade.libraryClient;
