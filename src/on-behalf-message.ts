export const ON_BEHALF_PREFIX = "[On Nasen's behalf] ";

export function formatOnBehalfAssistantMessage(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return trimmed;
  if (trimmed.startsWith(ON_BEHALF_PREFIX)) return trimmed;
  return `${ON_BEHALF_PREFIX}${trimmed}`;
}
