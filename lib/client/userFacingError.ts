/** Keep product messages; use a localized action hint for transport/provider errors. */
export function userFacingError(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return /[\u4e00-\u9fff]/.test(message) ? message : fallback;
}
