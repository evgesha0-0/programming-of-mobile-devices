export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class NotFoundError extends HttpError {
  constructor(message: string) {
    super(404, 'NOT_FOUND', message);
  }
}

export class ConflictError extends HttpError {
  constructor(message: string) {
    super(409, 'CONFLICT', message);
  }
}

export class UnauthorizedError extends HttpError {
  constructor(message: string) {
    super(401, 'UNAUTHORIZED', message);
  }
}

export class ForbiddenError extends HttpError {
  constructor(message: string) {
    super(403, 'FORBIDDEN', message);
  }
}

