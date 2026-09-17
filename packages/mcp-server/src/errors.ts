export class McpFailure extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
export function fail(code: string, message: string): never {
  throw new McpFailure(code, message);
}
export function publicError(error: unknown): { code: string; message: string } {
  if (error instanceof McpFailure)
    return { code: error.code, message: error.message };
  // Provider/OS errors may contain headers, credentials or signed payloads.
  return {
    code: "UNAVAILABLE",
    message:
      "The operation could not be completed. Check connection status and retry reads; inspect the request before retrying a trade.",
  };
}
