// SPDX-License-Identifier: AGPL-3.0-only

/** HTML that is already safe to insert as-is. */
export class SafeHtml {
  constructor(readonly value: string) {}
  toString(): string {
    return this.value;
  }
}

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ESCAPES[c]!);
}

type Value = SafeHtml | string | number | boolean | null | undefined | Value[];

function render(value: Value): string {
  if (value === null || value === undefined || value === false) return '';
  if (value instanceof SafeHtml) return value.value;
  if (Array.isArray(value)) return value.map(render).join('');
  return escapeHtml(String(value));
}

/**
 * Tagged template that escapes every interpolated value unless it is
 * SafeHtml (e.g. the result of another html`` call). Arrays are joined,
 * null/undefined/false render nothing.
 */
export function html(strings: TemplateStringsArray, ...values: Value[]): SafeHtml {
  let out = strings[0]!;
  values.forEach((v, i) => {
    out += render(v) + strings[i + 1]!;
  });
  return new SafeHtml(out);
}

/** Trusted markup produced by code (never user input). */
export function raw(markup: string): SafeHtml {
  return new SafeHtml(markup);
}
