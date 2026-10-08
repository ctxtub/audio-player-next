ALTER TABLE "GenerationHistory" ADD COLUMN "collectionDeletionBatch" TEXT;
ALTER TABLE "GuestGenerationHistory" ADD COLUMN "collectionDeletionBatch" TEXT;
ALTER TABLE "StoryCollection" ADD COLUMN "deletionBatch" TEXT;
ALTER TABLE "GuestStoryCollection" ADD COLUMN "deletionBatch" TEXT;
