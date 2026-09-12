/**
 * Library (StoryWork) Client Facade
 *
 * M3（Library UI）消费公开故事库资产的稳定客户端门面。
 * 遵循严格原则：
 * 1. 仅通过类型安全 tRPC Client 调用已冻结的 8 个 Procedure；
 * 2. 严禁包含任何 server-internal 实现细节与数据模型；
 * 3. 绝对不包含也不暴露内部测试接缝；
 * 4. 纯净依赖，不引入 TanStack Query（由 M3 UI 组件层按需结合）。
 */

import { trpc } from '@/lib/trpc/client';
import type {
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
  LibraryPermanentDeleteInput,
  LibraryPermanentDeleteOutput,
  StoryWorkSummaryDTO,
  StoryWorkDetailDTO,
  LibraryView,
  StoryAudioProjection,
  StoryAudioStatus,
} from '@/lib/trpc/schemas/library';

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
  LibraryPermanentDeleteInput,
  LibraryPermanentDeleteOutput,
  StoryWorkSummaryDTO,
  StoryWorkDetailDTO,
  LibraryView,
  StoryAudioProjection,
  StoryAudioStatus,
};

let activeTrpcClient = trpc;

/**
 * 注入自定义 tRPC 客户端实例（供测试桩或特殊上下文注入）
 */
export const setLibraryTrpcClient = (client: typeof trpc): void => {
  activeTrpcClient = client;
};

/**
 * 重置为全局默认 tRPC 客户端实例
 */
export const resetLibraryTrpcClient = (): void => {
  activeTrpcClient = trpc;
};

/**
 * 获取当前使用的 tRPC 客户端实例
 */
export const getLibraryTrpcClient = (): typeof trpc => activeTrpcClient;

/**
 * 查询故事作品分页列表
 *
 * @param input 查询参数（可选视图、搜索词、分页游标、单页条数）
 */
export const fetchLibraryList = async (
  input?: Partial<LibraryListInput>
): Promise<LibraryListOutput> => {
  return activeTrpcClient.library.list.query(input ?? {});
};

/**
 * 获取单个故事作品详情
 *
 * @param input 作品 ID 或查询入参对象
 */
export const fetchLibraryDetail = async (
  input: LibraryGetInput | number
): Promise<StoryWorkDetailDTO> => {
  const payload: LibraryGetInput = typeof input === 'number' ? { id: input } : input;
  return activeTrpcClient.library.get.query(payload);
};

/**
 * 创作故事作品入库
 *
 * @param input 创作参数（正文、提示词、可选标题与可选音色/来源消息ID）
 */
export const createStoryWork = async (
  input: LibraryCreateInput
): Promise<StoryWorkDetailDTO> => {
  return activeTrpcClient.library.create.mutate(input);
};

/**
 * 重命名故事作品标题
 *
 * @param idOrInput 作品 ID 或入参对象
 * @param title 当首参为 ID 时的新标题
 */
export const renameStoryWork = async (
  idOrInput: LibraryRenameInput | number,
  title?: string
): Promise<StoryWorkDetailDTO> => {
  const payload: LibraryRenameInput =
    typeof idOrInput === 'number'
      ? { id: idOrInput, title: title! }
      : idOrInput;
  return activeTrpcClient.library.rename.mutate(payload);
};

/**
 * 切换故事作品收藏状态
 *
 * @param idOrInput 作品 ID 或入参对象
 * @param favorite 当首参为 ID 时的收藏状态布尔值
 */
export const setStoryWorkFavorite = async (
  idOrInput: LibrarySetFavoriteInput | number,
  favorite?: boolean
): Promise<StoryWorkDetailDTO> => {
  const payload: LibrarySetFavoriteInput =
    typeof idOrInput === 'number'
      ? { id: idOrInput, favorite: favorite! }
      : idOrInput;
  return activeTrpcClient.library.setFavorite.mutate(payload);
};

/**
 * 将故事作品移入回收站（软删除）
 *
 * @param input 作品 ID 或入参对象
 */
export const trashStoryWork = async (
  input: LibraryTrashInput | number
): Promise<StoryWorkDetailDTO> => {
  const payload: LibraryTrashInput = typeof input === 'number' ? { id: input } : input;
  return activeTrpcClient.library.trash.mutate(payload);
};

/**
 * 从回收站恢复故事作品
 *
 * @param input 作品 ID 或入参对象
 */
export const restoreStoryWork = async (
  input: LibraryRestoreInput | number
): Promise<StoryWorkDetailDTO> => {
  const payload: LibraryRestoreInput = typeof input === 'number' ? { id: input } : input;
  return activeTrpcClient.library.restore.mutate(payload);
};

/**
 * 永久物理删除故事作品（仅限处于回收站中的作品）
 *
 * @param input 作品 ID 或入参对象
 */
export const permanentDeleteStoryWork = async (
  input: LibraryDeletePermanentlyInput | number
): Promise<LibraryDeletePermanentlyOutput> => {
  const payload: LibraryDeletePermanentlyInput =
    typeof input === 'number' ? { id: input } : input;
  return activeTrpcClient.library.permanentDelete.mutate(payload);
};

/** 别名导出 */
export const listStoryWorks = fetchLibraryList;
export const getStoryWork = fetchLibraryDetail;
export const deletePermanentlyStoryWork = permanentDeleteStoryWork;

/**
 * 统一聚合 Client 对象
 */
export const libraryClient = {
  list: fetchLibraryList,
  get: fetchLibraryDetail,
  create: createStoryWork,
  rename: renameStoryWork,
  setFavorite: setStoryWorkFavorite,
  trash: trashStoryWork,
  restore: restoreStoryWork,
  permanentDelete: permanentDeleteStoryWork,
};
