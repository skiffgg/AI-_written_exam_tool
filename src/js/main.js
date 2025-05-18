// src/js/main.js
import initSocket from './init/initSocket.js';
import initAllFeatures from './init/initFeatures.js';

document.addEventListener('DOMContentLoaded', () => {
  initSocket();
  initAllFeatures();
});
