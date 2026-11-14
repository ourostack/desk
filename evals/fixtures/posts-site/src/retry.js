export const RETRY_LIMIT = 3;

export function retryDelayMs(attempt) {
  return 200 * 2 ** (attempt - 1);
}

export function shouldRetry(attempt) {
  return attempt < RETRY_LIMIT;
}
