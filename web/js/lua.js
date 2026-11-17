// Tiny parser for WoW SavedVariables files (a subset of Lua: assignments of
// tables, strings, numbers, booleans and nil). Returns {VarName: value}.
// Tables become JS arrays when they only have consecutive integer keys from 1,
// otherwise plain objects.

export function parseSavedVariables(text) {
  const p = new Parser(text);
  const out = {};
  p.ws();
  while (!p.eof()) {
    const name = p.ident();
    p.ws();
    p.expect('=');
    out[name] = p.value();
    p.ws();
    if (p.peek() === ';') {
      p.i++;
      p.ws();
    }
  }
  return out;
}

class Parser {
  constructor(s) {
    this.s = s;
    this.i = 0;
  }
  eof() {
    return this.i >= this.s.length;
  }
  peek() {
    return this.s[this.i];
  }
  err(msg) {
    const line = this.s.slice(0, this.i).split('\n').length;
    throw new Error(`SavedVariables parse error at line ${line}: ${msg}`);
  }
  expect(ch) {
    if (this.s[this.i] !== ch) this.err(`expected '${ch}' got '${this.s[this.i]}'`);
    this.i++;
  }
  ws() {
    const s = this.s;
    for (;;) {
      const c = s[this.i];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '﻿') this.i++;
      else if (c === '-' && s[this.i + 1] === '-') {
        if (s.startsWith('[[', this.i + 2)) {
          const end = s.indexOf(']]', this.i + 4);
          this.i = end < 0 ? s.length : end + 2;
        } else {
          const nl = s.indexOf('\n', this.i);
          this.i = nl < 0 ? s.length : nl + 1;
        }
      } else break;
    }
  }
  ident() {
    const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(this.s.slice(this.i, this.i + 256));
    if (!m) this.err('expected identifier');
    this.i += m[0].length;
    return m[0];
  }
  value() {
    this.ws();
    const c = this.peek();
    if (c === '{') return this.table();
    if (c === '"' || c === "'") return this.string();
    if (c === '[' && (this.s[this.i + 1] === '[' || this.s[this.i + 1] === '=')) return this.longString();
    if (c === '-' || c === '.' || (c >= '0' && c <= '9')) return this.number();
    const id = this.ident();
    if (id === 'true') return true;
    if (id === 'false') return false;
    if (id === 'nil') return null;
    this.err(`unexpected identifier ${id}`);
  }
  number() {
    const m = /^-?(0x[0-9a-fA-F]+|\d*\.?\d+(?:[eE][-+]?\d+)?|inf|nan)/.exec(this.s.slice(this.i, this.i + 64));
    if (!m) this.err('bad number');
    this.i += m[0].length;
    return Number(m[0]);
  }
  string() {
    const q = this.s[this.i++];
    let out = '';
    const s = this.s;
    for (;;) {
      if (this.i >= s.length) this.err('unterminated string');
      const c = s[this.i++];
      if (c === q) break;
      if (c === '\\') {
        const e = s[this.i++];
        if (e === 'n') out += '\n';
        else if (e === 't') out += '\t';
        else if (e === 'r') out += '\r';
        else if (e === '\n') out += '\n';
        else if (e >= '0' && e <= '9') {
          let digits = e;
          while (digits.length < 3 && s[this.i] >= '0' && s[this.i] <= '9') digits += s[this.i++];
          out += String.fromCharCode(parseInt(digits, 10));
        } else out += e;
      } else out += c;
    }
    return out;
  }
  longString() {
    const m = /^\[(=*)\[/.exec(this.s.slice(this.i, this.i + 64));
    if (!m) this.err('bad long string');
    const close = `]${m[1]}]`;
    const start = this.i + m[0].length;
    const end = this.s.indexOf(close, start);
    if (end < 0) this.err('unterminated long string');
    this.i = end + close.length;
    return this.s.slice(start, end).replace(/^\r?\n/, '');
  }
  table() {
    this.expect('{');
    const obj = {};
    let arrIndex = 1;
    let isArray = true;
    for (;;) {
      this.ws();
      if (this.peek() === '}') {
        this.i++;
        break;
      }
      let key;
      if (this.peek() === '[') {
        this.i++;
        key = this.value();
        this.ws();
        this.expect(']');
        this.ws();
        this.expect('=');
      } else {
        const save = this.i;
        const m = /^[A-Za-z_][A-Za-z0-9_]*\s*=(?!=)/.exec(this.s.slice(this.i, this.i + 300));
        if (m) {
          key = this.ident();
          this.ws();
          this.expect('=');
        } else {
          this.i = save;
          key = arrIndex;
        }
      }
      const v = this.value();
      if (key === arrIndex) arrIndex++;
      else isArray = false;
      obj[key] = v;
      this.ws();
      const c = this.peek();
      if (c === ',' || c === ';') this.i++;
    }
    if (isArray && arrIndex > 1) {
      const arr = [];
      for (let k = 1; k < arrIndex; k++) arr.push(obj[k]);
      return arr;
    }
    return obj;
  }
}
