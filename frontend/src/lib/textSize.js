const KEY = 'hb.textSize';

/** The text size saved on this device. Storage can be blocked: then it is simply normal. */
export function savedTextSize() {
  try {
    return localStorage.getItem(KEY) === 'large' ? 'large' : 'normal';
  } catch {
    return 'normal';
  }
}

/** Sizes everything in rem at once (styles/index.css). Lasts for this page if it can't save. */
export function applyTextSize(size) {
  document.documentElement.dataset.textSize = size;
  try {
    localStorage.setItem(KEY, size);
  } catch {
    // A convenience only: the page is already the right size.
  }
}
