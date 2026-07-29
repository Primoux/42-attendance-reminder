/*
 * Mini DOM suffisant pour tester parser.js sans dépendance externe.
 * Supporte : tagName, className, attributs, textContent, querySelectorAll('*')
 * et querySelector('[attr]').
 */

class FakeElement {
  constructor(tag, options = {}) {
    this.tagName = tag.toUpperCase();
    this.className = options.className || '';
    this.attributes = options.attributes || {};
    this.text = options.text || '';
    this.children = [];
  }

  append(...nodes) {
    for (const n of nodes) this.children.push(n);
    return this;
  }

  getAttribute(name) {
    if (name === 'class') return this.className;
    return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null;
  }

  get textContent() {
    if (!this.children.length) return this.text;
    return (this.text ? this.text + ' ' : '') + this.children.map((c) => c.textContent).join(' ');
  }

  descendants() {
    const out = [];
    for (const child of this.children) {
      out.push(child, ...child.descendants());
    }
    return out;
  }

  querySelectorAll(selector) {
    if (selector !== '*') throw new Error(`selecteur non supporté: ${selector}`);
    return this.descendants();
  }

  querySelector(selector) {
    const m = /^\[([\w-]+)\]$/.exec(selector);
    if (!m) throw new Error(`selecteur non supporté: ${selector}`);
    return this.descendants().find((el) => el.getAttribute(m[1]) !== null) || null;
  }
}

const h = (tag, options, ...children) => new FakeElement(tag, options).append(...children);

/** Construit un faux document avec le fragment donné enfoui dans du bruit. */
function makeDocument(...nodes) {
  return h('html', {},
    h('head', {}, h('title', { text: 'intra 42' })),
    h('body', {},
      h('nav', {}, h('a', { text: 'Projects' }), h('span', { text: 'Last update 09:12' })),
      h('div', { className: 'content' }, ...nodes),
      h('footer', { text: '© 42 — 12:00' })
    )
  );
}

module.exports = { FakeElement, h, makeDocument };
