import 'fastify';

import type { AuthenticatedUser } from './user-authentication.service.js';

declare module 'fastify' {
  interface FastifyRequest {
    userIdentity: AuthenticatedUser | null;
  }
}

interface UserIdentityRequest {
  userIdentity: AuthenticatedUser | null;
}

export function setUserIdentity(request: UserIdentityRequest, identity: AuthenticatedUser): void {
  request.userIdentity = identity;
}

export function getUserIdentity(request: UserIdentityRequest): AuthenticatedUser {
  if (!request.userIdentity) throw new Error('Authenticated user identity is missing');
  return request.userIdentity;
}
