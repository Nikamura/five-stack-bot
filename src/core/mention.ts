import type { RosterMember } from "../db/types.js";

export function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/** HTML-safe mention. Username form if available, else tg://user link. */
export function mention(m: { telegram_user_id: number; username: string | null; display_name: string }): string {
  if (m.username) return `@${m.username}`;
  return `<a href="tg://user?id=${m.telegram_user_id}">${escapeHtml(m.display_name)}</a>`;
}

export function mentionList(members: RosterMember[]): string {
  return members.map(mention).join(" ");
}

export function mentionByIds(roster: RosterMember[], ids: number[]): string {
  const map = new Map(roster.map((m) => [m.telegram_user_id, m]));
  return ids
    .map((id) => map.get(id))
    .filter((m): m is RosterMember => !!m)
    .map(mention)
    .join(" ");
}

/** HTML-safe party mentions with any stored lateness shown inline. */
export function mentionByIdsWithLate(
  roster: RosterMember[],
  ids: number[],
  lateByUserId: Map<number, number>,
): string {
  const map = new Map(roster.map((m) => [m.telegram_user_id, m]));
  return ids
    .map((id) => {
      const member = map.get(id);
      if (!member) return "";
      const base = mention(member);
      const late = lateByUserId.get(id);
      return late && late > 0 ? `${base} <i>(${late} min late)</i>` : base;
    })
    .filter(Boolean)
    .join(" ");
}
