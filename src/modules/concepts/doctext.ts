/**
 * Prepares a paper's full text (item.attachmentText, which keeps line breaks)
 * for candidate generation: drops running headers/footers and the
 * bibliography, keeps appendices.
 */

export function cleanDocumentText(raw: string): string {
  const lines = raw.split("\n");

  // Running headers/footers: short lines repeated on several pages.
  const counts = new Map<string, number>();
  for (const l of lines) {
    const k = l.trim();
    if (k.length > 0 && k.length < 120) counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const repeated = (l: string) => {
    const k = l.trim();
    return /^\d{1,3}$/.test(k) || (counts.get(k) ?? 0) >= 3; // page numbers, headers
  };

  // Bibliography: from the last "References" heading to the next appendix
  // heading (or the end).
  let refStart = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^\s*(?:\d+\.?\s*)?(references|bibliography)\s*$/i.test(lines[i])) {
      refStart = i;
      break;
    }
  }
  let refEnd = lines.length;
  if (refStart >= 0) {
    for (let i = refStart + 1; i < lines.length; i++) {
      if (
        /^\s*(?:appendix|appendices|supplementary material)\b/i.test(
          lines[i],
        ) ||
        /^\s*A\.?\s+[A-Z][A-Za-z]/.test(lines[i])
      ) {
        refEnd = i;
        break;
      }
    }
  }

  return lines
    .filter((l, i) => !(refStart >= 0 && i >= refStart && i < refEnd))
    .filter((l) => !repeated(l))
    .join("\n");
}
