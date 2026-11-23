import { feedingIdSchema, type FeedingId } from '../domain/index.js';
import type { IdGenerator } from '../ports/index.js';
import { SeededRandom } from './seeded-random.js';

export class DeterministicIdGenerator implements IdGenerator {
  private readonly random: SeededRandom;

  constructor(seed: string | number) {
    this.random = new SeededRandom(seed);
  }

  generateFeedingId(): FeedingId {
    const bytes = this.random.bytes(16);
    bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
    bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
    const hex = [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
    return feedingIdSchema.parse([
      hex.slice(0, 8),
      hex.slice(8, 12),
      hex.slice(12, 16),
      hex.slice(16, 20),
      hex.slice(20),
    ].join('-'));
  }
}
