alter table public.study_conversations
  add column if not exists title_is_custom boolean not null default false;
