/**
 * Library (StoryWork) Client Facade
 *
 * M3（Library UI）消费公开故事库资产的稳定客户端门面。
 * 遵循严格原则：
 * 1. 仅通过类型安全 tRPC Client 调用已冻结的 8 个 canonical Procedure；
 * 2. 严禁包含任何 server-internal 实现细节与数据模型；
 * 3. 绝对不包含也不暴露测试接缝或全局可变状态；
 * 4. 纯净依赖，不引入 TanStack Query（由 M3 UI 组件层按需结合）；
 * 5. 纯结构体入参（Struct-only），无旧名兼容别名与裸 number convenience。
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

export const list = defaultFacade.list;
export const get = defaultFacade.get;
export const create = defaultFacade.create;
export const rename = defaultFacade.rename;
export const setFavorite = defaultFacade.setFavorite;
export const moveToTrash = defaultFacade.moveToTrash;
export const restore = defaultFacade.restore;
export const deletePermanently = defaultFacade.deletePermanently;

export const libraryClient = defaultFacade.libraryClient;
