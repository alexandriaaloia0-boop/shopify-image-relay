interface AppErrorOptions extends ErrorOptions {
  details?: Record<string, unknown>;
}

export class AppError extends Error {
  public readonly details: Record<string, unknown> | undefined;

  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    options?: AppErrorOptions
  ) {
    super(message, options);
    this.name = "AppError";
    this.details = options?.details;
  }
}
