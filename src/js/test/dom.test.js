import { describe, it, expect } from 'vitest';
import { el, escapeHtml } from '../core/dom.js';

describe('escapeHtml', () => {
  it('escapes &, <, >, ", \'', () => {
    expect(escapeHtml('<script>alert("xss&evil")</script>')).toBe(
      '&lt;script&gt;alert(&quot;xss&amp;evil&quot;)&lt;/script&gt;',
    );
  });

  it('leaves safe text unchanged', () => {
    expect(escapeHtml('hello world')).toBe('hello world');
  });

  it('handles null/undefined', () => {
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
  });

  it('handles numbers', () => {
    expect(escapeHtml(42)).toBe('42');
  });
});

describe('el', () => {
  it('creates an element with a class', () => {
    const node = el('div', { class: 'test-class' });
    expect(node.className).toBe('test-class');
    expect(node.tagName).toBe('DIV');
  });

  it('adds a dataset', () => {
    const node = el('div', { dataset: { path: '/tmp', index: '5' } });
    expect(node.dataset.path).toBe('/tmp');
    expect(node.dataset.index).toBe('5');
  });

  it('sets text via the text prop', () => {
    const node = el('span', { text: 'hello' });
    expect(node.textContent).toBe('hello');
  });

  it('appends child elements', () => {
    const child1 = el('span', { text: 'a' });
    const child2 = el('span', { text: 'b' });
    const parent = el('div', {}, child1, child2);
    expect(parent.children.length).toBe(2);
    expect(parent.textContent).toBe('ab');
  });

  it('appends string children as text nodes', () => {
    const node = el('p', {}, 'text');
    expect(node.childNodes[0].nodeType).toBe(Node.TEXT_NODE);
    expect(node.textContent).toBe('text');
  });

  it('skips null/undefined/false children', () => {
    const node = el('div', {}, null, undefined, false, 'ok');
    expect(node.textContent).toBe('ok');
  });

  it('supports event handlers (onXxx)', () => {
    const spy = vi.fn();
    const btn = el('button', { onClick: spy });
    btn.click();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('sets arbitrary attributes', () => {
    const input = el('input', { type: 'text', placeholder: 'search' });
    expect(input.type).toBe('text');
    expect(input.placeholder).toBe('search');
  });
});
