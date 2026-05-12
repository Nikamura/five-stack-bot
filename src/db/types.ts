export type VoteValue = "yes" | "maybe" | "no";
export type LockRole = "core" | "alternate";

export interface ChatRow {
  chat_id: number;
  tz: string;
  valid_stacks: string;
  created_at: number;
}

export interface RosterMember {
  chat_id: number;
  telegram_user_id: number;
  username: string | null;
  display_name: string;
  added_at: number;
}

export interface SessionRow {
  id: number;
  chat_id: number;
  opener_user_id: number;
  opener_display_name: string;
  start_minutes: number;
  end_minutes: number;
  poll_message_id: number | null;
  game_on_message_id: number | null;
  opened_at: number;
  archive_at: number;
  archived_at: number | null;
}

export interface VoteRow {
  session_id: number;
  telegram_user_id: number;
  slot_minutes: number;
  value: VoteValue;
  voted_at: number;
}

export interface LockRow {
  session_id: number;
  slot_minutes: number;
  size: number;
  locked_at: number;
}

export interface LockPartyRow {
  session_id: number;
  telegram_user_id: number;
  role: LockRole;
  vote_order: number;
}

export interface ScheduledJob {
  id: number;
  fire_at: number;
  kind: string;
  payload: string;
  created_at: number;
}
