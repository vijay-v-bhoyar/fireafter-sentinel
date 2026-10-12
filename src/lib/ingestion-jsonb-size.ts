/** PostgreSQL jsonb::text uses separator spaces and expands JSON exponent numbers. */
export function jsonbTextBytes(serialized: string): number {
  let size = Buffer.byteLength(serialized), quoted = false, escaped = false;
  for (let index = 0; index < serialized.length; index++) {
    const char = serialized[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') { quoted = true; continue; }
    if (char === "," || char === ":") size++;
    if (char === "-" || (char >= "0" && char <= "9")) {
      let end = index + 1;
      while (end < serialized.length && /[0-9eE+.-]/.test(serialized[end])) end++;
      const number = serialized.slice(index, end);
      const match = /^(-?)(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/.exec(number);
      if (match) {
        const digits = match[2].length + (match[3]?.length ?? 0);
        const point = match[2].length + Number(match[4]);
        const expanded = match[1].length + (point <= 0 ? 2 - point + digits : point >= digits ? point : digits + 1);
        size += expanded - number.length;
      }
      index = end - 1;
    }
  }
  return size;
}
