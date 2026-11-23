import { computed } from 'vue';
import { isMobileUserAgent } from '~/utils/device';

export function useIsMobileDevice() {
  return computed(() =>
    typeof navigator === 'undefined'
      ? false
      : isMobileUserAgent(navigator.userAgent),
  );
}
