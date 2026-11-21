import type { FeedingId } from '../domain/index.js';

export interface IdGenerator {
  generateFeedingId(): FeedingId;
}
