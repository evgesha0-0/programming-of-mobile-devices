import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';

import { HttpError } from './http-error.js';

interface ErrorResponse {
  error: {
    code: string;
    message: string;
    request_id: string;
  };
}

export function errorHandler(
  error: FastifyError | Error,
  request: FastifyRequest,
  reply: FastifyReply,
): FastifyReply {
  if ('validation' in error && error.validation) {
    request.log.warn({ err: error }, 'Request validation failed');
    return reply.code(400).send(
      createErrorResponse('VALIDATION_ERROR', error.message, request.id),
    );
  }

  if (error instanceof HttpError) {
    request.log.warn({ err: error }, 'Request rejected');
    return reply.code(error.statusCode).send(
      createErrorResponse(error.code, error.message, request.id),
    );
  }

  request.log.error({ err: error }, 'Unhandled request error');
  return reply.code(500).send(
    createErrorResponse('INTERNAL_ERROR', 'Internal server error', request.id),
  );
}

function createErrorResponse(
  code: string,
  message: string,
  requestId: string,
): ErrorResponse {
  return {
    error: {
      code,
      message,
      request_id: requestId,
    },
  };
}
