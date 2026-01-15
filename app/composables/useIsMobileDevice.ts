import { isMobileUserAgent } from '~/utils/device';

export function useIsMobileDevice() {
  if (import.meta.server) {
    const headers = useRequestHeaders(['user-agent']);
    return computed(() => isMobileUserAgent(headers['user-agent']));
  }

  return computed(() => isMobileUserAgent(navigator.userAgent));
}
