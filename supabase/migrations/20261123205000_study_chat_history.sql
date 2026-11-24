create table public.study_conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  title text not null check (char_length(btrim(title)) between 1 and 120),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint study_conversations_id_user_id_key unique (id, user_id)
);

create table public.study_messages (
  id uuid primary key default gen_random_uuid(),
  message_order bigint generated always as identity unique,
  conversation_id uuid not null,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  content text not null check (char_length(content) between 1 and 30000),
  created_at timestamptz not null default now(),
  constraint study_messages_conversation_owner_fkey
    foreign key (conversation_id, user_id)
    references public.study_conversations (id, user_id)
    on delete cascade
);

create index study_conversations_user_updated_idx
  on public.study_conversations (user_id, updated_at desc);

create index study_messages_user_conversation_order_idx
  on public.study_messages (user_id, conversation_id, message_order);

alter table public.study_conversations enable row level security;
alter table public.study_messages enable row level security;

grant select, insert, update, delete on public.study_conversations to authenticated;
grant select, insert, delete on public.study_messages to authenticated;

create policy "Users can view their own study conversations"
  on public.study_conversations for select to authenticated
  using ((select auth.uid()) = user_id);

create policy "Users can create their own study conversations"
  on public.study_conversations for insert to authenticated
  with check ((select auth.uid()) = user_id);

create policy "Users can update their own study conversations"
  on public.study_conversations for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "Users can delete their own study conversations"
  on public.study_conversations for delete to authenticated
  using ((select auth.uid()) = user_id);

create policy "Users can view their own study messages"
  on public.study_messages for select to authenticated
  using ((select auth.uid()) = user_id);

create policy "Users can create their own study messages"
  on public.study_messages for insert to authenticated
  with check ((select auth.uid()) = user_id);

create policy "Users can delete their own study messages"
  on public.study_messages for delete to authenticated
  using ((select auth.uid()) = user_id);
