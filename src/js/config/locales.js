// Словари перевода. Плоские ключи вида 'группа.имя'.
// Подстановки — фигурные скобки: '{n}', '{msg}', '{done}', '{total}', '{size}'.
//
// Покрыто: топбар, статус-бар, вкладки, хлебные крошки, диалог подтверждения,
// панель файлов, панель дубликатов, меню палитры, названия тем и тегов.
// Остальные компоненты (палитра команд, сайдбар, превью, граф связей,
// сообщения regex) переводятся по тому же шаблону t('ключ').

export const STRINGS = {
  ru: {
    // Общее
    'common.error': 'Ошибка: {msg}',
    'common.trashed': 'В корзину: {n}',

    // Топбар
    'topbar.search.placeholder': 'Поиск… (текст или regex)',
    'topbar.search.title': 'Фильтр активной панели: текст или регулярное выражение',
    'topbar.dirsize': 'Посчитать размеры папок',
    'topbar.preview': 'Превью выбранного файла',
    'topbar.collapse': 'Свернуть боковую панель',
    'topbar.duplicates': 'Найти дубликаты',
    'topbar.graph': 'Связи между файлами',
    'topbar.theme': 'Палитра',
    'topbar.tabcolors': 'Цветовая индикация вкладок',
    'topbar.lang': 'Язык интерфейса',

    // Статус-бар
    'status.selected': '{n} выделено',
    'status.folders': '{n} папок',
    'status.files': '{n} файлов',
    'status.search': 'Поиск',
    'status.duplicates': 'Дубликаты',
    'status.links': 'Связи',

    // Диалог подтверждения
    'confirm.title': 'Подтверждение',
    'confirm.cancel': 'Отмена',
    'confirm.ok': 'OK',

    // Вкладки
    'tab.close': 'Закрыть',
    'tab.new': 'Новая вкладка',

    // Хлебные крошки
    'crumbs.back': 'Назад',

    // Контекстное меню
    'ctx.open': 'Открыть',
    'ctx.newFolder': 'Создать папку',
    'ctx.reveal': 'Показать в проводнике',
    'ctx.rename': 'Переименовать…',
    'ctx.duplicates': 'Найти дубликаты',
    'ctx.delete': 'Удалить в корзину',

    // Панель файлов
    'panel.split': 'Разделить',
    'panel.closePanel': 'Закрыть панель',
    'panel.empty': 'Папка пуста',
    'panel.notFound': 'Ничего не найдено',
    'panel.computing': 'Подсчёт…',
    'col.name': 'Имя',
    'col.type': 'Тип',
    'col.tag': 'Метка',
    'col.size': 'Размер',
    'col.modified': 'Изменено',
    'panel.noCreateHere': 'Здесь нельзя создать папку',
    'panel.newFolderName': 'Новая папка',
    'panel.createFolderError': 'Не удалось создать папку: {msg}',
    'panel.deleteTitle': 'Удаление',
    'panel.deleteMsg': 'Удалить в корзину: {n}?',
    'panel.deleteConfirm': 'Удалить',
    'panel.deleteError': 'Ошибка удаления: {msg}',
    'panel.openError': 'Не удалось открыть: {msg}',
    'panel.renameError': 'Ошибка переименования: {msg}',
    'panel.noDropTag': 'Нельзя бросать в тег-папку',
    'panel.conflictTitle': 'Конфликт имён',
    'panel.conflictMsg': 'Уже существует в назначении: {n}',
    'panel.overwrite': 'Перезаписать',
    'panel.skip': 'Пропустить',
    'panel.copied': 'Скопировано: {n}',
    'panel.moved': 'Перемещено: {n}',

    // Панель дубликатов
    'dup.title': 'Дубликаты',
    'dup.none': 'Дубликаты не найдены',
    'dup.scanning': 'Сканирование…',
    'dup.hashing': 'Хеширование {done} / {total}',
    'dup.scanError': 'Ошибка поиска: {msg}',
    'dup.canFree': 'можно освободить {n} копий',
    'dup.keep': 'оставить',
    'dup.delTitle': 'Удалить в корзину',
    'dup.copies': '{n} копий',
    'dup.keepFirst': 'Оставить первый',

    // Темы (палитра)
    'theme.title': 'Палитра',
    'theme.emerald': 'Тёмно-изумрудный',
    'theme.gold': 'Тёпло-золотой',
    'theme.light': 'Светло-голубая',

    // Теги
    'tag.urgent': 'Срочно',
    'tag.in-progress': 'В работе',
    'tag.done': 'Готово',
    'tag.reference': 'Справка',
    'tag.archive': 'Архив',
  },

  en: {
    // Common
    'common.error': 'Error: {msg}',
    'common.trashed': 'Moved to Trash: {n}',

    // Topbar
    'topbar.search.placeholder': 'Search… (text or regex)',
    'topbar.search.title': 'Filter the active panel: text or regular expression',
    'topbar.dirsize': 'Compute folder sizes',
    'topbar.preview': 'Preview selected file',
    'topbar.collapse': 'Collapse sidebar',
    'topbar.duplicates': 'Find duplicates',
    'topbar.graph': 'File relationships',
    'topbar.theme': 'Theme',
    'topbar.tabcolors': 'Color-code tabs',
    'topbar.lang': 'Interface language',

    // Status bar
    'status.selected': '{n} selected',
    'status.folders': '{n} folders',
    'status.files': '{n} files',
    'status.search': 'Search',
    'status.duplicates': 'Duplicates',
    'status.links': 'Links',

    // Confirm dialog
    'confirm.title': 'Confirm',
    'confirm.cancel': 'Cancel',
    'confirm.ok': 'OK',

    // Tabs
    'tab.close': 'Close',
    'tab.new': 'New tab',

    // Breadcrumbs
    'crumbs.back': 'Back',

    // Context menu
    'ctx.open': 'Open',
    'ctx.newFolder': 'New folder',
    'ctx.reveal': 'Show in Explorer',
    'ctx.rename': 'Rename…',
    'ctx.duplicates': 'Find duplicates',
    'ctx.delete': 'Move to Trash',

    // File panel
    'panel.split': 'Split',
    'panel.closePanel': 'Close panel',
    'panel.empty': 'Folder is empty',
    'panel.notFound': 'Nothing found',
    'panel.computing': 'Computing…',
    'col.name': 'Name',
    'col.type': 'Type',
    'col.tag': 'Tag',
    'col.size': 'Size',
    'col.modified': 'Modified',
    'panel.noCreateHere': "Can't create a folder here",
    'panel.newFolderName': 'New folder',
    'panel.createFolderError': "Couldn't create folder: {msg}",
    'panel.deleteTitle': 'Delete',
    'panel.deleteMsg': 'Move {n} item(s) to Trash?',
    'panel.deleteConfirm': 'Delete',
    'panel.deleteError': 'Delete error: {msg}',
    'panel.openError': "Couldn't open: {msg}",
    'panel.renameError': 'Rename error: {msg}',
    'panel.noDropTag': "Can't drop into a tag folder",
    'panel.conflictTitle': 'Name conflict',
    'panel.conflictMsg': 'Already exists at destination: {n}',
    'panel.overwrite': 'Overwrite',
    'panel.skip': 'Skip',
    'panel.copied': 'Copied: {n}',
    'panel.moved': 'Moved: {n}',

    // Duplicates panel
    'dup.title': 'Duplicates',
    'dup.none': 'No duplicates found',
    'dup.scanning': 'Scanning…',
    'dup.hashing': 'Hashing {done} / {total}',
    'dup.scanError': 'Search error: {msg}',
    'dup.canFree': '{n} extra copies can be freed',
    'dup.keep': 'keep',
    'dup.delTitle': 'Move to Trash',
    'dup.copies': '{n} copies',
    'dup.keepFirst': 'Keep first',

    // Themes
    'theme.title': 'Theme',
    'theme.emerald': 'Dark Emerald',
    'theme.gold': 'Warm Gold',
    'theme.light': 'Light Blue',

    // Tags
    'tag.urgent': 'Urgent',
    'tag.in-progress': 'In progress',
    'tag.done': 'Done',
    'tag.reference': 'Reference',
    'tag.archive': 'Archive',
  },
};
