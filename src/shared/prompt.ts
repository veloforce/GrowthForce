const SYSTEM_REMINDER_PATTERN = /<system-reminder>[\s\S]*?<\/system-reminder>\s*/g;

export function stripSystemReminders(text: string): string {
  return text.replace(SYSTEM_REMINDER_PATTERN, "").trim();
}
