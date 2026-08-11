/*
 * fake-dom.js - le minimum de DOM dont parser.js a besoin.
 *
 * parser.js n'utilise que querySelectorAll('*'), querySelector('[datetime]'),
 * textContent et getAttribute : pas besoin de jsdom pour ça.
 *
 * textContent concatène les enfants *sans séparateur*, comme le vrai DOM —
 * c'est important, parce que c'est ce qui décide si une regex matche ou non
 * sur un élément conteneur.
 */

class FakeElement {
  constructor({ text = '', attrs = {}, children = [] } = {}) {
    this.ownText = text;
    this.attrs = attrs;
    this.children = children;
  }

  get textContent() {
    if (this.children.length === 0) return this.ownText;
    return this.ownText + this.children.map((c) => c.textContent).join('');
  }

  getAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null;
  }

  /** Tous les descendants, dans l'ordre du document (l'élément lui-même exclu). */
  descendants() {
    const out = [];
    for (const child of this.children) {
      out.push(child);
      out.push(...child.descendants());
    }
    return out;
  }

  querySelectorAll(selector) {
    const all = this.descendants();
    if (selector === '*') return all;
    if (selector === '[datetime]') return all.filter((el) => el.getAttribute('datetime') !== null);
    throw new Error(`sélecteur non supporté par le faux DOM : ${selector}`);
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }
}

/** el('On Site 10:31') ou el({ text, attrs, children }) */
function el(spec) {
  return new FakeElement(typeof spec === 'string' ? { text: spec } : spec);
}

/** Racine jouant le rôle de `document` : ses enfants sont les candidats. */
function dom(...specs) {
  return el({ children: specs.map((s) => (s instanceof FakeElement ? s : el(s))) });
}

module.exports = { el, dom, FakeElement };
