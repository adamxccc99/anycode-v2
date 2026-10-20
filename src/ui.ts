// ANSI formatting helpers (no dependency).
const on = process.stdout.isTTY && !process.env['NO_COLOR'];

const code = (n: number, s: string) =>
  on ? `\x1b[${n}m${s}\x1b[0m` : s;

export const dim = (s: string): string => code(2, s);
export const red = (s: string): string => code(31, s);
export const green = (s: string): string => code(32, s);
export const yellow = (s: string): string => code(33, s);
export const cyan = (s: string): string => code(36, s);
