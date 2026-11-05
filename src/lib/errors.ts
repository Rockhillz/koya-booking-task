export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

export const badRequest = (msg: string) => new HttpError(400, msg);
export const notFound = (msg: string) => new HttpError(404, msg);
export const conflict = (msg: string) => new HttpError(409, msg);
