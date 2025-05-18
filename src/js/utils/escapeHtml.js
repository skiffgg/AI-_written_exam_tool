// src/js/utils/escapeHtml.js
const escapeMap = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#039;'
};
export function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, m => escapeMap[m]);
}
