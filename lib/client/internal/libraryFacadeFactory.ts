/**
 * Library Facade Factory
 *
 * 内部工厂模块，根据传入的 tRPC 客户端实例构建 Library 消费门面。
 * 供生产端绑定默认 trpc，并供测试环境构建隔离的测试门面。
 */

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
  StoryWorkDetailDTO,
} from '@/lib/trpc/schemas/library';

export interface MinimalLibraryTrpcClient {
  library: {
    list: {
      query: (input?: Partial<LibraryListInput>) => Promise<LibraryListOutput>;
    };
    get: {
      query: (input: LibraryGetInput) => Promise<StoryWorkDetailDTO>;
    };
    create: {
      mutate: (input: LibraryCreateInput) => Promise<StoryWorkDetailDTO>;
    };
    rename: {
      mutate: (input: LibraryRenameInput) => Promise<StoryWorkDetailDTO>;
    };
    setFavorite: {
      mutate: (input: LibrarySetFavoriteInput) => Promise<StoryWorkDetailDTO>;
    };
    moveToTrash: {
      mutate: (input: LibraryTrashInput) => Promise<StoryWorkDetailDTO>;
    };
    restore: {
      mutate: (input: LibraryRestoreInput) => Promise<StoryWorkDetailDTO>;
    };
    deletePermanently: {
      mutate: (input: LibraryDeletePermanentlyInput) => Promise<LibraryDeletePermanentlyOutput>;
    };
  };
}

/**
 * 根据给定的 tRPC 客户端创建 Library Facade
 *
 * @param client 实现 MinimalLibraryTrpcClient 的客户端实例
 */
export function createLibraryFacade<TClient extends MinimalLibraryTrpcClient>(client: TClient) {
  /**
   * 查询故事作品分页列表
   */
  const fetchLibraryList = async (
    input?: Partial<LibraryListInput>
  ): Promise<LibraryListOutput> => {
    return client.library.list.query(input ?? {});
  };

  /**
   * 获取单个故事作品详情
   */
  const fetchLibraryDetail = async (
    input: LibraryGetInput | number
  ): Promise<StoryWorkDetailDTO> => {
    const payload: LibraryGetInput = typeof input === 'number' ? { id: input } : input;
    return client.library.get.query(payload);
  };

  /**
   * 创作故事作品入库
   */
  const createStoryWork = async (
    input: LibraryCreateInput
  ): Promise<StoryWorkDetailDTO> => {
    return client.library.create.mutate(input);
  };

  /**
   * 重命名故事作品标题（收窄为纯结构体入参，避免悬空重载）
   */
  const renameStoryWork = async (
    input: LibraryRenameInput
  ): Promise<StoryWorkDetailDTO> => {
    return client.library.rename.mutate(input);
  };

  /**
   * 切换故事作品收藏状态（收窄为纯结构体入参，避免悬空重载）
   */
  const setStoryWorkFavorite = async (
    input: LibrarySetFavoriteInput
  ): Promise<StoryWorkDetailDTO> => {
    return client.library.setFavorite.mutate(input);
  };

  /**
   * 将故事作品移入回收站（软删除，canonical 命名）
   */
  const moveToTrash = async (
    input: LibraryTrashInput | number
  ): Promise<StoryWorkDetailDTO> => {
    const payload: LibraryTrashInput = typeof input === 'number' ? { id: input } : input;
    return client.library.moveToTrash.mutate(payload);
  };

  /**
   * 从回收站恢复故事作品
   */
  const restoreStoryWork = async (
    input: LibraryRestoreInput | number
  ): Promise<StoryWorkDetailDTO> => {
    const payload: LibraryRestoreInput = typeof input === 'number' ? { id: input } : input;
    return client.library.restore.mutate(payload);
  };

  /**
   * 永久物理删除故事作品（仅限处于回收站中的作品，canonical 命名）
   */
  const deletePermanently = async (
    input: LibraryDeletePermanentlyInput | number
  ): Promise<LibraryDeletePermanentlyOutput> => {
    const payload: LibraryDeletePermanentlyInput =
      typeof input === 'number' ? { id: input } : input;
    return client.library.deletePermanently.mutate(payload);
  };

  /**
   * 聚合 Client 对象（8 个 Procedure 入口）
   */
  const libraryClient = {
    list: fetchLibraryList,
    get: fetchLibraryDetail,
    create: createStoryWork,
    rename: renameStoryWork,
    setFavorite: setStoryWorkFavorite,
    moveToTrash,
    restore: restoreStoryWork,
    deletePermanently,
  };

  return {
    fetchLibraryList,
    fetchLibraryDetail,
    createStoryWork,
    renameStoryWork,
    setStoryWorkFavorite,
    moveToTrash,
    restoreStoryWork,
    deletePermanently,
    // 兼容别名
    listStoryWorks: fetchLibraryList,
    getStoryWork: fetchLibraryDetail,
    trashStoryWork: moveToTrash,
    permanentDeleteStoryWork: deletePermanently,
    deletePermanentlyStoryWork: deletePermanently,
    libraryClient,
  };
}

export type LibraryFacade = ReturnType<typeof createLibraryFacade>;
