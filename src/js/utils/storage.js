// src/js/utils/storage.js
export function save(key, data) {
  try {
    localStorage.setItem(key, JSON.stringify(data));
  } catch (e) {
    console.warn(`[Storage] Save error: ${e}`);
  }
}

export function load(key, defaultValue = null) {
  try {
    const item = localStorage.getItem(key);
    return item !== null ? JSON.parse(item) : defaultValue;
  } catch (e) {
    console.warn(`[Storage] Load error: ${e}`);
    return defaultValue;
  }
}
