// Состояние перетаскивания файлов между панелями — единый синглтон с явным
// интерфейсом вместо мутабельной переменной на уровне модуля. Безопасно при
// будущем расширении (тройной сплит, независимый DnD по вкладкам).
let current = null; // { paths: string[], sourceSide: 'left' | 'right' } | null

export function startDrag(paths, sourceSide) {
  current = { paths, sourceSide };
}

export function getDrag() {
  return current;
}

export function clearDrag() {
  current = null;
}
