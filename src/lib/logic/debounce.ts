export const SEARCH_DEBOUNCE_MS = 400;

export function createSearchScheduler(delay = SEARCH_DEBOUNCE_MS) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let active: AbortController | null = null;

  return {
    schedule(task: (signal: AbortSignal) => void) {
      if (timer) clearTimeout(timer);
      if (active) active.abort();
      const controller = new AbortController();
      active = controller;
      timer = setTimeout(() => {
        if (!controller.signal.aborted) task(controller.signal);
      }, delay);
    },
    cancel() {
      if (timer) clearTimeout(timer);
      if (active) active.abort();
      timer = null;
      active = null;
    },
  };
}
