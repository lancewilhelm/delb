const mobileUserAgentRegex =
  /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobi/i;

export function isMobileUserAgent(userAgent?: string | null): boolean {
  if (!userAgent) return false;
  return mobileUserAgentRegex.test(userAgent);
}
