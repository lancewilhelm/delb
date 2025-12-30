export function useScrollList({ nearBottomThreshold = 75 } = {}) {
  const containerRef = shallowRef<HTMLElement | null>(null);
  const isNearBottom = ref(true);

  function scrollToBottom() {
    const el = containerRef.value;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }

  function handleScroll() {
    const el = containerRef.value;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    isNearBottom.value = distance <= nearBottomThreshold;
  }

  const vMeasure = {
    mounted(el: HTMLElement) {
      observer?.observe(el);
    },
    updated(el: HTMLElement) {
      observer?.observe(el);
    },
    unmounted(el: HTMLElement) {
      observer?.unobserve(el);
    },
  };

  // Optional: ResizeObserver to detect late content expansion (e.g., MDC)
  let observer: ResizeObserver | null = null;

  if (import.meta.client) {
    observer = new ResizeObserver(() => {
      if (isNearBottom.value) scrollToBottom();
    });
  }

  onMounted(() => {
    containerRef.value?.addEventListener("scroll", handleScroll);
    nextTick(() => {
      setTimeout(() => {
        if (!containerRef.value) return;
        containerRef.value.scrollTop = containerRef.value.scrollHeight;
      }, 0);
    });
  });

  onBeforeUnmount(() => {
    containerRef.value?.removeEventListener("scroll", handleScroll);
  });

  return {
    containerRef,
    scrollToBottom,
    isNearBottom,
    vMeasure,
  };
}
