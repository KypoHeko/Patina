// Declarative keyboard shortcut map.

export const KEYMAP = [
  { combo: 'ctrl+k', action: 'command-palette', description: 'Поиск / палитра команд' },
  { combo: 'ctrl+d', action: 'duplicates', description: 'Поиск дубликатов' },
  { combo: 'ctrl+g', action: 'relationship-graph', description: 'Граф связей' },
  { combo: 'ctrl+t', action: 'new-tab', description: 'Новая вкладка' },
  { combo: 'ctrl+w', action: 'close-tab', description: 'Закрыть вкладку' },
  { combo: 'ctrl+shift+t', action: 'reopen-tab', description: 'Открыть закрытую вкладку' },
  { combo: 'ctrl+shift+n', action: 'new-folder', description: 'Создать папку' },
  { combo: 'delete', action: 'delete', description: 'Удалить в корзину' },
];
