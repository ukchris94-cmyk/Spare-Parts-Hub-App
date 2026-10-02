export function partSearchTerms(value: string): string[] {
  return Array.from(
    new Set(
      value
        .normalize("NFKC")
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .map((term) => term.trim())
        .filter(Boolean),
    ),
  ).slice(0, 12);
}
