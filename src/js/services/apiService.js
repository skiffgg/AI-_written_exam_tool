// src/js/services/apiService.js
export async function fetchAvailableModels(token) {
  const res = await fetch('/api/available_models', {
    headers: token ? { 'Authorization': `Bearer ${token}` } : {}
  });
  if (!res.ok) throw new Error(`加载模型失败：${res.status}`);
  return res.json();
}

export async function sendVoice(blob, token) {
  const fd = new FormData();
  fd.append('audio', blob);
  const headers = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch('/process_voice', { method: 'POST', body: fd, headers });
  if (!res.ok) throw new Error(`语音发送失败：${res.status}`);
  return res.json();
}
