// src/js/utils/dom.js
export function createDeleteButton(onClick) {
  const btn = document.createElement('button');
  btn.className = 'delete-history btn btn-xs btn-outline-danger py-0 px-1 ms-auto';
  btn.title = '删除此条记录';
  btn.type = 'button';
  btn.innerHTML = '<i class="fas fa-times small"></i>';
  btn.addEventListener('click', e => {
    e.stopPropagation();
    onClick();
  });
  return btn;
}




