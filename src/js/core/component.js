// Базовый класс компонента. От него наследуются все элементы UI.
// Даёт единый жизненный цикл и — главное — автоматическую очистку
// подписок и слушателей при destroy(), чтобы не текла память.

export class Component {
  /**
   * @param {object} ctx
   * @param {HTMLElement} ctx.mount  контейнер для рендера
   * @param {object} ctx.store
   * @param {object} ctx.bus
   */
  constructor({ mount, store, bus }) {
    this.mount = mount;
    this.store = store;
    this.bus = bus;
    /** @type {Array<function>} функции отмены (отписки/снятия слушателей) */
    this._cleanups = [];
    /** @type {Array<Component>} дочерние компоненты */
    this._children = [];
  }

  /** Подписка на стор с автоочисткой. */
  subscribe(fn) {
    this._cleanups.push(this.store.subscribe(fn));
  }

  /** Подписка на шину событий с автоочисткой. */
  listen(event, fn) {
    this._cleanups.push(this.bus.on(event, fn));
  }

  /** addEventListener с автоснятием при destroy. */
  on(target, type, handler, options) {
    target.addEventListener(type, handler, options);
    this._cleanups.push(() => target.removeEventListener(type, handler, options));
  }

  /** Зарегистрировать дочерний компонент (будет уничтожен вместе с родителем). */
  addChild(component) {
    this._children.push(component);
    return component;
  }

  /** Точка входа. Переопределяется наследником. */
  init() {}

  /** Отрисовка. Переопределяется наследником. */
  render() {}

  /** Снять всё: дети, слушатели, подписки, очистить DOM. */
  destroy() {
    this._children.forEach((c) => c.destroy());
    this._children = [];
    this._cleanups.forEach((fn) => fn());
    this._cleanups = [];
    this.mount.innerHTML = '';
  }
}
