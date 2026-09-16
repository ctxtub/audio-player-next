/**
 * StoryCollection 客户端门面（change-id 2026-09-15-story-collection-continuous-creation）。
 *
 * 仅通过类型安全 tRPC Client 调用 collection Router；不含任何 server-internal 细节。
 */

import { trpc } from '@/lib/trpc/client';
import type {
  CollectionListInput,
  CollectionListOutput,
  CollectionPromoteInput,
  StoryCollectionDetailDTO,
  StoryCollectionSummaryDTO,
} from '@/lib/trpc/schemas/collection';

export type {
  CollectionListInput,
  CollectionListOutput,
  CollectionPromoteInput,
  StoryCollectionDetailDTO,
  StoryCollectionSummaryDTO,
};

export const listCollections = (input: CollectionListInput): Promise<CollectionListOutput> =>
  trpc.collection.list.query(input);

export const getCollection = (id: string): Promise<StoryCollectionDetailDTO> =>
  trpc.collection.get.query({ id });

export const promoteArtifact = (input: CollectionPromoteInput) =>
  trpc.collection.promoteArtifact.mutate(input);

export const renameCollection = (id: string, title: string) =>
  trpc.collection.rename.mutate({ id, title });

export const setCollectionFavorite = (id: string, favorite: boolean) =>
  trpc.collection.setFavorite.mutate({ id, favorite });

export const softDeleteCollection = (id: string) =>
  trpc.collection.softDelete.mutate({ id });

export const restoreCollection = (id: string) => trpc.collection.restore.mutate({ id });

export const deleteCollectionForever = (id: string) =>
  trpc.collection.deleteForever.mutate({ id });
