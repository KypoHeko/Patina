import { Component } from '../core/component.js';
import { el } from '../core/dom.js';
import { t } from '../lib/i18n.js';

// A generic dialog. Opened by a bus event:
// confirm:open { title, message, confirmLabel, altLabel, danger, onConfirm, onAlt }
export class ConfirmDialog extends Component {
  init() {
    this._req = null;
    this.listen('confirm:open', (req) => this.open(req));
    this.on(document, 'keydown', (e) => {
      if (this._req && e.key === 'Escape') this.close();
    });
  }

  open(req) {
    this._req = req;
    const backdrop = el('div', { class: 'cd__backdrop', onClick: () => this.close() });
    const box = el('div', { class: 'cd' });
    box.append(
      el('div', { class: 'cd__title' }, req.title || t('confirm.title')),
      el('div', { class: 'cd__msg' }, req.message || ''),
    );
    const actions = el('div', { class: 'cd__actions' });
    actions.append(el('button', { class: 'cd__btn', onClick: () => this.close() }, t('confirm.cancel')));
    if (req.altLabel) {
      actions.append(
        el('button', { class: 'cd__btn', onClick: () => this.run('onAlt') }, req.altLabel),
      );
    }
    actions.append(
      el(
        'button',
        { class: 'cd__btn cd__btn--primary' + (req.danger ? ' is-danger' : ''), onClick: () => this.run('onConfirm') },
        req.confirmLabel || t('confirm.ok'),
      ),
    );
    box.append(actions);
    this.mount.innerHTML = '';
    this.mount.append(backdrop, box);
  }

  run(key) {
    const req = this._req;
    this.close();
    if (req && typeof req[key] === 'function') req[key]();
  }

  /** Re-render on language change (if the dialog is open). */
  applyLang() {
    if (!this._req) return;
    // Re-render with the same request, but the "Cancel" button / default texts
    // will pick up new translations. If the caller passed confirmLabel/altLabel,
    // they are preserved — those are caller-provided strings, not our keys.
    this.open(this._req);
  }

  close() {
    this._req = null;
    this.mount.innerHTML = '';
  }
}
