import { createHttpClient } from '@/lib/http/common';

const defaultTimeout = Number(process.env.HTTP_SERVER_TIMEOUT_MS ?? '60000');

export const serverHttp = createHttpClient({
  timeout: defaultTimeout,
});
