import { createHttpClient } from '@/lib/http/common';

export const browserHttp = createHttpClient({
  withCredentials: true,
});
