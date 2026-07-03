// Base component class. All UI elements inherit from it.
// Gives a unified lifecycle and — most importantly — automatic cleanup of
// subscriptions and listeners on destroy(), so memory does not leak.

export class Component {
  /**
   * @param {object} ctx
   * @param {HTMLElement} ctx.mount  render container
   * @param {object} ctx.store
   * @param {object} ctx.bus
   */
  constructor({ mount, store, bus }) {
    this.mount = mount;
    this.store = store;
    this.bus = bus;
    /** @type {Array<function>} cleanup functions (unsubscribe/remove listeners) */
    this._cleanups = [];
    /** @type {Array<Component>} child components */
    this._children = [];
  }

  /** Subscribe to the store with auto-cleanup. */
  subscribe(fn) {
    this._cleanups.push(this.store.subscribe(fn));
  }

  /** Subscribe to the event bus with auto-cleanup. */
  listen(event, fn) {
    this._cleanups.push(this.bus.on(event, fn));
  }

  /** addEventListener that is auto-removed on destroy. */
  on(target, type, handler, options) {
    target.addEventListener(type, handler, options);
    this._cleanups.push(() => target.removeEventListener(type, handler, options));
  }

  /** Register a child component (destroyed together with the parent). */
  addChild(component) {
    this._children.push(component);
    return component;
  }

  /** Entry point. Overridden by the subclass. */
  init() {}

  /** Render. Overridden by the subclass. */
  render() {}

  /** Tear down everything: children, listeners, subscriptions, clear the DOM. */
  destroy() {
    this._children.forEach((c) => c.destroy());
    this._children = [];
    this._cleanups.forEach((fn) => fn());
    this._cleanups = [];
    this.mount.innerHTML = '';
  }
}
