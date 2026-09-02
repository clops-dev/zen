/** Standard headers for SSE responses — disable proxy/CDN buffering. */
export const SSE_HEADERS = {
  "content-type": "text/event-stream",
  "cache-control": "no-cache",
  "x-accel-buffering": "no",
} as const
